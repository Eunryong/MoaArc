/**
 * Auth Routes
 * GET  /api/auth/nonce   → { nonce }
 * POST /api/auth/verify  → { token }
 */

import { Hono } from "hono";
import { getNonce, verifyAndIssueToken } from "../controllers/auth.controller.js";

const auth = new Hono();

auth.get("/nonce", getNonce);
auth.post("/verify", verifyAndIssueToken);
// GET 터널 — 게이트웨이가 POST를 차단할 때 ?_method=POST&_body=<base64> 로 우회
auth.get("/verify", verifyAndIssueToken);

export default auth;
