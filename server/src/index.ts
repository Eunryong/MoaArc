/**
 * MoaArc API Server — 진입점
 *
 * 실행: bun run server/src/index.ts
 * 포트: PORT 환경변수 (기본 3001)
 *
 * 필수 환경변수:
 *   DATABASE_PATH            SQLite 파일 경로 (기본: server/prisma/dev.db — bun:sqlite 직접 접근)
 *   DATABASE_URL             DATABASE_PATH 미설정 시 "file:./server/prisma/dev.db" 형식도 지원 (하위 호환)
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
 * 이 파일은 serve() 호출만 담습니다.
 * app 정의(미들웨어·라우트)는 server/src/app.ts에 있습니다.
 *
 * 분리 이유:
 *   bun run으로 실행할 때 `export default app` (Hono 인스턴스)이 있으면
 *   Bun이 해당 인스턴스를 자동 서버로도 실행합니다.
 *   @hono/node-server serve()까지 더해져 같은 PORT에 이중 바인딩되어
 *   EADDRINUSE로 프로세스가 종료됩니다.
 *   이 파일에는 export default가 없으므로 Bun 자동 서버가 실행되지 않습니다.
 */

import { serve } from "@hono/node-server";
import { app } from "./app.js";
import {
  verifyServerNetworkConfig,
  ACTIVE_CHAIN_ID,
} from "./lib/chain.js";

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
    console.error(
      `[chain] network MISMATCH (chainId expected=${ACTIVE_CHAIN_ID}):`,
      result.errors
    );
  }
}).catch((e: unknown) => {
  console.error("[chain] network verification failed:", String(e));
});

// export default 없음 — Bun이 자동 서버를 실행하지 않습니다.
// 테스트는 app.ts를 직접 import합니다.
