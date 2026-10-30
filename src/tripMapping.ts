import type { ParticipantId, Trip } from "./types";
import type { TripApiRecord } from "./apiClient";

/**
 * TripApiRecord → Trip 최소 변환.
 *
 * 서버(DB)는 참여자 목록만 알고 금액은 모릅니다. 따라서 depositedAmount / allocatedBudget /
 * spentFromBudget 는 여기서 "값 없음"(0n + onchainStatus "loading") 으로 초기화하고,
 * 실제 값은 온체인 읽기(useParticipantBalances → applyOnchainBalances)로 채웁니다.
 */
export function apiRecordToTrip(r: TripApiRecord): Trip {
  return {
    id: r.id,
    name: r.name,
    contractAddress: r.contractAddress,
    onchainTripId: BigInt(r.onchainTripId),
    adminId: (r.participants.find((p) => p.isAdmin)?.address ?? r.adminAddress) as ParticipantId,
    participants: r.participants.map((p, i) => ({
      id: (["A", "B", "C", "D"][i] ?? p.address.slice(2, 4)) as ParticipantId,
      name: p.displayName,
      address: p.address,
      isAdmin: p.isAdmin,
      depositedAmount: 0n,
      plannedDeposit: 0n,
      allocatedBudget: 0n,
      spentFromBudget: 0n,
      personalPrepaid: 0n,
      paidDeficit: 0n,
      refundClaimed: false,
      onchainStatus: "loading" as const,
    })),
    targetBudget: 0n,
    settlement: null,
    expenses: [],
    itinerary: [],
    createdAt: r.createdAt,
  };
}
