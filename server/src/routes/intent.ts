/**
 * Intent routes — 여행방 생성 의도 API
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  prepareCreateTripIntent,
  submitIntentTxHash,
  getIntentStatus,
} from "../controllers/intent.controller.js";

const intent = new Hono();

intent.use("/*", requireAuth);

// POST /api/intent/create-trip  — intent 준비, calldata 반환
// GET  /api/intent/create-trip?_method=POST&_body=<base64>  — 게이트웨이 터널
intent.post("/create-trip", prepareCreateTripIntent);
intent.get("/create-trip", prepareCreateTripIntent);

// POST /api/intent/:intentId/submit  — txHash 제출 + RPC 검증
// GET  /api/intent/:intentId/submit?_method=POST&_body=<base64>  — 게이트웨이 터널
intent.post("/:intentId/submit", submitIntentTxHash);
intent.get("/:intentId/submit", submitIntentTxHash);

// GET  /api/intent/:intentId  — 상태 조회 (polling)
intent.get("/:intentId", getIntentStatus);

export default intent;
