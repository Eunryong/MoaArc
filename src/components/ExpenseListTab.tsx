import { useState, useRef } from "react";
import { useI18n } from "../i18n";
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
  parsePositiveUsdc,
  parseOptionalUsdc,
  usdcInputProblem,
  formatUsdcExact,
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

// Server values — never translated
const CATEGORIES = ["식비", "숙박", "교통", "기타"] as const;
const PAYMENT_FLOWS = [
  { value: "personal_prepaid" },
  { value: "community_release" },
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
  const { t } = useI18n();
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
        <span className="text-xs text-stone-500">{trip.expenses.length} total</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">
            {t("status_confirmed")} {trip.expenses.filter(isExpenseConfirmed).length} ·
            {t("status_pending_approval")} {trip.expenses.filter(isExpensePending).length}
          </span>
          <button
            onClick={() => setViewMode("add")}
            className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            {t("add_expense_btn")}
          </button>
        </div>
      </div>

      {trip.expenses.length === 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-stone-400 text-sm">{t("no_expenses")}</p>
          <button
            onClick={() => setViewMode("add")}
            className="mt-3 text-sm text-indigo-600 hover:underline"
          >
            {t("add_expense_btn")} →
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
                    {activeVer?.status === "확정" ? t("status_confirmed")
                      : activeVer?.status === "승인대기" ? t("status_pending_approval")
                      : activeVer?.status === "수정안투표중" ? t("status_revision_vote")
                      : activeVer?.status === "취소됨" ? t("status_cancelled")
                      : t("status_unknown")}
                  </span>
                  <span className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full">
                    {exp.category}
                  </span>
                  {exp.refunds.length > 0 && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                      Refund ×{exp.refunds.length}
                    </span>
                  )}
                </div>
                <p className="text-sm font-semibold text-stone-800 mt-1.5">{exp.title}</p>
                <p className="text-xs text-stone-400 mt-0.5">
                  {exp.date.slice(0, 10)} ·
                  {t("payer_label")}: {trip.participants.find((p) => p.id === exp.paidBy)?.name}
                </p>
                {exp.localCurrency && (
                  <p className="text-xs text-stone-400">
                    Local: {exp.localCurrency} {exp.localAmount?.toLocaleString()}
                  </p>
                )}
              </div>
              <div className="text-right ml-3">
                <p className="text-base font-bold tabular-nums text-stone-800">
                  {fmtUsdc(exp.totalAmount)} USDC
                </p>
                <p className="text-xs text-stone-400 mt-0.5">
                  v{exp.currentVersion} · {exp.participants.length} participants
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
  const { t } = useI18n();
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
  // 필드별 인라인 오류 메시지
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"title" | "date" | "amount" | "participants" | "split", string>>>({});
  // 서버 오류 / 기타 폼 단위 오류
  const [formError, setFormError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const totalParsed = parseUsdcInput(amountStr);
  const amountProblem = usdcInputProblem(amountStr);

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
    return pids.map((pid) => {
      // 빈 칸 = 0. 잘못된 칸은 handleSubmit 에서 사전 거부되므로 여기서는 미리보기용으로 0 처리
      const parsed = parseOptionalUsdc(customShares[pid] ?? "");
      return { participantId: pid, amount: parsed.ok ? parsed.value : 0n };
    });
  }

  function toggleParticipant(pid: ParticipantId) {
    setSelectedParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
    setFieldErrors((prev) => ({ ...prev, participants: undefined, split: undefined }));
  }

  async function handleSubmit() {
    // 필드별 검증 — 첫 번째 실패에서 해당 필드에 포커스 후 중단
    if (!title.trim()) {
      setFieldErrors((prev) => ({ ...prev, title: t("err_title_required") }));
      titleRef.current?.focus();
      return;
    }
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      setFieldErrors((prev) => ({ ...prev, date: t("err_date_invalid") }));
      dateRef.current?.focus();
      return;
    }
    // 총액: 0~6자리 소수만 허용. 7자리 이상/지수 표기/음수는 서버 호출 전에 거부 (절사·반올림 없음)
    const totalCheck = parsePositiveUsdc(amountStr);
    if (!totalCheck.ok) {
      setFieldErrors((prev) => ({ ...prev, amount: t(totalCheck.key) }));
      amountRef.current?.focus();
      return;
    }
    const total = totalCheck.value;
    if (selectedParticipants.size === 0) {
      setFieldErrors((prev) => ({ ...prev, participants: t("err_no_participants") }));
      return;
    }

    // 직접 입력 분담액: 잘못된 칸(7자리 이상 소수 등)을 0 으로 취급하지 않고 명시적으로 거부
    if (!useEqualSplit) {
      for (const pid of selectedParticipants) {
        const problem = usdcInputProblem(customShares[pid] ?? "");
        if (problem) {
          setFieldErrors((prev) => ({ ...prev, split: t(problem) }));
          return;
        }
      }
    }

    const shares = computeShares();
    const sharesSum = shares.reduce((s, sh) => s + sh.amount, 0n);
    if (sharesSum !== total) {
      const msg = t("err_split_mismatch")
        .replace("{sum}", fmtUsdc(sharesSum))
        .replace("{total}", fmtUsdc(total));
      setFieldErrors((prev) => ({ ...prev, split: msg }));
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setFormError("");
    try {
      await addExpense(dbTripId, {
        title: title.trim(),
        category,
        date,
        totalUsdc: total.toString(),
        paymentFlow,
        receiptNote: receiptNote.trim() || undefined,
        shares: shares.map((s) => ({
          address: trip.participants.find((p) => p.id === s.participantId)?.address ?? s.participantId,
          amountUsdc: s.amount.toString(),
        })),
      });
      onSuccess();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : t("err_500"));
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
          {t("back_to_list")}
        </button>
        <h2 className="text-base font-semibold text-stone-800">{t("add_expense_form_title")}</h2>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 p-4 space-y-3">
        {/* 제목 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">{t("expense_title_label")} *</label>
          <input
            ref={titleRef}
            type="text"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${fieldErrors.title ? "border-rose-400" : "border-stone-200"}`}
            placeholder={t("expense_title_placeholder")}
            value={title}
            onChange={(e) => { setTitle(e.target.value); setFieldErrors((prev) => ({ ...prev, title: undefined })); }}
          />
          {fieldErrors.title && <p className="mt-1 text-xs text-rose-600">{fieldErrors.title}</p>}
        </div>

        {/* 카테고리 + 날짜 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1 block">{t("category_label")} *</label>
            <select
              className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof CATEGORIES[number])}
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-stone-600 mb-1 block">{t("date_label")} *</label>
            <input
              ref={dateRef}
              type="date"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${fieldErrors.date ? "border-rose-400" : "border-stone-200"}`}
              value={date}
              onChange={(e) => { setDate(e.target.value); setFieldErrors((prev) => ({ ...prev, date: undefined })); }}
            />
            {fieldErrors.date && <p className="mt-1 text-xs text-rose-600">{fieldErrors.date}</p>}
          </div>
        </div>

        {/* 금액 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">{t("amount_usdc_label")} *</label>
          <input
            ref={amountRef}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={!!amountProblem}
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 tabular-nums ${fieldErrors.amount ? "border-rose-400" : "border-stone-200"}`}
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => { setAmountStr(e.target.value); setFieldErrors((prev) => ({ ...prev, amount: undefined })); }}
          />
          {amountProblem && !fieldErrors.amount && <p className="mt-1 text-xs text-rose-600">{t(amountProblem)}</p>}
          {fieldErrors.amount && <p className="mt-1 text-xs text-rose-600">{fieldErrors.amount}</p>}
        </div>

        {/* 결제 방식 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">{t("payment_flow_label")} *</label>
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
                <span className="text-sm text-stone-700">
                  {pf.value === "personal_prepaid" ? t("payment_flow_personal") : t("payment_flow_community")}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 분담 대상 */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-stone-600">{t("participants_label")} *</label>
            <button
              onClick={() => setUseEqualSplit((v) => !v)}
              className="text-xs text-indigo-600 hover:underline"
            >
              {useEqualSplit ? t("split_switch_manual") : t("split_switch_equal")}
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
                  {p.name}{p.id === currentUserId ? ` (${t("me")})` : ""}
                </label>
                {!useEqualSplit && selectedParticipants.has(p.id) && (
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-invalid={!!usdcInputProblem(customShares[p.id] ?? "")}
                    className={`w-28 border rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-300 ${usdcInputProblem(customShares[p.id] ?? "") ? "border-rose-400" : "border-stone-200"}`}
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
          {fieldErrors.participants && (
            <p className="mt-1 text-xs text-rose-600">{fieldErrors.participants}</p>
          )}
          {totalParsed != null && totalParsed > 0n && (
            <div className={`mt-2 text-xs px-3 py-1.5 rounded-lg ${isSharesValid ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
              Split: {fmtUsdc(sharesSum)} / Total: {fmtUsdc(totalParsed)}
              {isSharesValid ? " ✓" : ` (diff: ${fmtUsdc(totalParsed - sharesSum)})`}
            </div>
          )}
          {fieldErrors.split && <p className="mt-1 text-xs text-rose-600">{fieldErrors.split}</p>}
        </div>

        {/* 메모 */}
        <div>
          <label className="text-xs font-medium text-stone-600 mb-1 block">{t("memo_optional_label")}</label>
          <input
            type="text"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            placeholder={t("memo_placeholder")}
            value={receiptNote}
            onChange={(e) => setReceiptNote(e.target.value)}
          />
        </div>

        {formError && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm text-rose-700">
            {formError}
          </div>
        )}

        <button
          onClick={() => { void handleSubmit(); }}
          disabled={submitting}
          className="w-full py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-indigo-700 transition-colors"
        >
          {submitting ? t("submitting") : t("submit_expense")}
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
  const { t } = useI18n();
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

  // 입력 문자열을 그대로 보관 (number 입력/Number 변환으로 값이 바뀌지 않도록). 빈 칸 = 0, 잘못된 칸은 제출 차단.
  const [shareInputs, setShareInputs] = useState<Record<string, string>>({});
  const hasShareProblem = editShares.some(
    (s) => usdcInputProblem(shareInputs[s.participantId] ?? "") !== null
  );

  function updateShare(pid: ParticipantId, val: string) {
    setShareInputs((prev) => ({ ...prev, [pid]: val }));
    const parsed = parseOptionalUsdc(val);
    setEditShares((prev) =>
      prev.map((s) => (s.participantId === pid ? { ...s, amount: parsed.ok ? parsed.value : 0n } : s))
    );
  }

  async function handleApprove() {
    setSubmitting(true);
    setActionMsg(null);
    try {
      await approveExpense(dbTripId, expense.id, { action: "승인" });
      setActionMsg({ type: "ok", text: t("approve_success") });
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : t("approve_fail") });
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
      setActionMsg({ type: "ok", text: t("revision_request_success") });
      setRejectReason("");
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : t("revision_request_fail") });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAdminEdit() {
    if (!isSharesValid || hasShareProblem || !editReason.trim()) return;
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
      setActionMsg({ type: "ok", text: t("admin_edit_success") });
      setEditReason("");
      onExpenseReload();
    } catch (e: unknown) {
      setActionMsg({ type: "err", text: e instanceof Error ? e.message : t("admin_edit_fail") });
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
        {t("back_to_list")}
      </button>

      {/* 기본 정보 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-stone-800">{expense.title}</h3>
            <p className="text-xs text-stone-400 mt-1">
              {expense.date.slice(0, 10)} · {expense.category} · {t("payer_label")}:{" "}
              {trip.participants.find((p) => p.id === expense.paidBy)?.name}
            </p>
            {expense.localCurrency && (
              <p className="text-xs text-stone-400">
                Local: {expense.localCurrency} {expense.localAmount?.toLocaleString()}
              </p>
            )}
            {expense.receiptNote && (
              <p className="text-xs text-stone-400 mt-1">
                Note: {expense.receiptNote}
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
          <h3 className="text-sm font-semibold text-stone-700">{t("participants_split_status")}</h3>
          <span className="text-xs text-stone-400">{t("approval_count")} {approvedCount}/{totalParticipants}</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-stone-400 border-b border-stone-100">
              <th className="text-left py-1.5 font-medium">{t("col_participant")}</th>
              <th className="text-right py-1.5 font-medium">{t("col_share")}</th>
              <th className="text-right py-1.5 font-medium">{t("col_ratio")}</th>
              <th className="text-right py-1.5 font-medium">{t("col_approval")}</th>
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
                        <span className="ml-1 text-xs text-indigo-600">({t("me")})</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-stone-800 font-semibold">
                      {fmtUsdc(s.amount)} USDC
                    </td>
                    <td className="py-2 text-right tabular-nums text-stone-500 text-xs">{ratio}%</td>
                    <td className="py-2 text-right">
                      {appr?.action === "승인" ? (
                        <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                          {t("approved_label")} ✓
                        </span>
                      ) : appr?.action === "수정요청" ? (
                        <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                          {t("revision_requested_label")}
                        </span>
                      ) : (
                        <span className="text-xs bg-stone-100 text-stone-500 px-2 py-0.5 rounded-full">
                          {t("no_response_label")}
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
            {t("admin_edit_title")}
            <span className="ml-2 text-xs font-normal text-stone-400">({t("admin_only_badge")})</span>
          </h3>
          <p className="text-xs text-stone-400 mb-3">
            {t("admin_edit_desc")}
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
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-invalid={!!usdcInputProblem(shareInputs[s.participantId] ?? "")}
                      className={`flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 tabular-nums ${usdcInputProblem(shareInputs[s.participantId] ?? "") ? "border-rose-400" : "border-stone-200"}`}
                      value={shareInputs[s.participantId] ?? formatUsdcExact(s.amount)}
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
              Split: <strong className="tabular-nums">{fmtUsdc(sharesSum)} USDC</strong>
            </span>
            <span>
              {isSharesValid ? "✓ OK" : `⚠ diff: ${diff > 0n ? "+" : ""}${fmtUsdc(diff)} USDC`}
            </span>
          </div>
          <input
            type="text"
            className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 mb-2"
            placeholder={t("edit_reason_placeholder")}
            value={editReason}
            onChange={(e) => { setEditReason(e.target.value); setActionMsg(null); }}
          />
          <button
            onClick={() => { void handleAdminEdit(); }}
            disabled={!isSharesValid || hasShareProblem || !editReason.trim() || submitting}
            className="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-indigo-700 transition-colors"
          >
            {submitting ? t("submitting") : t("admin_submit_btn")}
          </button>
        </div>
      )}

      {/* 참여자 승인 / 수정요청 (서버 저장) */}
      {!isConfirmed && activeVer?.status === "승인대기" && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <h3 className="text-sm font-semibold text-stone-700 mb-3">{t("my_approval_title")}</h3>

          {hasApproved && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-700">
              {t("already_approved")}
            </div>
          )}
          {hasRejected && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">
              {t("revision_sent")}
            </div>
          )}
          {!hasApproved && !hasRejected && (
            <div className="space-y-3">
              <button
                onClick={() => { void handleApprove(); }}
                disabled={submitting}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-emerald-700 transition-colors"
              >
                {submitting ? t("submitting") : t("approve_btn")}
              </button>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300"
                  placeholder={t("revision_reason_placeholder")}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                />
                <button
                  onClick={() => { void handleReject(); }}
                  disabled={!rejectReason.trim() || submitting}
                  className="px-4 py-2 bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-rose-200 transition-colors whitespace-nowrap"
                >
                  {t("revision_request_btn")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 환불 처리 — 서버 미지원 (비활성화) */}
      {isAdmin && isConfirmed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4 opacity-60">
          <h3 className="text-sm font-semibold text-stone-500 mb-1">{t("refund_title")}</h3>
          <p className="text-xs text-stone-400">{t("refund_unavailable")}</p>
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
          <h3 className="text-sm font-semibold text-stone-700">{t("version_history_title")}</h3>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="text-xs text-indigo-600 hover:underline"
          >
            {showHistory ? t("collapse") : `${expense.versions.length} ${t("expand_versions")}`}
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
                      <span className="ml-1 text-indigo-600">({t("current_label")})</span>
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
                    {v.status === "확정" ? t("status_confirmed")
                      : v.status === "취소됨" ? t("status_cancelled")
                      : v.status === "승인대기" ? t("status_pending_approval")
                      : v.status}
                  </span>
                </div>
                <p className="text-xs text-stone-500">
                  {t("proposer_label")}: {trip.participants.find((p) => p.id === v.proposedBy)?.name} ·{" "}
                  {v.proposedAt.slice(0, 16).replace("T", " ")}
                </p>
                <p className="text-xs text-stone-500 mt-0.5">{t("reason_label")}: {v.reason}</p>
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
                            ✓ {t("approved_label")} {a.approvedAt?.slice(0, 16).replace("T", " ")}
                          </span>
                        ) : a.action === "수정요청" ? (
                          <span className="text-rose-600">✗ {t("revision_requested_label")}</span>
                        ) : (
                          <span className="text-stone-400">{t("no_response_label")}</span>
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
