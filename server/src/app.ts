/**
 * MoaArc Hono app 정의 — 서버 시작 없음
 *
 * 이 파일은 Hono app 인스턴스와 미들웨어/라우트를 정의하고 export합니다.
 * serve() 호출이 없으므로 bun이 export default를 자동 서버로 실행하지 않습니다.
 *
 * 서버 시작은 server/src/index.ts (진입점)에서만 합니다.
 * 테스트는 이 파일을 import해 app.request()로 HTTP 없이 테스트합니다.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

// BigInt JSON 직렬화: db.ts에서 전역 설정됩니다 (getDb() 첫 호출 시).
// app.ts 레이어에서 BigInt를 JSON으로 반환하기 전에 getDb()가 항상 먼저 호출됩니다.

import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

import auth from "./routes/auth.js";
import trips from "./routes/trips.js";
import agent from "./routes/agent.js";
import intent from "./routes/intent.js";
import {
  getNetworkVerification,
  isNetworkReady,
} from "./lib/chain.js";

const app = new Hono();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS ?? "";
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
];
const allowedOrigins = rawOrigins
  ? rawOrigins.split(",").map((o) => o.trim())
  : defaultOrigins;

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.endsWith(".preview.studio.arc.io")) return origin;
      if (!rawOrigins && (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))) return origin;
      return allowedOrigins[0];
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ─── HTTP 메서드 터널링 미들웨어 ───────────────────────────────────────────────
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
if (process.env.NODE_ENV === "development") {
  app.use("*", logger());
}

// ─── 상태 확인 ────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => {
  return c.json({
    status: "ok",
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    dbConfigured: !!(process.env.DATABASE_PATH ?? process.env.DATABASE_URL),
    contractConfigured: !!process.env.MOARC_CONTRACT_ADDRESS,
  });
});

// ─── /api/network ─────────────────────────────────────────────────────────────
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
const networkGuard: MiddlewareHandler = async (c, next) => {
  const check = isNetworkReady();
  if (!check.ready) {
    return c.json({ error: check.reason }, 503);
  }
  await next();
};

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
  if (isProd) {
    console.error("[server error]", err.message);
  } else {
    console.error("[server error]", err);
  }
  if (err instanceof RangeError) {
    return c.json({ error: err.message }, 400);
  }
  const msg = isProd ? "서버 오류가 발생했습니다." : err.message;
  return c.json({ error: msg }, 500);
});

// export default는 Hono 인스턴스가 아니라 fetch handler 형태로 노출하지 않습니다.
// bun이 { fetch } 형태의 default export를 자동 서버로 실행하는 것을 방지합니다.
// serve() 호출은 index.ts에서만 합니다.
export { app };
