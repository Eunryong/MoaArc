/**
 * Prisma SQLite 호환성 테스트 — :memory: 전용, 실제 DB 파일 미접촉
 *
 * 목적:
 *  Prisma quaint native driver가 SQLite에 저장하는 형식과 우리 bun:sqlite 읽기 코드
 *  사이의 호환성을 검증합니다.
 *
 * Prisma(quaint native) SQLite 저장 형식 (소스 검증):
 *  - DateTime  → INTEGER  Unix epoch 밀리초  (ToSql: value.timestamp_millis())
 *  - Boolean   → BOOLEAN 컬럼에 INTEGER 0/1  (rusqlite default)
 *  - BigInt    → INTEGER  (64비트 signed)
 *  - String    → TEXT
 *  - Int       → INTEGER
 *  - Float     → REAL
 *  - JSON/enum → TEXT
 *  - Prisma schema의 DateTime 컬럼 선언 타입: NUMERIC (migration engine 기준)
 *    quaint는 decl_type이 DATETIME/TIMESTAMP일 때만 INTEGER를 밀리초로 해석하고,
 *    NUMERIC 컬럼의 INTEGER는 Int64로 읽음 — 그러나 우리 코드는 parseDateField()로
 *    number/bigint이면 new Date(Number(v))로 처리하므로 어느 쪽이든 정확히 변환됩니다.
 *
 * 검증 항목:
 *  1. DateTime INTEGER(밀리초) → Date 정확도 (ms 단위)
 *  2. Boolean INTEGER(0/1) → boolean
 *  3. BigInt INTEGER(> 2^53) → bigint 정밀도 무손실
 *  4. BigInt STRING(저장 시 .toString()) → bigint
 *  5. NULL 날짜 → null
 *  6. TEXT ISO-8601 날짜 → Date (현재 코드베이스 기본 형식)
 *  7. 전체 CRUD: createTrip → findTripById 왕복
 *  8. Prisma 형식 fixture를 직접 INSERT → findTripById 왕복
 *  9. 알림 read 플래그 (INTEGER 0/1)
 * 10. itinerary estMinUsdc BigInt NULL 처리
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../lib/schema.sql.js";
import {
  parseDateField,
  toBigIntSafe,
  toIso,
  newId,
  _setTestDb,
  _clearTestDb,
} from "../lib/db.js";
import {
  createTrip,
  findTripById,
  createItineraryItem,
  findItinerary,
  createExpense,
  findExpenses,
  findParticipant,
} from "../repositories/trip.repository.js";
import { createIntent, findIntentById } from "../repositories/intent.repository.js";

// ─── 헬퍼 ──────────────────────────────────────────────────────────────────────

function openMemory(): Database {
  // safeIntegers: true — openDb()와 동일하게 모든 INTEGER를 bigint로 반환
  const db = new Database(":memory:", { safeIntegers: true });
  initSchema(db);
  return db;
}

// 주소 상수
const ADMIN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ─── 단위: parseDateField ──────────────────────────────────────────────────────

describe("parseDateField 단위", () => {
  test("null → null", () => {
    expect(parseDateField(null)).toBeNull();
    expect(parseDateField(undefined)).toBeNull();
    expect(parseDateField("")).toBeNull();
  });

  test("INTEGER 밀리초 epoch → Date (Prisma 기존 형식)", () => {
    const ms = 1735689600123; // 2025-01-01T00:00:00.123Z
    const d = parseDateField(ms);
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(ms);
    expect(d!.toISOString()).toBe("2025-01-01T00:00:00.123Z");
  });

  test("bigint 밀리초 → Date", () => {
    const ms = 1735689600000n;
    const d = parseDateField(ms);
    expect(d!.getTime()).toBe(1735689600000);
  });

  test("TEXT ISO-8601 → Date (현재 코드베이스 형식)", () => {
    const iso = "2025-06-15T12:34:56.789Z";
    const d = parseDateField(iso);
    expect(d!.getTime()).toBe(new Date(iso).getTime());
  });

  test("TEXT '%Y-%m-%d %H:%M:%S' (quaint TEXT fallback) → Date", () => {
    // quaint가 TEXT 컬럼에서 읽을 때 쓰는 포맷
    const s = "2025-06-15 12:34:56";
    const d = parseDateField(s);
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2025);
    expect(d!.getMonth()).toBe(5); // 0-indexed
    expect(d!.getDate()).toBe(15);
  });

  test("epoch 0 (1970-01-01) → Date(0)", () => {
    expect(parseDateField(0)!.getTime()).toBe(0);
  });
});

// ─── 단위: toBigIntSafe ────────────────────────────────────────────────────────

describe("toBigIntSafe 단위", () => {
  test("null/undefined → null", () => {
    expect(toBigIntSafe(null)).toBeNull();
    expect(toBigIntSafe(undefined)).toBeNull();
  });

  test("안전 범위 number → bigint 손실 없음", () => {
    expect(toBigIntSafe(1234567)).toBe(1234567n);
    expect(toBigIntSafe(0)).toBe(0n);
  });

  test("Number.MAX_SAFE_INTEGER → bigint", () => {
    expect(toBigIntSafe(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test("bigint → 그대로 반환", () => {
    const big = 9999999999999999999n;
    expect(toBigIntSafe(big)).toBe(big);
  });

  test("string '123' → bigint", () => {
    expect(toBigIntSafe("123")).toBe(123n);
  });

  test("string '0' → 0n", () => {
    expect(toBigIntSafe("0")).toBe(0n);
  });

  test("큰 uint256 string → bigint (정밀도 무손실)", () => {
    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(toBigIntSafe(big)!.toString()).toBe(big);
  });

  test("빈 string → null", () => {
    expect(toBigIntSafe("")).toBeNull();
  });
});

// ─── Prisma 형식 fixture — :memory: DB에 직접 INSERT ──────────────────────────
//
// Prisma quaint native driver가 실제로 기록하는 방식으로 row를 삽입한 후
// 우리 repository 코드로 읽어 정확히 변환되는지 검증합니다.

describe("Prisma 형식 fixture → repository 읽기 호환", () => {
  let db: Database;

  const TRIP_ID = "prisma-compat-trip-1";
  const PART_ID = "prisma-compat-part-1";
  const EXPENSE_ID = "prisma-compat-expense-1";
  const VERSION_ID = "prisma-compat-version-1";
  const APPROVAL_ID = "prisma-compat-approval-1";
  const ITINERARY_ID = "prisma-compat-itinerary-1";

  // Prisma가 저장하는 날짜 값: INTEGER 밀리초
  const CREATED_MS = 1735689600000; // 2025-01-01T00:00:00.000Z
  const UPDATED_MS = 1735693200000; // 2025-01-01T01:00:00.000Z

  // Prisma BigInt(totalUsdc): INTEGER, 안전 범위 내
  const TOTAL_USDC_INT = 5_000_000; // 5 USDC

  beforeAll(() => {
    db = openMemory();
    _setTestDb(db);

    // TripRecord — Prisma 형식: createdAt/updatedAt = INTEGER ms
    db.exec(`
      INSERT INTO TripRecord
        (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash, createdAt, updatedAt)
      VALUES
        ('${TRIP_ID}', 5042002, '0xcontract', 42, '프리즈마 호환 테스트', '${ADMIN}', '0xtxhash',
         ${CREATED_MS}, ${UPDATED_MS})
    `);

    // ParticipantRecord — isAdmin: Prisma BOOLEAN → INTEGER 1
    db.exec(`
      INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin)
      VALUES ('${PART_ID}', '${TRIP_ID}', '${ADMIN}', '관리자', 1)
    `);

    // ExpenseRecord — totalUsdc: INTEGER, createdAt/updatedAt: INTEGER ms
    db.exec(`
      INSERT INTO ExpenseRecord
        (id, tripId, payerAddress, title, category, date, totalUsdc, paymentFlow,
         currentVersion, status, createdBy, createdAt, updatedAt)
      VALUES
        ('${EXPENSE_ID}', '${TRIP_ID}', '${ADMIN}', '숙박비', '숙박', '2025-01-01',
         ${TOTAL_USDC_INT}, 'USDC_DIRECT', 1, '승인대기', '${ADMIN}',
         ${CREATED_MS}, ${UPDATED_MS})
    `);

    // ExpenseVersion
    db.exec(`
      INSERT INTO ExpenseVersion
        (id, expenseId, version, shares, proposedBy, reason, status, proposedAt)
      VALUES
        ('${VERSION_ID}', '${EXPENSE_ID}', 1,
         '[{"address":"${ADMIN}","amountUsdc":"5000000"}]',
         '${ADMIN}', '최초 등록', '승인대기', ${CREATED_MS})
    `);

    // ExpenseApproval
    db.exec(`
      INSERT INTO ExpenseApproval (id, versionId, address, action, approvedAt)
      VALUES ('${APPROVAL_ID}', '${VERSION_ID}', '${ADMIN}', '승인', ${CREATED_MS})
    `);

    // ItineraryRecord — estMinUsdc: INTEGER, estAt: INTEGER ms, createdAt/updatedAt: INTEGER ms
    db.exec(`
      INSERT INTO ItineraryRecord
        (id, tripId, date, location, activity, participants, status,
         estMinUsdc, estMaxUsdc, createdBy, createdAt, updatedAt)
      VALUES
        ('${ITINERARY_ID}', '${TRIP_ID}', '2025-01-01', '호텔', '체크인', '[]', 'draft',
         2000000, 3000000, '${ADMIN}', ${CREATED_MS}, ${UPDATED_MS})
    `);
  });

  afterAll(() => {
    _clearTestDb();
    db.close();
  });

  test("findTripById — createdAt/updatedAt INTEGER ms → Date 정확", async () => {
    const trip = await findTripById(TRIP_ID);
    expect(trip).not.toBeNull();
    expect(trip!.createdAt.getTime()).toBe(CREATED_MS);
    expect(trip!.updatedAt.getTime()).toBe(UPDATED_MS);
    expect(trip!.createdAt.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  test("findTripById — onchainTripId INTEGER → bigint", async () => {
    const trip = await findTripById(TRIP_ID);
    expect(typeof trip!.onchainTripId).toBe("bigint");
    expect(trip!.onchainTripId).toBe(42n);
  });

  test("findTripById — chainId → number", async () => {
    const trip = await findTripById(TRIP_ID);
    expect(typeof trip!.chainId).toBe("number");
    expect(trip!.chainId).toBe(5042002);
  });

  test("participant isAdmin INTEGER 1 → boolean true", async () => {
    const p = await findParticipant(TRIP_ID, ADMIN);
    expect(p).not.toBeNull();
    expect(p!.isAdmin).toBe(true);
    expect(typeof p!.isAdmin).toBe("boolean");
  });

  test("findExpenses — totalUsdc INTEGER → bigint", async () => {
    const expenses = await findExpenses(TRIP_ID);
    expect(expenses.length).toBe(1);
    expect(typeof expenses[0].totalUsdc).toBe("bigint");
    expect(expenses[0].totalUsdc).toBe(BigInt(TOTAL_USDC_INT));
  });

  test("findExpenses — expense createdAt INTEGER ms → Date", async () => {
    const expenses = await findExpenses(TRIP_ID);
    expect(expenses[0].createdAt.getTime()).toBe(CREATED_MS);
  });

  test("findExpenses — version proposedAt INTEGER ms → Date", async () => {
    const expenses = await findExpenses(TRIP_ID);
    const v = expenses[0].versions[0];
    expect(v.proposedAt.getTime()).toBe(CREATED_MS);
  });

  test("findExpenses — approval approvedAt INTEGER ms → Date", async () => {
    const expenses = await findExpenses(TRIP_ID);
    const a = expenses[0].versions[0].approvals[0];
    expect(a.approvedAt.getTime()).toBe(CREATED_MS);
  });

  test("findItinerary — estMinUsdc INTEGER → bigint", async () => {
    const items = await findItinerary(TRIP_ID);
    expect(items.length).toBe(1);
    expect(typeof items[0].estMinUsdc).toBe("bigint");
    expect(items[0].estMinUsdc).toBe(2000000n);
    expect(items[0].estMaxUsdc).toBe(3000000n);
  });

  test("findItinerary — createdAt INTEGER ms → Date", async () => {
    const items = await findItinerary(TRIP_ID);
    expect(items[0].createdAt.getTime()).toBe(CREATED_MS);
  });
});

// ─── 현재 형식 CRUD 왕복 (TEXT ISO-8601) ──────────────────────────────────────

describe("현재 형식(TEXT ISO-8601) CRUD 왕복", () => {
  let db: Database;

  beforeAll(() => {
    db = openMemory();
    _setTestDb(db);
  });

  afterAll(() => {
    _clearTestDb();
    db.close();
  });

  test("createTrip → findTripById 왕복", async () => {
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xcontractabc",
      onchainTripId: "99",
      name: "테스트 여행방",
      adminAddress: ADMIN,
      createTxHash: "0xhash123",
      participants: [
        { address: ADMIN, displayName: "관리자", isAdmin: true },
        { address: USER2, displayName: "참여자", isAdmin: false },
      ],
    });

    expect(trip).not.toBeNull();
    expect(trip.name).toBe("테스트 여행방");
    expect(typeof trip.onchainTripId).toBe("bigint");
    expect(trip.onchainTripId).toBe(99n);
    expect(trip.createdAt).toBeInstanceOf(Date);
    expect(trip.updatedAt).toBeInstanceOf(Date);
    // createdAt은 현재 시각 근처여야 함 (±5초)
    expect(Math.abs(trip.createdAt.getTime() - Date.now())).toBeLessThan(5000);

    expect(trip.participants.length).toBe(2);
    const admin = trip.participants.find((p) => p.address === ADMIN);
    const user2 = trip.participants.find((p) => p.address === USER2);
    expect(admin!.isAdmin).toBe(true);
    expect(user2!.isAdmin).toBe(false);
    expect(typeof admin!.isAdmin).toBe("boolean");
  });

  test("createExpense → findExpenses — totalUsdc bigint 왕복", async () => {
    // 먼저 여행방 생성
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xcontract2",
      onchainTripId: "100",
      name: "경비 테스트",
      adminAddress: ADMIN,
      createTxHash: "0xhash456",
      participants: [{ address: ADMIN, displayName: "관리자", isAdmin: true }],
    });

    const bigUsdc = 123456789012n; // 123456 USDC — 안전 범위 내
    const expense = await createExpense({
      tripId: trip.id,
      payerAddress: ADMIN,
      title: "큰 지출",
      category: "기타",
      date: "2025-06-01",
      totalUsdc: bigUsdc,
      paymentFlow: "USDC_DIRECT",
      createdBy: ADMIN,
      shares: [{ address: ADMIN, amountUsdc: bigUsdc.toString() }],
    });

    expect(typeof expense.totalUsdc).toBe("bigint");
    expect(expense.totalUsdc).toBe(bigUsdc);

    const fetched = await findExpenses(trip.id);
    expect(fetched[0].totalUsdc).toBe(bigUsdc);
  });

  test("createItineraryItem — estMinUsdc/estMaxUsdc null 처리", async () => {
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xcontract3",
      onchainTripId: "101",
      name: "일정 테스트",
      adminAddress: ADMIN,
      createTxHash: "0xhash789",
      participants: [{ address: ADMIN, displayName: "관리자", isAdmin: true }],
    });

    const item = await createItineraryItem({
      tripId: trip.id,
      date: "2025-07-01",
      location: "서울",
      activity: "관광",
      createdBy: ADMIN,
    });

    expect(item.estMinUsdc).toBeNull();
    expect(item.estMaxUsdc).toBeNull();
    expect(item.estAt).toBeNull();
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  test("createIntent → findIntentById 왕복", async () => {
    const intent = await createIntent({
      creatorAddress: ADMIN,
      chainId: 5042002,
      contractAddress: "0xcontractintent",
      tripName: "의도 테스트",
      participantAddresses: [ADMIN, USER2],
      targetBudget: 1000000000n,
      calldata: "0xabcdef",
    });

    expect(intent.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(intent.createdAt.getTime() - Date.now())).toBeLessThan(5000);
    expect(typeof intent.chainId).toBe("number");

    const fetched = await findIntentById(intent.id);
    expect(fetched!.createdAt.getTime()).toBe(intent.createdAt.getTime());
  });
});

// ─── BigInt 정밀도 경계 테스트 ────────────────────────────────────────────────

describe("BigInt 정밀도 경계", () => {
  let db: Database;

  beforeAll(() => {
    db = openMemory();
    _setTestDb(db);
  });

  afterAll(() => {
    _clearTestDb();
    db.close();
  });

  test("onchainTripId = 2^53 - 1 (MAX_SAFE) → bigint 정밀도 무손실", async () => {
    const safeMax = BigInt(Number.MAX_SAFE_INTEGER);
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xboundary1",
      onchainTripId: safeMax.toString(),
      name: "MAX_SAFE 테스트",
      adminAddress: ADMIN,
      createTxHash: "0xhash_max",
      participants: [{ address: ADMIN, displayName: "테스터", isAdmin: true }],
    });
    expect(trip.onchainTripId).toBe(safeMax);
  });

  test("totalUsdc = 2^40 (~1조 USDC) → bigint 저장/조회", async () => {
    // 2^40 = 1,099,511,627,776 micro-USDC ≈ 1.09조 USDC
    // Number.MAX_SAFE_INTEGER = 2^53-1, 2^40 < 2^53 → 손실 없음
    const bigUsdc = 2n ** 40n;
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xboundary2",
      onchainTripId: "1",
      name: "대용량 예산 테스트",
      adminAddress: ADMIN,
      createTxHash: "0xhash_big",
      participants: [{ address: ADMIN, displayName: "테스터", isAdmin: true }],
    });
    const expense = await createExpense({
      tripId: trip.id,
      payerAddress: ADMIN,
      title: "대용량",
      category: "기타",
      date: "2025-01-01",
      totalUsdc: bigUsdc,
      paymentFlow: "USDC_DIRECT",
      createdBy: ADMIN,
      shares: [{ address: ADMIN, amountUsdc: bigUsdc.toString() }],
    });
    expect(expense.totalUsdc).toBe(bigUsdc);

    const fetched = await findExpenses(trip.id);
    expect(fetched[0].totalUsdc).toBe(bigUsdc);
  });

  test("totalUsdc = 2^53 + 1 (MAX_SAFE 초과 string 저장) → bigint 정밀도 무손실", async () => {
    // bun:sqlite가 INTEGER로 저장하면 JS number로 돌아올 때 손실 발생 가능
    // 하지만 우리 코드는 totalUsdc를 .toString()으로 저장하므로 TEXT로 저장됨
    // → toBigIntSafe(string)으로 정밀도 무손실
    const overMax = BigInt(Number.MAX_SAFE_INTEGER) + 2n; // 2^53 + 1
    const trip = await createTrip({
      chainId: 5042002,
      contractAddress: "0xboundary3",
      onchainTripId: "2",
      name: "초과 정밀도 테스트",
      adminAddress: ADMIN,
      createTxHash: "0xhash_over",
      participants: [{ address: ADMIN, displayName: "테스터", isAdmin: true }],
    });
    const expense = await createExpense({
      tripId: trip.id,
      payerAddress: ADMIN,
      title: "초과",
      category: "기타",
      date: "2025-01-01",
      totalUsdc: overMax,
      paymentFlow: "USDC_DIRECT",
      createdBy: ADMIN,
      shares: [{ address: ADMIN, amountUsdc: overMax.toString() }],
    });
    // .toString()으로 저장했으므로 TEXT로 읽혀 toBigIntSafe(string)으로 변환
    expect(expense.totalUsdc).toBe(overMax);

    const fetched = await findExpenses(trip.id);
    expect(fetched[0].totalUsdc).toBe(overMax);
  });
});
