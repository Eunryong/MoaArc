/**
 * JWT 인증 미들웨어 + 여행방 참여자/관리자 권한 검증
 *
 * 인증 경로: Authorization: Bearer <token> 헤더만 허용합니다.
 * X-Auth-Token, Cookie, URL 쿼리 파라미터 우회 경로는 없습니다.
 * Vite 개발 프록시(/api → localhost:3001)가 Authorization 헤더를 그대로 전달합니다.
 */

import type { Context, Next } from "hono";
import { verifyToken } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

declare module "hono" {
  interface ContextVariableMap {
    callerAddress: string;
    tripRecord: Awaited<ReturnType<typeof prisma.tripRecord.findUniqueOrThrow>>;
    participantRecord: Awaited<ReturnType<typeof prisma.participantRecord.findFirstOrThrow>>;
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
// :dbTripId = TripRecord.id (cuid)

export async function requireParticipant(c: Context, next: Next) {
  const tripDbId = c.req.param("dbTripId");
  const address = c.get("callerAddress");

  const trip = await prisma.tripRecord.findUnique({ where: { id: tripDbId } });
  if (!trip) return c.json({ error: "여행방을 찾을 수 없습니다." }, 404);

  const participant = await prisma.participantRecord.findFirst({
    where: { tripId: trip.id, address },
  });
  if (!participant) return c.json({ error: "이 여행방의 참여자가 아닙니다." }, 403);

  c.set("tripRecord", trip);
  c.set("participantRecord", participant);
  c.set("isAdmin", participant.isAdmin);
  await next();
}

// ─── 관리자 전용 ────────────────────────────────────────────────────────────

export async function requireAdmin(c: Context, next: Next) {
  if (!c.get("isAdmin")) {
    return c.json({ error: "관리자 권한이 필요합니다." }, 403);
  }
  await next();
}
