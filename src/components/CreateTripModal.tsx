/**
 * CreateTripModal — 여행방 생성
 *
 * 흐름:
 *  1. 사용자가 여행방 이름·참여자·예산 입력
 *  2. "생성하기" → POST /api/intent/create-trip (calldata 수신)
 *  3. useSendTransaction으로 지갑 서명 요청 (calldata를 그대로 전달)
 *  4. 지갑이 txHash 반환 → POST /api/intent/:id/submit
 *  5. 백엔드가 RPC에서 영수증 확인 — useQuery로 polling (2초 간격, confirmed시 중단)
 *  6. confirmed → 여행방 목록 갱신 + 모달 닫기
 *
 * 프론트엔드에서 waitForTransactionReceipt를 사용하지 않습니다.
 * 컨트랙트 ABI·RPC·이벤트 파싱은 모두 백엔드가 담당합니다.
 */

import { useState, useCallback } from "react";
import { useI18n } from "../i18n";
import { parseOptionalUsdc, usdcInputProblem } from "../calculations";
import { useSendTransaction, useChainId } from "wagmi";
import { NETWORK_CONFIG, NETWORK_LABEL, CONFIG_VALID } from "../networkConfig";
import { assertIntentTxMatchesConfig } from "../intentGuard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  prepareCreateTripIntent,
  submitTripIntentTxHash,
  getIntentStatus,
  getToken,
  type TripApiRecord,
} from "../apiClient";

interface Participant {
  name: string;
  address: string;
}

interface Props {
  onClose: () => void;
  onCreated: (trip: TripApiRecord) => void;
  connectedAddress: string;
}

type Step =
  | "form"              // 입력 중
  | "preparing"         // intent 준비 중
  | "awaiting_wallet"   // 지갑 서명 대기
  | "polling"           // 백엔드 영수증 확인 중
  | "error";

/** Sentinel returned when the wallet is on the wrong chain — translated by the caller. */
const ERR_WRONG_CHAIN = "__ERR_WRONG_CHAIN__";

function parseError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("User rejected") || msg.includes("user rejected")) return "Signature cancelled.";
  if (msg.includes("does not match the target chain")) return ERR_WRONG_CHAIN;
  if (msg.includes("insufficient funds")) return "Insufficient funds.";
  return msg.split("\n")[0].slice(0, 120);
}

export function CreateTripModal({ onClose, onCreated, connectedAddress }: Props) {
  const { t } = useI18n();
  const chainId = useChainId();
  const isWrongChain = chainId !== NETWORK_CONFIG.chainId;

  const [step, setStep] = useState<Step>("form");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);

  // 폼 상태
  const [tripName, setTripName] = useState("");
  const [budgetInput, setBudgetInput] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([
    { name: t("me"), address: connectedAddress },
  ]);

  const budgetProblem = usdcInputProblem(budgetInput);

  const { sendTransactionAsync } = useSendTransaction();
  const queryClient = useQueryClient();

  // ─── intent 상태 polling ──────────────────────────────────────────────────
  const { data: intentStatus } = useQuery({
    queryKey: ["intent", intentId],
    queryFn: () => getIntentStatus(intentId!),
    enabled: step === "polling" && !!intentId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || status === "submitted" || status === "pending_tx") return 2000;
      return false; // confirmed / failed / reverted → 중단
    },
  });

  // polling 결과 처리
  if (intentStatus?.status === "confirmed" && intentStatus.trip) {
    onCreated(intentStatus.trip);
    void queryClient.invalidateQueries({ queryKey: ["trips"] });
  }
  if (
    intentStatus?.status === "failed" ||
    intentStatus?.status === "reverted"
  ) {
    if (step === "polling") {
      setStep("error");
      setErrorMsg(intentStatus.error ?? t("err_500"));
    }
  }

  // ─── 참여자 관리 ───────────────────────────────────────────────────────────
  const addParticipant = () =>
    setParticipants((ps) => [...ps, { name: "", address: "" }]);
  const removeParticipant = (i: number) =>
    setParticipants((ps) => ps.filter((_, idx) => idx !== i));
  const updateParticipant = (i: number, field: keyof Participant, value: string) =>
    setParticipants((ps) => ps.map((p, idx) => idx === i ? { ...p, [field]: value } : p));

  // ─── 생성 실행 ──────────────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!tripName.trim()) { setErrorMsg(t("err_400")); return; }
    if (isWrongChain) { setErrorMsg(t("switch_to_arc", { network: NETWORK_LABEL })); return; }
    if (!CONFIG_VALID) { setErrorMsg(t("config_invalid_blocked")); return; }

    // 목표 예산은 선택 입력(빈 값 = 0). 7자리 이상 소수·지수 표기·음수는 서버/지갑 호출 전에 거부 (반올림 없음)
    const budgetParsed = parseOptionalUsdc(budgetInput);
    if (!budgetParsed.ok) { setErrorMsg(t(budgetParsed.key)); return; }
    const targetBudgetMicro = budgetParsed.value;

    const otherParticipants = participants
      .filter((p) => p.address.trim() && p.address.toLowerCase() !== connectedAddress.toLowerCase())
      .map((p) => p.address.trim() as `0x${string}`);

    setStep("preparing");
    setErrorMsg(null);

    // 토큰 확인 — 없으면 재로그인 안내
    if (!getToken()) {
      setErrorMsg(t("err_401"));
      setStep("form");
      return;
    }

    try {
      // 1. 백엔드에서 intent 준비 + calldata 수신
      const intentResp = await prepareCreateTripIntent({
        tripName: tripName.trim(),
        participantAddresses: otherParticipants,
        targetBudget: targetBudgetMicro.toString(),
      });

      setIntentId(intentResp.intentId);
      setStep("awaiting_wallet");

      // 2. 지갑 서명 직전 검증 — 서버가 준 tx 가 이 프런트 설정(체인·컨트랙트)과 사용자 입력(이름·참여자·예산)과
      //    정확히 같고 value=0 인지 확인합니다. 하나라도 다르면 지갑을 호출하지 않습니다.
      assertIntentTxMatchesConfig(intentResp.tx, {
        configValid: CONFIG_VALID,
        chainId: NETWORK_CONFIG.chainId,
        contractAddress: NETWORK_CONFIG.contractAddress,
        tripName: tripName.trim(),
        participantAddresses: otherParticipants,
        targetBudgetMicro,
      });

      // 3. 지갑 서명 — calldata를 그대로 전달 (chainId 고정), 영수증 조회는 하지 않음
      const txHash = await sendTransactionAsync({
        to: intentResp.tx.to,
        data: intentResp.tx.data,
        value: 0n,
        chainId: NETWORK_CONFIG.chainId,
      });

      // 4. txHash를 백엔드에 제출
      const submitResult = await submitTripIntentTxHash(intentResp.intentId, txHash);

      if (submitResult.status === "confirmed" && submitResult.trip) {
        onCreated(submitResult.trip);
        void queryClient.invalidateQueries({ queryKey: ["trips"] });
        return;
      }

      // 5. 아직 미확인 → polling 시작
      setStep("polling");
    } catch (e) {
      setStep("error");
      const raw = parseError(e);
      setErrorMsg(raw === ERR_WRONG_CHAIN
        ? t("err_wrong_chain_switch", { network: NETWORK_LABEL })
        : raw);
    }
  }, [
    tripName, budgetInput, participants, connectedAddress,
    isWrongChain, sendTransactionAsync, queryClient, onCreated, t,
  ]);

  // ─── 렌더 ──────────────────────────────────────────────────────────────────

  if (step === "preparing" || step === "awaiting_wallet" || step === "polling") {
    const messages: Record<typeof step, string> = {
      preparing: t("creating_preparing"),
      awaiting_wallet: t("creating_awaiting_wallet"),
      polling: t("creating_polling"),
    };
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8 flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-stone-600 text-center">{messages[step]}</p>
          {step === "polling" && (
            <p className="text-xs text-stone-400 text-center">
              {t("tx_submitted_note")}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* 헤더 */}
        <div className="flex items-center justify-between p-6 border-b border-stone-100">
          <h2 className="text-lg font-semibold text-stone-800">{t("add_trip")}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-5">
          {/* 체인 경고 */}
          {isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              {t("switch_to_arc", { network: NETWORK_LABEL })} (Chain ID: {NETWORK_CONFIG.chainId}). Current: {chainId}
            </div>
          )}

          {/* 에러 — form/error 모두 표시 */}
          {errorMsg && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">
              {errorMsg}
            </div>
          )}

          {/* 여행방 이름 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              {t("trip_name_label")} <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={tripName}
              onChange={(e) => setTripName(e.target.value)}
              placeholder={t("trip_name_placeholder")}
              className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>

          {/* 목표 예산 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              {t("budget_label")}
            </label>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={!!budgetProblem}
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              placeholder="예: 500"
              className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            {budgetProblem && <p className="mt-1 text-xs text-rose-600">{t(budgetProblem)}</p>}
          </div>

          {/* 참여자 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-2">
              {t("participants_label")} <span className="text-rose-500">*</span>
            </label>
            <div className="space-y-2">
              {participants.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={p.name}
                    onChange={(e) => updateParticipant(i, "name", e.target.value)}
                    placeholder={t("name_placeholder")}
                    className="w-24 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <input
                    type="text"
                    value={p.address}
                    onChange={(e) => updateParticipant(i, "address", e.target.value)}
                    placeholder={t("wallet_address_placeholder")}
                    readOnly={i === 0}
                    className={`flex-1 px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                      i === 0 ? "bg-stone-50 text-stone-500 border-stone-100 cursor-not-allowed" : "border-stone-200"
                    }`}
                  />
                  {i > 0 && (
                    <button
                      onClick={() => removeParticipant(i)}
                      className="text-stone-400 hover:text-rose-500 text-lg leading-none px-1"
                    >×</button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={addParticipant}
              className="mt-2 text-sm text-indigo-600 hover:text-indigo-800"
            >
              + {t("add_participant_btn")}
            </button>
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-stone-200 text-stone-700 text-sm font-medium hover:bg-stone-50"
          >
            {t("cancel_btn")}
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={isWrongChain || !tripName.trim() || !!budgetProblem}
            className="flex-1 py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("create_trip_btn")}
          </button>
        </div>
      </div>
    </div>
  );
}
