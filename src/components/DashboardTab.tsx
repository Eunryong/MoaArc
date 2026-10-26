import { useState, useEffect } from "react";
import type { Trip, ParticipantId } from "../types";
import {
  getTotalAllocated,
  getTotalConfirmedExpenses,
  getTotalPendingExpenses,
  getPendingExpenseCount,
  fmtUsdc,
  parseUsdcInput,
  calcParticipantSummary,
} from "../calculations";
import {
  useDeposit,
  useReleaseBudget,
  useReturnUnusedBudget,
  txStatusLabel,
  txStatusColor,
  txExplorerUrl,
} from "../useContractWrite";
import {
  useTripBalance,
  useDepositedAmount,
  useUsdcBalance,
} from "../useContractState";

interface Props {
  trip: Trip;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
  connectedAddress?: `0x${string}`;
  /** Arc Testnet이 아닌 체인에 연결됐을 때 true */
  isWrongChain?: boolean;
}

export default function DashboardTab({ trip, currentUserId, onTripUpdate: _onTripUpdate, connectedAddress, isWrongChain }: Props) {
  const [depositInput, setDepositInput] = useState("");
  const [depositMsg, setDepositMsg] = useState("");
  const [releaseInput, setReleaseInput] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<ParticipantId>("A");
  const [releaseMemo, setReleaseMemo] = useState("");
  const [releaseMsg, setReleaseMsg] = useState("");
  const [returnInput, setReturnInput] = useState("");
  const [returnMsg, setReturnMsg] = useState("");

  const onchainTripId = trip.onchainTripId ?? 0n;  // bigint from DB ("1" → 1n); 0n fallback이면 훅은 enabled=false로 차단됨
  const isAdmin = trip.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;
  const totalAllocated = getTotalAllocated(trip);
  const confirmedExpenses = getTotalConfirmedExpenses(trip);
  const pendingExpenses = getTotalPendingExpenses(trip);
  const pendingCount = getPendingExpenseCount(trip);
  const me = trip.participants.find((p) => p.id === currentUserId)!;
  const summary = calcParticipantSummary(trip, currentUserId);

  // ─── 컨트랙트 실시간 읽기 ──────────────────────────────────────────────
  const enabled = onchainTripId > 0n;
  const tripBalanceResult = useTripBalance(onchainTripId, enabled);
  const myDepositResult = useDepositedAmount(onchainTripId, connectedAddress, enabled && !!connectedAddress);
  const myUsdcResult = useUsdcBalance(connectedAddress, !!connectedAddress);

  // 읽기 결과 (실패 = undefined, 로딩 중 = undefined)
  const contractBalance: bigint | undefined = tripBalanceResult.data;
  const myDepositOnchain: bigint | undefined = myDepositResult.data;
  const myUsdcBalance: bigint | undefined = myUsdcResult.data;
  const contractBalanceError = tripBalanceResult.isError;
  const myDepositError = myDepositResult.isError;
  const myUsdcError = myUsdcResult.isError;

  // ─── 온체인 훅 (쓰기 전용) ────────────────────────────────────────────
  const depositHook = useDeposit(onchainTripId);
  const releaseHook = useReleaseBudget(onchainTripId);
  const returnHook = useReturnUnusedBudget(onchainTripId);

  // deposit 성공 후 read 훅 refetch
  useEffect(() => {
    if (depositHook.state.status === "success") {
      void tripBalanceResult.refetch();
      void myDepositResult.refetch();
      void myUsdcResult.refetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositHook.state.status]);

  // ─── 온체인 핸들러 ──────────────────────────────────────────────────────

  async function handleOnchainDeposit() {
    const amt = parseUsdcInput(depositInput);
    if (!amt || amt <= 0n) {
      setDepositMsg("올바른 금액을 입력해주세요.");
      return;
    }
    setDepositMsg("");
    await depositHook.execute(amt);
    if (depositHook.state.status === "success") {
      setDepositInput("");
    }
  }

  async function handleOnchainRelease() {
    const amt = parseUsdcInput(releaseInput);
    if (!amt || amt <= 0n) {
      setReleaseMsg("올바른 금액을 입력해주세요.");
      return;
    }
    const spenderAddr = trip.participants.find((p) => p.id === releaseTarget)?.address as `0x${string}` | undefined;
    if (!spenderAddr) return;
    setReleaseMsg("");
    await releaseHook.execute(spenderAddr, amt, releaseMemo);
    if (releaseHook.state.status === "success") {
      setReleaseInput("");
      setReleaseMemo("");
    }
  }

  async function handleOnchainReturn() {
    const amt = parseUsdcInput(returnInput);
    if (!amt || amt <= 0n) {
      setReturnMsg("올바른 금액을 입력해주세요.");
      return;
    }
    setReturnMsg("");
    await returnHook.execute(amt);
    if (returnHook.state.status === "success") {
      setReturnInput("");
    }
  }

  const handleDeposit = handleOnchainDeposit;
  const handleRelease = handleOnchainRelease;
  const handleReturn = handleOnchainReturn;

  return (
    <div className="space-y-4">
      {/* 여행 요약 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">공동지갑 현황</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Row
            label="총 입금액 (tripBalance)"
            value={contractBalanceError ? "읽기 실패" : contractBalance === undefined ? "조회 중…" : `${fmtUsdc(contractBalance)} USDC`}
            highlight
          />
          <Row
            label="내 입금 완료액"
            value={myDepositError ? "읽기 실패" : myDepositOnchain === undefined ? "조회 중…" : `${fmtUsdc(myDepositOnchain)} USDC`}
          />
          <Row
            label="외부 결제지갑 공동자금"
            value={`${fmtUsdc(totalAllocated)} USDC`}
            note="※ 공동지갑과 중복 아님"
          />
          <Row label="확정 누적 지출" value={`${fmtUsdc(confirmedExpenses)} USDC`} />
          <Row
            label="대기 중 지출"
            value={`${fmtUsdc(pendingExpenses)} USDC`}
            badge={pendingCount > 0 ? `${pendingCount}건 미확정` : undefined}
          />
          <Row label="목표 예산" value={`${fmtUsdc(trip.targetBudget)} USDC`} />
        </div>
      </div>

      {/* 컨트랙트 주소 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-2">스마트 컨트랙트 (V2)</h3>
        <a
          href={`https://explorer.testnet.arc.io/address/${trip.contractAddress}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-indigo-600 font-mono break-all hover:underline"
        >
          {trip.contractAddress}
        </a>
        <p className="text-xs text-stone-400 mt-1">Arc Testnet · USDC 0x3600…0000 (6 decimals)</p>
        <p className="text-xs text-stone-400">
          온체인 정산 상태: <strong>{trip.onchainSettlementStatus ?? "알 수 없음"}</strong>
        </p>
      </div>

      {/* 입금 카드 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-stone-700">공동지갑 입금</h3>
        </div>
        <p className="text-xs text-stone-400 mb-1">
          내 입금 완료액 (온체인):{" "}
          <strong className="text-stone-700">
            {myDepositError ? "읽기 실패" : myDepositOnchain === undefined ? "조회 중…" : `${fmtUsdc(myDepositOnchain)} USDC`}
          </strong>
        </p>
        <p className="text-xs text-stone-400 mb-3">
          내 지갑 USDC 잔액:{" "}
          <strong className="text-stone-700">
            {myUsdcError ? "읽기 실패" : myUsdcBalance === undefined ? "조회 중…" : `${fmtUsdc(myUsdcBalance)} USDC`}
          </strong>
        </p>
        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="0.000001"
            className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder="USDC 금액 (예: 100)"
            value={depositInput}
            onChange={(e) => { setDepositInput(e.target.value); setDepositMsg(""); depositHook.reset(); }}
          />
          <button
            onClick={() => { void handleDeposit(); }}
            disabled={depositHook.state.status === "pending" || depositHook.state.status === "waiting_approval" || !!isWrongChain}
            title={isWrongChain ? "Arc Testnet (5042002)으로 전환해야 합니다" : undefined}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            입금
          </button>
        </div>
        {depositMsg && (
          <p className="text-xs mt-1.5 text-rose-600">{depositMsg}</p>
        )}
        {depositHook.state.status !== "idle" && (
          <TxStatusRow state={depositHook.state} />
        )}
        <p className="text-xs text-stone-400 mt-1">
          USDC approve → deposit 순서로 두 번의 지갑 승인이 필요합니다.
        </p>
      </div>

      {/* 예산 이체 카드 (관리자 전용) */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-stone-700">결제용 예산 이체</h3>
            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">관리자 전용</span>
          </div>
          <p className="text-xs text-stone-400 mb-3">
            공동자금을 결제자의 외부 지갑으로 이체합니다.
            이 이체는 <strong>여행 지출로 계산되지 않으며</strong> allocatedBudget에 기록됩니다.
            결제자는 실제 외부 지출 후 사용 금액을 별도 기록해야 합니다.
          </p>
          <div className="space-y-2">
            <div className="flex gap-2">
              <select
                className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                value={releaseTarget}
                onChange={(e) => setReleaseTarget(e.target.value as ParticipantId)}
              >
                {trip.participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (보유: {fmtUsdc(p.allocatedBudget)} USDC)
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="0.000001"
                className="w-28 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="금액"
                value={releaseInput}
                onChange={(e) => { setReleaseInput(e.target.value); setReleaseMsg(""); releaseHook.reset(); }}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="메모 (예: 호텔 선결제)"
                value={releaseMemo}
                onChange={(e) => setReleaseMemo(e.target.value)}
              />
              <button
                onClick={() => { void handleRelease(); }}
                disabled={releaseHook.state.status === "pending" || !!isWrongChain}
                title={isWrongChain ? "Arc Testnet (5042002)으로 전환해야 합니다" : undefined}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                이체
              </button>
            </div>
          </div>
          {releaseMsg && <p className="text-xs mt-1.5 text-rose-600">{releaseMsg}</p>}
          {releaseHook.state.status !== "idle" && <TxStatusRow state={releaseHook.state} />}
        </div>
      )}

      {/* 미반납 예산 반납 카드 */}
      {(me?.allocatedBudget ?? 0n) > 0n && (
        <div className="rounded-xl border p-4 bg-amber-50 border-amber-200">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-amber-800">미반납 결제예산 반납</h3>
          </div>
          <p className="text-xs text-amber-600 mb-3">
            내 외부 결제지갑에 공동자금 <strong>{fmtUsdc(me.allocatedBudget)} USDC</strong>가 있습니다.
            실제 사용: {fmtUsdc(me.spentFromBudget)} USDC · 미사용 추정: {fmtUsdc(me.allocatedBudget - me.spentFromBudget)} USDC
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="0.000001"
              className="flex-1 border border-amber-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"
              placeholder="반납 금액"
              value={returnInput}
              onChange={(e) => { setReturnInput(e.target.value); setReturnMsg(""); returnHook.reset(); }}
            />
            <button
              onClick={() => { void handleReturn(); }}
              disabled={returnHook.state.status === "pending" || !!isWrongChain}
              title={isWrongChain ? "Arc Testnet (5042002)으로 전환해야 합니다" : undefined}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              반납
            </button>
          </div>
          {returnMsg && <p className="text-xs mt-1.5 text-rose-600">{returnMsg}</p>}
          {returnHook.state.status !== "idle" && <TxStatusRow state={returnHook.state} />}
          <p className="text-xs text-amber-600 mt-1">
            USDC approve → returnUnusedBudget 순서로 두 번의 지갑 승인이 필요합니다.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  highlight,
  note,
  badge,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  note?: string;
  badge?: string;
}) {
  return (
    <div className={`rounded-lg px-3 py-2 ${highlight ? "bg-indigo-50 border border-indigo-100" : "bg-stone-50"}`}>
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`font-semibold tabular-nums text-sm ${highlight ? "text-indigo-700" : "text-stone-800"}`}>
        {value}
        {badge && (
          <span className="ml-1 text-xs font-normal bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </p>
      {note && <p className="text-xs text-stone-400 mt-0.5">{note}</p>}
    </div>
  );
}

function TxStatusRow({ state }: { state: import("../useContractWrite").TxState }) {
  return (
    <div className="mt-2 text-xs">
      <p className={txStatusColor(state)}>{txStatusLabel(state)}</p>
      {state.txHash && (
        <a
          href={txExplorerUrl(state.txHash)}
          target="_blank"
          rel="noreferrer"
          className="text-indigo-500 hover:underline font-mono"
        >
          {state.txHash.slice(0, 10)}…{state.txHash.slice(-6)} ↗
        </a>
      )}
    </div>
  );
}
