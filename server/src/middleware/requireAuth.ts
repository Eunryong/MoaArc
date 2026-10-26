/**
 * JWT 인증 미들웨어 + 여행방 참여자/관리자 권한 검증
 *
 * 인증 경로: Authorization: Bearer <token> 헤더만 허용합니다.
 * X-Auth-Token, Cookie, URL 쿼리 파라미터(_t) 경로는 제거됐습니다.
 * Arc Studio 게이트웨이가 Authorization 헤더를 제거하면 401로 실패합니다.
 * 이것은 보안 차단이며, URL/쿠키/커스텀 헤더 우회 경로는 추가하지 않습니다.
 *
 * [STUDIO_TEST_MODE 우회 — Arc Studio 프리뷰 전용]
 * STUDIO_TEST_MODE==="1" && NODE_ENV!=="production" 일 때만,
 * Authorization 헤더가 없는 경우에 한해 ?as=0x... 쿼리를 callerAddress로 사용합니다.
 * 프로덕션 배포 전 반드시 제거하세요 (docs/STUDIO_TEST_MODE.md 참고).
 */

import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { verifyToken } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

// 0x + 40 hex 주소 정규식
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const STUDIO_TEST_MODE =
  process.env.STUDIO_TEST_MODE === "1" &&
  process.env.NODE_ENV !== "production";

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
  const hasAuthorizationHeader = authHeader.length > 0;
  const hasBearerScheme = authHeader.startsWith("Bearer ");
  const rawToken = hasBearerScheme ? authHeader.slice(7) : null;

  // 진단 로그: 서버 생성 ID만 사용, 헤더 값·토큰값 미기록
  // hasAuthorizationHeader: Authorization 헤더 자체의 도착 여부
  // hasBearerScheme: "Bearer " 스킴 여부 (헤더가 있지만 스킴이 다를 경우 구분)
  // [임시 진단] 도착한 헤더 이름 목록 (소문자 정렬, 값 미기록)
  // authorization/cookie는 이름도 민감하므로 존재 여부(boolean)만 기록
  const reqId = randomUUID();
  const allHeaderNames = [...c.req.raw.headers.keys()]
    .map((h) => h.toLowerCase())
    .filter((h) => h !== "authorization" && h !== "cookie")
    .sort();
  const hasCookieHeader = c.req.raw.headers.has("cookie");
  console.log(
    `[auth] reqId=${reqId}` +
    ` path=${c.req.path}` +
    ` hasAuthorizationHeader=${hasAuthorizationHeader}` +
    ` hasBearerScheme=${hasBearerScheme}` +
    ` hasToken=${!!rawToken}` +
    ` hasCookie=${hasCookieHeader}` +
    ` headers=[${allHeaderNames.join(",")}]`
  );

  if (!rawToken) {
    // [STUDIO_TEST_MODE] Bearer 헤더 없을 때만 ?as= 쿼리 허용
    if (STUDIO_TEST_MODE) {
      const asParam = c.req.query("as") ?? "";
      if (ETH_ADDR_RE.test(asParam)) {
        const studioAddress = asParam.toLowerCase();
        console.log(
          `[auth] reqId=${reqId} path=${c.req.path}` +
          ` mode=studio-test addr=${studioAddress.slice(0, 6)}...`
        );
        c.set("callerAddress", studioAddress);
        return next();
      }
    }
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
