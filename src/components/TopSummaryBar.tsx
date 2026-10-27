import type { ParticipantSummary, Participant } from "../types";
import { fmtUsdc } from "../calculations";
import { useI18n } from "../i18n";

interface Props {
  participant: Participant;
  summary: ParticipantSummary;
}

export default function TopSummaryBar({ participant, summary }: Props) {
  const { t } = useI18n();
  const { depositedAmount, confirmedBurden, pendingBurden, netBalance } = summary;

  const netSign = netBalance >= 0n ? "+" : "-";
  const netAbs = netBalance < 0n ? -netBalance : netBalance;
  const netLabel = netBalance >= 0n ? t("surplus") : t("deficit");
  const netColor = netBalance >= 0n ? "text-emerald-700" : "text-rose-600";

  return (
    <div className="bg-white border-b border-stone-200 px-4 py-3">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-stone-500 font-medium">
            <strong className="text-stone-700">{participant.name}</strong>
          </span>
          {pendingBurden > 0n && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
              {t("status_pending_approval")}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {/* 내가 낸 돈 */}
          <div className="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <p className="text-xs text-stone-500 mb-0.5">{t("actual_deposit")}</p>
            <p className="text-lg font-bold text-stone-800 tabular-nums">
              {fmtUsdc(depositedAmount)} <span className="text-xs font-normal text-stone-500">USDC</span>
            </p>
          </div>

          {/* 내가 부담한 돈 */}
          <div className="bg-stone-50 rounded-lg p-3 border border-stone-200">
            <p className="text-xs text-stone-500 mb-0.5">{t("my_burden")}</p>
            <p className="text-lg font-bold text-stone-800 tabular-nums">
              {fmtUsdc(confirmedBurden)} <span className="text-xs font-normal text-stone-500">USDC</span>
            </p>
            {pendingBurden > 0n && (
              <p className="text-xs text-amber-600 tabular-nums mt-0.5">
                + {t("status_pending_approval")} {fmtUsdc(pendingBurden)} USDC
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
