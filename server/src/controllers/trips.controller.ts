/**
 * Trips Controller — 요청 파싱과 응답 조립만 담당합니다.
 * DB 접근은 trip.repository.ts, 온체인 검증은 lib/chain.ts에 위임합니다.
 */

import type { Context } from "hono";
import { verifyCreateTripTx, fetchOnchainParticipants, ARC_TESTNET_CHAIN_ID } from "../lib/chain.js";
import * as repo from "../repositories/trip.repository.js";

// ─── 입력 검증 상수 ───────────────────────────────────────────────────────────

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/i;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export const EXPENSE_CATEGORY = new Set(["식비", "숙박", "교통", "기타", "관광", "쇼핑", "통신"]);
export const PAYMENT_FLOW = new Set(["community_release", "personal_prepaid"]);
export const ITINERARY_STATUS = new Set(["draft", "confirmed", "cancelled"]);
export const CONFIDENCE = new Set(["high", "medium", "low", "none"]);
export const APPROVAL_ACTION = new Set(["승인", "수정요청"]);

export const MAX_NAME = 200;
export const MAX_TEXT = 2000;
export const MAX_URL = 1000;
const MAX_PARTICIPANTS = 50;

export function assertAddr(val: unknown, field: string): string {
  if (typeof val !== "string" || !ADDR_RE.test(val))
    throw new RangeError(`${field}은 유효한 0x 주소여야 합니다.`);
  return val.toLowerCase();
}

export function assertStr(val: unknown, field: string, max = MAX_NAME): string {
  if (typeof val !== "string" || val.trim().length === 0)
    throw new RangeError(`${field}은 비어 있을 수 없습니다.`);
  if (val.length > max)
    throw new RangeError(`${field}은 최대 ${max}자입니다.`);
  return val.trim();
}

export function assertEnum(val: unknown, allowed: Set<string>, field: string): string {
  if (typeof val !== "string" || !allowed.has(val))
    throw new RangeError(`${field}은 다음 중 하나여야 합니다: ${[...allowed].join(", ")}`);
  return val;
}

function assertDate(val: unknown, field: string): string {
  if (typeof val !== "string" || !DATE_RE.test(val))
    throw new RangeError(`${field}은 YYYY-MM-DD 형식이어야 합니다.`);
  return val;
}

function assertBigIntStr(val: unknown, field: string): bigint {
  try { const n = BigInt(val as string); if (n < 0n) throw new Error(); return n; }
  catch { throw new RangeError(`${field}은 0 이상의 정수 문자열이어야 합니다.`); }
}

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

  try {
    const date = assertDate(body.date, "date");
    if (body.time && !TIME_RE.test(body.time))
      throw new RangeError("time은 HH:MM 형식이어야 합니다.");
    const location = assertStr(body.location, "location", MAX_TEXT);
    const activity = assertStr(body.activity, "activity", MAX_TEXT);
    const participants = (body.participants ?? []).map((a) => assertAddr(a, "participants[]"));
    if (participants.length > MAX_PARTICIPANTS)
      throw new RangeError(`participants는 최대 ${MAX_PARTICIPANTS}명입니다.`);
    const notes = body.notes ? assertStr(body.notes, "notes", MAX_TEXT) : undefined;

    const item = await repo.createItineraryItem({
      tripId: trip.id, date, time: body.time, location, activity,
      participants, notes, createdBy: caller,
    });
    return c.json({ item }, 201);
  } catch (e) {
    if (e instanceof RangeError) return c.json({ error: e.message }, 400);
    throw e;
  }
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
  try {
    if (body.date)                patch.date = assertDate(body.date, "date");
    if (body.time !== undefined)  { if (body.time && !TIME_RE.test(body.time)) throw new RangeError("time은 HH:MM 형식"); patch.time = body.time; }
    if (body.location)            patch.location = assertStr(body.location, "location", MAX_TEXT);
    if (body.activity)            patch.activity = assertStr(body.activity, "activity", MAX_TEXT);
    if (body.participants)        patch.participants = JSON.stringify(body.participants.map((a) => assertAddr(a, "participants[]")));
    if (body.notes !== undefined) patch.notes = body.notes ? assertStr(body.notes, "notes", MAX_TEXT) : null;
    if (body.status)              patch.status = assertEnum(body.status, ITINERARY_STATUS, "status");
    if (body.estMinUsdc)          patch.estMinUsdc = assertBigIntStr(body.estMinUsdc, "estMinUsdc");
    if (body.estMaxUsdc)          patch.estMaxUsdc = assertBigIntStr(body.estMaxUsdc, "estMaxUsdc");
    if (body.estCurrency)         patch.estCurrency = assertStr(body.estCurrency, "estCurrency", 10);
    if (body.estSource)         { patch.estSource = assertStr(body.estSource, "estSource", MAX_URL); patch.estAt = new Date(); }
    if (body.confidence)          patch.confidence = assertEnum(body.confidence, CONFIDENCE, "confidence");
  } catch (e) {
    if (e instanceof RangeError) return c.json({ error: e.message }, 400);
    throw e;
  }

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

  try {
    assertStr(body.title, "title", MAX_NAME);
    assertEnum(body.category, EXPENSE_CATEGORY, "category");
    assertDate(body.date, "date");
    assertEnum(body.paymentFlow, PAYMENT_FLOW, "paymentFlow");
    if (body.receiptNote) assertStr(body.receiptNote, "receiptNote", MAX_TEXT);
    (body.shares ?? []).forEach((s, i) => {
      assertAddr(s.address, `shares[${i}].address`);
      assertBigIntStr(s.amountUsdc, `shares[${i}].amountUsdc`);
    });
  } catch (e) {
    if (e instanceof RangeError) return c.json({ error: e.message }, 400);
    throw e;
  }

  const total = assertBigIntStr(body.totalUsdc, "totalUsdc");
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

  if (!APPROVAL_ACTION.has(body.action)) {
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
