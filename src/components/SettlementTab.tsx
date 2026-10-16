import { useState } from "react";
import type { Trip, ParticipantId, FinalSettlement } from "../types";
import {
  calcParticipantSummary,
  getPendingExpenseCount,
  getContractBalance,
  fmtUsdc,
  parseUsdcInput,
  toDisplayNumber,
} from "../calculations";
import { createEmptySettlement } from "../demoData";

interface Props {
  trip: Trip;
  currentUserId: ParticipantId;
  onTripUpdate: (t: Trip) => void;
  demoMode?: boolean;
  connectedAddress?: `0x${string}`;
}

export default function SettlementTab({ trip, currentUserId, onTripUpdate }: Props) {
  const isAdmin = trip.participants.find((p) => p.id === currentUserId)?.isAdmin ?? false;
  const pendingCount = getPendingExpenseCount(trip);
  const contractBalance = getContractBalance(trip);
  const [deficitInput, setDeficitInput] = useState<Record<ParticipantId, string>>({
    A: "", B: "", C: "", D: "",
  });
  const [claimMsg, setClaimMsg] = useState<Record<ParticipantId, string>>({
    A: "", B: "", C: "", D: "",
  });
  const [settleMsg, setSettleMsg] = useState("");

  // 각 참여자 요약 계산
  const summaries = trip.participants.map((p) => ({
    participant: p,
    summary: calcParticipantSummary(trip, p.id),
  }));

  const settlement = trip.settlement;

  // 전원 승인 여부
  const allApproved =
    settlement?.proposed &&
    settlement.approvals.length === trip.participants.length &&
    settlement.approvals.every((a) => a.approved);

  // 내 미납 부족분
  const myRequiredDeficit = settlement?.requiredDeficits[currentUserId] ?? 0n;
  const myPaidDeficit =
    trip.participants.find((p) => p.id === currentUserId)?.paidDeficit ?? 0n;
  const myDeficitRemaining = myRequiredDeficit - myPaidDeficit;

  // 모든 부족분 납입 완료 여부
  const allDeficitPaid = trip.participants.every((p) => {
    const required = settlement?.requiredDeficits[p.id] ?? 0n;
    return p.paidDeficit >= required;
  });

  // 예상 환급액 합계 (컨트랙트 잔액 일치 검증용)
  const totalRefunds: bigint = settlement
    ? Object.values(settlement.finalRefundAmounts).reduce((s: bigint, v: bigint) => s + v, 0n)
    : 0n;

  // 잔액 일치 여부 (부족분 납입 후, bigint 정수 비교)
  const balanceMatches = contractBalance === totalRefunds;

  function proposeSettlement() {
    if (pendingCount > 0) {
      setSettleMsg("미확정 지출이 남아 있어 최종 정산을 진행할 수 없습니다.");
      return;
    }
    // 간단히: 각 참여자의 예상 차액을 기반으로 정산안 생성
    const newSettlement: FinalSettlement = createEmptySettlement();
    for (const { participant, summary } of summaries) {
      if (summary.netBalance >= 0n) {
        newSettlement.finalRefundAmounts[participant.id] = summary.netBalance;
        newSettlement.requiredDeficits[participant.id] = 0n;
      } else {
        newSettlement.finalRefundAmounts[participant.id] = 0n;
        newSettlement.requiredDeficits[participant.id] = -summary.netBalance;
      }
    }
    newSettlement.proposed = true;
    newSettlement.proposedAt = new Date().toISOString();
    newSettlement.ledgerHash = `0x${Array.from({ length: 64 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("")}`;
    newSettlement.approvals = [];
    onTripUpdate({ ...trip, settlement: newSettlement });
    setSettleMsg("최종 정산안이 제출되었습니다. 참여자 전원의 확인이 필요합니다.");
  }

  function approveSettlement() {
    if (!settlement) return;
    const alreadyApproved = settlement.approvals.find((a) => a.participantId === currentUserId);
    if (alreadyApproved) return;
    const newApprovals = [
      ...settlement.approvals,
      { participantId: currentUserId, approved: true, approvedAt: new Date().toISOString() },
    ];
    onTripUpdate({
      ...trip,
      settlement: { ...settlement, approvals: newApprovals },
    });
  }

  function payDeficit(pid: ParticipantId) {
    if (!settlement) return;
    const amt = parseUsdcInput(deficitInput[pid] ?? "");
    if (!amt || amt <= 0n) return;
    const required = settlement.requiredDeficits[pid] ?? 0n;
    const alreadyPaid = trip.participants.find((p) => p.id === pid)?.paidDeficit ?? 0n;
    if (alreadyPaid + amt > required) {
      setClaimMsg({ ...claimMsg, [pid]: "필요 부족분을 초과합니다." });
      return;
    }
    const updatedParticipants = trip.participants.map((p) =>
      p.id === pid ? { ...p, paidDeficit: p.paidDeficit + amt } : p
    );
    onTripUpdate({ ...trip, participants: updatedParticipants });
    setDeficitInput({ ...deficitInput, [pid]: "" });
    setClaimMsg({ ...claimMsg, [pid]: `${fmtUsdc(amt)} USDC 납입 완료` });
  }

  function claimRefund(pid: ParticipantId) {
    if (!settlement || !allApproved || !allDeficitPaid || !balanceMatches) {
      setClaimMsg({ ...claimMsg, [pid]: "환급 조건이 충족되지 않았습니다." });
      return;
    }
    const refundAmt = settlement.finalRefundAmounts[pid] ?? 0n;
    const updatedParticipants = trip.participants.map((p) =>
      p.id === pid ? { ...p, refundClaimed: true } : p
    );
    onTripUpdate({ ...trip, participants: updatedParticipants });
    setClaimMsg({ ...claimMsg, [pid]: `${fmtUsdc(refundAmt)} USDC 수령 완료!` });
  }

  const myApproval = settlement?.approvals.find((a) => a.participantId === currentUserId);

  return (
    <div className="space-y-4">
      {/* 미처리 항목 체크리스트 */}
      {pendingCount > 0 && (
        <div className="bg-rose-50 rounded-xl border border-rose-200 p-4">
          <h3 className="text-sm font-semibold text-rose-700 mb-2">최종 정산 불가 — 미처리 항목</h3>
          <p className="text-sm text-rose-600">
            승인 대기 중인 지출이 {pendingCount}건 있습니다.
            모든 지출이 확정되어야 최종 정산이 가능합니다.
          </p>
        </div>
      )}

      {/* 참여자별 정산 표 */}
      <div className="bg-white rounded-xl border border-stone-200 p-4">
        <h3 className="text-sm font-semibold text-stone-700 mb-3">참여자별 정산 내역</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[540px]">
            <thead>
              <tr className="text-xs text-stone-400 border-b border-stone-100">
                <th className="text-left py-2 font-medium">참여자</th>
                <th className="text-right py-2 font-medium">납입액</th>
                <th className="text-right py-2 font-medium">확정 부담액</th>
                <th className="text-right py-2 font-medium">미반납 결제예산</th>
                <th className="text-right py-2 font-medium">최종 차액</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(({ participant, summary }) => {
                const isMe = participant.id === currentUserId;
                return (
                  <tr
                    key={participant.id}
                    className={`border-b border-stone-50 ${isMe ? "bg-indigo-50/40" : ""}`}
                  >
                    <td className="py-2.5 font-medium text-stone-700">
                      {participant.name}
                      {participant.isAdmin && (
                        <span className="ml-1 text-xs text-stone-400">(관리자)</span>
                      )}
                      {isMe && <span className="ml-1 text-xs text-indigo-600">(나)</span>}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-stone-700">
                      {fmtUsdc(summary.depositedAmount)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-stone-700">
                      {fmtUsdc(summary.confirmedBurden)}
                      {summary.pendingBurden > 0 && (
                        <div className="text-xs text-amber-500">
                          +{fmtUsdc(summary.pendingBurden)} 대기
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {summary.allocatedBudget > 0n ? (
                        <span className="text-amber-600 font-medium">
                          {fmtUsdc(summary.allocatedBudget)}
                        </span>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums font-semibold">
                      {summary.netBalance >= 0n ? (
                        <span className="text-emerald-700">+{fmtUsdc(summary.netBalance)}</span>
                      ) : (
                        <span className="text-rose-600">-{fmtUsdc(-summary.netBalance)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-400 mt-2">
          최종 차액 = 납입액 - 확정 부담액 - 미반납 결제예산 (양수: 환급 / 음수: 추가 납부)
        </p>
      </div>

      {/* 외부 결제 잔액 회수 알림 */}
      {summaries.some(({ summary }) => summary.allocatedBudget > 0n) && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
          <h3 className="text-sm font-semibold text-amber-800 mb-2">외부 결제예산 잔액 회수 필요</h3>
          <div className="space-y-1">
            {summaries
              .filter(({ summary }) => summary.allocatedBudget > 0n)
              .map(({ participant, summary }) => (
                <p key={participant.id} className="text-sm text-amber-700">
                  {participant.name}: 공동자금 {fmtUsdc(summary.allocatedBudget)} USDC 반납 필요
                </p>
              ))}
          </div>
        </div>
      )}

      {/* 정산안 제출 (관리자) */}
      {isAdmin && pendingCount === 0 && !settlement?.proposed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <h3 className="text-sm font-semibold text-stone-700 mb-1">최종 정산안 제출</h3>
          <p className="text-xs text-stone-400 mb-3">
            위 차액 계산을 기반으로 자동 정산안을 생성합니다. 전원 승인 후 환급이 실행됩니다.
          </p>
          <button
            onClick={proposeSettlement}
            className="w-full py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
          >
            최종 정산안 제출
          </button>
          {settleMsg && <p className="text-xs mt-1.5 text-stone-600">{settleMsg}</p>}
        </div>
      )}

      {/* 정산안 확인 및 승인 */}
      {settlement?.proposed && (
        <div className="bg-white rounded-xl border border-stone-200 p-4">
          <h3 className="text-sm font-semibold text-stone-700 mb-1">최종 정산안 확인 · 승인</h3>
          <p className="text-xs text-stone-400 mb-3 font-mono break-all">
            해시: {settlement.ledgerHash}
          </p>

          {/* 정산안 상세 */}
          <div className="space-y-1.5 mb-4">
            {trip.participants.map((p) => {
              const refund = settlement.finalRefundAmounts[p.id] ?? 0;
              const deficit = settlement.requiredDeficits[p.id] ?? 0;
              const paidDef = p.paidDeficit;
              const approvedThis = settlement.approvals.find((a) => a.participantId === p.id);
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                    p.id === currentUserId ? "bg-indigo-50 border border-indigo-100" : "bg-stone-50"
                  }`}
                >
                  <div>
                    <span className="text-sm font-medium text-stone-700">{p.name}</span>
                    {p.id === currentUserId && <span className="ml-1 text-xs text-indigo-600">(나)</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {refund > 0 && (
                      <span className="text-sm text-emerald-700 tabular-nums font-medium">
                        +{fmtUsdc(refund)} USDC
                      </span>
                    )}
                    {deficit > 0 && (
                      <span className="text-sm text-rose-600 tabular-nums font-medium">
                        -{fmtUsdc(deficit)} USDC
                        {paidDef > 0 && (
                          <span className="text-xs text-stone-400 ml-1">
                            ({fmtUsdc(paidDef)} 납입)
                          </span>
                        )}
                      </span>
                    )}
                    {approvedThis?.approved ? (
                      <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">승인 ✓</span>
                    ) : (
                      <span className="text-xs bg-stone-100 text-stone-400 px-2 py-0.5 rounded-full">미승인</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 내 부족분 납입 */}
          {myDeficitRemaining > 0n && (
            <div className="bg-rose-50 rounded-lg p-3 mb-3 border border-rose-200">
              <p className="text-sm font-semibold text-rose-700 mb-2">
                추가 납부 필요: {fmtUsdc(myDeficitRemaining)} USDC
              </p>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  max={toDisplayNumber(myDeficitRemaining)}
                  className="flex-1 border border-rose-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 bg-white"
                  placeholder={`최대 ${fmtUsdc(myDeficitRemaining)} USDC`}
                  value={deficitInput[currentUserId]}
                  onChange={(e) =>
                    setDeficitInput({ ...deficitInput, [currentUserId]: e.target.value })
                  }
                />
                <button
                  onClick={() => payDeficit(currentUserId)}
                  className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700 transition-colors"
                >
                  납부
                </button>
              </div>
              {claimMsg[currentUserId] && (
                <p className="text-xs mt-1.5 text-rose-700">{claimMsg[currentUserId]}</p>
              )}
            </div>
          )}

          {/* 승인 버튼 */}
          {!myApproval?.approved && myDeficitRemaining <= 0 && (
            <button
              onClick={approveSettlement}
              className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors mb-3"
            >
              최종 정산안 승인
            </button>
          )}

          {/* 전원 승인 & 환급 수령 */}
          {allApproved && allDeficitPaid && (
            <div className="bg-emerald-50 rounded-lg p-4 border border-emerald-200">
              <p className="text-sm font-semibold text-emerald-700 mb-1">
                전원 승인 완료! 환급 수령 가능
              </p>
              {!balanceMatches && (
                <p className="text-xs text-rose-600 mb-2">
                  잔액 불일치: 컨트랙트 잔액({fmtUsdc(contractBalance)}) ≠ 환급 합계({fmtUsdc(totalRefunds)})
                </p>
              )}
              {balanceMatches && (() => {
                const refundAmt = settlement.finalRefundAmounts[currentUserId] ?? 0n;
                const meObj = trip.participants.find((p) => p.id === currentUserId);
                const claimed = meObj?.refundClaimed ?? false;
                return refundAmt > 0n ? (
                  claimed ? (
                    <p className="text-sm text-emerald-700 font-medium">
                      {fmtUsdc(refundAmt)} USDC 수령 완료 ✓
                    </p>
                  ) : (
                    <button
                      onClick={() => claimRefund(currentUserId)}
                      className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors"
                    >
                      {fmtUsdc(refundAmt)} USDC 환급 수령
                    </button>
                  )
                ) : (
                  <p className="text-sm text-stone-500">
                    내 환급액: 0 USDC (추가 납부자)
                  </p>
                );
              })()}
              {claimMsg[currentUserId] && (
                <p className="text-xs mt-1.5 text-emerald-700 font-medium">{claimMsg[currentUserId]}</p>
              )}
            </div>
          )}

          {/* 승인 진행 현황 */}
          <div className="mt-3 pt-3 border-t border-stone-100">
            <p className="text-xs text-stone-500">
              승인 현황: {settlement.approvals.filter((a) => a.approved).length}/{trip.participants.length}명
              {allApproved ? " — 전원 승인" : ""}
            </p>
            {settlement.proposedAt && (
              <p className="text-xs text-stone-400">
                제출일: {settlement.proposedAt.slice(0, 16).replace("T", " ")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
