/**
 * Trips Controller — 요청 파싱과 응답 조립만 담당합니다.
 * DB 접근은 trip.repository.ts, 온체인 검증은 lib/chain.ts에 위임합니다.
 */

import type { Context } from "hono";
import { verifyCreateTripTx, fetchOnchainParticipants, ARC_TESTNET_CHAIN_ID } from "../lib/chain.js";
import * as repo from "../repositories/trip.repository.js";

// ─── 여행방 목록 ──────────────────────────────────────────────────────────────

export async function listTrips(c: Context) {
  const caller = c.get("callerAddress");
  const records = await repo.findTripsByParticipant(caller);
  // 인증된 사용자의 여행방 0개 → 200 빈 배열 (인증 실패와 구분)
  return c.json({ trips: records });
}

// ─── 여행방 등록 ──────────────────────────────────────────────────────────────

export async function createTrip(c: Context) {
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

  let verified;
  try {
    verified = await verifyCreateTripTx(txHash as `0x${string}`, chainId, contractAddress);
  } catch (e) {
    return c.json({ error: `트랜잭션 검증 실패: ${String(e)}` }, 400);
  }

  if (verified.admin !== caller) {
    return c.json({ error: "요청 지갑이 온체인 트랜잭션의 admin과 다릅니다." }, 403);
  }

  const existing = await repo.findTripByOnchain(chainId, contractAddress, verified.tripId);
  if (existing) {
    return c.json({ error: "이미 등록된 여행방입니다.", tripId: existing.id }, 409);
  }

  let onchainParticipants: string[];
  try {
    onchainParticipants = await fetchOnchainParticipants(contractAddress.toLowerCase(), verified.tripId);
  } catch (e) {
    return c.json({ error: `온체인 참여자 조회 실패: ${String(e)}` }, 400);
  }

  if (participants.length > 0) {
    const requestedAddrs = participants.map((p) => p.address.toLowerCase());
    const onchainSet = new Set(onchainParticipants);
    const mismatch = requestedAddrs.filter((a) => !onchainSet.has(a));
    if (mismatch.length > 0) {
      return c.json({ error: `요청한 참여자 주소가 온체인 여행방 참여자와 다릅니다: ${mismatch.join(", ")}` }, 400);
    }
  }

  const displayNameMap = new Map<string, string>(
    participants.map((p) => [p.address.toLowerCase(), p.displayName])
  );
  const allParticipants = onchainParticipants.map((addr) => ({
    address: addr,
    displayName: displayNameMap.get(addr) ?? addr.slice(0, 10),
    isAdmin: addr === caller,
  }));

  const trip = await repo.createTrip({
    chainId,
    contractAddress,
    onchainTripId: verified.tripId,
    name: verified.name,
    adminAddress: caller,
    createTxHash: txHash,
    participants: allParticipants,
  });

  return c.json({ trip }, 201);
}

// ─── 여행방 상세 ──────────────────────────────────────────────────────────────

export async function getTripDetail(c: Context) {
  const trip = c.get("tripRecord");
  const full = await repo.findTripById(trip.id);
  return c.json({ trip: full });
}

// ─── 일정 ─────────────────────────────────────────────────────────────────────

export async function getItinerary(c: Context) {
  const trip = c.get("tripRecord");
  const items = await repo.findItinerary(trip.id);
  return c.json({ itinerary: items });
}

export async function addItineraryItem(c: Context) {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    date: string; time?: string; location: string;
    activity: string; participants?: string[]; notes?: string;
  }>();

  if (!body.date || !body.location || !body.activity) {
    return c.json({ error: "date, location, activity 필드가 필요합니다." }, 400);
  }

  const item = await repo.createItineraryItem({
    tripId: trip.id,
    date: body.date,
    time: body.time,
    location: body.location,
    activity: body.activity,
    participants: body.participants,
    notes: body.notes,
    createdBy: caller,
  });
  return c.json({ item }, 201);
}

export async function patchItineraryItem(c: Context) {
  const trip = c.get("tripRecord");
  const itemId = c.req.param("itemId");
  const body = await c.req.json<Partial<{
    date: string; time: string; location: string; activity: string;
    participants: string[]; notes: string; status: string;
    estMinUsdc: string; estMaxUsdc: string; estCurrency: string;
    estSource: string; confidence: string;
  }>>();

  const existing = await repo.findItineraryItem(itemId, trip.id);
  if (!existing) return c.json({ error: "일정을 찾을 수 없습니다." }, 404);

  const patch: Record<string, unknown> = {};
  if (body.date)                patch.date = body.date;
  if (body.time !== undefined)  patch.time = body.time;
  if (body.location)            patch.location = body.location;
  if (body.activity)            patch.activity = body.activity;
  if (body.participants)        patch.participants = JSON.stringify(body.participants);
  if (body.notes !== undefined) patch.notes = body.notes;
  if (body.status)              patch.status = body.status;
  if (body.estMinUsdc)          patch.estMinUsdc = BigInt(body.estMinUsdc);
  if (body.estMaxUsdc)          patch.estMaxUsdc = BigInt(body.estMaxUsdc);
  if (body.estCurrency)         patch.estCurrency = body.estCurrency;
  if (body.estSource)         { patch.estSource = body.estSource; patch.estAt = new Date(); }
  if (body.confidence)          patch.confidence = body.confidence;

  const updated = await repo.updateItineraryItem(itemId, patch as Parameters<typeof repo.updateItineraryItem>[1]);
  return c.json({ item: updated });
}

// ─── 지출 ─────────────────────────────────────────────────────────────────────

export async function getExpenses(c: Context) {
  const trip = c.get("tripRecord");
  const expenses = await repo.findExpenses(trip.id);
  return c.json({ expenses });
}

export async function addExpense(c: Context) {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const body = await c.req.json<{
    title: string; category: string; date: string;
    totalUsdc: string; paymentFlow: string;
    localCurrency?: string; localAmount?: number; receiptNote?: string;
    shares: { address: string; amountUsdc: string }[];
  }>();

  if (!body.title || !body.category || !body.date || !body.totalUsdc || !body.paymentFlow) {
    return c.json({ error: "title, category, date, totalUsdc, paymentFlow 필드가 필요합니다." }, 400);
  }

  const total = BigInt(body.totalUsdc);
  const sharesSum = (body.shares ?? []).reduce((s, sh) => s + BigInt(sh.amountUsdc), 0n);
  if (sharesSum !== total) {
    return c.json({ error: `분담 합계(${sharesSum})가 지출 총액(${total})과 일치하지 않습니다.` }, 400);
  }

  const expense = await repo.createExpense({
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
    shares: body.shares ?? [],
  });
  return c.json({ expense }, 201);
}

export async function approveExpense(c: Context) {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const isAdmin = c.get("isAdmin");
  const expenseId = c.req.param("expenseId");
  const body = await c.req.json<{
    action: string; reason?: string;
    newShares?: { address: string; amountUsdc: string }[];
  }>();

  if (!["승인", "수정요청"].includes(body.action)) {
    return c.json({ error: "action은 '승인' 또는 '수정요청' 이어야 합니다." }, 400);
  }

  const expense = await repo.findExpenseById(expenseId, trip.id);
  if (!expense) return c.json({ error: "지출을 찾을 수 없습니다." }, 404);
  if (expense.status === "확정" || expense.status === "취소됨") {
    return c.json({ error: "이미 확정되었거나 취소된 지출입니다." }, 400);
  }

  const currentVer = expense.versions[0];
  if (!currentVer) return c.json({ error: "분담안을 찾을 수 없습니다." }, 404);

  if (body.action === "수정요청" && body.newShares) {
    if (!isAdmin) return c.json({ error: "분담 수정안은 관리자만 제출할 수 있습니다." }, 403);
    const total = BigInt(expense.totalUsdc);
    const sum = body.newShares.reduce((s, sh) => s + BigInt(sh.amountUsdc), 0n);
    if (sum !== total) {
      return c.json({ error: `분담 합계(${sum})가 총액(${total})과 일치하지 않습니다.` }, 400);
    }

    const newVersion = await repo.createExpenseVersion({
      expenseId,
      version: currentVer.version + 1,
      shares: body.newShares,
      proposedBy: caller,
      reason: body.reason ?? "수정",
    });
    await repo.updateExpenseStatus(expenseId, { status: "수정안투표중", currentVersion: newVersion.version });
    return c.json({ version: newVersion });
  }

  // 승인 등록
  const existing = await repo.findExpenseApproval(currentVer.id, caller);
  await repo.upsertExpenseApproval({
    existingId: existing?.id,
    versionId: currentVer.id,
    address: caller,
    action: body.action,
    reason: body.reason,
  });

  if (body.action === "수정요청") {
    return c.json({ message: "수정 요청이 접수되었습니다." });
  }

  // 전원 승인 확인
  const participants = await repo.findParticipantsByTrip(trip.id);
  const allApprovals = await repo.findAllApprovals(currentVer.id);
  const allApproved = participants.every((p) =>
    allApprovals.some((a) => a.address === p.address && a.action === "승인")
  );

  if (allApproved) {
    await repo.updateExpenseVersionStatus(currentVer.id, "확정");
    await repo.updateExpenseStatus(expenseId, { status: "확정" });
    return c.json({ message: "전원 승인 — 지출이 확정되었습니다." });
  }

  return c.json({ message: "승인이 기록되었습니다." });
}

// ─── 알림 ─────────────────────────────────────────────────────────────────────

export async function getNotifications(c: Context) {
  const trip = c.get("tripRecord");
  const caller = c.get("callerAddress");
  const notifications = await repo.findNotifications(trip.id, caller);
  return c.json({ notifications });
}

export async function markNotifRead(c: Context) {
  const notifId = c.req.param("notifId");
  const caller = c.get("callerAddress");
  const notif = await repo.findNotification(notifId, caller);
  if (!notif) return c.json({ error: "알림을 찾을 수 없습니다." }, 404);
  await repo.markNotificationRead(notifId);
  return c.json({ message: "읽음 처리 완료" });
}
