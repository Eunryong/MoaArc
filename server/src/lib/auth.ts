/**
 * 지갑 서명 기반 nonce 인증
 *
 * 흐름:
 *   1. GET /api/auth/nonce?address=0x...  → { nonce }
 *   2. 클라이언트가 nonce 메시지를 지갑으로 서명
 *   3. POST /api/auth/verify  { address, nonce, signature } → { token (JWT) }
 *   4. 이후 모든 요청: Authorization: Bearer <token>
 *
 * 서버는 지갑 개인키를 받거나 저장하지 않습니다.
 * JWT secret은 JWT_SECRET 환경변수에서만 읽습니다.
 */

import { randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { verifyMessage } from "viem";
import { prisma } from "./prisma.js";

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET 환경변수가 설정되지 않았습니다.");
  return new TextEncoder().encode(s);
})();

const NONCE_TTL_MS = 5 * 60 * 1000; // 5분
const TOKEN_TTL = "24h";

// ─── Nonce 발급 ──────────────────────────────────────────────────────────────

export async function issueNonce(address: string): Promise<string> {
  const norm = address.toLowerCase();
  const nonce = `MoaArc 인증 요청\n주소: ${norm}\nnonce: ${randomBytes(16).toString("hex")}\n시각: ${new Date().toISOString()}`;

  await prisma.authNonce.create({
    data: {
      address: norm,
      nonce,
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    },
  });

  return nonce;
}

// ─── 서명 검증 → JWT 발급 ────────────────────────────────────────────────────

export async function verifySignatureAndIssueToken(
  address: string,
  nonce: string,
  signature: `0x${string}`
): Promise<string> {
  const norm = address.toLowerCase() as `0x${string}`;

  // DB에서 nonce 조회
  const record = await prisma.authNonce.findUnique({ where: { nonce } });
  if (!record) throw new Error("nonce를 찾을 수 없습니다.");
  if (record.used) throw new Error("이미 사용된 nonce입니다.");
  if (record.address !== norm) throw new Error("주소가 nonce와 일치하지 않습니다.");
  if (record.expiresAt < new Date()) throw new Error("nonce가 만료되었습니다.");

  // 서명 검증
  const valid = await verifyMessage({ address: norm, message: nonce, signature });
  if (!valid) throw new Error("서명 검증 실패");

  // nonce 소비
  await prisma.authNonce.update({ where: { nonce }, data: { used: true } });

  // JWT 발급 (지갑 주소만 클레임)
  const token = await new SignJWT({ sub: norm })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(JWT_SECRET);

  return token;
}

// ─── JWT 검증 ────────────────────────────────────────────────────────────────

export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (!payload.sub) throw new Error("토큰에 주소가 없습니다.");
  return payload.sub;
}
