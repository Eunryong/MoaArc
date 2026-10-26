/**
 * Auth Controller — 요청 파싱과 응답 형식만 담당합니다.
 * 업무 규칙은 lib/auth.ts 서비스에 위임합니다.
 */

import type { Context } from "hono";

async function parseBody<T>(c: Context): Promise<T> {
  const tunnelBody = c.get("_tunnelBody" as never) as string | undefined;
  if (tunnelBody) {
    try { return JSON.parse(tunnelBody) as T; }
    catch { throw Object.assign(new Error("터널 body JSON 파싱 실패"), { status: 400 }); }
  }
  return c.req.json<T>();
}
import { issueNonce, verifySignatureAndIssueToken } from "../lib/auth.js";

export async function getNonce(c: Context) {
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
}

export async function verifyAndIssueToken(c: Context) {
  const body = await parseBody<{ address: string; nonce: string; signature: string }>(c);
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
    return c.json({ error: "인증에 실패했습니다. 서명을 확인해주세요." }, 401);
  }
}
