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
import { useSendTransaction, useChainId } from "wagmi";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  prepareCreateTripIntent,
  submitTripIntentTxHash,
  getIntentStatus,
  getToken,
  type TripApiRecord,
} from "../apiClient";

const ARC_TESTNET_CHAIN_ID = 5042002;

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

function parseError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("User rejected") || msg.includes("user rejected")) return "지갑에서 서명을 취소했습니다.";
  if (msg.includes("does not match the target chain")) return "지갑을 Arc Testnet으로 전환하세요.";
  if (msg.includes("insufficient funds")) return "잔액이 부족합니다.";
  return msg.split("\n")[0].slice(0, 120);
}

export function CreateTripModal({ onClose, onCreated, connectedAddress }: Props) {
  const chainId = useChainId();
  const isWrongChain = chainId !== ARC_TESTNET_CHAIN_ID;

  const [step, setStep] = useState<Step>("form");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);

  // 폼 상태
  const [tripName, setTripName] = useState("");
  const [budgetInput, setBudgetInput] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([
    { name: "나", address: connectedAddress },
  ]);

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
      setErrorMsg(intentStatus.error ?? "트랜잭션이 실패했습니다.");
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
    if (!tripName.trim()) { setErrorMsg("여행방 이름을 입력하세요."); return; }
    if (isWrongChain) { setErrorMsg("Arc Testnet으로 전환하세요."); return; }

    const budgetUSDC = Number(budgetInput || "0");
    if (budgetInput && budgetUSDC < 0) { setErrorMsg("예산은 0 이상이어야 합니다."); return; }
    const targetBudgetMicro = BigInt(Math.round(budgetUSDC * 1_000_000));

    const otherParticipants = participants
      .filter((p) => p.address.trim() && p.address.toLowerCase() !== connectedAddress.toLowerCase())
      .map((p) => p.address.trim() as `0x${string}`);

    setStep("preparing");
    setErrorMsg(null);

    // 토큰 확인 — 없으면 재로그인 안내
    if (!getToken()) {
      setErrorMsg("로그인이 필요합니다. 지갑 서명으로 다시 로그인해주세요.");
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

      // 2. 지갑 서명 — calldata를 그대로 전달, 영수증 조회는 하지 않음
      const txHash = await sendTransactionAsync({
        to: intentResp.tx.to,
        data: intentResp.tx.data,
        value: BigInt(intentResp.tx.value),
      });

      // 3. txHash를 백엔드에 제출
      const submitResult = await submitTripIntentTxHash(intentResp.intentId, txHash);

      if (submitResult.status === "confirmed" && submitResult.trip) {
        onCreated(submitResult.trip);
        void queryClient.invalidateQueries({ queryKey: ["trips"] });
        return;
      }

      // 4. 아직 미확인 → polling 시작
      setStep("polling");
    } catch (e) {
      setStep("error");
      setErrorMsg(parseError(e));
    }
  }, [
    tripName, budgetInput, participants, connectedAddress,
    isWrongChain, sendTransactionAsync, queryClient, onCreated,
  ]);

  // ─── 렌더 ──────────────────────────────────────────────────────────────────

  if (step === "preparing" || step === "awaiting_wallet" || step === "polling") {
    const messages: Record<typeof step, string> = {
      preparing: "서버에서 트랜잭션을 준비하는 중...",
      awaiting_wallet: "지갑에서 승인 대기 중...",
      polling: "블록체인에서 확인 중... (최대 1~2분 소요)",
    };
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8 flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-stone-600 text-center">{messages[step]}</p>
          {step === "polling" && (
            <p className="text-xs text-stone-400 text-center">
              트랜잭션이 제출됐습니다. 네트워크 상황에 따라 시간이 걸릴 수 있습니다.
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
          <h2 className="text-lg font-semibold text-stone-800">여행방 추가</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-5">
          {/* 체인 경고 */}
          {isWrongChain && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              지갑을 Arc Testnet(Chain ID: 5042002)으로 전환하세요. 현재: {chainId}
            </div>
          )}

          {/* 에러 */}
          {step === "error" && errorMsg && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">
              {errorMsg}
            </div>
          )}

          {/* 여행방 이름 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              여행방 이름 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={tripName}
              onChange={(e) => setTripName(e.target.value)}
              placeholder="예: 도쿄 여행 2025"
              className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>

          {/* 목표 예산 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              목표 예산 (USDC) — 비워두면 제한 없음
            </label>
            <input
              type="number"
              min="0"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              placeholder="예: 500"
              className="w-full px-4 py-2.5 border border-stone-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>

          {/* 참여자 */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-2">
              참여자 <span className="text-rose-500">*</span>
            </label>
            <div className="space-y-2">
              {participants.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={p.name}
                    onChange={(e) => updateParticipant(i, "name", e.target.value)}
                    placeholder="이름"
                    className="w-24 px-3 py-2 border border-stone-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <input
                    type="text"
                    value={p.address}
                    onChange={(e) => updateParticipant(i, "address", e.target.value)}
                    placeholder="0x 지갑 주소"
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
              + 참여자 추가
            </button>
          </div>
        </div>

        {/* 하단 버튼 */}
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-stone-200 text-stone-700 text-sm font-medium hover:bg-stone-50"
          >
            취소
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={isWrongChain || !tripName.trim()}
            className="flex-1 py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            생성하기
          </button>
        </div>
      </div>
    </div>
  );
}
