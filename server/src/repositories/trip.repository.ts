/**
 * Trip Repository — Prisma 쿼리만 담당합니다.
 * 업무 규칙, HTTP 관련 코드가 없습니다.
 */

import { prisma } from "../lib/prisma.js";

// ─── 여행방 ───────────────────────────────────────────────────────────────────

export async function findTripsByParticipant(address: string) {
  return prisma.tripRecord.findMany({
    where: { participants: { some: { address } } },
    include: { participants: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function findTripById(id: string) {
  return prisma.tripRecord.findUnique({
    where: { id },
    include: { participants: true },
  });
}

export async function findTripByOnchain(chainId: number, contractAddress: string, onchainTripId: string) {
  return prisma.tripRecord.findFirst({
    where: { chainId, contractAddress: contractAddress.toLowerCase(), onchainTripId: BigInt(onchainTripId) },
  });
}

export async function createTrip(data: {
  chainId: number;
  contractAddress: string;
  onchainTripId: string;
  name: string;
  adminAddress: string;
  createTxHash: string;
  participants: { address: string; displayName: string; isAdmin: boolean }[];
}) {
  return prisma.tripRecord.create({
    data: {
      chainId: data.chainId,
      contractAddress: data.contractAddress.toLowerCase(),
      onchainTripId: BigInt(data.onchainTripId),
      name: data.name,
      adminAddress: data.adminAddress,
      createTxHash: data.createTxHash.toLowerCase(),
      participants: { create: data.participants },
    },
    include: { participants: true },
  });
}

// ─── 참여자 ───────────────────────────────────────────────────────────────────

export async function findParticipant(tripId: string, address: string) {
  return prisma.participantRecord.findFirst({ where: { tripId, address } });
}

/** findParticipant의 별칭 — addTripParticipant 컨트롤러에서 사용 */
export const findParticipantByAddress = findParticipant;

export async function createParticipant(data: {
  tripId: string;
  address: string;
  displayName: string;
  isAdmin: boolean;
}) {
  return prisma.participantRecord.create({
    data: {
      tripId: data.tripId,
      address: data.address.toLowerCase(),
      displayName: data.displayName,
      isAdmin: data.isAdmin,
    },
  });
}

/**
 * 4인 제한 초과 방지를 DB 트랜잭션으로 직렬화합니다.
 * 동시 추가 요청이 제한을 초과하면 "MAX_PARTICIPANTS" 메시지로 throw합니다.
 */
export async function addParticipantAtomic(data: {
  tripId: string;
  address: string;
  displayName: string;
  maxParticipants: number;
}) {
  return prisma.$transaction(async (tx) => {
    const count = await tx.participantRecord.count({ where: { tripId: data.tripId } });
    if (count >= data.maxParticipants) {
      throw new Error(`MAX_PARTICIPANTS: ${count} >= ${data.maxParticipants}`);
    }
    await tx.participantRecord.create({
      data: {
        tripId: data.tripId,
        address: data.address.toLowerCase(),
        displayName: data.displayName,
        isAdmin: false,
      },
    });
    return tx.tripRecord.findUnique({
      where: { id: data.tripId },
      include: { participants: true },
    });
  });
}

export async function findParticipantsByTrip(tripId: string) {
  return prisma.participantRecord.findMany({ where: { tripId } });
}

// ─── 일정 ─────────────────────────────────────────────────────────────────────

export async function findItinerary(tripId: string) {
  return prisma.itineraryRecord.findMany({
    where: { tripId },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
}

export async function findItineraryItem(itemId: string, tripId: string) {
  return prisma.itineraryRecord.findFirst({ where: { id: itemId, tripId } });
}

export async function createItineraryItem(data: {
  tripId: string;
  date: string;
  time?: string;
  location: string;
  activity: string;
  participants?: string[];
  notes?: string;
  createdBy: string;
}) {
  return prisma.itineraryRecord.create({
    data: {
      tripId: data.tripId,
      date: data.date,
      time: data.time,
      location: data.location,
      activity: data.activity,
      participants: JSON.stringify(data.participants ?? []),
      notes: data.notes,
      createdBy: data.createdBy,
    },
  });
}

export async function updateItineraryItem(
  itemId: string,
  patch: Partial<{
    date: string; time: string | null; location: string; activity: string;
    participants: string;  // JSON string of address[]
    notes: string | null; status: string;
    estMinUsdc: bigint; estMaxUsdc: bigint; estCurrency: string;
    estSource: string; confidence: string; estAt: Date;
  }>
) {
  return prisma.itineraryRecord.update({ where: { id: itemId }, data: patch });
}

// ─── 지출 ─────────────────────────────────────────────────────────────────────

export async function findExpenses(tripId: string) {
  return prisma.expenseRecord.findMany({
    where: { tripId },
    include: {
      versions: {
        include: { approvals: true },
        orderBy: { version: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });
}

export async function findExpenseById(expenseId: string, tripId: string) {
  return prisma.expenseRecord.findFirst({
    where: { id: expenseId, tripId },
    include: { versions: { orderBy: { version: "desc" }, take: 1, include: { approvals: true } } },
  });
}

export async function createExpense(data: {
  tripId: string;
  payerAddress: string;
  title: string;
  category: string;
  date: string;
  totalUsdc: bigint;
  paymentFlow: string;
  localCurrency?: string;
  localAmount?: number;
  receiptNote?: string;
  createdBy: string;
  shares: { address: string; amountUsdc: string }[];
}) {
  return prisma.expenseRecord.create({
    data: {
      tripId: data.tripId,
      payerAddress: data.payerAddress,
      title: data.title,
      category: data.category,
      date: data.date,
      totalUsdc: data.totalUsdc,
      paymentFlow: data.paymentFlow,
      localCurrency: data.localCurrency,
      localAmount: data.localAmount,
      receiptNote: data.receiptNote,
      createdBy: data.createdBy,
      versions: {
        create: {
          version: 1,
          shares: JSON.stringify(data.shares),
          proposedBy: data.createdBy,
          reason: "최초 등록",
          status: "승인대기",
          approvals: {
            create: { address: data.createdBy, action: "승인" },
          },
        },
      },
    },
    include: { versions: { include: { approvals: true } } },
  });
}

export async function createExpenseVersion(data: {
  expenseId: string;
  version: number;
  shares: { address: string; amountUsdc: string }[];
  proposedBy: string;
  reason: string;
}) {
  return prisma.expenseVersion.create({
    data: {
      expenseId: data.expenseId,
      version: data.version,
      shares: JSON.stringify(data.shares),
      proposedBy: data.proposedBy,
      reason: data.reason,
      status: "승인대기",
      approvals: {
        create: { address: data.proposedBy, action: "승인" },
      },
    },
    include: { approvals: true },
  });
}

export async function updateExpenseStatus(expenseId: string, data: { status: string; currentVersion?: number }) {
  return prisma.expenseRecord.update({ where: { id: expenseId }, data });
}

export async function updateExpenseVersionStatus(versionId: string, status: string) {
  return prisma.expenseVersion.update({ where: { id: versionId }, data: { status } });
}

export async function findExpenseApproval(versionId: string, address: string) {
  return prisma.expenseApproval.findFirst({ where: { versionId, address } });
}

export async function upsertExpenseApproval(data: {
  existingId?: string;
  versionId: string;
  address: string;
  action: string;
  reason?: string;
}) {
  if (data.existingId) {
    return prisma.expenseApproval.update({
      where: { id: data.existingId },
      data: { action: data.action, reason: data.reason },
    });
  }
  return prisma.expenseApproval.create({
    data: { versionId: data.versionId, address: data.address, action: data.action, reason: data.reason },
  });
}

export async function findAllApprovals(versionId: string) {
  return prisma.expenseApproval.findMany({ where: { versionId } });
}

/**
 * 전원 승인 판정 및 확정 전환.
 *
 * "전원"의 기준은 해당 버전의 shares에 포함된 지갑 주소(분담 대상자)입니다.
 * 방 참여자 전체가 아니라 이 버전의 분담 대상자 전원이 "승인" 레코드를 가질 때만 확정합니다.
 *
 * 엣지 케이스:
 *  - shares가 비어 있으면(분담 대상자 0명) 확정하지 않고 false를 반환합니다.
 *    분담 대상자가 없는 지출은 정상적으로 의미가 없으므로 안전한 기본값입니다.
 *
 * 반환값: true = 확정으로 전환됨, false = 아직 미확정(또는 이미 확정·취소)
 */
export async function checkAndConfirmExpense(
  expenseId: string,
  versionId: string,
  sharesJson: string,
): Promise<boolean> {
  // shares JSON 파싱 — 분담 대상 주소 목록 추출
  let shareAddresses: string[];
  try {
    const parsed = JSON.parse(sharesJson) as { address: string }[];
    shareAddresses = parsed.map((s) => s.address.toLowerCase());
  } catch {
    return false;
  }

  // 분담 대상자가 0명이면 확정하지 않음
  if (shareAddresses.length === 0) return false;

  // 해당 버전의 모든 승인 레코드 조회
  const approvals = await prisma.expenseApproval.findMany({ where: { versionId } });
  const approvedSet = new Set(
    approvals.filter((a) => a.action === "승인").map((a) => a.address.toLowerCase()),
  );

  // 분담 대상자 전원이 승인했는지 확인
  const allApproved = shareAddresses.every((addr) => approvedSet.has(addr));
  if (!allApproved) return false;

  // 두 테이블 모두 "확정"으로 업데이트
  await prisma.$transaction([
    prisma.expenseVersion.update({ where: { id: versionId }, data: { status: "확정" } }),
    prisma.expenseRecord.update({ where: { id: expenseId }, data: { status: "확정" } }),
  ]);
  return true;
}

// ─── 알림 ─────────────────────────────────────────────────────────────────────

export async function findNotifications(tripId: string, address: string) {
  return prisma.notificationRecord.findMany({
    where: { tripId, address },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function findNotification(notifId: string, address: string) {
  return prisma.notificationRecord.findFirst({ where: { id: notifId, address } });
}

export async function markNotificationRead(notifId: string) {
  return prisma.notificationRecord.update({ where: { id: notifId }, data: { read: true } });
}
