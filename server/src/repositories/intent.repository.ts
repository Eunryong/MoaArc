/**
 * TripCreationIntent repository — DB 접근만 담당합니다.
 */

import { prisma } from "../lib/prisma.js";

export type IntentStatus =
  | "pending_tx"   // 프론트가 아직 트랜잭션을 전송하지 않음
  | "submitted"    // txHash 제출됨, 아직 블록 미확인
  | "confirmed"    // 영수증 확인, TripRecord 생성됨
  | "failed"       // DB 저장 실패 등 내부 오류
  | "reverted";    // 온체인 revert 확인됨

export async function createIntent(data: {
  creatorAddress: string;
  chainId: number;
  contractAddress: string;
  tripName: string;
  participantAddresses: string[];
  targetBudget: bigint;
  calldata: string;
}) {
  return prisma.tripCreationIntent.create({
    data: {
      creatorAddress: data.creatorAddress.toLowerCase(),
      chainId: data.chainId,
      contractAddress: data.contractAddress.toLowerCase(),
      tripName: data.tripName,
      participantAddresses: JSON.stringify(data.participantAddresses.map((a) => a.toLowerCase())),
      targetBudget: data.targetBudget.toString(),
      calldata: data.calldata,
      status: "pending_tx",
    },
  });
}

export async function findIntentById(id: string) {
  return prisma.tripCreationIntent.findUnique({ where: { id } });
}

export async function findIntentByTxHash(txHash: string) {
  return prisma.tripCreationIntent.findUnique({ where: { txHash: txHash.toLowerCase() } });
}

export async function submitIntentTxHash(id: string, txHash: string) {
  return prisma.tripCreationIntent.update({
    where: { id },
    data: { txHash: txHash.toLowerCase(), status: "submitted" },
  });
}

export async function updateIntentStatus(
  id: string,
  status: IntentStatus,
  extra?: { onchainTripId?: string; errorMessage?: string }
) {
  return prisma.tripCreationIntent.update({
    where: { id },
    data: { status, ...extra },
  });
}
