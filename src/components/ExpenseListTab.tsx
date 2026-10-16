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
  applyProportionalRefund,
  applyFullRefund,
  parseUsdcInput,
  toDisplayNumber,
} from "../calculations";

interface Props {
  trip: Trip;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
}

type ViewMode = "list" | "detail";

export default function ExpenseListTab({ trip, currentUserId, onTripUpdate }: Props) {
  const [selectedExpenseId, setSelectedExpenseId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  const isAdmin = trip.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;

  function selectExpense(id: string) {
    setSelectedExpenseId(id);
    setViewMode("detail");
  }

  function backToList() {
    setViewMode("list");
    setSelectedExpenseId(null);
  }

  const selectedExpense = trip.expenses.find((e) => e.id === selectedExpenseId);

  if (viewMode === "detail" && selectedExpense) {
    return (
      <ExpenseDetail
        expense={selectedExpense}
        trip={trip}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onBack={backToList}
        onTripUpdate={onTripUpdate}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* 필터 행 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-stone-500">총 {trip.expenses.length}건</span>
        <span className="text-xs text-stone-400">
          확정 {trip.expenses.filter(isExpenseConfirmed).length}건 ·
          대기 {trip.expenses.filter(isExpensePending).length}건
        </span>
      </div>

      {trip.expenses.length === 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-stone-400 text-sm">등록된 지출이 없습니다.</p>
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
                  v{exp.currentVersion} ·{" "}
                  {exp.participants.length}명 참여
                </p>
              </div>
            </div>

            {/* 분담 미니 뷰 */}
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

// ─── 지출 상세 / 승인 뷰 ──────────────────────────────────────────────────────

function ExpenseDetail({
  expense,
  trip,
  currentUserId,
  isAdmin,
  onBack,
  onTripUpdate,
}: {
  expense: Expense;
  trip: Trip;
  currentUserId: ParticipantId;
  isAdmin: boolean;
  onBack: () => void;
  onTripUpdate: (t: Trip) => void;
}) {
  const activeVer = getActiveVersion(expense);
  const [editShares, setEditShares] = useState<ShareEntry[]>(
    activeVer?.shares.map((s) => ({ ...s })) ?? []
  );
  const [editReason, setEditReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [editMsg, setEditMsg] = useState("");
  const [showRefund, setShowRefund] = useState(false);
  const [refundAmt, setRefundAmt] = useState("");
  const [refundMsg, setRefundMsg] = useState("");
  const [showHistory, setShowHistory] = useState(false);

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

  function updateExpenseInTrip(updatedExp: Expense) {
    onTripUpdate({
      ...trip,
      expenses: trip.expenses.map((e) => (e.id === updatedExp.id ? updatedExp : e)),
    });
  }

  function submitEdit() {
    if (!isSharesValid) {
      setEditMsg(`분담액 합계(${fmtUsdc(sharesSum)})와 지출 총액(${fmtUsdc(totalAmount)})이 맞지 않습니다.`);
      return;
    }
    if (!editReason.trim()) {
      setEditMsg("수정 이유를 입력해주세요.");
      return;
    }
    const newVersion = expense.currentVersion + 1;
    const updatedVersions = expense.versions.map((v) =>
      v.version === expense.currentVersion ? { ...v, status: "취소됨" as const } : v
    );
    const newVer: ExpenseVersion = {
      version: newVersion,
      shares: editShares,
      proposedBy: currentUserId,
      proposedAt: new Date().toISOString(),
      reason: editReason,
      approvals: expense.participants.map((pid) => ({
        participantId: pid,
        approvedAt: null,
        action: null,
      })),
      status: "승인대기",
    };
    updateExpenseInTrip({
      ...expense,
      currentVersion: newVersion,
      versions: [...updatedVersions, newVer],
    });
    setEditMsg("수정안이 제출되었습니다. 참여자 전원의 승인이 필요합니다.");
    setEditReason("");
  }

  function handleApprove() {
    const updatedVersions = expense.versions.map((v) => {
      if (v.version !== expense.currentVersion) return v;
      const newApprovals = v.approvals.map((a) =>
        a.participantId === currentUserId
          ? { ...a, action: "승인" as const, approvedAt: new Date().toISOString() }
          : a
      );
      // 전원 승인이면 확정
      const allApproved = newApprovals
        .filter((a) => expense.participants.includes(a.participantId))
        .every((a) => a.action === "승인");
      return { ...v, approvals: newApprovals, status: allApproved ? ("확정" as const) : v.status };
    });
    updateExpenseInTrip({ ...expense, versions: updatedVersions });
  }

  function handleReject() {
    if (!rejectReason.trim()) return;
    const updatedVersions = expense.versions.map((v) => {
      if (v.version !== expense.currentVersion) return v;
      const newApprovals = v.approvals.map((a) =>
        a.participantId === currentUserId
          ? { ...a, action: "수정요청" as const, approvedAt: new Date().toISOString(), reason: rejectReason }
          : a
      );
      return { ...v, approvals: newApprovals, status: "수정안투표중" as const };
    });
    updateExpenseInTrip({ ...expense, versions: updatedVersions });
    setRejectReason("");
  }

  function handleFullRefund() {
    updateExpenseInTrip(applyFullRefund(expense));
    setRefundMsg("전액 환불 처리 완료. 새로운 버전의 승인이 필요합니다.");
  }

  function handlePartialRefund() {
    const amt = parseUsdcInput(refundAmt);
    if (!amt || amt <= 0n || amt >= expense.totalAmount) {
      setRefundMsg("올바른 부분 환불 금액을 입력해주세요 (0 < 금액 < 총 지출액).");
      return;
    }
    updateExpenseInTrip(applyProportionalRefund(expense, amt));
    setRefundMsg(`${fmtUsdc(amt)} USDC 부분 환불 처리 완료 (비율 자동 조정). 새 버전의 승인이 필요합니다.`);
    setRefundAmt("");
  }

  const myApproval = activeVer?.approvals.find((a) => a.participantId === currentUserId);
  const hasApproved = myApproval?.action === "승인";
  const hasRejected = myApproval?.action === "수정요청";
  const isConfirmed = activeVer?.status === "확정";

  // 승인한 참여자 수
  const approvedCount = activeVer?.approvals.filter(
    (a) => expense.participants.includes(a.participantId) && a.action === "승인"
  ).length ?? 0;
  const totalParticipants = expense.participants.length;

  return (
    <div className="space-y-4">
      {/* 뒤로 가기 */}
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
                영수증 메모: {expense.receiptNote}
                <span className="ml-1 text-amber-600">(수동 기록)</span>
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xl font-bold tabular-nums text-stone-800">
              {fmtUsdc(expense.totalAmount)} USDC
            </p>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                isConfirmed
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
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
          <span className="text-xs text-stone-400">
            승인 {approvedCount}/{totalParticipants}명
          </span>
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
                const ratio = expense.totalAmount > 0n ? (Number((s.amount * 1000n) / expense.totalAmount) / 10).toFixed(1) : "0.0";
                const name = trip.participants.find((p) => p.id === s.participantId)?.name ?? s.participantId;
                return (
                  <tr
                    key={s.participantId}
                    className={`border-b border-stone-50 ${s.participantId === currentUserId ? "bg-indigo-50/40" : ""}`}
                  >
                    <td className="py-2 text-stone-700 font-medium">
                      {name}
                      {s.participantId === currentUserId && <span className="ml-1 text-xs text-indigo-600">(나)</span>}
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
                        <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full" title={appr.reason}>
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
          <tfoot>
            <tr className="border-t border-stone-200">
              <td className="py-2 text-sm font-semibold text-stone-700">합계</td>
              <td className="py-2 text-right tabular-nums text-sm font-bold text-stone-800">
                {fmtUsdc(activeVer?.shares.filter(s=>expense.participants.includes(s.participantId)).reduce((s,e)=>s+e.amount,0n) ?? 0n)} USDC
              </td>
              <td colSpan={2} className="py-2 text-right text-xs text-stone-400">
                (지출 총액 {fmtUsdc(expense.totalAmount)} USDC)
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 관리자 분담 수정 */}
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
                const name = trip.participants.find((p) => p.id === s.participantId)?.name ?? s.participantId;
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

          {/* 합계 검증 */}
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
            onChange={(e) => { setEditReason(e.target.value); setEditMsg(""); }}
          />
          <button
            onClick={submitEdit}
            disabled={!isSharesValid}
            className="w-full py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-indigo-700 transition-colors"
          >
            수정안 제출 (전원 재승인 필요)
          </button>
          {editMsg && <p className="text-xs mt-1.5 text-stone-600">{editMsg}</p>}
        </div>
      )}

      {/* 참여자 승인/수정요청 */}
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
                onClick={handleApprove}
                className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
              >
                분담안 승인
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
                  onClick={handleReject}
                  disabled={!rejectReason.trim()}
                  className="px-4 py-2 bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-sm font-medium disabled:opacity-40 hover:bg-rose-200 transition-colors whitespace-nowrap"
                >
                  수정 요청
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 환불 처리 (관리자 전용, 확정된 지출) */}
      {isAdmin && isConfirmed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-stone-700">환불 처리</h3>
            <button
              onClick={() => setShowRefund(!showRefund)}
              className="text-xs text-indigo-600 hover:underline"
            >
              {showRefund ? "닫기" : "환불 처리하기"}
            </button>
          </div>

          {showRefund && (
            <div className="space-y-3">
              <div className="bg-amber-50 rounded-lg p-3 text-xs text-amber-700">
                <strong>전액 환불</strong>: 모든 참여자의 부담액이 0으로 되돌아갑니다.<br />
                <strong>부분 환불</strong>: 원래 분담 비율에 따라 자동으로 줄어듭니다.<br />
                환불 처리 후 새 버전의 전원 승인이 필요합니다.
              </div>
              <button
                onClick={handleFullRefund}
                className="w-full py-2 border border-rose-200 text-rose-700 rounded-lg text-sm font-medium hover:bg-rose-50 transition-colors"
              >
                전액 환불 ({fmtUsdc(expense.totalAmount)} USDC → 각 참여자 0 USDC)
              </button>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="flex-1 border border-stone-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  placeholder="부분 환불 금액 (USDC)"
                  value={refundAmt}
                  onChange={(e) => { setRefundAmt(e.target.value); setRefundMsg(""); }}
                />
                <button
                  onClick={handlePartialRefund}
                  className="px-4 py-2 bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-sm font-medium hover:bg-indigo-200 transition-colors whitespace-nowrap"
                >
                  비율 환불
                </button>
              </div>
              {refundMsg && <p className="text-xs text-stone-600">{refundMsg}</p>}
            </div>
          )}
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
            {[...expense.versions].reverse().map((v) => (
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

                {/* 분담 */}
                <div className="mt-2 flex gap-1 flex-wrap">
                  {v.shares
                    .filter((s) => expense.participants.includes(s.participantId))
                    .map((s) => (
                      <span key={s.participantId} className="text-xs bg-white border border-stone-200 px-2 py-0.5 rounded-full tabular-nums">
                        {s.participantId}: {fmtUsdc(s.amount)}
                      </span>
                    ))}
                </div>

                {/* 승인 타임라인 */}
                <div className="mt-2 space-y-0.5">
                  {v.approvals
                    .filter((a) => expense.participants.includes(a.participantId))
                    .map((a) => (
                      <div key={a.participantId} className="flex items-center gap-2 text-xs">
                        <span className="text-stone-500 w-20">
                          {trip.participants.find((p) => p.id === a.participantId)?.name?.split(" ")[0]}
                        </span>
                        {a.action === "승인" ? (
                          <span className="text-emerald-600">✓ 승인 {a.approvedAt?.slice(0, 16).replace("T", " ")}</span>
                        ) : a.action === "수정요청" ? (
                          <span className="text-rose-600">✗ 수정요청 — {a.reason}</span>
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
