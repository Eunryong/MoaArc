/**
 * MoaArc API Server
 *
 * 실행: bun run server/src/index.ts
 * 포트: PORT 환경변수 (기본 3001)
 *
 * 필수 환경변수:
 *   DATABASE_URL             Prisma DB (SQLite: "file:./server/prisma/dev.db", Postgres: "postgresql://...")
 *   JWT_SECRET               JWT 서명 키 (랜덤 32바이트 이상 권장)
 *   MOARC_CONTRACT_ADDRESS   배포된 MoaArcTreasury 주소
 *   ARC_TESTNET_RPC_FALLBACK Arc Testnet RPC URL (또는 RPC_PROXY_* 세트)
 *
 * 선택 환경변수:
 *   GEMINI_API_KEY           Google AI Studio 키 (미설정 시 에이전트 비활성)
 *   GEMINI_MODEL             Gemini 모델 ID (기본: gemini-2.0-flash)
 *   PORT                     서버 포트 (기본: 3001)
 *   ALLOWED_ORIGINS          CORS 허용 origin 쉼표 목록
 *
 * 배포 환경에서 DATABASE_URL은 영속 Postgres를 사용하세요.
 * SQLite는 컨테이너 재시작 시 데이터가 사라질 수 있습니다.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

// BigInt를 JSON으로 직렬화할 수 없는 문제 전역 처리
// Prisma BigInt 필드(targetBudget, estMinUsdc 등)를 문자열로 반환합니다.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

import auth from "./routes/auth.js";
import trips from "./routes/trips.js";
import agent from "./routes/agent.js";
import intent from "./routes/intent.js";
import {
  verifyServerNetworkConfig,
  getNetworkVerification,
  isNetworkReady,
  ACTIVE_CHAIN_ID,
} from "./lib/chain.js";

const app = new Hono();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS: 쉼표로 구분한 허용 origin 목록
// 미설정 시 개발 환경 기본값 + Arc Studio 프리뷰 도메인을 포함합니다.
const rawOrigins = process.env.ALLOWED_ORIGINS ?? "";
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  // Arc Studio 프리뷰 — 정확한 subdomain을 ALLOWED_ORIGINS에 추가하세요
  // 예: ALLOWED_ORIGINS=https://iwz313xbx2wspvilaq384.preview.studio.arc.io,http://localhost:5173
];
const allowedOrigins = rawOrigins
  ? rawOrigins.split(",").map((o) => o.trim())
  : defaultOrigins;

app.use(
  "*",
  cors({
    // origin 콜백: 허용 목록에 있으면 해당 origin 반환, 없으면 요청 origin 그대로 반환
    // (개발/테스트 편의. 프로덕션에서는 ALLOWED_ORIGINS를 명시적으로 설정하세요.)
    origin: (origin) => {
      if (!origin) return allowedOrigins[0]; // 직접 curl 등 origin 없는 요청
      if (allowedOrigins.includes(origin)) return origin;
      // *.preview.studio.arc.io 도메인은 개발 프리뷰로 허용
      if (origin.endsWith(".preview.studio.arc.io")) return origin;
      // ALLOWED_ORIGINS 미설정(개발) 시 모든 localhost 허용
      if (!rawOrigins && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) return origin;
      return allowedOrigins[0]; // 그 외: 첫 번째 허용 origin으로 응답 (브라우저가 차단)
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ─── HTTP 메서드 터널링 미들웨어 ───────────────────────────────────────────────
// Arc Studio 프리뷰 게이트웨이가 POST/PUT/DELETE를 403으로 차단합니다.
// 클라이언트가 GET ?_method=POST&_body=<base64> 로 터널링하면 여기서 복원합니다.
// _method 터널 body 파싱 미들웨어 — context에 저장, 핸들러에서 getTunnelBody(c)로 읽습니다.
app.use("*", async (c, next) => {
  const tunnelMethod = c.req.query("_method")?.toUpperCase();
  if (tunnelMethod && ["POST", "PUT", "PATCH", "DELETE"].includes(tunnelMethod)) {
    const encodedBody = c.req.query("_body");
    const bodyText = encodedBody
      ? Buffer.from(encodedBody, "base64").toString("utf-8")
      : "{}";
    c.set("_tunnelMethod" as never, tunnelMethod);
    c.set("_tunnelBody" as never, bodyText);
  }
  await next();
});

// ─── 미들웨어 ─────────────────────────────────────────────────────────────────
app.use("*", secureHeaders());
// 개발 환경에서만 요청 로그 활성화 (API 키·토큰이 URL에 없도록 주의)
if (process.env.NODE_ENV === "development") {
  app.use("*", logger());
}

// ─── 상태 확인 ────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    dbConfigured: !!process.env.DATABASE_URL,
    contractConfigured: !!process.env.MOARC_CONTRACT_ADDRESS,
  });
});

// ─── /api/network — 공개 네트워크/컨트랙트 검증 결과 ────────────────────────────
// 반환값에는 민감 정보(토큰, 키, RPC URL) 없음.
// 프런트엔드는 이 엔드포인트로 서버 체인 설정을 확인하고 지갑 서명을 허용합니다.
app.get("/api/network", (c) => {
  const v = getNetworkVerification();
  if (!v) {
    return c.json({
      status: "pending",
      message: "네트워크 검증이 아직 완료되지 않았습니다.",
    }, 503);
  }
  return c.json({
    status: v.ok ? "ok" : "mismatch",
    network: v.network,
    contractAddress: v.contractAddress,
    chainId: v.chainId,
    version: v.version,
    usdcAddress: v.usdcAddress,
    usdcDecimals: v.usdcDecimals,
    errors: v.ok ? [] : v.errors,
  }, v.ok ? 200 : 503);
});

// ─── write API 네트워크 미들웨어 ────────────────────────────────────────────────
// 검증 결과가 없거나 ok=false이면 503을 반환합니다.
// /api/auth, /api/health, /api/network는 차단 제외.
// 테스트에서는 _setVerificationResultForTest()로 결과를 주입한 뒤 이 미들웨어를 통과합니다.
//
// 주의: Hono "/api/trips/*" 패턴은 "/api/trips"(후행 슬래시 없음)에 매칭되지 않습니다.
// 두 패턴을 모두 등록합니다.
const networkGuard: MiddlewareHandler = async (c, next) => {
  const check = isNetworkReady();
  if (!check.ready) {
    return c.json({ error: check.reason }, 503);
  }
  await next();
};

// Hono의 "/api/trips/*" 패턴은 "/api/trips"(후행 슬래시 없음)에 매칭 안 됨.
// 두 패턴을 모두 등록합니다.
app.use("/api/trips", networkGuard);
app.use("/api/trips/*", networkGuard);
app.use("/api/intent", networkGuard);
app.use("/api/intent/*", networkGuard);

// ─── 라우터 등록 ──────────────────────────────────────────────────────────────
app.route("/api/auth", auth);
app.route("/api/trips", trips);
app.route("/api/agent", agent);
app.route("/api/intent", intent);

// ─── 에러 핸들러 ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const isProd = process.env.NODE_ENV === "production";
  // production: 스택 트레이스 미노출. 개발: 전체 출력
  if (isProd) {
    console.error("[server error]", err.message);
  } else {
    console.error("[server error]", err);
  }
  // RangeError(입력 검증 실패)는 400으로 클라이언트에 메시지 노출
  if (err instanceof RangeError) {
    return c.json({ error: err.message }, 400);
  }
  // production: 일반 오류 메시지로 숨김. 개발: 실제 메시지 노출
  const msg = isProd ? "서버 오류가 발생했습니다." : err.message;
  return c.json({ error: msg }, 500);
});


// ─── 서버 시작 ────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3001);
  console.log(`MoaArc API Server listening on port ${port}`);
  serve({ fetch: app.fetch, port });

  // 비동기 네트워크 설정 검증 (서버 실행 차단 안 함)
  // 완료 전까지 /api/trips/* 와 /api/intent/* 는 503 반환 (isNetworkReady() 미들웨어)
  verifyServerNetworkConfig().then((result) => {
    if (result.ok) {
      console.log(
        `[chain] network OK — network=${result.network} chainId=${result.chainId}` +
        ` contract=${result.contractAddress} version=${result.version}` +
        ` usdcDecimals=${result.usdcDecimals}`
      );
    } else {
      // 오류가 있으면 write API가 503으로 차단됨 (isNetworkReady() 참조)
      // 민감값(토큰, RPC URL 파라미터)은 sanitizeError()로 마스킹됨
      console.error(
        `[chain] network MISMATCH (chainId expected=${ACTIVE_CHAIN_ID}):`,
        result.errors
      );
    }
  }).catch((e: unknown) => {
    console.error("[chain] network verification failed:", String(e));
  });
}

export default app;
