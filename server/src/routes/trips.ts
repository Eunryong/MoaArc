/**
 * POST   /api/trips                         여행방 오프체인 등록 (onchain 트랜잭션 검증 후)
 * GET    /api/trips                         내가 참여한 여행방 목록
 * GET    /api/trips/:dbTripId              여행방 상세
 * GET    /api/trips/:dbTripId/itinerary    일정 목록
 * POST   /api/trips/:dbTripId/itinerary    일정 추가 (관리자만)
 * PATCH  /api/trips/:dbTripId/itinerary/:itemId  일정 수정 (관리자만)
 * GET    /api/trips/:dbTripId/expenses     지출 목록
 * POST   /api/trips/:dbTripId/expenses     지출 등록
 * POST   /api/trips/:dbTripId/expenses/:expenseId/approve  분담 승인/수정요청
 * GET    /api/trips/:dbTripId/notifications  내 알림
 * PATCH  /api/trips/:dbTripId/notifications/:notifId/read  읽음 처리
 */

import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import {
  verifyCreateTripTx,
  fetchOnchainParticipants,
  ARC_TESTNET_CHAIN_ID,
} from "../lib/chain.js";
import {
  requireAuth,
  requireParticipant,
  requireAdmin,
} from "../middleware/requireAuth.js";

const trips = new Hono();

// ─── 여행방 등록 ──────────────────────────────────────────────────────────────

trips.post("/", requireAuth, async (c) => {
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    txHash: string;
    chainId: number;
    contractAddress: string;
    participants: { address: string; displayName: string }[];
  }>();

  const { txHash, chainId, contractAddress, participants } = body ?? {};
  if (!txHash || !chainId || !contractAddress || !Array.isArray(participants)) {
    return c.json({ error: "txHash, chainId, contractAddress, participants 필드가 필요합니다." }, 400);
  }
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    return c.json({ error: `Arc Testnet(chainId=${ARC_TESTNET_CHAIN_ID})만 지원합니다.` }, 400);
  }

  // 1. 온체인 트랜잭션 검증 (TripCreated 이벤트 파싱)
  let verified;
  try {
    verified = await verifyCreateTripTx(
      txHash as `0x${string}`,
      chainId,
      contractAddress
    );
  } catch (e) {
    return c.json({ error: `트랜잭션 검증 실패: ${String(e)}` }, 400);
  }

  // 2. 요청자가 onchain admin 이어야 함
  if (verified.admin !== caller) {
    return c.json({ error: "요청 지갑이 온체인 트랜잭션의 admin과 다릅니다." }, 403);
  }

  // 3. 중복 등록 방지
  const existing = await prisma.tripRecord.findFirst({
    where: {
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      onchainTripId: verified.tripId,
    },
  });
  if (existing) {
    return c.json({ error: "이미 등록된 여행방입니다.", tripId: existing.id }, 409);
  }

  // 4. 온체인 참여자 목록 조회 (컨트랙트 직접 호출)
  let onchainParticipants: string[];
  try {
    onchainParticipants = await fetchOnchainParticipants(
      contractAddress.toLowerCase(),
      verified.tripId
    );
  } catch (e) {
    return c.json({ error: `온체인 참여자 조회 실패: ${String(e)}` }, 400);
  }

  // 5. 요청 본문의 참여자 목록이 있으면 온체인 목록과 대조
  //    요청 본문 participants는 선택적 — 없으면 온체인 목록만 사용
  if (participants.length > 0) {
    const requestedAddrs = participants.map((p) => p.address.toLowerCase());
    const onchainSet = new Set(onchainParticipants);
    const mismatch = requestedAddrs.filter((a) => !onchainSet.has(a));
    if (mismatch.length > 0) {
      return c.json({
        error: `요청한 참여자 주소가 온체인 여행방 참여자와 다릅니다: ${mismatch.join(", ")}`,
      }, 400);
    }
  }

  // 6. 참여자 목록 구성 — 온체인 데이터를 권위 있는 출처로 사용
  //    displayName은 요청 본문에서 보조적으로 사용 (없으면 주소 앞 8자)
  const displayNameMap = new Map<string, string>(
    participants.map((p) => [p.address.toLowerCase(), p.displayName])
  );
  const allParticipants = onchainParticipants.map((addr) => ({
    address: addr,
    displayName: displayNameMap.get(addr) ?? addr.slice(0, 10),
    isAdmin: addr === caller,
  }));

  const trip = await prisma.tripRecord.create({
    data: {
      chainId,
      contractAddress: contractAddress.toLowerCase(),
      onchainTripId: verified.tripId,
      name: verified.name,
      adminAddress: caller,
      createTxHash: txHash.toLowerCase(),
      participants: {
        create: allParticipants,
      },
    },
    include: { participants: true },
  });

  return c.json({ trip }, 201);
});

// ─── 내 여행방 목록 ───────────────────────────────────────────────────────────

trips.get("/", requireAuth, async (c) => {
  const caller = c.get("callerAddress");
  const records = await prisma.tripRecord.findMany({
    where: {
      participants: { some: { address: caller } },
    },
    include: { participants: true },
    orderBy: { createdAt: "desc" },
  });
  return c.json({ trips: records });
});

// ─── 여행방 상세 ──────────────────────────────────────────────────────────────

trips.get("/:dbTripId", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const full = await prisma.tripRecord.findUnique({
    where: { id: trip.id },
    include: { participants: true },
  });
  return c.json({ trip: full });
});

// ─── 일정 목록 ────────────────────────────────────────────────────────────────

trips.get("/:dbTripId/itinerary", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const items = await prisma.itineraryRecord.findMany({
    where: { tripId: trip.id },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  return c.json({ itinerary: items });
});

// ─── 일정 추가 (관리자만) ─────────────────────────────────────────────────────

trips.post("/:dbTripId/itinerary", requireAuth, requireParticipant, requireAdmin, async (c) => {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    date: string;
    time?: string;
    location: string;
    activity: string;
    participants?: string[];
    notes?: string;
  }>();

  if (!body.date || !body.location || !body.activity) {
    return c.json({ error: "date, location, activity 필드가 필요합니다." }, 400);
  }

  const item = await prisma.itineraryRecord.create({
    data: {
      tripId: trip.id,
      date: body.date,
      time: body.time,
      location: body.location,
      activity: body.activity,
      participants: JSON.stringify(body.participants ?? []),
      notes: body.notes,
      createdBy: caller,
    },
  });
  return c.json({ item }, 201);
});

// ─── 일정 수정 (관리자만) ─────────────────────────────────────────────────────

trips.patch("/:dbTripId/itinerary/:itemId", requireAuth, requireParticipant, requireAdmin, async (c) => {
  const trip = c.get("tripRecord");
  const itemId = c.req.param("itemId");
  const body = await c.req.json<Partial<{
    date: string; time: string; location: string; activity: string;
    participants: string[]; notes: string; status: string;
    estMinUsdc: string; estMaxUsdc: string; estCurrency: string;
    estSource: string; confidence: string;
  }>>();

  const existing = await prisma.itineraryRecord.findFirst({
    where: { id: itemId, tripId: trip.id },
  });
  if (!existing) return c.json({ error: "일정을 찾을 수 없습니다." }, 404);

  const updated = await prisma.itineraryRecord.update({
    where: { id: itemId },
    data: {
      ...( body.date && { date: body.date }),
      ...( body.time !== undefined && { time: body.time }),
      ...( body.location && { location: body.location }),
      ...( body.activity && { activity: body.activity }),
      ...( body.participants && { participants: JSON.stringify(body.participants) }),
      ...( body.notes !== undefined && { notes: body.notes }),
      ...( body.status && { status: body.status }),
      ...( body.estMinUsdc && { estMinUsdc: BigInt(body.estMinUsdc) }),
      ...( body.estMaxUsdc && { estMaxUsdc: BigInt(body.estMaxUsdc) }),
      ...( body.estCurrency && { estCurrency: body.estCurrency }),
      ...( body.estSource && { estSource: body.estSource }),
      ...( body.confidence && { confidence: body.confidence }),
      ...( body.estSource && { estAt: new Date() }),
    },
  });
  return c.json({ item: updated });
});

// ─── 지출 목록 ────────────────────────────────────────────────────────────────

trips.get("/:dbTripId/expenses", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const expenses = await prisma.expenseRecord.findMany({
    where: { tripId: trip.id },
    include: {
      versions: {
        include: { approvals: true },
        orderBy: { version: "asc" },
      },
    },
    orderBy: { date: "asc" },
  });
  return c.json({ expenses });
});

// ─── 지출 등록 ────────────────────────────────────────────────────────────────

trips.post("/:dbTripId/expenses", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    title: string;
    category: string;
    date: string;
    totalUsdc: string; // 마이크로USDC string (bigint)
    paymentFlow: string;
    localCurrency?: string;
    localAmount?: number;
    receiptNote?: string;
    shares: { address: string; amountUsdc: string }[];
  }>();

  if (!body.title || !body.category || !body.date || !body.totalUsdc || !body.paymentFlow) {
    return c.json({ error: "title, category, date, totalUsdc, paymentFlow, shares 필드가 필요합니다." }, 400);
  }

  // 분담 합계 검증
  const total = BigInt(body.totalUsdc);
  const sharesSum = (body.shares ?? []).reduce((s, sh) => s + BigInt(sh.amountUsdc), 0n);
  if (sharesSum !== total) {
    return c.json({
      error: `분담 합계(${sharesSum})가 지출 총액(${total})과 일치하지 않습니다.`,
    }, 400);
  }

  const expense = await prisma.expenseRecord.create({
    data: {
      tripId: trip.id,
      payerAddress: caller,
      title: body.title,
      category: body.category,
      date: body.date,
      totalUsdc: total,
      paymentFlow: body.paymentFlow,
      localCurrency: body.localCurrency,
      localAmount: body.localAmount,
      receiptNote: body.receiptNote,
      createdBy: caller,
      versions: {
        create: {
          version: 1,
          shares: JSON.stringify(body.shares),
          proposedBy: caller,
          reason: "최초 등록",
          status: "승인대기",
          approvals: {
            create: {
              address: caller,
              action: "승인", // 등록자는 자동 승인
            },
          },
        },
      },
    },
    include: { versions: { include: { approvals: true } } },
  });
  return c.json({ expense }, 201);
});

// ─── 분담 승인 / 수정 요청 ────────────────────────────────────────────────────

trips.post("/:dbTripId/expenses/:expenseId/approve", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const isAdmin = c.get("isAdmin");
  const expenseId = c.req.param("expenseId");
  const body = await c.req.json<{ action: string; reason?: string; newShares?: { address: string; amountUsdc: string }[] }>();

  if (!["승인", "수정요청"].includes(body.action)) {
    return c.json({ error: "action은 '승인' 또는 '수정요청' 이어야 합니다." }, 400);
  }

  const expense = await prisma.expenseRecord.findFirst({
    where: { id: expenseId, tripId: trip.id },
    include: { versions: { orderBy: { version: "desc" }, take: 1, include: { approvals: true } } },
  });
  if (!expense) return c.json({ error: "지출을 찾을 수 없습니다." }, 404);
  if (expense.status === "확정" || expense.status === "취소됨") {
    return c.json({ error: "이미 확정되었거나 취소된 지출입니다." }, 400);
  }

  const currentVer = expense.versions[0];
  if (!currentVer) return c.json({ error: "분담안을 찾을 수 없습니다." }, 404);

  // 수정안 제출 (관리자만)
  if (body.action === "수정요청" && body.newShares) {
    if (!isAdmin) return c.json({ error: "분담 수정안은 관리자만 제출할 수 있습니다." }, 403);
    const total = BigInt(expense.totalUsdc);
    const sum = body.newShares.reduce((s, sh) => s + BigInt(sh.amountUsdc), 0n);
    if (sum !== total) {
      return c.json({ error: `분담 합계(${sum})가 총액(${total})과 일치하지 않습니다.` }, 400);
    }

    // 기존 승인 초기화, 새 버전 생성
    const newVersion = await prisma.expenseVersion.create({
      data: {
        expenseId,
        version: currentVer.version + 1,
        shares: JSON.stringify(body.newShares),
        proposedBy: caller,
        reason: body.reason ?? "수정",
        status: "승인대기",
        approvals: {
          create: { address: caller, action: "승인" },
        },
      },
      include: { approvals: true },
    });

    await prisma.expenseRecord.update({
      where: { id: expenseId },
      data: { currentVersion: newVersion.version, status: "수정안투표중" },
    });
    return c.json({ version: newVersion });
  }

  // 승인 등록
  const existing = await prisma.expenseApproval.findFirst({
    where: { versionId: currentVer.id, address: caller },
  });
  if (existing) {
    await prisma.expenseApproval.update({
      where: { id: existing.id },
      data: { action: body.action, reason: body.reason },
    });
  } else {
    await prisma.expenseApproval.create({
      data: { versionId: currentVer.id, address: caller, action: body.action, reason: body.reason },
    });
  }

  // 수정 요청이 있으면 상태 유지
  if (body.action === "수정요청") {
    return c.json({ message: "수정 요청이 접수되었습니다." });
  }

  // 전원 승인 여부 확인
  const participants = await prisma.participantRecord.findMany({ where: { tripId: trip.id } });
  const allApprovals = await prisma.expenseApproval.findMany({ where: { versionId: currentVer.id } });
  const allApproved = participants.every((p) =>
    allApprovals.some((a) => a.address === p.address && a.action === "승인")
  );
  if (allApproved) {
    await prisma.expenseVersion.update({ where: { id: currentVer.id }, data: { status: "확정" } });
    await prisma.expenseRecord.update({ where: { id: expenseId }, data: { status: "확정" } });
    return c.json({ message: "전원 승인 — 지출이 확정되었습니다." });
  }

  return c.json({ message: "승인이 기록되었습니다." });
});

// ─── 알림 목록 ────────────────────────────────────────────────────────────────

trips.get("/:dbTripId/notifications", requireAuth, requireParticipant, async (c) => {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const notifications = await prisma.notificationRecord.findMany({
    where: { tripId: trip.id, address: caller },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return c.json({ notifications });
});

trips.patch("/:dbTripId/notifications/:notifId/read", requireAuth, requireParticipant, async (c) => {
  const notifId = c.req.param("notifId");
  const caller = c.get("callerAddress");
  const notif = await prisma.notificationRecord.findFirst({
    where: { id: notifId, address: caller },
  });
  if (!notif) return c.json({ error: "알림을 찾을 수 없습니다." }, 404);
  await prisma.notificationRecord.update({ where: { id: notifId }, data: { read: true } });
  return c.json({ message: "읽음 처리 완료" });
});

export default trips;
