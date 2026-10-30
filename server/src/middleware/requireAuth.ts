/**
 * JWT 인증 미들웨어 + 여행방 참여자/관리자 권한 검증
 *
 * 인증 경로: Authorization: Bearer <token> 헤더만 허용합니다.
 * X-Auth-Token, Cookie, URL 쿼리 파라미터 우회 경로는 없습니다.
 */

import type { Context, Next } from "hono";
import { verifyToken } from "../lib/auth.js";
import { getDb, parseDateField, toBigIntSafe } from "../lib/db.js";

// ─── Hono ContextVariableMap 확장 ────────────────────────────────────────────

interface TripRecord {
  id: string;
  chainId: number;
  contractAddress: string;
  onchainTripId: bigint;
  name: string;
  adminAddress: string;
  createTxHash: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ParticipantRecord {
  id: string;
  tripId: string;
  address: string;
  displayName: string;
  isAdmin: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    callerAddress: string;
    tripRecord: TripRecord;
    participantRecord: ParticipantRecord;
    isAdmin: boolean;
  }
}

// ─── Bearer 토큰 검증 ────────────────────────────────────────────────────────

export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization") ?? "";
  const hasBearerScheme = authHeader.startsWith("Bearer ");
  const rawToken = hasBearerScheme ? authHeader.slice(7) : null;

  if (!rawToken) {
    return c.json({ error: "인증이 필요합니다." }, 401);
  }
  try {
    const address = await verifyToken(rawToken);
    c.set("callerAddress", address);
    await next();
  } catch {
    return c.json({ error: "유효하지 않거나 만료된 토큰입니다." }, 401);
  }
}

// ─── 여행방 참여자 확인 ───────────────────────────────────────────────────────

export async function requireParticipant(c: Context, next: Next) {
  const tripDbId = c.req.param("dbTripId") ?? "";
  const address = c.get("callerAddress");
  const db = getDb();

  // safeIntegers=true: INTEGER 컬럼은 bigint로 반환됨
  const tripRow = db.prepare(
    `SELECT * FROM TripRecord WHERE id = ? LIMIT 1`
  ).get(tripDbId) as {
    id: string; chainId: number | bigint; contractAddress: string;
    onchainTripId: number | bigint | string; name: string; adminAddress: string;
    createTxHash: string; createdAt: string | number; updatedAt: string | number;
  } | null;

  if (!tripRow) return c.json({ error: "여행방을 찾을 수 없습니다." }, 404);

  const participantRow = db.prepare(
    `SELECT * FROM ParticipantRecord WHERE tripId = ? AND address = ? LIMIT 1`
  ).get(tripRow.id, address.toLowerCase()) as {
    id: string; tripId: string; address: string; displayName: string;
    isAdmin: number | bigint;
  } | null;

  if (!participantRow) return c.json({ error: "이 여행방의 참여자가 아닙니다." }, 403);

  const isAdminBool = Number(participantRow.isAdmin) !== 0;

  c.set("tripRecord", {
    ...tripRow,
    chainId: Number(tripRow.chainId),
    onchainTripId: toBigIntSafe(tripRow.onchainTripId) ?? 0n,
    createdAt: parseDateField(tripRow.createdAt) ?? new Date(0),
    updatedAt: parseDateField(tripRow.updatedAt) ?? new Date(0),
  });
  c.set("participantRecord", { ...participantRow, isAdmin: isAdminBool });
  c.set("isAdmin", isAdminBool);
  await next();
}

// ─── 관리자 전용 ─────────────────────────────────────────────────────────────

export async function requireAdmin(c: Context, next: Next) {
  if (!c.get("isAdmin")) {
    return c.json({ error: "관리자 권한이 필요합니다." }, 403);
  }
  await next();
}
