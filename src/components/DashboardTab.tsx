import { useState, useEffect } from "react";
import { useI18n } from "../i18n";
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
  useSettlementStatus,
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
  const { t } = useI18n();
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
  const settlementStatusResult = useSettlementStatus(onchainTripId, enabled);

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
      setDepositMsg(t("err_400"));
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
      setReleaseMsg(t("err_400"));
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
      setReturnMsg(t("err_400"));
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
        <h3 className="text-sm font-semibold text-stone-700 mb-3">{t("shared_wallet")}</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Row
            label={t("total_deposited")}
            value={contractBalanceError ? t("read_failed") : contractBalance === undefined ? t("checking") : `${fmtUsdc(contractBalance)} USDC`}
            highlight
          />
          <Row
            label={t("my_deposit")}
            value={myDepositError ? t("read_failed") : myDepositOnchain === undefined ? t("checking") : `${fmtUsdc(myDepositOnchain)} USDC`}
          />
          <Row
            label={t("external_wallet_budget")}
            value={`${fmtUsdc(totalAllocated)} USDC`}
            note={t("external_wallet_note")}
          />
          <Row label={t("confirmed_expenses")} value={`${fmtUsdc(confirmedExpenses)} USDC`} />
          <Row
            label={t("pending_expenses")}
            value={`${fmtUsdc(pendingExpenses)} USDC`}
            badge={pendingCount > 0 ? `${pendingCount} ${t("unconfirmed_badge")}` : undefined}
          />
          <Row label={t("target_budget")} value={`${fmtUsdc(trip.targetBudget)} USDC`} />
        </div>
      </div>

      {/* Smart contract card */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-2">{t("smart_contract")}</h3>
        <a
          href={`https://explorer.testnet.arc.io/address/${trip.contractAddress}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-indigo-600 font-mono break-all hover:underline"
        >
          {trip.contractAddress}
        </a>
        <p className="text-xs text-stone-400 mt-1">{t("arc_testnet_note")}</p>
        <p className="text-xs text-stone-400">
          {t("onchain_settlement_status")}:{" "}
          <strong>
            {!enabled
              ? t("status_unknown")
              : settlementStatusResult.isError
              ? t("status_error")
              : settlementStatusResult.settlementStatus === undefined
              ? t("status_loading")
              : settlementStatusResult.settlementStatus}
          </strong>
        </p>
      </div>

      {/* Deposit card */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-stone-700">{t("deposit_card_title")}</h3>
        </div>
        <p className="text-xs text-stone-400 mb-1">
          {t("my_deposit_onchain")}:{" "}
          <strong className="text-stone-700">
            {myDepositError ? t("read_failed") : myDepositOnchain === undefined ? t("checking") : `${fmtUsdc(myDepositOnchain)} USDC`}
          </strong>
        </p>
        <p className="text-xs text-stone-400 mb-3">
          {t("my_wallet_balance")}:{" "}
          <strong className="text-stone-700">
            {myUsdcError ? t("read_failed") : myUsdcBalance === undefined ? t("checking") : `${fmtUsdc(myUsdcBalance)} USDC`}
          </strong>
        </p>
        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="0.000001"
            className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder={t("deposit_placeholder")}
            value={depositInput}
            onChange={(e) => { setDepositInput(e.target.value); setDepositMsg(""); depositHook.reset(); }}
          />
          <button
            onClick={() => { void handleDeposit(); }}
            disabled={depositHook.state.status === "pending" || depositHook.state.status === "waiting_approval" || !!isWrongChain}
            title={isWrongChain ? t("switch_chain_title") : undefined}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {depositHook.state.status === "pending" || depositHook.state.status === "waiting_approval" ? t("depositing") : t("deposit_btn")}
          </button>
        </div>
        {depositMsg && (
          <p className="text-xs mt-1.5 text-rose-600">{depositMsg}</p>
        )}
        {depositHook.state.status !== "idle" && (
          <TxStatusRow state={depositHook.state} />
        )}
        <p className="text-xs text-stone-400 mt-1">{t("deposit_approve_note")}</p>
      </div>

      {/* Budget transfer card (admin only) */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-stone-700">{t("budget_transfer_title")}</h3>
            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{t("admin_only_badge")}</span>
          </div>
          <p className="text-xs text-stone-400 mb-3">
            {t("budget_transfer_desc")} {t("budget_transfer_note")}
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
                    {p.name} ({t("balance_label")}: {fmtUsdc(p.allocatedBudget)} USDC)
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="0.000001"
                className="w-28 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder={t("amount_placeholder")}
                value={releaseInput}
                onChange={(e) => { setReleaseInput(e.target.value); setReleaseMsg(""); releaseHook.reset(); }}
              />
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder={t("memo_placeholder")}
                value={releaseMemo}
                onChange={(e) => setReleaseMemo(e.target.value)}
              />
              <button
                onClick={() => { void handleRelease(); }}
                disabled={releaseHook.state.status === "pending" || !!isWrongChain}
                title={isWrongChain ? t("switch_chain_title") : undefined}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {releaseHook.state.status === "pending" ? t("transferring") : t("transfer_btn")}
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
            <h3 className="text-sm font-semibold text-amber-800">{t("return_budget_title")}</h3>
          </div>
          <p className="text-xs text-amber-600 mb-3">
            {t("return_budget_desc_prefix")} <strong>{fmtUsdc(me.allocatedBudget)} USDC</strong>.
            {t("return_budget_desc_actual")}: {fmtUsdc(me.spentFromBudget)} USDC · {t("return_budget_desc_unused")}: {fmtUsdc(me.allocatedBudget - me.spentFromBudget)} USDC
          </p>
          <div className="flex gap-2">
            <input
              type="number"
              min="0"
              step="0.000001"
              className="flex-1 border border-amber-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"
              placeholder={t("return_amount_placeholder")}
              value={returnInput}
              onChange={(e) => { setReturnInput(e.target.value); setReturnMsg(""); returnHook.reset(); }}
            />
            <button
              onClick={() => { void handleReturn(); }}
              disabled={returnHook.state.status === "pending" || !!isWrongChain}
              title={isWrongChain ? t("switch_chain_title") : undefined}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {returnHook.state.status === "pending" ? t("returning") : t("return_btn")}
            </button>
          </div>
          {returnMsg && <p className="text-xs mt-1.5 text-rose-600">{returnMsg}</p>}
          {returnHook.state.status !== "idle" && <TxStatusRow state={returnHook.state} />}
          <p className="text-xs text-amber-600 mt-1">{t("return_approve_note")}</p>
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
