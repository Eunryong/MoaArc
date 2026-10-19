/**
 * JWT 인증 미들웨어 + 여행방 참여자/관리자 권한 검증
 *
 * 지갑 주소만 헤더에 넣는 것을 인증으로 인정하지 않습니다.
 * 서버는 온체인 참여자 정보를 DB에서 확인합니다.
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
  // 토큰 추출 우선순위:
  // 1) Authorization: Bearer <token>  — 표준 헤더 (Arc Studio 게이트웨이가 제거함, 확인됨)
  // 2) X-Auth-Token: <token>          — 커스텀 헤더 (게이트웨이가 제거함, 확인됨)
  // 3) Cookie: moaarc_token=<token>   — 쿠키 (게이트웨이가 쿠키를 드롭하지 않는다고 확인됨)
  // traces 2026-10-18 실측: Authorization과 X-Auth-Token 모두 게이트웨이에서 제거됨.
  const authHeader = c.req.header("Authorization") ?? "";
  const xAuthToken = c.req.header("X-Auth-Token") ?? "";
  const cookieHeader = c.req.header("Cookie") ?? "";
  const cookieToken = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("moaarc_token="))
    ?.slice("moaarc_token=".length) ?? "";
  const rawToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : xAuthToken || cookieToken || null;
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
