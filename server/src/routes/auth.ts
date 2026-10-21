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

export default auth;
