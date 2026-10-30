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
import { getDb, newId, toIso } from "./db.js";

const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET 환경변수가 설정되지 않았습니다.");
  return new TextEncoder().encode(s);
})();

const NONCE_TTL_MS = 5 * 60 * 1000; // 5분
const TOKEN_TTL = (process.env.JWT_EXPIRY ?? "24h") as string;

// ─── Nonce 발급 ──────────────────────────────────────────────────────────────

export async function issueNonce(address: string): Promise<string> {
  const norm = address.toLowerCase();
  const nonce = `MoaArc 인증 요청\n주소: ${norm}\nnonce: ${randomBytes(16).toString("hex")}\n시각: ${new Date().toISOString()}`;
  const expiresAt = toIso(new Date(Date.now() + NONCE_TTL_MS));

  const db = getDb();
  db.prepare(
    `INSERT INTO AuthNonce (id, address, nonce, expiresAt, used, createdAt)
     VALUES (?, ?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(newId(), norm, nonce, expiresAt);

  return nonce;
}

// ─── 서명 검증 → JWT 발급 ────────────────────────────────────────────────────

export async function verifySignatureAndIssueToken(
  address: string,
  nonce: string,
  signature: `0x${string}`
): Promise<string> {
  const norm = address.toLowerCase() as `0x${string}`;
  const now = toIso(new Date());

  const db = getDb();

  // 1. nonce 존재·주소 일치·만료 여부 사전 확인
  // safeIntegers=true 환경에서 used는 bigint(0n/1n)로 반환될 수 있으므로 Number()로 정규화
  const record = db.prepare(
    `SELECT id, address, used, expiresAt FROM AuthNonce WHERE nonce = ? LIMIT 1`
  ).get(nonce) as { id: string; address: string; used: number | bigint; expiresAt: string } | null;

  if (!record) throw new Error("nonce를 찾을 수 없습니다.");
  if (Number(record.used) !== 0) throw new Error("이미 사용된 nonce입니다.");
  if (record.address !== norm) throw new Error("주소가 nonce와 일치하지 않습니다.");
  if (record.expiresAt <= now) throw new Error("nonce가 만료되었습니다.");

  // 2. 서명 검증 — 실패 시 여기서 throw, nonce는 소비되지 않음
  const valid = await verifyMessage({ address: norm, message: nonce, signature });
  if (!valid) throw new Error("서명 검증 실패");

  // 3. 원자적 nonce 소비:
  //    used=0 AND address 일치 AND expiresAt > now 조건을 만족하는 행만 업데이트.
  //    경합(race condition)으로 다른 요청이 먼저 소비했으면 changes()=0 → 인증 실패.
  //    safeIntegers=true에서 changes는 bigint이므로 Number()로 정규화.
  const result = db.prepare(
    `UPDATE AuthNonce SET used = 1
     WHERE nonce = ? AND address = ? AND used = 0 AND expiresAt > ?`
  ).run(nonce, norm, now);

  if (Number(result.changes) !== 1) {
    throw new Error("nonce 소비 실패: 이미 사용됐거나 만료되었습니다.");
  }

  // 4. JWT 발급 (지갑 주소만 클레임, 민감값 로그 없음)
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
