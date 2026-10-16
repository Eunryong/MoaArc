import type { Trip, ParticipantId } from "../types";
import {
  calcParticipantSummary,
  getBurdenByCategory,
  fmtUsdc,
  isExpensePending,
  getParticipantShare,
  isExpenseConfirmed,
} from "../calculations";

interface Props {
  trip: Trip;
  currentUserId: ParticipantId;
}

export default function MyExpensesTab({ trip, currentUserId }: Props) {
  const summary = calcParticipantSummary(trip, currentUserId);
  const categoryBurden = getBurdenByCategory(trip, currentUserId);

  // 나와 관련된 대기 지출
  const pendingForMe = trip.expenses.filter(
    (e) => isExpensePending(e) && e.participants.includes(currentUserId)
  );

  // 즉시 출금 가능 금액 = 실제 잔액 기준으로 내가 받을 부분
  // (환급 예정액은 전원 승인 전까지 즉시 출금 불가)
  const immediatelyWithdrawable = 0n; // 전원 미승인 상태이므로 0

  return (
    <div className="space-y-4">
      {/* 내 수지 요약 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">내 정산 요약</h3>
        <div className="space-y-2">
          <SummaryRow
            label="실제 입금 완료액"
            value={`${fmtUsdc(summary.depositedAmount)} USDC`}
            sub={
              summary.plannedDeposit > summary.depositedAmount
                ? `입금 예정액 ${fmtUsdc(summary.plannedDeposit)} USDC (미입금 ${fmtUsdc(summary.plannedDeposit - summary.depositedAmount)} USDC)`
                : undefined
            }
          />
          <SummaryRow
            label="확정 부담액"
            value={`${fmtUsdc(summary.confirmedBurden)} USDC`}
            sub={
              summary.pendingBurden > 0
                ? `+ 승인 대기 ${fmtUsdc(summary.pendingBurden)} USDC (아직 미확정)`
                : undefined
            }
          />
          {summary.allocatedBudget > 0 && (
            <SummaryRow
              label="외부 결제지갑 미반납 공동자금"
              value={`${fmtUsdc(summary.allocatedBudget)} USDC`}
              warn
            />
          )}
          <div className="border-t border-stone-100 pt-2 mt-2">
            <SummaryRow
              label={summary.netBalance >= 0n ? "예상 환급액" : "추가 납부 필요"}
              value={`${summary.netBalance >= 0n ? "+" : "-"}${fmtUsdc(summary.netBalance < 0n ? -summary.netBalance : summary.netBalance)} USDC`}
              big
              positive={summary.netBalance >= 0n}
            />
            <p className="text-xs text-stone-400 mt-1">
              즉시 출금 가능: <strong className="text-stone-600">{fmtUsdc(immediatelyWithdrawable)} USDC</strong>
              <span className="ml-1">(최종 정산 전원 승인 후 수령 가능)</span>
            </p>
          </div>
        </div>
      </div>

      {/* 카테고리별 부담액 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">카테고리별 확정 부담액</h3>
        <div className="grid grid-cols-4 gap-2">
          {Object.entries(categoryBurden).map(([cat, amt]) => (
            <div key={cat} className="bg-stone-50 rounded-lg p-3 text-center">
              <p className="text-xs text-stone-500 mb-1">{cat}</p>
              <p className="text-sm font-semibold tabular-nums text-stone-800">
                {fmtUsdc(amt)}
              </p>
              <p className="text-xs text-stone-400">USDC</p>
            </div>
          ))}
        </div>
      </div>

      {/* 나와 관련된 대기 알림 */}
      {pendingForMe.length > 0 && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">
            내 승인 필요 지출 ({pendingForMe.length}건)
          </h3>
          <div className="space-y-2">
            {pendingForMe.map((exp) => {
              const myShare = getParticipantShare(exp, currentUserId);
              return (
                <div key={exp.id} className="bg-white rounded-lg p-3 border border-amber-100">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-stone-700">{exp.title}</p>
                    <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                      승인 대기
                    </span>
                  </div>
                  <p className="text-xs text-stone-500 mt-0.5">
                    내 부담액: <strong className="text-stone-700">{fmtUsdc(myShare)} USDC</strong>
                    {" "}/ 지출 합계 {fmtUsdc(exp.totalAmount)} USDC
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 내가 결제한 지출 목록 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">내가 결제한 지출</h3>
        {trip.expenses.filter((e) => e.paidBy === currentUserId).length === 0 ? (
          <p className="text-sm text-stone-400">내가 결제한 지출이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {trip.expenses
              .filter((e) => e.paidBy === currentUserId)
              .map((exp) => (
                <div key={exp.id} className="flex items-center justify-between py-2 border-b border-stone-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-stone-700">{exp.title}</p>
                    <p className="text-xs text-stone-400">
                      {exp.date.slice(0, 10)} · {exp.category}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums text-stone-800">
                      {fmtUsdc(exp.totalAmount)} USDC
                    </p>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        isExpenseConfirmed(exp)
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {isExpenseConfirmed(exp) ? "확정" : "대기"}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  sub,
  warn,
  big,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
  big?: boolean;
  positive?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between py-1.5 ${big ? "py-2" : ""}`}>
      <div>
        <p className={`text-sm ${warn ? "text-amber-700 font-medium" : "text-stone-600"}`}>{label}</p>
        {sub && <p className="text-xs text-stone-400 mt-0.5">{sub}</p>}
      </div>
      <p
        className={`font-semibold tabular-nums ${
          big
            ? positive
              ? "text-lg text-emerald-700"
              : "text-lg text-rose-600"
            : warn
            ? "text-amber-700"
            : "text-stone-800"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
