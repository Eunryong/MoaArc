/**
 * CreateTripModal — 여행방 생성 전체 흐름
 *
 * 1. 사용자가 여행방 이름, 목표 예산, 참여자 목록을 입력
 * 2. "생성하기" 클릭 → useCreateTrip으로 온체인 createTrip() 트랜잭션 실행 (지갑 서명 요청)
 * 3. 트랜잭션 완료 후 txHash + contractAddress + participants를 서버에 자동 등록
 * 4. 완료 콜백으로 App에 새 여행방 전달
 */

import { useState, useCallback } from "react";
import { useChainId } from "wagmi";
import { useCreateTrip } from "../useContractWrite";
import { registerTrip, type TripApiRecord } from "../apiClient";
import { MOAARK_ADDRESS } from "../contractAbi";

const ARC_TESTNET_CHAIN_ID = 5042002;

interface Props {
  onClose: () => void;
  onCreated: (trip: TripApiRecord) => void;
  connectedAddress?: string;
}

interface Participant {
  displayName: string;
  address: string;
}

export default function CreateTripModal({ onClose, onCreated, connectedAddress }: Props) {
  const chainId = useChainId();
  const isWrongChain = chainId !== ARC_TESTNET_CHAIN_ID;

  const [name, setName] = useState("");
  const [targetBudget, setTargetBudget] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([
    { displayName: "나", address: connectedAddress ?? "" },
    { displayName: "", address: "" },
  ]);
  const [step, setStep] = useState<"form" | "tx" | "registering" | "done" | "error">("form");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { state: txState, execute: executeCreateTrip } = useCreateTrip();

  const updateParticipant = (i: number, field: keyof Participant, val: string) => {
    setParticipants((prev) => prev.map((p, idx) => idx === i ? { ...p, [field]: val } : p));
  };

  const addParticipant = () => setParticipants((prev) => [...prev, { displayName: "", address: "" }]);
  const removeParticipant = (i: number) => setParticipants((prev) => prev.filter((_, idx) => idx !== i));

  const validParticipants = participants.filter(
    (p) => p.address.trim().startsWith("0x") && p.address.trim().length >= 10
  );

  const handleCreate = useCallback(async () => {
    setErrorMsg(null);

    if (!name.trim()) { setErrorMsg("여행방 이름을 입력하세요."); return; }
    if (validParticipants.length === 0) { setErrorMsg("참여자 주소를 올바르게 입력하세요."); return; }
    const budgetUSDC = targetBudget.trim() === "" ? 0 : parseFloat(targetBudget);
    if (isNaN(budgetUSDC) || budgetUSDC < 0) { setErrorMsg("목표 예산은 0 이상으로 입력하세요."); return; }

    const budgetMicro = BigInt(Math.round(budgetUSDC * 1_000_000)); // USDC 6 decimals
    const addrs = validParticipants.map((p) => p.address.trim() as `0x${string}`);

    setStep("tx");

    // Step 1: 온체인 트랜잭션 (지갑 서명 요청)
    await executeCreateTrip(name.trim(), addrs, budgetMicro);
  }, [name, targetBudget, validParticipants, executeCreateTrip]);

  // txState 변화를 감지해 서버 등록 진행
  const prevTxStatus = txState.status;
  if (prevTxStatus === "success" && txState.txHash && txState.tripId !== undefined && step === "tx") {
    setStep("registering");
    void (async () => {
      try {
        const newTrip = await registerTrip({
          txHash: txState.txHash!,
          chainId: ARC_TESTNET_CHAIN_ID,
          contractAddress: MOAARK_ADDRESS,
          participants: validParticipants.map((p) => ({
            address: p.address.trim().toLowerCase(),
            displayName: p.displayName.trim() || p.address.slice(0, 6),
          })),
        });
        setStep("done");
        onCreated(newTrip);
      } catch (e) {
        setErrorMsg(`서버 등록 실패: ${e instanceof Error ? e.message : String(e)}`);
        setStep("error");
      }
    })();
  }

  if (prevTxStatus === "error" && step === "tx") {
    setStep("error");
    setErrorMsg(txState.errorMessage ?? "트랜잭션이 실패했습니다.");
  }

  // ── 렌더 ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-stone-100">
          <h2 className="text-base font-bold text-stone-800">여행방 만들기</h2>
          {step === "form" && (
            <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
          )}
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* ── 입력 폼 ── */}
          {step === "form" && (
            <>
              {/* 체인 경고 */}
              {isWrongChain && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                  ⚠️ 지갑을 <strong>Arc Testnet (Chain ID: 5042002)</strong>으로 전환한 뒤 생성하세요.
                  <br/>
                  <span className="text-xs text-amber-600">현재: Chain ID {chainId}</span>
                </div>
              )}

              {/* 여행방 이름 */}
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1">
                  여행방 이름 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="예: 도쿄 여행 2027"
                  className="w-full border border-stone-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              {/* 목표 예산 */}
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1">
                  목표 예산 (USDC)
                </label>
                <input
                  type="number"
                  value={targetBudget}
                  onChange={(e) => setTargetBudget(e.target.value)}
                  placeholder="비워두면 제한 없음"
                  min="0"
                  step="any"
                  className="w-full border border-stone-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              {/* 참여자 */}
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-2">
                  참여자 <span className="text-red-400">*</span>
                </label>
                <div className="space-y-2">
                  {participants.map((p, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={p.displayName}
                        onChange={(e) => updateParticipant(i, "displayName", e.target.value)}
                        placeholder="이름"
                        className="w-24 border border-stone-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      />
                      <input
                        type="text"
                        value={p.address}
                        onChange={(e) => updateParticipant(i, "address", e.target.value)}
                        placeholder="0x 지갑 주소"
                        className="flex-1 border border-stone-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      />
                      {participants.length > 1 && (
                        <button
                          onClick={() => removeParticipant(i)}
                          className="text-stone-400 hover:text-red-500 text-lg leading-none px-1"
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

              {errorMsg && (
                <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{errorMsg}</p>
              )}

              {/* 안내 */}
              <div className="text-xs text-stone-500 bg-stone-50 rounded-xl px-4 py-3 space-y-1">
                <p className="font-semibold text-stone-600">💡 진행 순서</p>
                <p>1. "생성하기"를 누르면 지갑에서 서명 요청이 뜹니다.</p>
                <p>2. Arc Testnet 온체인 트랜잭션이 완료되면 자동으로 서버에 등록됩니다.</p>
              </div>

              {/* 버튼 */}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl border border-stone-300 text-stone-600 text-sm hover:bg-stone-50"
                >
                  취소
                </button>
                <button
                  onClick={handleCreate}
                  disabled={isWrongChain || !name.trim() || validParticipants.length === 0}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  생성하기
                </button>
              </div>
            </>
          )}

          {/* ── 트랜잭션 진행 중 ── */}
          {step === "tx" && (
            <div className="py-6 text-center space-y-4">
              {txState.status === "waiting_approval" && (
                <>
                  <div className="text-3xl">📱</div>
                  <p className="font-semibold text-stone-700">지갑 서명을 확인하세요</p>
                  <p className="text-sm text-stone-500">지갑 앱에서 트랜잭션 승인을 눌러주세요.</p>
                </>
              )}
              {txState.status === "pending" && (
                <>
                  <div className="text-3xl animate-spin inline-block">⏳</div>
                  <p className="font-semibold text-stone-700">블록 확인 중...</p>
                  <p className="text-sm text-stone-500">Arc Testnet에서 트랜잭션을 처리하고 있습니다.</p>
                  {txState.txHash && (
                    <p className="text-xs text-stone-400 font-mono break-all">{txState.txHash.slice(0, 20)}…</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── 서버 등록 중 ── */}
          {step === "registering" && (
            <div className="py-6 text-center space-y-4">
              <div className="text-3xl">🔗</div>
              <p className="font-semibold text-stone-700">서버에 등록 중...</p>
              <p className="text-sm text-stone-500">온체인 트랜잭션을 검증하고 여행방을 등록합니다.</p>
            </div>
          )}

          {/* ── 완료 ── */}
          {step === "done" && (
            <div className="py-6 text-center space-y-4">
              <div className="text-4xl">🎉</div>
              <p className="font-bold text-stone-800">여행방이 생성됐습니다!</p>
              <p className="text-sm text-stone-500">여행방 화면으로 이동합니다.</p>
            </div>
          )}

          {/* ── 오류 ── */}
          {step === "error" && (
            <div className="py-4 space-y-4">
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">{errorMsg}</p>
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-xl border border-stone-300 text-stone-600 text-sm"
                >
                  닫기
                </button>
                <button
                  onClick={() => { setStep("form"); setErrorMsg(null); }}
                  className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700"
                >
                  다시 시도
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
