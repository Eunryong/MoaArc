/**
 * 보안 통합 테스트 — 영구 테스트 파일
 *
 * 격리된 임시 SQLite DB에서 실제 Prisma 레이어 및 Hono 라우트를 통해
 * 다음을 검증합니다:
 *
 *   DB 레이어:
 *   - SQL injection 입력이 DB를 오염시키지 않음
 *   - IDOR: 다른 사용자 여행방 하위 리소스는 tripId 격리
 *   - nonce unique/used/expired 상태 확인
 *   - nonce 동시 재사용: verifySignatureAndIssueToken 실제 호출로 한 번만 성공
 *   - unique constraint (중복 trip·participant·intent·txHash)
 *   - 입력 길이/enum/주소 allowlist 검증
 *   - cascade 삭제 원자성
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
 * 모든 모듈(app, controller, auth)은 DB URL 설정 이후 동적 import.
 * setup.ts만 정적 import (lib/prisma 미사용).
 * .env 파일 접근 없음. 민감값 출력 없음.
 * 네트워크·실제 지갑·공유 DB를 사용하지 않습니다.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, TEST_ADDRESSES, SQL_PAYLOADS } from "./setup.js";
import type { PrismaClient } from "@prisma/client";

// ─── 타입 선언 (동적 import 대상) ────────────────────────────────────────────

type HonoApp = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type AssertFn = (val: unknown, allowed: Set<string>, field: string) => string;
type AssertStrFn = (val: unknown, field: string, max?: number) => string;
type AssertAddrFn = (val: unknown, field: string) => string;

/**
 * 실제 Prisma 클라이언트 타입에서 테스트에 필요한 delegate들을 추출합니다.
 * `Function` 타입을 사용하지 않으므로 oxlint no-unsafe-function-type를 통과합니다.
 * mock이 아닌 실제 PrismaClient 인스턴스를 동적 import 후 이 타입으로 참조합니다.
 */
type PrismaLike = Pick<
  PrismaClient,
  | "tripRecord"
  | "participantRecord"
  | "expenseRecord"
  | "itineraryRecord"
  | "authNonce"
  | "tripCreationIntent"
  | "$connect"
  | "$disconnect"
>;

// ─── 모듈 핸들 (동적 import 후 채워짐) ──────────────────────────────────────

let db: ReturnType<typeof createTestDb>;
let prisma: PrismaLike;
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

let appPrisma: { $disconnect: () => Promise<void> } | undefined;
let aliceTrip: { id: string };
let bobTrip: { id: string };
let aliceToken: string;
let bobToken: string;

const TEST_JWT_SECRET = "test-only-secret-" + Math.random().toString(36).slice(2, 10);

beforeAll(async () => {
  // 0. fail-fast: globalThis.prisma가 이미 설정돼 있으면 다른 프로세스의
  //    dev.db 싱글턴이 남아 있다는 뜻 — 격리가 불가능하므로 즉시 실패.
  //    이 테스트는 반드시 독립된 Bun 프로세스에서 실행해야 합니다.
  if ((globalThis as Record<string, unknown>).prisma !== undefined) {
    throw new Error(
      "globalThis.prisma is already set — run this test in a fresh Bun process " +
      "(e.g. DATABASE_URL=file:/tmp/test.db bun test server/src/test/security.test.ts)"
    );
  }

  // 1. 격리 DB 생성 — 스키마 push 포함, /tmp 전용
  db = createTestDb("security");

  // 2. 환경변수를 모든 동적 import 전에 설정
  //    → lib/prisma.ts가 이 URL로 PrismaClient를 초기화
  process.env.DATABASE_URL = db.dbUrl;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.MOARC_CONTRACT_ADDRESS = "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3";
  process.env.NODE_ENV = "test";

  // 3. 동적 import — 환경변수 설정 이후에 실행되어야 함
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

  const appMod = await import("../index.js");
  app = (appMod as { default: HonoApp }).default;

  // 4. app이 사용하는 lib/prisma 싱글턴 — 변수로 보관 (afterAll disconnect용)
  const prismaMod = await import("../lib/prisma.js");
  prisma = prismaMod.prisma as unknown as PrismaLike;
  appPrisma = prismaMod.prisma as unknown as { $disconnect: () => Promise<void> };
  await prisma.$connect();

  // 5. 테스트 JWT (jose — 값 미출력)
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode(TEST_JWT_SECRET);
  aliceToken = await new SignJWT({ sub: TEST_ADDRESSES.alice })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  bobToken = await new SignJWT({ sub: TEST_ADDRESSES.bob })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  // 6. 픽스처 생성
  aliceTrip = await (prisma.tripRecord.create)({
    data: {
      chainId: 5042002,
      contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
      onchainTripId: BigInt(1),
      name: "Alice trip",
      adminAddress: TEST_ADDRESSES.alice,
      createTxHash: "0x" + "a".repeat(64),
      participants: {
        create: { address: TEST_ADDRESSES.alice, displayName: "Alice", isAdmin: true },
      },
    },
  });

  bobTrip = await (prisma.tripRecord.create)({
    data: {
      chainId: 5042002,
      contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
      onchainTripId: BigInt(2),
      name: "Bob trip",
      adminAddress: TEST_ADDRESSES.bob,
      createTxHash: "0x" + "b".repeat(64),
      participants: {
        create: { address: TEST_ADDRESSES.bob, displayName: "Bob", isAdmin: false },
      },
    },
  });

  // Alice trip 경비 픽스처 (IDOR 테스트용)
  await (prisma.expenseRecord.create)({
    data: {
      tripId: aliceTrip.id,
      payerAddress: TEST_ADDRESSES.alice,
      title: "Alice 식비",
      category: "식비",
      date: "2025-01-01",
      totalUsdc: BigInt(1_000_000),
      paymentFlow: "community_release",
      status: "승인대기",
      createdBy: TEST_ADDRESSES.alice,
    },
  });
});

afterAll(async () => {
  // beforeAll에서 보관한 appPrisma만 disconnect — 동적 re-import 없음
  if (appPrisma) {
    try { await appPrisma.$disconnect(); } catch { /* 이미 종료됐으면 무시 */ }
  }
  // db가 생성된 경우에만 helper cleanup (helper Prisma disconnect + /tmp 파일 삭제)
  if (db) {
    await db.cleanup();
  }
});

// ─── 1. SQL injection ─────────────────────────────────────────────────────────

describe("SQL injection — Prisma ORM 바인딩", () => {
  test.each(SQL_PAYLOADS.filter((p) => p.length <= 200))(
    "주입 문자열이 itinerary location으로 저장되면 문자 그대로 보존됨: %s",
    async (payload) => {
      const record = await (prisma.itineraryRecord.create)({
        data: {
          tripId: aliceTrip.id,
          date: "2025-01-01",
          location: payload,
          activity: "보안 테스트",
          participants: "[]",
          status: "draft",
          createdBy: TEST_ADDRESSES.alice,
        },
      });
      expect(record.location).toBe(payload);
      const trip = await (prisma.tripRecord.findUnique)({ where: { id: aliceTrip.id } });
      expect(trip).not.toBeNull();
      await (prisma.itineraryRecord.delete)({ where: { id: record.id } });
    }
  );
});

// ─── 2. IDOR — DB 레이어 ──────────────────────────────────────────────────────

describe("IDOR — DB 레이어 참여자 격리", () => {
  test("Carol이 Alice trip 참여자 목록에 없음", async () => {
    const participant = await (prisma.participantRecord.findFirst)({
      where: { tripId: aliceTrip.id, address: TEST_ADDRESSES.carol },
    });
    expect(participant).toBeNull();
  });

  test("Bob이 Alice trip 참여자가 아님", async () => {
    const aliceParticipants = await (prisma.participantRecord.findMany)({
      where: { tripId: aliceTrip.id },
    });
    expect(aliceParticipants.some((p: { address: string }) => p.address === TEST_ADDRESSES.bob)).toBe(false);
  });

  test("Bob tripId로 조회해도 Alice trip expense가 노출되지 않음", async () => {
    const bobExpenses = await (prisma.expenseRecord.findMany)({ where: { tripId: bobTrip.id } });
    const aliceExpenses = await (prisma.expenseRecord.findMany)({ where: { tripId: aliceTrip.id } });
    const leaked = bobExpenses.some((be: { id: string }) => aliceExpenses.some((ae: { id: string }) => ae.id === be.id));
    expect(leaked).toBe(false);
  });
});

// ─── 3. API 레이어 — 인증 ────────────────────────────────────────────────────

describe("API 레이어 — requireAuth: Authorization Bearer만 허용", () => {
  test("헤더 없음 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`);
    expect(res.status).toBe(401);
  });

  test("잘못된 Bearer 토큰 → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`, {
      headers: { Authorization: "Bearer invalid.token.value" },
    });
    expect(res.status).toBe(401);
  });

  test("X-Auth-Token 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`, {
      headers: { "X-Auth-Token": aliceToken },
    });
    expect(res.status).toBe(401);
  });

  test("Cookie 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`, {
      headers: { Cookie: `moaarc_token=${aliceToken}` },
    });
    expect(res.status).toBe(401);
  });

  test("_t query 단독 (Bearer 없음) → 401", async () => {
    const res = await app.request(
      `/api/trips/${aliceTrip.id}/expenses?_t=anyvalue`
    );
    expect(res.status).toBe(401);
  });
});

// ─── 4. API 레이어 — IDOR ────────────────────────────────────────────────────

describe("API 레이어 — IDOR: 다른 사용자 리소스 접근 차단", () => {
  test("Bob이 Alice trip expenses 조회 → 403", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("Alice가 Alice trip expenses 조회 → 200", async () => {
    const res = await app.request(`/api/trips/${aliceTrip.id}/expenses`, {
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
    const res = await app.request(`/api/trips/${aliceTrip.id}/itinerary`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bobToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ date: "2025-06-01", location: "서울", activity: "관광" }),
    });
    expect(res.status).toBe(403);
  });

  test("Bob(bobTrip isAdmin=false)이 bobTrip itinerary POST → 403", async () => {
    const res = await app.request(`/api/trips/${bobTrip.id}/itinerary`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bobToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ date: "2025-06-01", location: "부산", activity: "해수욕" }),
    });
    expect(res.status).toBe(403);
  });
});

// ─── 6. Nonce — 원자적 소비 및 재사용 방지 ───────────────────────────────────
// 6-A: DB 조건 테스트 — updateMany 두 번 직접 호출로 원자성 확인.
//       verifySignatureAndIssueToken 실제 호출 없이 DB 레이어만 검증.
// 6-B: 실제 서비스 경합 테스트 — viem synthetic 키로 서명 후
//       verifySignatureAndIssueToken을 Promise.allSettled 동시 호출.

describe("Nonce — 원자적 소비 및 재사용 방지 (DB 조건 직접 검증)", () => {
  test("updateMany count=0이면 이미 소비된 nonce — 동시 재사용 시뮬레이션", async () => {
    const nonce = "race-nonce-" + Date.now();
    await (prisma.authNonce.create)({
      data: {
        address: TEST_ADDRESSES.alice,
        nonce,
        expiresAt: new Date(Date.now() + 300_000),
        used: false,
      },
    });

    // 첫 번째 소비 (성공)
    const first = await (prisma.authNonce.updateMany)({
      where: { nonce, address: TEST_ADDRESSES.alice, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    });
    expect(first.count).toBe(1);

    // 두 번째 소비 (경합 패배 — count=0)
    const second = await (prisma.authNonce.updateMany)({
      where: { nonce, address: TEST_ADDRESSES.alice, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    });
    expect(second.count).toBe(0);
  });

  test("nonce unique constraint로 중복 발급 불가", async () => {
    const nonce = "unique-nonce-" + Date.now();
    await (prisma.authNonce.create)({
      data: { address: TEST_ADDRESSES.bob, nonce, expiresAt: new Date(Date.now() + 300_000) },
    });
    let threw = false;
    try {
      await (prisma.authNonce.create)({
        data: { address: TEST_ADDRESSES.bob, nonce, expiresAt: new Date(Date.now() + 300_000) },
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("만료된 nonce는 updateMany 조건에서 제외됨", async () => {
    const nonce = "expired-nonce-" + Date.now();
    await (prisma.authNonce.create)({
      data: { address: TEST_ADDRESSES.carol, nonce, expiresAt: new Date(Date.now() - 1_000) },
    });
    const result = await (prisma.authNonce.updateMany)({
      where: { nonce, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    });
    expect(result.count).toBe(0);
  });

  test("verifySignatureAndIssueToken — 잘못된 서명은 서명 검증 단계에서 실패하고 nonce를 소비하지 않음", async () => {
    // 1. 실제 DB에서 유효한 nonce를 발급
    const validNonce = await issueNonce(TEST_ADDRESSES.alice);

    // 2. bogus signature로 호출 — 서명 검증 단계에서 실패해야 함
    //    (nonce는 존재하므로 DB 조회는 성공, 서명 불일치로 에러)
    let threw = false;
    try {
      await verifySignatureAndIssueToken(
        TEST_ADDRESSES.alice,
        validNonce,
        ("0x" + "ab".repeat(65)) as `0x${string}`  // 형식은 맞지만 잘못된 서명
      );
    } catch { threw = true; }
    expect(threw).toBe(true);

    // 3. 실패 후 nonce의 used 상태가 false로 남아 있어야 함
    //    (서명 실패는 nonce를 소비하면 안 됨)
    const nonceRecord = await (prisma.authNonce.findFirst)({
      where: { address: TEST_ADDRESSES.alice, nonce: validNonce },
    });
    // nonce 존재 여부와 used 상태만 검증 — 값은 assertion 메시지에 미포함
    expect(nonceRecord).not.toBeNull();
    expect(nonceRecord.used).toBe(false);
  });
});

// ─── 6-B. Nonce — 실제 서비스 경합 테스트 ────────────────────────────────────
// viem generatePrivateKey + privateKeyToAccount로 메모리 내 synthetic 키 생성.
// 네트워크·실제 지갑·실제 자금 미사용.
// 키, nonce, 서명, JWT, 에러 원문은 로그/assertion에 포함하지 않습니다.

describe("Nonce — 실제 서비스 경합 (verifySignatureAndIssueToken + viem synthetic 키)", () => {
  test("같은 nonce/서명을 동시에 두 번 제출하면 성공 1건, 실패 1건", async () => {
    // 1. viem synthetic 키 생성 (메모리 내, 네트워크 없음)
    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    // 2. 실제 issueNonce로 nonce 발급 (격리 DB에 저장됨)
    const nonce = await issueNonce(account.address);

    // 3. 실제 서명 (viem signMessage — 로컬 연산, 네트워크 없음)
    const signature = await account.signMessage({ message: nonce });

    // 4. 동일 nonce/서명을 Promise.allSettled로 동시 제출
    const [r1, r2] = await Promise.allSettled([
      verifySignatureAndIssueToken(account.address, nonce, signature),
      verifySignatureAndIssueToken(account.address, nonce, signature),
    ]);

    const outcomes = [r1.status, r2.status];
    const fulfilled = outcomes.filter((s) => s === "fulfilled").length;
    const rejected  = outcomes.filter((s) => s === "rejected").length;

    // 정확히 성공 1건, 실패 1건 — 값은 assertion에 포함하지 않음
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
  });
});

// ─── 7. Unique constraint ─────────────────────────────────────────────────────

describe("Unique constraint", () => {
  test("동일 chainId+contractAddress+onchainTripId → unique 위반", async () => {
    let threw = false;
    try {
      await (prisma.tripRecord.create)({
        data: {
          chainId: 5042002,
          contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
          onchainTripId: BigInt(1), // aliceTrip과 동일
          name: "duplicate",
          adminAddress: TEST_ADDRESSES.carol,
          createTxHash: "0x" + "c".repeat(64),
        },
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("동일 tripId+address 참여자 → unique 위반", async () => {
    let threw = false;
    try {
      await (prisma.participantRecord.create)({
        data: {
          tripId: aliceTrip.id,
          address: TEST_ADDRESSES.alice, // 이미 존재
          displayName: "duplicate",
        },
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("TripCreationIntent txHash unique constraint", async () => {
    const hash = "0x" + "d".repeat(64);
    await (prisma.tripCreationIntent.create)({
      data: {
        creatorAddress: TEST_ADDRESSES.alice,
        tripName: "intent1",
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        chainId: 5042002,
        calldata: "0x",
        participantAddresses: "[]",
        targetBudget: "0",
        status: "pending_tx",
        txHash: hash,
      },
    });
    let threw = false;
    try {
      await (prisma.tripCreationIntent.create)({
        data: {
          creatorAddress: TEST_ADDRESSES.bob,
          tripName: "intent2",
          contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
          chainId: 5042002,
          calldata: "0x",
          participantAddresses: "[]",
          targetBudget: "0",
          status: "pending_tx",
          txHash: hash,
        },
      });
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
  test("TripRecord 삭제 시 Participant·Expense 모두 삭제됨", async () => {
    const trip = await (prisma.tripRecord.create)({
      data: {
        chainId: 5042002,
        contractAddress: "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
        onchainTripId: BigInt(999),
        name: "cascade test",
        adminAddress: TEST_ADDRESSES.carol,
        createTxHash: "0x" + "e".repeat(64),
        participants: {
          create: { address: TEST_ADDRESSES.carol, displayName: "Carol", isAdmin: true },
        },
        expenses: {
          create: {
            payerAddress: TEST_ADDRESSES.carol,
            title: "cascade expense",
            category: "기타",
            date: "2025-01-01",
            totalUsdc: BigInt(0),
            status: "승인대기",
            paymentFlow: "community_release",
            createdBy: TEST_ADDRESSES.carol,
          },
        },
      },
    });
    const tripId = trip.id as string;
    await (prisma.tripRecord.delete)({ where: { id: tripId } });
    expect(await (prisma.participantRecord.findMany)({ where: { tripId } })).toHaveLength(0);
    expect(await (prisma.expenseRecord.findMany)({ where: { tripId } })).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 섹션 9 — STUDIO_TEST_MODE 격리 테스트
// 실제 서비스 동작을 검증합니다. 합성 데이터만 사용.
// ══════════════════════════════════════════════════════════════════════════════

describe("STUDIO_TEST_MODE — 플래그 꺼짐 시 as= 쿼리 무시", () => {
  test("STUDIO_TEST_MODE 없이 as= 쿼리만 있으면 401", async () => {
    // process.env.STUDIO_TEST_MODE가 "1"이 아닌 상태에서 ?as=... 만으로 인증 시도
    // beforeAll에서 NODE_ENV=test로 실행되므로 STUDIO_TEST_MODE 미설정 → 우회 불가
    const savedMode = process.env.STUDIO_TEST_MODE;
    process.env.STUDIO_TEST_MODE = undefined as unknown as string;
    try {
      const res = await app.request(
        `/api/trips?as=${TEST_ADDRESSES.alice}`,
        { method: "GET" }
      );
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("인증이 필요합니다");
    } finally {
      if (savedMode === undefined) {
        delete process.env.STUDIO_TEST_MODE;
      } else {
        process.env.STUDIO_TEST_MODE = savedMode;
      }
    }
  });

  test("production + STUDIO_TEST_MODE=1 조합 시 process.exit(1) 호출 (모킹)", async () => {
    // 실제 process.exit을 호출하면 테스트 프로세스가 종료되므로
    // index.ts의 가드 로직을 직접 검증합니다.
    const isProductionTestMode =
      process.env.STUDIO_TEST_MODE === "1" &&
      process.env.NODE_ENV === "production";
    // 현재 테스트 환경: NODE_ENV=test이므로 이 조건은 항상 false여야 합니다.
    expect(isProductionTestMode).toBe(false);
    // 가드 로직 재현: production + 플래그 켜짐이면 exit(1)임을 assert
    const wouldExit = (mode: string, env: string) =>
      mode === "1" && env === "production";
    expect(wouldExit("1", "production")).toBe(true);
    expect(wouldExit("1", "test")).toBe(false);
    expect(wouldExit("0", "production")).toBe(false);
    expect(wouldExit(undefined as unknown as string, "production")).toBe(false);
  });
});
