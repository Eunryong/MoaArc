import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useI18n } from "../i18n";
import type { Trip, ParticipantId } from "../types";
import {
  getTotalConfirmedExpenses,
  getTotalPendingExpenses,
  getPendingExpenseCount,
  fmtUsdc,
  parsePositiveUsdc,
  usdcInputProblem,
  calcParticipantSummary,
} from "../calculations";
import {
  useDeposit,
  useReleaseBudget,
  useReturnUnusedBudget,
  useAddParticipant,
  isLegacyTrip,
  txStatusLabel,
  txStatusColor,
  txExplorerUrl,
} from "../useContractWrite";
import {
  classifyRead,
  exceedsKnownBalance,
  formatReadUsdc,
  participantSumState,
  shortAddress,
  statusLabelKey,
} from "../onchainReads";
import { buildBalanceDetails } from "../balanceDetails";
import BalanceDetailsDialog from "./BalanceDetailsDialog";
import { addTripParticipant } from "../apiClient";
import { NETWORK_CONFIG, NETWORK_LABEL, addressExplorerUrl } from "../networkConfig";
import {
  useTripBalance,
  useUsdcBalance,
  useSettlementStatus,
} from "../useContractState";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

interface Props {
  trip: Trip;
  dbTripId: string;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
  onParticipantAdded?: () => void;
  /** 입금/이체/반납 성공 후 참여자별 온체인 잔액(App 레벨 배치 읽기)을 다시 읽도록 요청 */
  onOnchainBalancesChanged?: () => void;
  connectedAddress?: `0x${string}`;
  /** Arc Testnet이 아닌 체인에 연결됐을 때 true */
  isWrongChain?: boolean;
}

/** 트랜잭션 확정 직후 RPC 노드 간 지연을 고려한 2차 재조회 지연(ms) */
const FOLLOW_UP_REFRESH_MS = 3_000;

export default function DashboardTab({ trip, dbTripId, currentUserId, onTripUpdate: _onTripUpdate, onParticipantAdded, onOnchainBalancesChanged, connectedAddress, isWrongChain }: Props) {
  const { t } = useI18n();
  const [depositInput, setDepositInput] = useState("");
  const [depositMsg, setDepositMsg] = useState("");
  const [releaseInput, setReleaseInput] = useState("");
  const [releaseTarget, setReleaseTarget] = useState<ParticipantId | "">("");
  const [releaseMemo, setReleaseMemo] = useState("");
  const [releaseMsg, setReleaseMsg] = useState("");
  const [returnInput, setReturnInput] = useState("");
  const [returnMsg, setReturnMsg] = useState("");
  // ─── 참여자 추가 상태 ──────────────────────────────────────────────────
  const [newParticipantAddr, setNewParticipantAddr] = useState("");
  const [newParticipantName, setNewParticipantName] = useState("");
  const [addParticipantMsg, setAddParticipantMsg] = useState("");
  // ─── 잔액 상세(Details) 대화상자 ───────────────────────────────────────
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  // ─── 수동 새로고침 상태 ─────────────────────────────────────────────────
  const [isRefreshing, setIsRefreshing] = useState(false);

  const onchainTripId = trip.onchainTripId ?? 0n;  // bigint from DB ("1" → 1n); 0n fallback이면 훅은 enabled=false로 차단됨
  const isAdmin = trip.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;
  const confirmedExpenses = getTotalConfirmedExpenses(trip);
  const pendingExpenses = getTotalPendingExpenses(trip);
  const pendingCount = getPendingExpenseCount(trip);
  const me = trip.participants.find((p) => p.id === currentUserId)!;
  const summary = calcParticipantSummary(trip, currentUserId);

  // ─── 컨트랙트 실시간 읽기 ──────────────────────────────────────────────
  const ca = trip.contractAddress;  // 레거시 방이면 읽기 훅이 disabled됨
  const enabled = onchainTripId > 0n;
  const tripBalanceResult = useTripBalance(onchainTripId, enabled, ca);
  const myUsdcResult = useUsdcBalance(connectedAddress, !!connectedAddress);
  const settlementStatusResult = useSettlementStatus(onchainTripId, enabled, ca);

  // 읽기 결과 (실패 = undefined, 로딩 중 = undefined)
  const myUsdcBalance: bigint | undefined = myUsdcResult.data;
  const myUsdcError = myUsdcResult.isError;

  const isLegacy = isLegacyTrip(ca);

  // 입력 도중 즉시 보여줄 금액 형식 경고 (7자리 이상 소수·지수 표기 등) — 해당 버튼도 비활성화
  const depositProblem = usdcInputProblem(depositInput);
  const releaseProblem = usdcInputProblem(releaseInput);
  const returnProblem = usdcInputProblem(returnInput);

  // 현재 공동지갑 잔액(tripBalance) — 누적 입금액이 아님. 입금 − 이체(release) + 반납(return) 이 반영된 "지금 이체 가능한 금액".
  const sharedBalance = classifyRead<bigint>({
    enabled: enabled && !isLegacy,
    isError: tripBalanceResult.isError,
    data: tripBalanceResult.data,
  });
  const sharedBalanceKnown: bigint | undefined = sharedBalance.kind === "ok" ? sharedBalance.value : undefined;
  // true only when the balance is known AND is exactly zero — used to block budget transfer
  const zeroSharedBalance = useMemo(
    () => sharedBalance.kind === "ok" && sharedBalance.value === 0n,
    [sharedBalance],
  );
  // 참여자별 온체인 값(App 에서 주입)의 합계 — 한 명이라도 읽기 전/실패면 합계를 보여주지 않음
  const cumulativeDeposits = participantSumState(trip.participants, "depositedAmount");
  const totalAllocatedState = participantSumState(trip.participants, "allocatedBudget");
  const readLabel = (key: ReturnType<typeof statusLabelKey>) => t(key);
  const balanceDetails = buildBalanceDetails(
    {
      sharedBalance,
      cumulativeDeposits,
      allocatedTotal: totalAllocatedState,
      participants: trip.participants,
      connectedAddress,
    },
    readLabel,
  );

  // 내 지갑 기준 반납 대상 (returnUnusedBudget 은 msg.sender 의 allocatedBudget 만 사용)
  const meIsConnectedWallet =
    !!me && !!connectedAddress && me.address.toLowerCase() === connectedAddress.toLowerCase();
  const meStatus = me?.onchainStatus ?? "ok";

  // ─── 온체인 훅 (쓰기 전용) ────────────────────────────────────────────
  const depositHook = useDeposit(onchainTripId, ca);
  const releaseHook = useReleaseBudget(onchainTripId, ca);
  const returnHook = useReturnUnusedBudget(onchainTripId, ca);
  const addParticipantHook = useAddParticipant(onchainTripId, ca);

  // 4인 모델: A/B/C/D 고정 슬롯. 비어있는 첫 번째 슬롯에 배정.
  const SLOTS: ParticipantId[] = ["A", "B", "C", "D"];
  const usedIds = new Set(trip.participants.map((p) => p.id));
  const nextSlotAvailable = SLOTS.find((s) => !usedIds.has(s)) ?? null;
  const participantCount = trip.participants.length;
  const MAX_PARTICIPANTS_UI = 4;

  // 결제비 지급 대상: 자기 자신(관리자)을 제외한 참여자만 선택 가능
  const eligibleParticipants = trip.participants.filter(
    (p) => !connectedAddress || p.address.toLowerCase() !== connectedAddress.toLowerCase()
  );
  const hasEligibleParticipants = eligibleParticipants.length > 0;

  // releaseTarget 을 eligible 목록과 동기화 — eligible 추가/변경 시 첫 번째로 자동 선택
  useEffect(() => {
    if (eligibleParticipants.length > 0) {
      const firstId = eligibleParticipants[0].id;
      setReleaseTarget((prev) =>
        eligibleParticipants.some((p) => p.id === prev) ? prev : firstId
      );
    } else {
      setReleaseTarget("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleParticipants.map((p) => p.id).join(",")]);

  /** onchain 성공했지만 DB sync가 실패한 경우 같은 txHash로 재시도 */
  async function handleAddParticipant() {
    const addr = newParticipantAddr.trim() as `0x${string}`;
    if (!ADDR_RE.test(addr)) {
      setAddParticipantMsg(t("err_invalid_address"));
      return;
    }
    if (participantCount >= MAX_PARTICIPANTS_UI) {
      setAddParticipantMsg(t("err_max_participants", { max: String(MAX_PARTICIPANTS_UI) }));
      return;
    }
    if (nextSlotAvailable === null) {
      setAddParticipantMsg(t("err_no_slot"));
      return;
    }
    setAddParticipantMsg("");

    // onchain — hook이 confirmedTxHash를 보존하므로 DB sync 실패 후 재호출해도 안전
    const txHash = await addParticipantHook.execute(addr);
    if (!txHash) return;

    // DB sync — 실패해도 txHash는 hook에 보존됨 → 재호출로 복구 가능
    try {
      await addTripParticipant(dbTripId, {
        txHash,
        chainId: NETWORK_CONFIG.chainId,
        contractAddress: trip.contractAddress,
        newParticipantAddress: addr,
        displayName: newParticipantName.trim() || addr.slice(0, 10),
      });
      setNewParticipantAddr("");
      setNewParticipantName("");
      onParticipantAdded?.();
    } catch (e) {
      // onchain 성공, DB sync 실패 — 오류 메시지만 표시 (txHash는 hook에 보존)
      setAddParticipantMsg(
        t("err_db_sync_retry") + ": " + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  // ─── 성공 후 읽기 갱신 ───────────────────────────────────────────────────
  // 핸들러 안에서 `hook.state.status` 를 await 직후 읽으면 클로저의 이전 값이라 항상 stale 입니다.
  // 따라서 상태 전이를 effect 로 감지해 (1) 입력 초기화 (2) 즉시 재조회 (3) 지연 재조회를 수행합니다.
  const followUpTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { followUpTimers.current.forEach(clearTimeout); }, []);

  function refreshAfterTx(refresh: () => void) {
    refresh();
    followUpTimers.current.push(setTimeout(refresh, FOLLOW_UP_REFRESH_MS));
  }

  // ─── 수동 새로고침 ────────────────────────────────────────────────────
  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.allSettled([
        tripBalanceResult.refetch(),
        myUsdcResult.refetch(),
        onOnchainBalancesChanged ? Promise.resolve(onOnchainBalancesChanged()) : Promise.resolve(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripBalanceResult, myUsdcResult, onOnchainBalancesChanged]);

  useEffect(() => {
    if (depositHook.state.status !== "success") return;
    setDepositInput("");
    refreshAfterTx(() => {
      void tripBalanceResult.refetch();
      void myUsdcResult.refetch();
      onOnchainBalancesChanged?.();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositHook.state.status]);

  useEffect(() => {
    if (releaseHook.state.status !== "success") return;
    setReleaseInput("");
    setReleaseMemo("");
    refreshAfterTx(() => {
      void tripBalanceResult.refetch();
      void myUsdcResult.refetch();
      onOnchainBalancesChanged?.();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [releaseHook.state.status]);

  useEffect(() => {
    if (returnHook.state.status !== "success") return;
    setReturnInput("");
    refreshAfterTx(() => {
      void tripBalanceResult.refetch();
      void myUsdcResult.refetch();
      onOnchainBalancesChanged?.();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnHook.state.status]);

  // ─── 온체인 핸들러 ──────────────────────────────────────────────────────

  async function handleOnchainDeposit() {
    // 7자리 이상 소수·지수 표기·음수 등은 지갑/컨트랙트 호출 전에 거부 (절사·반올림 없음)
    const parsed = parsePositiveUsdc(depositInput);
    if (!parsed.ok) {
      setDepositMsg(t(parsed.key));
      return;
    }
    const amt = parsed.value;
    setDepositMsg("");
    await depositHook.execute(amt);
  }

  async function handleOnchainRelease() {
    const parsed = parsePositiveUsdc(releaseInput);
    if (!parsed.ok) {
      setReleaseMsg(t(parsed.key));
      return;
    }
    const amt = parsed.value;
    // tripBalance 를 읽은 경우에만 사전 차단 (읽기 실패/로딩이면 simulateContract 가 온체인에서 최종 검증)
    if (exceedsKnownBalance(amt, sharedBalanceKnown)) {
      setReleaseMsg(t("err_exceeds_shared_balance", { available: fmtUsdc(sharedBalanceKnown ?? 0n) }));
      return;
    }
    if (!releaseTarget) return;
    const spenderAddr = trip.participants.find((p) => p.id === releaseTarget)?.address as `0x${string}` | undefined;
    if (!spenderAddr) return;
    setReleaseMsg("");
    await releaseHook.execute(spenderAddr, amt, releaseMemo);
  }

  async function handleOnchainReturn() {
    const parsed = parsePositiveUsdc(returnInput);
    if (!parsed.ok) {
      setReturnMsg(t(parsed.key));
      return;
    }
    const amt = parsed.value;
    if (me && meStatus === "ok" && amt > me.allocatedBudget) {
      setReturnMsg(t("err_exceeds_allocated", { allocated: fmtUsdc(me.allocatedBudget) }));
      return;
    }
    setReturnMsg("");
    await returnHook.execute(amt);
  }

  const handleDeposit = handleOnchainDeposit;
  const handleRelease = handleOnchainRelease;
  const handleReturn = handleOnchainReturn;

  return (
    <div className="space-y-4">
      {/* 레거시 방 배너 */}
      {isLegacy && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800 flex items-start gap-2">
          <span className="font-semibold whitespace-nowrap">{t("legacy_trip_badge")}</span>
          <span>{t("legacy_trip_banner")}</span>
        </div>
      )}

      {/* 여행 요약 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-stone-700">{t("shared_wallet")}</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void handleManualRefresh(); }}
              disabled={isRefreshing}
              aria-label={t("refresh_balances")}
              className="min-h-[44px] rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-600 hover:bg-stone-50 disabled:opacity-50"
            >
              {isRefreshing ? t("refreshing_balances") : `↻ ${t("refresh_balances")}`}
            </button>
            <button
              ref={detailsButtonRef}
              type="button"
              onClick={() => setDetailsOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              className="min-h-[44px] rounded-lg border border-indigo-200 px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
            >
              {t("details_btn")}
            </button>
          </div>
        </div>
        <BalanceDetailsDialog
          open={detailsOpen}
          onClose={closeDetails}
          details={balanceDetails}
          returnFocusRef={detailsButtonRef}
        />
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Row
            label={t("shared_balance_now")}
            value={formatReadUsdc(sharedBalance, readLabel)}
            note={t("shared_balance_note")}
            highlight
          />
          <Row
            label={t("total_deposited")}
            value={formatReadUsdc(cumulativeDeposits, readLabel)}
            note={t("total_deposited_note")}
          />
          <Row
            label={t("external_wallet_budget")}
            value={formatReadUsdc(totalAllocatedState, readLabel)}
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
          href={addressExplorerUrl(trip.contractAddress)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-indigo-600 font-mono break-all hover:underline"
        >
          {trip.contractAddress}
        </a>
        <p className="text-xs text-stone-400 mt-1">{t("arc_testnet_note", { network: NETWORK_LABEL })}</p>
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

      {/* 결제비 지급 카드 (관리자 전용) — Deposit 위에 배치해 즉시 찾을 수 있도록 */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-stone-200 p-4" id="budget-transfer-card">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-stone-700">{t("budget_transfer_title")}</h3>
            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{t("admin_only_badge")}</span>
          </div>
          <p className="text-xs text-stone-400 mb-1">{t("budget_transfer_desc")}</p>
          <p className="text-xs text-stone-400 mb-3">{t("budget_transfer_note")}</p>

          {/* 이체 가능 금액 = 현재 공동지갑 잔액(tripBalance). 누적 입금액·배정액과 다름. */}
          <div className="mb-3 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2" aria-live="polite">
            <p className="text-xs text-indigo-700">{t("available_to_transfer")}</p>
            <p
              className={`text-base font-semibold tabular-nums ${sharedBalance.kind === "error" ? "text-rose-600" : "text-indigo-800"}`}
              data-testid="available-to-transfer"
            >
              {formatReadUsdc(sharedBalance, readLabel)}
            </p>
            {sharedBalance.kind === "error" && (
              <button
                type="button"
                onClick={() => { void tripBalanceResult.refetch(); }}
                className="mt-1 text-xs text-indigo-600 underline hover:text-indigo-800"
              >
                {t("retry_read")}
              </button>
            )}
            <p className="mt-1 text-xs text-stone-500">{t("available_to_transfer_note")}</p>
          </div>

          {/* 동행자 없음: 지급 대상이 없을 때 — 참여자 추가 안내로 스크롤 */}
          {!hasEligibleParticipants ? (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800 space-y-2"
              role="status"
              data-testid="no-eligible-notice"
            >
              <p className="font-semibold">{t("budget_transfer_no_eligible")}</p>
              <p>{t("budget_transfer_add_participant_hint")}</p>
              <a
                href="#add-participant-card"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById("add-participant-card")?.scrollIntoView({ behavior: "smooth" });
                }}
                className="inline-block underline text-amber-700 hover:text-amber-900 font-medium"
              >
                ↓ {t("add_participant")}
              </a>
            </div>
          ) : zeroSharedBalance ? (
            /* 잔액 0: 공동지갑에 USDC 없음 */
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
              role="status"
              data-testid="zero-balance-notice"
            >
              {t("budget_transfer_zero_balance")}
            </div>
          ) : (
            /* 정상: 지급 폼 */
            <div className="space-y-2">
              <p className="text-xs text-stone-500">{t("budget_transfer_recipient_label")}</p>
              <div className="flex gap-2">
                <select
                  className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  value={releaseTarget}
                  onChange={(e) => setReleaseTarget(e.target.value as ParticipantId)}
                >
                  {eligibleParticipants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({shortAddress(p.address)})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-invalid={!!releaseProblem}
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
                  disabled={releaseHook.state.status === "pending" || releaseHook.state.status === "waiting_approval" || !!isWrongChain || !!releaseProblem || !releaseTarget}
                  title={isWrongChain ? t("switch_chain_title", { network: NETWORK_LABEL }) : undefined}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {releaseHook.state.status === "pending" || releaseHook.state.status === "waiting_approval" ? t("transferring") : t("transfer_btn")}
                </button>
              </div>
            </div>
          )}
          {releaseProblem && !releaseMsg && <p className="text-xs mt-1.5 text-rose-600">{t(releaseProblem)}</p>}
          {releaseMsg && <p className="text-xs mt-1.5 text-rose-600">{releaseMsg}</p>}
          {releaseHook.state.status !== "idle" && <TxStatusRow state={releaseHook.state} />}
        </div>
      )}

      {/* Deposit card */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold text-stone-700">{t("deposit_card_title")}</h3>
        </div>
        <p className="text-xs text-stone-400 mb-3">
          {t("my_wallet_balance")}:{" "}
          <strong className="text-stone-700" data-testid="my-wallet-balance">
            {myUsdcError ? t("read_failed") : myUsdcBalance === undefined ? t("checking") : `${fmtUsdc(myUsdcBalance)} USDC`}
          </strong>
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={!!depositProblem}
            className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder={t("deposit_placeholder")}
            value={depositInput}
            onChange={(e) => { setDepositInput(e.target.value); setDepositMsg(""); depositHook.reset(); }}
          />
          <button
            onClick={() => { void handleDeposit(); }}
            disabled={depositHook.state.status === "pending" || depositHook.state.status === "waiting_approval" || !!isWrongChain || !!depositProblem}
            title={isWrongChain ? t("switch_chain_title", { network: NETWORK_LABEL }) : undefined}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {depositHook.state.status === "pending" || depositHook.state.status === "waiting_approval" ? t("depositing") : t("deposit_btn")}
          </button>
        </div>
        {depositProblem && !depositMsg && <p className="text-xs mt-1.5 text-rose-600">{t(depositProblem)}</p>}
        {depositMsg && (
          <p className="text-xs mt-1.5 text-rose-600">{depositMsg}</p>
        )}
        {depositHook.state.status !== "idle" && (
          <TxStatusRow state={depositHook.state} />
        )}
        <p className="text-xs text-stone-400 mt-1">{t("deposit_approve_note")}</p>
      </div>

      {/* 참여자 추가 카드 — 관리자 전용, 4인 미만일 때만 표시 */}
      {isAdmin && participantCount < MAX_PARTICIPANTS_UI && (
        <div className="rounded-xl border p-4 bg-indigo-50 border-indigo-200" id="add-participant-card">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-semibold text-indigo-800">{t("add_participant")}</h3>
            <span className="text-xs text-indigo-500">{t("admin_only_badge")}</span>
            <span className="ml-auto text-xs text-indigo-500">{participantCount}/{MAX_PARTICIPANTS_UI}</span>
          </div>
          <p className="text-xs text-indigo-600 mb-2">
            {t("add_participant_helper")}
          </p>
          <div className="space-y-2">
            <input
              type="text"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${!newParticipantAddr || ADDR_RE.test(newParticipantAddr) ? "border-stone-200" : "border-rose-400"}`}
              placeholder={t("add_participant_addr_placeholder")}
              value={newParticipantAddr}
              onChange={(e) => { setNewParticipantAddr(e.target.value); setAddParticipantMsg(""); }}
            />
            <input
              type="text"
              className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              placeholder={t("add_participant_name_placeholder")}
              value={newParticipantName}
              onChange={(e) => setNewParticipantName(e.target.value)}
            />
            <button
              onClick={() => { void handleAddParticipant(); }}
              disabled={addParticipantHook.state.status === "pending" || addParticipantHook.state.status === "waiting_approval" || !!isWrongChain || !newParticipantAddr}
              title={isWrongChain ? t("switch_chain_title", { network: NETWORK_LABEL }) : undefined}
              className="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addParticipantHook.state.status === "waiting_approval" ? t("awaiting_wallet") :
               addParticipantHook.state.status === "pending" ? t("confirming_trip") :
               t("add_participant_btn")}
            </button>
          </div>
          {addParticipantMsg && <p className="text-xs mt-1.5 text-rose-600">{addParticipantMsg}</p>}
          {addParticipantHook.state.status !== "idle" && <TxStatusRow state={addParticipantHook.state} />}
        </div>
      )}

      {meIsConnectedWallet && meStatus === "error" && (
        <div className="rounded-xl border p-4 bg-amber-50 border-amber-200 text-xs text-amber-700 flex items-center justify-between gap-2">
          <span>{t("return_budget_title")}: {t("read_failed")}</span>
          <button
            type="button"
            onClick={() => { onOnchainBalancesChanged?.(); }}
            className="underline hover:text-amber-900"
          >
            {t("retry_read")}
          </button>
        </div>
      )}
      {meIsConnectedWallet && meStatus === "ok" && me.allocatedBudget > 0n && (
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
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={!!returnProblem}
              className="flex-1 border border-amber-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"
              placeholder={t("return_amount_placeholder")}
              value={returnInput}
              onChange={(e) => { setReturnInput(e.target.value); setReturnMsg(""); returnHook.reset(); }}
            />
            <button
              onClick={() => { void handleReturn(); }}
              disabled={returnHook.state.status === "pending" || returnHook.state.status === "approving" || returnHook.state.status === "waiting_approval" || !!isWrongChain || !!returnProblem}
              title={isWrongChain ? t("switch_chain_title", { network: NETWORK_LABEL }) : undefined}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {returnHook.state.status === "pending" || returnHook.state.status === "approving" || returnHook.state.status === "waiting_approval" ? t("returning") : t("return_btn")}
            </button>
          </div>
          {returnProblem && !returnMsg && <p className="text-xs mt-1.5 text-rose-600">{t(returnProblem)}</p>}
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
