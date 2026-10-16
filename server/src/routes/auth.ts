/**
 * GET  /api/auth/nonce   → { nonce }
 * POST /api/auth/verify  { address, nonce, signature } → { token }
 */

import { Hono } from "hono";
import { issueNonce, verifySignatureAndIssueToken } from "../lib/auth.js";

const auth = new Hono();

auth.get("/nonce", async (c) => {
  const address = c.req.query("address");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "유효한 지갑 주소를 address 쿼리로 전달해주세요." }, 400);
  }
  try {
    const nonce = await issueNonce(address);
    return c.json({ nonce });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

auth.post("/verify", async (c) => {
  const body = await c.req.json<{ address: string; nonce: string; signature: string }>();
  const { address, nonce, signature } = body ?? {};
  if (!address || !nonce || !signature) {
    return c.json({ error: "address, nonce, signature 모두 필요합니다." }, 400);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "유효하지 않은 주소 형식입니다." }, 400);
  }
  if (!/^0x[0-9a-fA-F]{130,132}$/.test(signature)) {
    return c.json({ error: "유효하지 않은 서명 형식입니다." }, 400);
  }
  try {
    const token = await verifySignatureAndIssueToken(
      address,
      nonce,
      signature as `0x${string}`
    );
    return c.json({ token });
  } catch {
    // 인증 실패 시 구체적인 오류 메시지를 노출하지 않음
    return c.json({ error: "인증에 실패했습니다. 서명을 확인해주세요." }, 401);
  }
});

export default auth;
