import type { ParticipantSummary, Participant } from "../types";
import { fmtUsdc } from "../calculations";

interface Props {
  participant: Participant;
  summary: ParticipantSummary;
}

export default function TopSummaryBar({ participant, summary }: Props) {
  const { depositedAmount, confirmedBurden, pendingBurden, netBalance } = summary;

  const netSign = netBalance >= 0n ? "+" : "-";
  const netAbs = netBalance < 0n ? -netBalance : netBalance;
  const netLabel = netBalance >= 0n ? "돌려받을 금액" : "추가 납부 필요";
  const netColor = netBalance >= 0n ? "text-emerald-700" : "text-rose-600";

  return (
    <div className="bg-white border-b border-stone-200 px-4 py-3">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-stone-500 font-medium">
            기준: <strong className="text-stone-700">{participant.name}</strong>
          </span>
          {pendingBurden > 0n && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
              승인 대기 지출 있음
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {/* 내가 낸 돈 */}
          <div className="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <p className="text-xs text-stone-500 mb-0.5">내가 낸 돈</p>
            <p className="text-lg font-bold text-stone-800 tabular-nums">
              {fmtUsdc(depositedAmount)} <span className="text-xs font-normal text-stone-500">USDC</span>
            </p>
          </div>

          {/* 내가 부담한 돈 */}
          <div className="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <p className="text-xs text-stone-500 mb-0.5">내가 부담한 돈</p>
            <p className="text-lg font-bold text-stone-800 tabular-nums">
              {fmtUsdc(confirmedBurden)} <span className="text-xs font-normal text-stone-500">USDC</span>
            </p>
            {pendingBurden > 0n && (
              <p className="text-xs text-amber-600 tabular-nums mt-0.5">
                + 대기 {fmtUsdc(pendingBurden)} USDC
              </p>
            )}
          </div>

          {/* 차액 */}
          <div
            className={`rounded-lg p-3 border ${
              netBalance >= 0
                ? "bg-emerald-50 border-emerald-200"
                : "bg-rose-50 border-rose-200"
            }`}
          >
            <p className="text-xs text-stone-500 mb-0.5">{netLabel}</p>
            <p className={`text-lg font-bold tabular-nums ${netColor}`}>
              {netSign}{fmtUsdc(netAbs)} <span className="text-xs font-normal text-stone-500">USDC</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
