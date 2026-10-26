import { useState } from "react";
import type {
  Trip,
  ParticipantId,
  Expense,
  ExpenseVersion,
  ShareEntry,
} from "../types";
import {
  getActiveVersion,
  validateShares,
  fmtUsdc,
  isExpenseConfirmed,
  isExpensePending,
  parseUsdcInput,
  toDisplayNumber,
} from "../calculations";
import { addExpense, approveExpense } from "../apiClient";
import type { TripApiRecord } from "../apiClient";

interface Props {
  trip: Trip;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
  dbTripId: string;
  onExpenseReload: () => void;
  /** 사용 가능한 여행방 목록 (여행방 전환용) */
  allTrips?: TripApiRecord[];
  /** 여행방 전환 콜백 */
  onTripSelect?: (dbTripId: string) => void;
}

type ViewMode = "list" | "add" | "detail";

const CATEGORIES = ["식비", "숙박", "교통", "기타"] as const;
const PAYMENT_FLOWS = [
  { value: "personal_prepaid", label: "개인 선결제 (나중에 정산)" },
  { value: "community_release", label: "공동지갑에서 결제 예산 이체" },
] as const;

export default function ExpenseListTab({
  trip,
  currentUserId,
  onTripUpdate,
  dbTripId,
  onExpenseReload,
  allTrips = [],
  onTripSelect,
}: Props) {
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const isAdmin = trip.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;

  // 여행방 헤더: 이름 + ID 앞 8자리, 여러 방이면 드롭다운 전환
  const tripHeader = (
    <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b text-sm">
      {allTrips.length > 1 && onTripSelect ? (
        <select
          className="font-semibold text-gray-800 bg-transparent border-none outline-none cursor-pointer"
          value={dbTripId}
          onChange={(e) => { onTripSelect(e.target.value); }}
        >
          {allTrips.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.id.slice(0, 8)}
            </option>
          ))}
        </select>
      ) : (
        <span className="font-semibold text-gray-800">
          {trip.name} · {dbTripId.slice(0, 8)}
        </span>
      )}
    </div>
  );

  function selectExpense(id: string) {
    setSelectedExpenseId(id);
    setViewMode("detail");
  }

  function backToList() {
    setViewMode("list");
    setSelectedExpenseId(null);
  }

  const selectedExpense = trip.expenses.find((e) => e.id === selectedExpenseId);

  if (viewMode === "add") {
    return (
      <div>
        {tripHeader}
        <AddExpenseForm
          trip={trip}
          currentUserId={currentUserId}
          dbTripId={dbTripId}
          onCancel={backToList}
          onSuccess={() => { onExpenseReload(); backToList(); }}
        />
      </div>
    );
  }

  if (viewMode === "detail" && selectedExpense) {
    return (
      <div>
        {tripHeader}
        <ExpenseDetail
          expense={selectedExpense}
          trip={trip}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          dbTripId={dbTripId}
          onBack={backToList}
          onTripUpdate={onTripUpdate}
          onExpenseReload={onExpenseReload}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tripHeader}
      {/* 헤더 행 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-stone-500">총 {trip.expenses.length}건</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">
            확정 {trip.expenses.filter(isExpenseConfirmed).length}건 ·
            대기 {trip.expenses.filter(isExpensePending).length}건
          </span>
          <button
            onClick={() => setViewMode("add")}
            className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            + 지출 추가
          </button>
        </div>
      </div>

      {trip.expenses.length === 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-stone-400 text-sm">등록된 지출이 없습니다.</p>
          <button
            onClick={() => setViewMode("add")}
            className="mt-3 text-sm text-indigo-600 hover:underline"
          >
            첫 지출 등록하기 →
          </button>
        </div>
      )}

      {trip.expenses.map((exp) => {
        const activeVer = getActiveVersion(exp);
        const isConfirmed = isExpenseConfirmed(exp);
        const isPending = isExpensePending(exp);

        return (
          <button
            key={exp.id}
            onClick={() => selectExpense(exp.id)}
            className="w-full bg-white rounded-xl border border-stone-200 p-4 text-left hover:border-indigo-200 hover:shadow-sm transition-all"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      isConfirmed
                        ? "bg-emerald-100 text-emerald-700"
                        : isPending
                        ? "bg-amber-100 text-amber-700"
                        : "bg-stone-100 text-stone-500"
                    }`}
                  >
                    {activeVer?.status ?? "알 수 없음"}
                  </span>
                  <span className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full">
                    {exp.category}
                  </span>
                  {exp.refunds.length > 0 && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      환불 {exp.refunds.length}건
                    </span>
                  )}
                </div>
                <p className="text-sm font-semibold text-stone-800 mt-1.5">{exp.title}</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  {exp.date.slice(0, 10)} ·
                  결제자: {trip.participants.find((p) => p.id === exp.paidBy)?.name}
                </p>
                {exp.localCurrency && (
                  <p className="text-xs text-stone-400">
                    현지: {exp.localCurrency} {exp.localAmount?.toLocaleString()}
                  </p>
                )}
              </div>
              <div className="text-right ml-3">
                <p className="text-base font-bold tabular-nums text-stone-800">
                  {fmtUsdc(exp.totalAmount)} USDC
                </p>
                <p className="text-xs text-stone-400 mt-0.5">
                  v{exp.currentVersion} · {exp.participants.length}명 참여
                </p>
              </div>
            </div>

            {activeVer && (
              <div className="mt-3 pt-3 border-t border-stone-100 flex gap-2 flex-wrap">
                {activeVer.shares.map((s) => (
                  <span
                    key={s.participantId}
                    className={`text-xs px-2 py-1 rounded-full tabular-nums ${
                      s.participantId === currentUserId
                        ? "bg-indigo-100 text-indigo-700 font-semibold"
                        : "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {s.participantId}: {fmtUsdc(s.amount)}
                  </span>
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── 지출 등록 폼 ────────────────────────────────────────────────────────────

function AddExpenseForm({
  trip,
  currentUserId,
  dbTripId,
  onCancel,
  onSuccess,
}: {
  trip: Trip;
  currentUserId: ParticipantId;
  dbTripId: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<typeof CATEGORIES[number]>("식비");
  const [date, setDate] = useState(today);
  const [amountStr, setAmountStr] = useState("");
  const [paymentFlow, setPaymentFlow] = useState<"personal_prepaid" | "community_release">("personal_prepaid");
  const [receiptNote, setReceiptNote] = useState("");
  // 분담 대상 + 균등 분배
  const [selectedParticipants, setSelectedParticipants] = useState<Set<ParticipantId>>(
    new Set(trip.participants.map((p) => p.id))
  );
  const [customShares, setCustomShares] = useState<Partial<Record<ParticipantId, string>>>({});
  const [useEqualSplit, setUseEqualSplit] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const totalParsed = parseUsdcInput(amountStr);

  // 균등 분배 계산
  function computeShares(): ShareEntry[] {
    const pids = Array.from(selectedParticipants);
    if (pids.length === 0 || !totalParsed) return [];
    if (useEqualSplit) {
      const base = totalParsed / BigInt(pids.length);
      const remainder = totalParsed % BigInt(pids.length);
      return pids.map((pid, i) => ({
        participantId: pid,
        amount: base + (i === 0 ? remainder : 0n),
      }));
    }
    return pids.map((pid) => ({
      participantId: pid,
      amount: parseUsdcInput(customShares[pid] ?? "") ?? 0n,
    }));
  }

  function toggleParticipant(pid: ParticipantId) {
    setSelectedParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  async function handleSubmit() {
    // 입력 검증
    if (!title.trim()) { setError("제목을 입력하세요."); return; }
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) { setError("날짜 형식이 올바르지 않습니다."); return; }
    if (!totalParsed || totalParsed <= 0n) { setError("금액은 0보다 커야 합니다."); return; }
    if (selectedParticipants.size === 0) { setError("분담 대상 참여자를 1명 이상 선택하세요."); return; }

    const shares = computeShares();
    const sharesSum = shares.reduce((s, sh) => s + sh.amount, 0n);
    if (sharesSum !== totalParsed) {
      setError(`분담 합계(${fmtUsdc(sharesSum)})가 지출 총액(${fmtUsdc(totalParsed)})과 일치하지 않습니다.`);
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await addExpense(dbTripId, {
        title: title.trim(),
        category,
        date,
        totalUsdc: totalParsed.toString(),
        paymentFlow,
        receiptNote: receiptNote.trim() || undefined,
        shares: shares.map((s) => ({
          address: trip.participants.find((p) => p.id === s.participantId)?.address ?? s.participantId,
          amountUsdc: s.amount.toString(),
        })),
      });
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "지출 등록에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  const shares = computeShares();
  const sharesSum = shares.reduce((s, sh) => s + sh.amount, 0n);
  const isSharesValid = !totalParsed || sharesSum === totalParsed;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onCancel} className="text-sm text-stone-500 hover:text-stone-700">
          ← 목록으로
        </button>
        <h2 className="text-base font-semibold text-stone-800">지출 추가</h2>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
        {/* 제목 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">제목 *</label>
          <input
            type="text"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder="예: 저녁 식사"
            value={title}
            onChange={(e) => { setTitle(e.target.value); setError(""); }}
          />
        </div>

        {/* 카테고리 + 날짜 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1 block">카테고리 *</label>
            <select
              className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof CATEGORIES[number])}
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1 block">날짜 *</label>
            <input
              type="date"
              className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              value={date}
              onChange={(e) => { setDate(e.target.value); setError(""); }}
            />
          </div>
        </div>

        {/* 금액 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">금액 (USDC) *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 tabular-nums"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => { setAmountStr(e.target.value); setError(""); }}
          />
        </div>

        {/* 결제 방식 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">결제 방식 *</label>
          <div className="space-y-1.5">
            {PAYMENT_FLOWS.map((pf) => (
              <label key={pf.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="paymentFlow"
                  value={pf.value}
                  checked={paymentFlow === pf.value}
                  onChange={() => setPaymentFlow(pf.value)}
                  className="accent-indigo-600"
                />
                <span className="text-sm text-stone-700">{pf.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* 분담 대상 */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-stone-600">분담 대상 *</label>
            <button
              onClick={() => setUseEqualSplit((v) => !v)}
              className="text-xs text-indigo-600 hover:underline"
            >
              {useEqualSplit ? "직접 입력으로 전환" : "균등 분배로 전환"}
            </button>
          </div>
          <div className="space-y-1.5">
            {trip.participants.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedParticipants.has(p.id)}
                  onChange={() => toggleParticipant(p.id)}
                  className="accent-indigo-600"
                  id={`p-${p.id}`}
                />
                <label htmlFor={`p-${p.id}`} className="text-sm text-stone-700 flex-1 cursor-pointer">
                  {p.name}{p.id === currentUserId ? " (나)" : ""}
                </label>
                {!useEqualSplit && selectedParticipants.has(p.id) && (
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="w-28 border border-stone-200 rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    placeholder="0.00"
                    value={customShares[p.id] ?? ""}
                    onChange={(e) => setCustomShares((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                )}
                {useEqualSplit && selectedParticipants.has(p.id) && totalParsed != null && totalParsed > 0n && (
                  <span className="text-xs tabular-nums text-stone-500 w-24 text-right">
                    {fmtUsdc(shares.find((s) => s.participantId === p.id)?.amount ?? 0n)} USDC
                  </span>
                )}
              </div>
            ))}
          </div>
          {totalParsed != null && totalParsed > 0n && (
            <div className={`mt-2 text-xs px-3 py-1.5 rounded-lg ${isSharesValid ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
              분담 합계: {fmtUsdc(sharesSum)} / 총액: {fmtUsdc(totalParsed)}
              {isSharesValid ? " ✓" : ` (차이: ${fmtUsdc(totalParsed - sharesSum)})`}
            </div>
          )}
        </div>

        {/* 메모 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">메모 (선택)</label>
          <input
            type="text"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder="영수증 메모, 현지 금액 등"
            value={receiptNote}
            onChange={(e) => setReceiptNote(e.target.value)}
          />
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        <button
          onClick={() => { void handleSubmit(); }}
          disabled={submitting}
          className="w-full py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-indigo-700 transition-colors"
        >
          {submitting ? "등록 중…" : "지출 등록"}
        </button>
      </div>
    </div>
  );
}

// ─── 지출 상세 / 승인 뷰 ────────────────────────────────────────────────────

function ExpenseDetail({
  expense,
  trip,
  currentUserId,
  isAdmin,
  dbTripId,
  onBack,
  onExpenseReload,
}: {
  expense: Expense;
  trip: Trip;
  currentUserId: ParticipantId;
  isAdmin: boolean;
  dbTripId: string;
  onBack: () => void;
  onTripUpdate: (t: Trip) => void;
  onExpenseReload: () => void;
}) {
  const activeVer = getActiveVersion(expense);
  const [editShares, setEditShares] = useState<ShareEntry[]>(
    activeVer?.shares.map((s) => ({ ...s })) ?? []
  );
  const [editReason, setEditReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const totalAmount = expense.totalAmount;
  const sharesSum = editShares.reduce((sum, s) => sum + s.amount, 0n);
  const isSharesValid = validateShares(editShares, totalAmount);
  const diff = totalAmount - sharesSum;

  function updateShare(pid: ParticipantId, val: string) {
    const parsed = parseUsdcInput(val);
    setEditShares((prev) =>
      prev.map((s) => (s.participantId === pid ? { ...s, amount: parsed ?? 0n } : s))
    );
  }

  async function handleApprove() {
    setSubmitting(true);
    setActionMsg(null);
    try {
      await approveExpense(dbTripId, expense.id, { action: "승인" });
      setActionMsg({ type: "ok", text: "승인이 기록됐습니다." });
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : "승인 실패" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!rejectReason.trim()) return;
    setSubmitting(true);
    setActionMsg(null);
    try {
      await approveExpense(dbTripId, expense.id, { action: "수정요청", reason: rejectReason });
      setActionMsg({ type: "ok", text: "수정 요청이 접수됐습니다." });
      setRejectReason("");
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : "수정 요청 실패" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdminEdit() {
    if (!isSharesValid || !editReason.trim()) return;
    setSubmitting(true);
    setActionMsg(null);
    try {
      await approveExpense(dbTripId, expense.id, {
        action: "수정요청",
        reason: editReason,
        newShares: editShares.map((s) => ({
          address: trip.participants.find((p) => p.id === s.participantId)?.address ?? s.participantId,
          amountUsdc: s.amount.toString(),
        })),
      });
      setActionMsg({ type: "ok", text: "수정안이 제출됐습니다. 참여자 전원 재승인 필요." });
      setEditReason("");
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : "수정안 제출 실패" });
    } finally {
      setSubmitting(false);
    }
  }

  const myApproval = activeVer?.approvals.find((a) => a.participantId === currentUserId);
  const hasApproved = myApproval?.action === "승인";
  const hasRejected = myApproval?.action === "수정요청";
  const isConfirmed = activeVer?.status === "확정";
  const approvedCount = activeVer?.approvals.filter(
    (a) => expense.participants.includes(a.participantId) && a.action === "승인"
  ).length ?? 0;
  const totalParticipants = expense.participants.length;

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-stone-500 hover:text-stone-700"
      >
        ← 지출 목록으로
      </button>

      {/* 기본 정보 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-stone-800">{expense.title}</h3>
            <p className="text-xs text-stone-400 mt-1">
              {expense.date.slice(0, 10)} · {expense.category} · 결제자:{" "}
              {trip.participants.find((p) => p.id === expense.paidBy)?.name}
            </p>
            {expense.localCurrency && (
              <p className="text-xs text-stone-400">
                현지: {expense.localCurrency} {expense.localAmount?.toLocaleString()}
              </p>
            )}
            {expense.receiptNote && (
              <p className="text-xs text-stone-400 mt-1">
                메모: {expense.receiptNote}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xl font-bold tabular-nums text-stone-800">
              {fmtUsdc(expense.totalAmount)} USDC
            </p>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                isConfirmed ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
              }`}
            >
              v{expense.currentVersion} · {activeVer?.status}
            </span>
          </div>
        </div>
      </div>

      {/* 분담 현황 표 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-stone-700">참여자별 분담 현황</h3>
          <span className="text-xs text-stone-400">승인 {approvedCount}/{totalParticipants}명</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-stone-400 border-b border-stone-100">
              <th className="text-left py-1.5 font-medium">참여자</th>
              <th className="text-right py-1.5 font-medium">부담액</th>
              <th className="text-right py-1.5 font-medium">비율</th>
              <th className="text-right py-1.5 font-medium">승인 상태</th>
            </tr>
          </thead>
          <tbody>
            {activeVer?.shares
              .filter((s) => expense.participants.includes(s.participantId))
              .map((s) => {
                const appr = activeVer.approvals.find((a) => a.participantId === s.participantId);
                const ratio =
                  expense.totalAmount > 0n
                    ? (Number((s.amount * 1000n) / expense.totalAmount) / 10).toFixed(1)
                    : "0.0";
                const name =
                  trip.participants.find((p) => p.id === s.participantId)?.name ?? s.participantId;
                return (
                  <tr
                    key={s.participantId}
                    className={`border-b border-stone-50 ${s.participantId === currentUserId ? "bg-indigo-50/40" : ""}`}
                  >
                    <td className="py-2 text-stone-700 font-medium">
                      {name}
                      {s.participantId === currentUserId && (
                        <span className="ml-1 text-xs text-indigo-600">(나)</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-stone-800 font-semibold">
                      {fmtUsdc(s.amount)} USDC
                    </td>
                    <td className="py-2 text-right tabular-nums text-stone-500 text-xs">{ratio}%</td>
                    <td className="py-2 text-right">
                      {appr?.action === "승인" ? (
                        <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                          승인 ✓
                        </span>
                      ) : appr?.action === "수정요청" ? (
                        <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                          수정 요청
                        </span>
                      ) : (
                        <span className="text-xs bg-stone-100 text-stone-500 px-2 py-0.5 rounded-full">
                          미응답
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* 관리자 분담 수정안 제출 (서버 저장) */}
      {isAdmin && !isConfirmed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <h3 className="text-sm font-semibold text-stone-700 mb-1">
            분담액 수정안 제출
            <span className="ml-2 text-xs font-normal text-stone-400">(관리자 전용)</span>
          </h3>
          <p className="text-xs text-stone-400 mb-3">
            수정 제출 시 기존 모든 승인이 초기화되고 전원 재승인이 필요합니다.
          </p>
          <div className="space-y-2 mb-3">
            {editShares
              .filter((s) => expense.participants.includes(s.participantId))
              .map((s) => {
                const name =
                  trip.participants.find((p) => p.id === s.participantId)?.name ?? s.participantId;
                return (
                  <div key={s.participantId} className="flex items-center gap-2">
                    <span className="text-sm text-stone-600 w-20 shrink-0">{name}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="flex-1 border border-stone-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 tabular-nums"
                      value={toDisplayNumber(s.amount)}
                      onChange={(e) => updateShare(s.participantId, e.target.value)}
                    />
                    <span className="text-xs text-stone-400 shrink-0">USDC</span>
                  </div>
                );
              })}
          </div>
          <div
            className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg mb-3 ${
              isSharesValid ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            <span>
              분담 합계: <strong className="tabular-nums">{fmtUsdc(sharesSum)} USDC</strong>
            </span>
            <span>
              {isSharesValid ? "✓ 일치" : `⚠ 차이: ${diff > 0n ? "+" : ""}${fmtUsdc(diff)} USDC`}
            </span>
          </div>
          <input
            type="text"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 mb-2"
            placeholder="수정 이유 (필수)"
            value={editReason}
            onChange={(e) => { setEditReason(e.target.value); setActionMsg(null); }}
          />
          <button
            onClick={() => { void handleAdminEdit(); }}
            disabled={!isSharesValid || !editReason.trim() || submitting}
            className="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-indigo-700 transition-colors"
          >
            {submitting ? "제출 중…" : "수정안 제출 (전원 재승인 필요)"}
          </button>
        </div>
      )}

      {/* 참여자 승인 / 수정요청 (서버 저장) */}
      {!isConfirmed && activeVer?.status === "승인대기" && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <h3 className="text-sm font-semibold text-stone-700 mb-3">내 승인 · 수정 요청</h3>

          {hasApproved && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-700">
              이미 승인하셨습니다.
            </div>
          )}
          {hasRejected && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">
              수정 요청을 보냈습니다. 관리자의 재제출을 기다리세요.
            </div>
          )}
          {!hasApproved && !hasRejected && (
            <div className="space-y-3">
              <button
                onClick={() => { void handleApprove(); }}
                disabled={submitting}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
              >
                {submitting ? "처리 중…" : "분담안 승인"}
              </button>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300"
                  placeholder="수정 요청 사유 (필수)"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
                <button
                  onClick={() => { void handleReject(); }}
                  disabled={!rejectReason.trim() || submitting}
                  className="px-4 py-2 bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-rose-200 transition-colors whitespace-nowrap"
                >
                  수정 요청
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 환불 처리 — 서버 미지원 (비활성화) */}
      {isAdmin && isConfirmed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4 opacity-60">
          <h3 className="text-sm font-semibold text-stone-500 mb-1">환불 처리</h3>
          <p className="text-xs text-stone-400">
            서버 미지원: 환불 API가 없어 현재 비활성화됩니다.
          </p>
        </div>
      )}

      {/* 피드백 */}
      {actionMsg && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            actionMsg.type === "ok"
              ? "bg-emerald-50 border border-emerald-200 text-emerald-700"
              : "bg-rose-50 border border-rose-200 text-rose-700"
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      {/* 버전 이력 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-stone-700">버전 수정 이력</h3>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="text-xs text-indigo-600 hover:underline"
          >
            {showHistory ? "접기" : `${expense.versions.length}개 버전 펼치기`}
          </button>
        </div>
        {showHistory && (
          <div className="space-y-3">
            {[...expense.versions].reverse().map((v: ExpenseVersion) => (
              <div
                key={v.version}
                className={`p-3 rounded-lg border ${
                  v.version === expense.currentVersion
                    ? "border-indigo-200 bg-indigo-50/40"
                    : "border-stone-100 bg-stone-50"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-stone-600">
                    v{v.version}
                    {v.version === expense.currentVersion && (
                      <span className="ml-1 text-indigo-600">(현재)</span>
                    )}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      v.status === "확정"
                        ? "bg-emerald-100 text-emerald-700"
                        : v.status === "취소됨"
                        ? "bg-stone-100 text-stone-400"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {v.status}
                  </span>
                </div>
                <p className="text-xs text-stone-500">
                  제출자: {trip.participants.find((p) => p.id === v.proposedBy)?.name} ·{" "}
                  {v.proposedAt.slice(0, 16).replace("T", " ")}
                </p>
                <p className="text-xs text-stone-500 mt-0.5">사유: {v.reason}</p>
                <div className="mt-2 flex gap-1 flex-wrap">
                  {v.shares
                    .filter((s) => expense.participants.includes(s.participantId))
                    .map((s) => (
                      <span
                        key={s.participantId}
                        className="text-xs bg-white border border-stone-200 px-2 py-0.5 rounded-full tabular-nums"
                      >
                        {s.participantId}: {fmtUsdc(s.amount)}
                      </span>
                    ))}
                </div>
                <div className="mt-2 space-y-0.5">
                  {v.approvals
                    .filter((a) => expense.participants.includes(a.participantId))
                    .map((a) => (
                      <div key={a.participantId} className="flex items-center gap-2 text-xs">
                        <span className="text-stone-500 w-20">
                          {trip.participants.find((p) => p.id === a.participantId)?.name?.split(" ")[0]}
                        </span>
                        {a.action === "승인" ? (
                          <span className="text-emerald-600">
                            ✓ 승인 {a.approvedAt?.slice(0, 16).replace("T", " ")}
                          </span>
                        ) : a.action === "수정요청" ? (
                          <span className="text-rose-600">✗ 수정요청</span>
                        ) : (
                          <span className="text-stone-400">미응답</span>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
