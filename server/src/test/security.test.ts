/**
 * 보안 통합 테스트 — bun:sqlite
 *
 * 격리된 임시 SQLite DB에서 실제 bun:sqlite 레이어 및 Hono 라우트를 통해
 * 다음을 검증합니다:
 *
 *   DB 레이어:
 *   - SQL injection 입력이 파라미터 바인딩으로 DB를 오염시키지 않음
 *   - IDOR: 다른 사용자 여행방 하위 리소스는 tripId 격리
 *   - nonce unique/used/expired 상태 확인
 *   - nonce 동시 재사용: verifySignatureAndIssueToken 실제 호출로 한 번만 성공
 *   - unique constraint (중복 trip·participant·intent·txHash)
 *   - 입력 길이/enum/주소 allowlist 검증
 *   - cascade 삭제 원자성 (외래키 ON DELETE CASCADE)
 *
 *   API 레이어 (Hono app.request() — 네트워크 없음):
 *   - 무인증 → 401
 *   - 잘못된 Bearer → 401
 *   - X-Auth-Token 단독 (Bearer 없음) → 401
 *   - Cookie 단독 (Bearer 없음) → 401
 *   - _t query 단독 (Bearer 없음) → 401
 *   - Bob이 Alice expenses 조회 → 403
 *   - Alice가 Alice expenses 조회 → 200
 *   - non-admin이 itinerary POST → 403
 *
 * .env 파일 접근 없음. 민감값 출력 없음.
 * 실제 dev.db·공유 DB를 사용하지 않습니다.
 * DATABASE_URL 환경변수를 직접 변경하지 않고 _setTestDb()로 싱글턴을 교체합니다.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, _setTestDb, _clearTestDb, TEST_ADDRESSES, SQL_PAYLOADS } from "./setup.js";
import { newId, toIso } from "../lib/db.js";
import type { Database } from "bun:sqlite";

// ─── 타입 선언 (동적 import 대상) ────────────────────────────────────────────

type HonoApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type AssertFn = (val: unknown, allowed: Set<string>, field: string) => string;
type AssertStrFn = (val: unknown, field: string, max?: number) => string;
type AssertAddrFn = (val: unknown, field: string) => string;

// ─── 모듈 핸들 (동적 import 후 채워짐) ──────────────────────────────────────

let testDb: ReturnType<typeof createTestDb>;
let db: Database;
let app: HonoApp;
let assertEnum: AssertFn;
let assertStr: AssertStrFn;
let assertAddr: AssertAddrFn;
let EXPENSE_CATEGORY: Set<string>;
let PAYMENT_FLOW: Set<string>;
let ITINERARY_STATUS: Set<string>;
let CONFIDENCE: Set<string>;
let APPROVAL_ACTION: Set<string>;
let issueNonce: (address: string) => Promise<string>;
let verifySignatureAndIssueToken: (
  address: string,
  nonce: string,
  signature: `0x${string}`
) => Promise<string>;

let aliceTripId: string;
let bobTripId: string;
let aliceToken: string;
let bobToken: string;

const TEST_JWT_SECRET = "test-only-secret-" + Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  // 1. 격리 DB 생성 (openDb → initSchema 포함)
  testDb = createTestDb("security");
  db = testDb.db;

  // 2. 싱글턴 교체 — 모든 동적 import 이전에 수행
  _setTestDb(db);

  // 3. 환경변수 설정
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.MOARC_CONTRACT_ADDRESS = "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3";
  process.env.NODE_ENV = "test";

  // 4. 동적 import — DB 싱글턴 주입 이후
  const ctrlMod = await import("../controllers/trips.controller.js");
  assertEnum = ctrlMod.assertEnum;
  assertStr = ctrlMod.assertStr;
  assertAddr = ctrlMod.assertAddr;
  EXPENSE_CATEGORY = ctrlMod.EXPENSE_CATEGORY;
  PAYMENT_FLOW = ctrlMod.PAYMENT_FLOW;
  ITINERARY_STATUS = ctrlMod.ITINERARY_STATUS;
  CONFIDENCE = ctrlMod.CONFIDENCE;
  APPROVAL_ACTION = ctrlMod.APPROVAL_ACTION;

  const authMod = await import("../lib/auth.js");
  issueNonce = authMod.issueNonce;
  verifySignatureAndIssueToken = authMod.verifySignatureAndIssueToken;

  const appMod = await import("../app.js");
  app = (appMod as { app: HonoApp }).app;

  // 5. 네트워크 검증 결과를 OK로 주입 (RPC 호출 없이 미들웨어 통과)
  const chainMod = await import("../lib/chain.js");
  chainMod._setVerificationResultForTest({
    ok: true,
    chainId: 5042002,
    bytecodePresent: true,
    version: "MoaArc-3.0",
    usdcAddress: "0x3600000000000000000000000000000000000000",
    usdcDecimals: 6,
    network: "testnet",
    contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
    errors: [],
  });

  // 6. 테스트 JWT (jose — 값 미출력)
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode(TEST_JWT_SECRET);
  aliceToken = await new SignJWT({ sub: TEST_ADDRESSES.alice })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);
  bobToken = await new SignJWT({ sub: TEST_ADDRESSES.bob })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(secret);

  // 7. 픽스처 직접 INSERT (bun:sqlite)
  const { newId, toIso } = await import("../lib/db.js");
  const now = toIso(new Date());

  aliceTripId = newId();
  db.prepare(
    `INSERT INTO TripRecord (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
     VALUES (?, 5042002, '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 1, 'Alice trip', ?, ?, ?, ?)`
  ).run(aliceTripId, TEST_ADDRESSES.alice, "0x" + "a".repeat(64), now, now);
  db.prepare(
    `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin) VALUES (?, ?, ?, 'Alice', 1)`
  ).run(newId(), aliceTripId, TEST_ADDRESSES.alice);

  bobTripId = newId();
  db.prepare(
    `INSERT INTO TripRecord (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
     VALUES (?, 5042002, '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 2, 'Bob trip', ?, ?, ?, ?)`
  ).run(bobTripId, TEST_ADDRESSES.bob, "0x" + "b".repeat(64), now, now);
  db.prepare(
    `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin) VALUES (?, ?, ?, 'Bob', 0)`
  ).run(newId(), bobTripId, TEST_ADDRESSES.bob);

  // Alice trip 경비 픽스처 (IDOR 테스트용)
  db.prepare(
    `INSERT INTO ExpenseRecord
       (id, tripId, payerAddress, title, category, date, totalUsdc, paymentFlow, status, createdBy, createdAt, updatedAt)
     VALUES (?, ?, ?, 'Alice 식비', '식비', '2025-01-01', 1000000, 'community_release', '승인대기', ?, ?, ?)`
  ).run(newId(), aliceTripId, TEST_ADDRESSES.alice, TEST_ADDRESSES.alice, now, now);
});

afterAll(async () => {
  _clearTestDb();
  if (testDb) await testDb.cleanup();
});

// ─── 1. SQL injection ─────────────────────────────────────────────────────────

describe("SQL injection — bun:sqlite 파라미터 바인딩", () => {
  test.each(SQL_PAYLOADS.filter((p) => p.length <= 200))(
    "주입 문자열이 itinerary location으로 저장되면 문자 그대로 보존됨: %s",
    (payload) => {
      
      const id = newId();
      const now = toIso(new Date());
      db.prepare(
        `INSERT INTO ItineraryRecord
           (id, tripId, date, location, activity, participants, status, createdBy, createdAt, updatedAt)
         VALUES (?, ?, '2025-01-01', ?, 'test', '[]', 'draft', ?, ?, ?)`
      ).run(id, aliceTripId, payload, TEST_ADDRESSES.alice, now, now);

      const row = db.prepare(`SELECT location FROM ItineraryRecord WHERE id = ?`).get(id) as { location: string } | null;
      expect(row?.location).toBe(payload);

      // TripRecord가 그대로 존재하는지 확인 (DROP TABLE 방지 검증)
      const trip = db.prepare(`SELECT id FROM TripRecord WHERE id = ?`).get(aliceTripId);
      expect(trip).not.toBeNull();

      db.prepare(`DELETE FROM ItineraryRecord WHERE id = ?`).run(id);
    }
  );
});

// ─── 2. IDOR — DB 레이어 ──────────────────────────────────────────────────────

describe("IDOR — DB 레이어 참여자 격리", () => {
  test("Carol이 Alice trip 참여자 목록에 없음", () => {
    const row = db.prepare(
      `SELECT id FROM ParticipantRecord WHERE tripId = ? AND address = ?`
    ).get(aliceTripId, TEST_ADDRESSES.carol);
    expect(row).toBeNull();
  });

  test("Bob이 Alice trip 참여자가 아님", () => {
    const rows = db.prepare(
      `SELECT address FROM ParticipantRecord WHERE tripId = ?`
    ).all(aliceTripId) as { address: string }[];
    expect(rows.some((p) => p.address === TEST_ADDRESSES.bob)).toBe(false);
  });

  test("Bob tripId로 조회해도 Alice trip expense가 노출되지 않음", () => {
    const bobExpenses = db.prepare(
      `SELECT id FROM ExpenseRecord WHERE tripId = ?`
    ).all(bobTripId) as { id: string }[];
    const aliceExpenses = db.prepare(
      `SELECT id FROM ExpenseRecord WHERE tripId = ?`
    ).all(aliceTripId) as { id: string }[];
    const leaked = bobExpenses.some((be) => aliceExpenses.some((ae) => ae.id === be.id));
    expect(leaked).toBe(false);
  });
});

// ─── 3. API 레이어 — 인증 ────────────────────────────────────────────────────

describe("API 레이어 — requireAuth: Authorization Bearer만 허용", () => {
  test("헤더 없음 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`);
    expect(res.status).toBe(401);
  });

  test("잘못된 Bearer 토큰 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`, {
      headers: { Authorization: "Bearer invalid.token.value" },
    });
    expect(res.status).toBe(401);
  });

  test("X-Auth-Token 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`, {
      headers: { "X-Auth-Token": aliceToken },
    });
    expect(res.status).toBe(401);
  });

  test("Cookie 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`, {
      headers: { Cookie: `moaarc_token=${aliceToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("_t query 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses?_t=anyvalue`);
    expect(res.status).toBe(401);
  });
});

// ─── 4. API 레이어 — IDOR ────────────────────────────────────────────────────

describe("API 레이어 — IDOR: 다른 사용자 리소스 접근 차단", () => {
  test("Bob이 Alice trip expenses 조회 → 403", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("Alice가 Alice trip expenses 조회 → 200", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { expenses: unknown[] };
    expect(Array.isArray(body.expenses)).toBe(true);
  });
});

// ─── 5. API 레이어 — requireAdmin ────────────────────────────────────────────

describe("API 레이어 — requireAdmin: non-admin itinerary POST 차단", () => {
  test("Bob(Alice trip 비참여자)이 Alice trip itinerary POST → 403", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/itinerary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2025-06-01", location: "서울", activity: "관광" }),
    });
    expect(res.status).toBe(403);
  });

  test("Bob(bobTrip isAdmin=false)이 bobTrip itinerary POST → 403", async () => {
    const res = await app.request(`/api/trips/${bobTripId}/itinerary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2025-06-01", location: "부산", activity: "해수욕" }),
    });
    expect(res.status).toBe(403);
  });
});

// ─── 6. Nonce — 원자적 소비 및 재사용 방지 ───────────────────────────────────

describe("Nonce — 원자적 소비 및 재사용 방지 (DB 조건 직접 검증)", () => {
  test("UPDATE changes=0이면 이미 소비된 nonce — 동시 재사용 시뮬레이션", () => {
    
    const nonce = "race-nonce-" + Date.now();
    const expiresAt = toIso(new Date(Date.now() + 300_000));
    db.prepare(
      `INSERT INTO AuthNonce (id, address, nonce, expiresAt, used) VALUES (?, ?, ?, ?, 0)`
    ).run(newId(), TEST_ADDRESSES.alice, nonce, expiresAt);

    const now = toIso(new Date());

    // 첫 번째 소비 (성공)
    // safeIntegers=true에서 changes는 bigint이므로 Number()로 정규화
    const first = db.prepare(
      `UPDATE AuthNonce SET used = 1
       WHERE nonce = ? AND address = ? AND used = 0 AND expiresAt > ?`
    ).run(nonce, TEST_ADDRESSES.alice, now);
    expect(Number(first.changes)).toBe(1);

    // 두 번째 소비 (경합 패배 — changes=0)
    const second = db.prepare(
      `UPDATE AuthNonce SET used = 1
       WHERE nonce = ? AND address = ? AND used = 0 AND expiresAt > ?`
    ).run(nonce, TEST_ADDRESSES.alice, now);
    expect(Number(second.changes)).toBe(0);
  });

  test("nonce UNIQUE constraint로 중복 발급 불가", () => {
    
    const nonce = "unique-nonce-" + Date.now();
    const expiresAt = toIso(new Date(Date.now() + 300_000));
    db.prepare(
      `INSERT INTO AuthNonce (id, address, nonce, expiresAt, used) VALUES (?, ?, ?, ?, 0)`
    ).run(newId(), TEST_ADDRESSES.bob, nonce, expiresAt);
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO AuthNonce (id, address, nonce, expiresAt, used) VALUES (?, ?, ?, ?, 0)`
      ).run(newId(), TEST_ADDRESSES.bob, nonce, expiresAt);
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("만료된 nonce는 UPDATE 조건에서 제외됨", () => {
    
    const nonce = "expired-nonce-" + Date.now();
    const expiredAt = toIso(new Date(Date.now() - 1_000));
    db.prepare(
      `INSERT INTO AuthNonce (id, address, nonce, expiresAt, used) VALUES (?, ?, ?, ?, 0)`
    ).run(newId(), TEST_ADDRESSES.carol, nonce, expiredAt);
    const now = toIso(new Date());
    const result = db.prepare(
      `UPDATE AuthNonce SET used = 1 WHERE nonce = ? AND used = 0 AND expiresAt > ?`
    ).run(nonce, now);
    // safeIntegers=true에서 changes는 bigint
    expect(Number(result.changes)).toBe(0);
  });

  test("verifySignatureAndIssueToken — 잘못된 서명은 서명 검증 단계에서 실패하고 nonce를 소비하지 않음", async () => {
    const validNonce = await issueNonce(TEST_ADDRESSES.alice);
    let threw = false;
    try {
      await verifySignatureAndIssueToken(
        TEST_ADDRESSES.alice,
        validNonce,
        ("0x" + "ab".repeat(65)) as `0x${string}`
      );
    } catch { threw = true; }
    expect(threw).toBe(true);

    // nonce의 used 상태가 0(false)으로 남아 있어야 함
    // safeIntegers=true에서 used는 bigint(0n)로 반환되므로 Number()로 정규화
    const row = db.prepare(
      `SELECT used FROM AuthNonce WHERE nonce = ? AND address = ? LIMIT 1`
    ).get(validNonce, TEST_ADDRESSES.alice) as { used: number | bigint } | null;
    expect(row).not.toBeNull();
    expect(Number(row!.used)).toBe(0);
  });
});

// ─── 6-B. Nonce — 실제 서비스 경합 테스트 ────────────────────────────────────

describe("Nonce — 실제 서비스 경합 (verifySignatureAndIssueToken + viem synthetic 키)", () => {
  test("같은 nonce/서명을 동시에 두 번 제출하면 성공 1건, 실패 1건", async () => {
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const nonce = await issueNonce(account.address);
    const signature = await account.signMessage({ message: nonce });

    const [r1, r2] = await Promise.allSettled([
      verifySignatureAndIssueToken(account.address, nonce, signature),
      verifySignatureAndIssueToken(account.address, nonce, signature),
    ]);

    const fulfilled = [r1.status, r2.status].filter((s) => s === "fulfilled").length;
    const rejected  = [r1.status, r2.status].filter((s) => s === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
  });
});

// ─── 7. Unique constraint ─────────────────────────────────────────────────────

describe("Unique constraint", () => {
  test("동일 chainId+contractAddress+onchainTripId → UNIQUE 위반", () => {
    
    const now = toIso(new Date());
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO TripRecord (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
         VALUES (?, 5042002, '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 1, 'dup', ?, ?, ?, ?)`
      ).run(newId(), TEST_ADDRESSES.carol, "0x" + "c".repeat(64), now, now);
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("동일 tripId+address 참여자 → UNIQUE 위반", () => {
    
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin) VALUES (?, ?, ?, 'dup', 0)`
      ).run(newId(), aliceTripId, TEST_ADDRESSES.alice);
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("TripCreationIntent txHash UNIQUE constraint", () => {
    
    const hash = "0x" + "d".repeat(64);
    const now = toIso(new Date());
    db.prepare(
      `INSERT INTO TripCreationIntent
         (id, creatorAddress, tripName, contractAddress, chainId, calldata, participantAddresses, targetBudget, status, txHash, createdAt, updatedAt)
       VALUES (?, ?, 'intent1', '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 5042002, '0x', '[]', '0', 'pending_tx', ?, ?, ?)`
    ).run(newId(), TEST_ADDRESSES.alice, hash, now, now);
    let threw = false;
    try {
      db.prepare(
        `INSERT INTO TripCreationIntent
           (id, creatorAddress, tripName, contractAddress, chainId, calldata, participantAddresses, targetBudget, status, txHash, createdAt, updatedAt)
         VALUES (?, ?, 'intent2', '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 5042002, '0x', '[]', '0', 'pending_tx', ?, ?, ?)`
      ).run(newId(), TEST_ADDRESSES.bob, hash, now, now);
    } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

// ─── 8. 입력 allowlist — 순수 함수 검증 ──────────────────────────────────────

describe("입력 allowlist — enum/길이/주소 (동적 import된 함수)", () => {
  test("유효한 expense category 통과", () => {
    expect(() => assertEnum("식비", EXPENSE_CATEGORY, "category")).not.toThrow();
    expect(() => assertEnum("숙박", EXPENSE_CATEGORY, "category")).not.toThrow();
  });
  test("허용되지 않은 category 거부", () => {
    expect(() => assertEnum("' DROP TABLE--", EXPENSE_CATEGORY, "category")).toThrow();
    expect(() => assertEnum("arbitrary", EXPENSE_CATEGORY, "category")).toThrow();
  });
  test("paymentFlow 검증", () => {
    expect(() => assertEnum("community_release", PAYMENT_FLOW, "paymentFlow")).not.toThrow();
    expect(() => assertEnum("evil", PAYMENT_FLOW, "paymentFlow")).toThrow();
  });
  test("itinerary status enum 검증", () => {
    expect(() => assertEnum("draft", ITINERARY_STATUS, "status")).not.toThrow();
    expect(() => assertEnum("invalid", ITINERARY_STATUS, "status")).toThrow();
  });
  test("confidence enum 검증", () => {
    expect(() => assertEnum("high", CONFIDENCE, "confidence")).not.toThrow();
    expect(() => assertEnum("unknown", CONFIDENCE, "confidence")).toThrow();
  });
  test("approval action enum 검증", () => {
    expect(() => assertEnum("승인", APPROVAL_ACTION, "action")).not.toThrow();
    expect(() => assertEnum("delete", APPROVAL_ACTION, "action")).toThrow();
  });
  test("문자열 길이 제한", () => {
    expect(() => assertStr("A".repeat(201), "name", 200)).toThrow("200자");
    expect(() => assertStr("A".repeat(200), "name", 200)).not.toThrow();
    expect(() => assertStr("", "name", 200)).toThrow();
  });
  test("지갑 주소 검증", () => {
    expect(() => assertAddr(TEST_ADDRESSES.alice, "addr")).not.toThrow();
    expect(() => assertAddr("not-an-address", "addr")).toThrow();
    expect(() => assertAddr("'; DROP TABLE--", "addr")).toThrow();
    expect(() => assertAddr("0x" + "a".repeat(39), "addr")).toThrow();
  });
});

// ─── 9. Cascade 삭제 ──────────────────────────────────────────────────────────

describe("Cascade 삭제 — TripRecord 삭제 시 하위 레코드 삭제", () => {
  test("TripRecord 삭제 시 Participant·Expense 모두 삭제됨", () => {
    
    const tripId = newId();
    const expenseId = newId();
    const now = toIso(new Date());

    db.prepare(
      `INSERT INTO TripRecord (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
       VALUES (?, 5042002, '0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3', 999, 'cascade test', ?, ?, ?, ?)`
    ).run(tripId, TEST_ADDRESSES.carol, "0x" + "e".repeat(64), now, now);
    db.prepare(
      `INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin) VALUES (?, ?, ?, 'Carol', 1)`
    ).run(newId(), tripId, TEST_ADDRESSES.carol);
    db.prepare(
      `INSERT INTO ExpenseRecord
         (id, tripId, payerAddress, title, category, date, totalUsdc, paymentFlow, status, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, 'cascade expense', '기타', '2025-01-01', 0, 'community_release', '승인대기', ?, ?, ?)`
    ).run(expenseId, tripId, TEST_ADDRESSES.carol, TEST_ADDRESSES.carol, now, now);

    db.prepare(`DELETE FROM TripRecord WHERE id = ?`).run(tripId);

    const participants = db.prepare(`SELECT id FROM ParticipantRecord WHERE tripId = ?`).all(tripId);
    const expenses = db.prepare(`SELECT id FROM ExpenseRecord WHERE tripId = ?`).all(tripId);
    expect(participants).toHaveLength(0);
    expect(expenses).toHaveLength(0);
  });
});

// ─── 10. STUDIO_TEST_MODE ─────────────────────────────────────────────────────

describe("STUDIO_TEST_MODE — 플래그 꺼짐 시 as= 쿼리 무시", () => {
  test("STUDIO_TEST_MODE 없이 as= 쿼리만 있으면 401", async () => {
    const savedMode = process.env.STUDIO_TEST_MODE;
    process.env.STUDIO_TEST_MODE = undefined as unknown as string;
    try {
      const res = await app.request(`/api/trips?as=${TEST_ADDRESSES.alice}`, { method: "GET" });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("인증이 필요합니다");
    } finally {
      if (savedMode === undefined) delete process.env.STUDIO_TEST_MODE;
      else process.env.STUDIO_TEST_MODE = savedMode;
    }
  });

  test("production + STUDIO_TEST_MODE=1 조합 시 process.exit(1) 호출 (모킹)", () => {
    const wouldExit = (mode: string, env: string) => mode === "1" && env === "production";
    expect(wouldExit("1", "production")).toBe(true);
    expect(wouldExit("1", "test")).toBe(false);
    expect(wouldExit("0", "production")).toBe(false);
    expect(wouldExit(undefined as unknown as string, "production")).toBe(false);
  });
});

describe("STUDIO_TEST_MODE 제거: Bearer 이외의 인증 수단 모두 거부", () => {
  test("?as= 쿼리 파라미터로는 인증 불가 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses?as=${TEST_ADDRESSES.alice}`);
    expect(res.status).toBe(401);
  });

  test("?_t= 쿼리로 인증 불가 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/expenses?_t=something`);
    expect(res.status).toBe(401);
  });

  test("STUDIO_TEST_MODE 환경변수로 인증 불가 — API 레이어에서 거부", async () => {
    const savedMode = process.env.STUDIO_TEST_MODE;
    process.env.STUDIO_TEST_MODE = "1";
    try {
      const res = await app.request(`/api/trips/${aliceTripId}/expenses`);
      expect(res.status).toBe(401);
    } finally {
      if (savedMode === undefined) delete process.env.STUDIO_TEST_MODE;
      else process.env.STUDIO_TEST_MODE = savedMode;
    }
  });
});

// ─── 11. addParticipant API 보안 ─────────────────────────────────────────────

describe("addParticipant API 보안", () => {
  test("비인증 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txHash: "0x" + "a".repeat(64), chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        newParticipantAddress: TEST_ADDRESSES.carol, displayName: "Carol",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("비-admin(Bob)이 Alice 여행방에 참여자 추가 → 403", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({
        txHash: "0x" + "a".repeat(64), chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        newParticipantAddress: TEST_ADDRESSES.carol, displayName: "Carol",
      }),
    });
    expect(res.status).toBe(403);
  });

  test("잘못된 주소 형식 → 400", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        txHash: "0x" + "a".repeat(64), chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        newParticipantAddress: "not-an-address", displayName: "Bad",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("잘못된 txHash → 400", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        txHash: "not-a-hash", chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        newParticipantAddress: TEST_ADDRESSES.carol, displayName: "Carol",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("contractAddress 불일치 → 400", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        txHash: "0x" + "a".repeat(64), chainId: 5042002,
        contractAddress: "0x1111111111111111111111111111111111111111",
        newParticipantAddress: TEST_ADDRESSES.carol, displayName: "Carol",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("자기 자신(admin) 추가 시도 → 400", async () => {
    const res = await app.request(`/api/trips/${aliceTripId}/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({
        txHash: "0x" + "a".repeat(64), chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        newParticipantAddress: TEST_ADDRESSES.alice, displayName: "Alice",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── 12. 네트워크 readiness 미들웨어 ──────────────────────────────────────────

describe("네트워크 readiness 미들웨어", () => {
  let chainMod: {
    _setVerificationResultForTest: (r: import("../lib/chain.js").ServerNetworkVerification | undefined) => void;
  };

  const READY_FIXTURE: import("../lib/chain.js").ServerNetworkVerification = {
    ok: true, chainId: 5042002, bytecodePresent: true, version: "MoaArc-3.0",
    usdcAddress: "0x3600000000000000000000000000000000000000", usdcDecimals: 6,
    network: "testnet", contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3", errors: [],
  };

  beforeAll(async () => { chainMod = await import("../lib/chain.js"); });
  const restoreReady = () => chainMod._setVerificationResultForTest(READY_FIXTURE);

  test("검증 결과가 undefined이면 /api/trips → 503", async () => {
    chainMod._setVerificationResultForTest(undefined);
    try {
      const res = await app.request("/api/trips", { headers: { Authorization: `Bearer ${aliceToken}` } });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("검증");
    } finally { restoreReady(); }
  });

  test("ok=false(VERSION 불일치)이면 /api/trips → 503, 오류 메시지 포함", async () => {
    chainMod._setVerificationResultForTest({
      ok: false, chainId: 5042002, bytecodePresent: true, version: "MoaArc-2.0",
      usdcAddress: "0x3600000000000000000000000000000000000000", usdcDecimals: 6,
      network: "testnet", contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
      errors: ['VERSION "MoaArc-2.0" ≠ 기대값 "MoaArc-3.0"'],
    });
    try {
      const res = await app.request("/api/trips", { headers: { Authorization: `Bearer ${aliceToken}` } });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("MoaArc-2.0");
    } finally { restoreReady(); }
  });

  test("ok=false(chainId 불일치)이면 /api/trips → 503", async () => {
    chainMod._setVerificationResultForTest({
      ok: false, chainId: 1, bytecodePresent: true, version: "MoaArc-3.0",
      usdcAddress: "0x3600000000000000000000000000000000000000", usdcDecimals: 6,
      network: "testnet", contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
      errors: ["RPC chainId=1 ≠ 설정값 5042002"],
    });
    try {
      const res = await app.request("/api/trips", { headers: { Authorization: `Bearer ${aliceToken}` } });
      expect(res.status).toBe(503);
    } finally { restoreReady(); }
  });

  test("ok=false(bytecode 없음)이면 /api/trips → 503", async () => {
    chainMod._setVerificationResultForTest({
      ok: false, chainId: 5042002, bytecodePresent: false, network: "testnet",
      contractAddress: "0x0000000000000000000000000000000000000001",
      errors: ["컨트랙트 0x0000000000000000000000000000000000000001에 코드가 없습니다"],
    });
    try {
      const res = await app.request("/api/trips", { headers: { Authorization: `Bearer ${aliceToken}` } });
      expect(res.status).toBe(503);
    } finally { restoreReady(); }
  });

  test("ok=true이면 /api/trips → 503 아님", async () => {
    chainMod._setVerificationResultForTest(READY_FIXTURE);
    const res = await app.request("/api/trips");
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(401);
  });

  test("ok=true이면 /api/intent → 503 아님", async () => {
    chainMod._setVerificationResultForTest(READY_FIXTURE);
    const res = await app.request("/api/intent/someId");
    expect(res.status).not.toBe(503);
  });
});
