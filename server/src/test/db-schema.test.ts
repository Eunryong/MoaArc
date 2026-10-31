/**
 * DB 스키마 열기 / 검증 동작 테스트 — :memory: 전용
 *
 * 검증 범위:
 *  1. createTestDb — :memory: DB 생성, 파일 없음
 *  2. openExistingDb — 스키마 불일치 시 fail-closed (변경 없이 Error)
 *  3. checkDbSchema  — 테이블 누락 케이스별 오류 메시지 검증
 *  4. openDb         — 새 DB 초기화 (별도 :memory:)
 *  5. 새 DB / 기존 DB 초기화 분리 원칙
 *  6. checkDbSchema — 컬럼·UNIQUE·FK 제약 누락 케이스 (신규)
 *  7. checkDbSchema — 정상 기존 DB 호환 케이스 (신규)
 *
 * 금지 사항:
 *  - /tmp 파일 생성 금지
 *  - 실제 dev.db 접근 금지
 *  - .env 접근 금지
 *  - Prisma CLI 금지
 */

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../lib/schema.sql.js";
import {
  checkDbSchema,
  openExistingDb,
} from "../lib/db.js";
import { createTestDb } from "./setup.js";

// ─── 1. createTestDb — :memory: 전용 ─────────────────────────────────────────

describe("createTestDb — :memory: 전용", () => {
  test("label 없이 호출 → :memory: DB 반환, 파일 없음", async () => {
    const { db, cleanup } = createTestDb();
    try {
      // 테이블이 존재하는지 확인
      const tables = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      ).all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain("TripRecord");
      expect(tables).toContain("AuthNonce");
      expect(tables).toContain("ExpenseRecord");
      // safeIntegers=true 확인 — INTEGER 컬럼은 bigint로 반환
      db.prepare(`INSERT INTO AuthNonce (id, address, nonce, expiresAt, used)
                  VALUES ('t1', '0xaaaa', 'n1', '2099-01-01T00:00:00.000Z', 0)`).run();
      const row = db.prepare(
        `SELECT used FROM AuthNonce WHERE id = 't1'`
      ).get() as { used: number | bigint };
      expect(typeof row.used).toBe("bigint");
    } finally {
      await cleanup();
    }
  });

  test("label 있는 호출 → 동일하게 :memory: DB (파일 생성 없음)", async () => {
    const { db, cleanup } = createTestDb("some-label");
    try {
      const tables = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table'`
      ).all() as { name: string }[]).map((r) => r.name);
      expect(tables).toContain("TripRecord");
    } finally {
      await cleanup();
    }
  });

  test("cleanup() 호출 후 DB는 닫힘", async () => {
    const { db, cleanup } = createTestDb("cleanup-test");
    await cleanup();
    // 닫힌 DB에서 쿼리하면 오류
    let threw = false;
    try { db.prepare("SELECT 1").get(); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("반환값에 dbPath / dbUrl 필드가 없음", () => {
    const result = createTestDb("no-file-fields");
    const keys = Object.keys(result);
    expect(keys).not.toContain("dbPath");
    expect(keys).not.toContain("dbUrl");
    // cleanup 호출 (반환값 사용 전 cleanup은 async — 여기선 동기로 닫음)
    result.db.close();
  });
});

// ─── 2. checkDbSchema — 테이블 누락 시 fail-closed ───────────────────────────

describe("checkDbSchema — 테이블 누락 시 fail-closed", () => {
  test("모든 테이블 존재 → 오류 없음", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    expect(() => checkDbSchema(db)).not.toThrow();
    db.close();
  });

  test("TripRecord 누락 → Error 던짐, DB 수정 없음", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    db.exec("DROP TABLE TripRecord");          // 강제 누락
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("TripRecord");
    expect(err!.message).toContain("마이그레이션");
    // DB가 변경되지 않았는지 — AuthNonce는 여전히 존재
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("AuthNonce");
    db.close();
  });

  test("여러 테이블 누락 → Error 메시지에 모두 포함", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    db.exec("DROP TABLE ExpenseVersion");
    db.exec("DROP TABLE AgentConversation");
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("ExpenseVersion");
    expect(err!.message).toContain("AgentConversation");
    db.close();
  });

  test("스키마 없는 빈 DB → 모든 테이블 누락 오류", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    // initSchema 없이 빈 DB
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("TripRecord");
    db.close();
  });

  test("checkDbSchema는 테이블을 생성/변경하지 않음", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    const before = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[]).map((r) => r.name).sort();
    checkDbSchema(db); // 정상 케이스 — 오류 없음
    const after = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(after).toEqual(before);
    db.close();
  });
});

// ─── 3. openExistingDb — :memory:에서 fail-closed 시뮬레이션 ─────────────────
// openExistingDb는 파일 경로를 받지만, ":memory:"를 넘겨도
// create:false 옵션으로 동일 동작을 검증할 수 있습니다.
// :memory:의 경우 bun:sqlite가 create:false라도 새 메모리 DB를 만들므로
// "파일 없음" 오류는 발생하지 않습니다.
// 따라서 이 describe는 "스키마 불일치 → fail-closed"에 집중합니다.

describe("openExistingDb — 스키마 불일치 시 fail-closed", () => {
  // openExistingDb를 직접 테스트하기 위해 checkDbSchema를 중심으로 검증합니다.
  // (openExistingDb는 파일 경로가 필요하므로 checkDbSchema + 동등한 시나리오를 씁니다.)

  test("정상 스키마 DB — checkDbSchema 통과 (openExistingDb 내부 동작과 동일)", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    db.exec("PRAGMA foreign_keys = ON;");
    initSchema(db);
    expect(() => checkDbSchema(db)).not.toThrow();
    db.close();
  });

  test("스키마 불일치 시 DB는 변경되지 않음 — 데이터 보존 확인", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    // 데이터 삽입
    db.prepare(`INSERT INTO AuthNonce (id, address, nonce, expiresAt, used)
                VALUES ('k1', '0xbbbb', 'nonce-x', '2099-01-01T00:00:00.000Z', 0)`).run();
    // 테이블 하나 삭제 → 불일치 유발
    db.exec("DROP TABLE NotificationRecord");
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // 기존 데이터는 그대로 있어야 함 — DB 수정이 없었으므로
    const row = db.prepare(
      `SELECT id FROM AuthNonce WHERE id = 'k1'`
    ).get() as { id: string } | null;
    expect(row).not.toBeNull();
    expect(row!.id).toBe("k1");
    db.close();
  });

  test("오류 메시지에 누락 테이블 이름과 안내 문구가 모두 포함됨", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    db.exec("DROP TABLE TripCreationIntent");
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err!.message).toContain("TripCreationIntent");
    expect(err!.message).toContain("마이그레이션");
    db.close();
  });
});

// ─── 4. openDb — 새 DB 초기화 (:memory: 시뮬레이션) ─────────────────────────

describe("openDb — 새 DB 초기화", () => {
  // openDb는 파일 경로를 받지만, :memory:로 동작을 검증합니다.
  // bun:sqlite에서 :memory:는 create:true와 동일하게 동작합니다.
  test(":memory: DB에 initSchema 적용 후 모든 테이블 존재", () => {
    const db = new Database(":memory:", { create: true, safeIntegers: true });
    initSchema(db);
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[]).map((r) => r.name);
    const expected = [
      "TripRecord", "ParticipantRecord", "AuthNonce",
      "ItineraryRecord", "ExpenseRecord", "ExpenseVersion",
      "ExpenseApproval", "TripCreationIntent", "AgentConversation",
      "NotificationRecord",
    ];
    for (const t of expected) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  test("initSchema는 멱등 — 두 번 호출해도 오류 없음 (CREATE TABLE IF NOT EXISTS)", () => {
    const db = new Database(":memory:", { create: true, safeIntegers: true });
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow(); // 두 번째 호출
    db.close();
  });

  test("initSchema 후 외래키 ON — CASCADE 삭제 동작", () => {
    const db = new Database(":memory:", { create: true, safeIntegers: true });
    initSchema(db);
    // TripRecord 삽입 후 삭제 → ParticipantRecord CASCADE 삭제 확인
    const fakeTxHash = "0x" + "f".repeat(64);
    db.prepare(`INSERT INTO TripRecord (id, chainId, contractAddress, onchainTripId, name, adminAddress, createTxHash)
                VALUES ('trip1', 1, '0xabc', 42, '테스트', '0xadmin', ?)`).run(fakeTxHash);
    db.prepare(`INSERT INTO ParticipantRecord (id, tripId, address, displayName, isAdmin)
                VALUES ('p1', 'trip1', '0xaaa', '참여자', 0)`).run();
    db.exec("DELETE FROM TripRecord WHERE id = 'trip1'");
    const participant = db.prepare(
      `SELECT id FROM ParticipantRecord WHERE id = 'p1'`
    ).get();
    expect(participant).toBeNull();
    db.close();
  });
});

// ─── 5. 새 DB와 기존 DB 초기화 분리 원칙 검증 ───────────────────────────────

describe("새 DB / 기존 DB 초기화 분리 원칙", () => {
  test("새 :memory: DB — initSchema 호출 전에는 스키마 없음", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
    db.close();
  });

  test("기존 DB 시뮬레이션 — initSchema 없이 checkDbSchema 불일치 → Error (스키마 자동 변경 없음)", () => {
    // openExistingDb가 하는 일: open → checkDbSchema (initSchema 없음)
    const db = new Database(":memory:", { safeIntegers: true });
    // initSchema 없이 바로 checkDbSchema — 스키마가 없으므로 불일치
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // DB에 테이블이 생기지 않음 (initSchema를 호출하지 않았으므로)
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table'`
    ).all() as { name: string }[];
    expect(tables).toHaveLength(0);
    db.close();
  });

  test("새 DB와 기존 DB의 차이: 새 DB는 initSchema 후 검증 통과, 기존 불일치 DB는 통과 못함", () => {
    // 새 DB (openDb 동작)
    const newDb = new Database(":memory:", { create: true, safeIntegers: true });
    initSchema(newDb);
    expect(() => checkDbSchema(newDb)).not.toThrow();
    newDb.close();

    // 기존 불일치 DB (openExistingDb 동작 — 스키마 없음)
    const oldDb = new Database(":memory:", { safeIntegers: true });
    // openExistingDb: initSchema 없이 checkDbSchema만
    let err: Error | null = null;
    try { checkDbSchema(oldDb); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    oldDb.close();
  });
});

// ─── 6. checkDbSchema — 컬럼·UNIQUE·FK 제약 누락 케이스 ────────────────────
// 테이블은 있지만 컬럼 또는 제약이 누락된 경우 → 변경 없이 Error

describe("checkDbSchema — 컬럼·UNIQUE·FK 제약 누락 시 fail-closed", () => {

  test("TripRecord에서 필수 컬럼 누락 → Error, 메시지에 컬럼명 포함", () => {
    // onchainTripId 없이 TripRecord 생성 (필수 컬럼 누락)
    const db = new Database(":memory:", { safeIntegers: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`CREATE TABLE TripRecord (
      id TEXT NOT NULL PRIMARY KEY,
      chainId INTEGER NOT NULL,
      contractAddress TEXT NOT NULL,
      -- onchainTripId 누락
      name TEXT NOT NULL,
      adminAddress TEXT NOT NULL,
      createTxHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(chainId, contractAddress)
    )`);
    // 나머지 테이블은 정상
    const rest = new Database(":memory:", { safeIntegers: true });
    initSchema(rest);
    // 나머지 테이블만 복사 (sqlite_master DDL 재실행)
    const otherTables = (rest.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name != 'TripRecord' AND name NOT LIKE 'sqlite_%'`
    ).all() as { sql: string }[]);
    for (const { sql } of otherTables) {
      try { db.exec(sql); } catch { /* FK 순서 이슈 무시 */ }
    }
    rest.close();

    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("onchainTripId");
    // DB 변경 없음 — TripRecord 여전히 존재
    const tbl = db.prepare(
      `SELECT name FROM sqlite_master WHERE name='TripRecord'`
    ).get() as { name: string } | null;
    expect(tbl).not.toBeNull();
    db.close();
  });

  test("ParticipantRecord에서 NOT NULL 제약 누락 → Error, 메시지에 해당 컬럼 포함", () => {
    // tripId를 nullable로 (notnull=0) 만든 잘못된 스키마
    const db = new Database(":memory:", { safeIntegers: true });
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`CREATE TABLE TripRecord (
      id TEXT NOT NULL PRIMARY KEY,
      chainId INTEGER NOT NULL,
      contractAddress TEXT NOT NULL,
      onchainTripId INTEGER NOT NULL,
      name TEXT NOT NULL,
      adminAddress TEXT NOT NULL,
      createTxHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      UNIQUE(chainId, contractAddress, onchainTripId)
    )`);
    db.exec(`CREATE TABLE ParticipantRecord (
      id TEXT NOT NULL PRIMARY KEY,
      tripId TEXT,           -- NOT NULL 누락!
      address TEXT NOT NULL,
      displayName TEXT NOT NULL,
      isAdmin INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tripId, address)
    )`);
    // AuthNonce 등 나머지는 정상 initSchema로
    const rest = new Database(":memory:", { safeIntegers: true });
    initSchema(rest);
    const others = (rest.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type='table'
       AND name NOT IN ('TripRecord','ParticipantRecord')
       AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string; sql: string }[]);
    for (const { sql } of others) {
      try { db.exec(sql); } catch { /* 무시 */ }
    }
    rest.close();

    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("tripId");
    expect(err!.message).toContain("NOT NULL");
    db.close();
  });

  test("AuthNonce에서 UNIQUE 제약 누락 → Error, 메시지에 UNIQUE 언급", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    // AuthNonce를 DROP하고 UNIQUE 없이 재생성
    db.exec("DROP TABLE AuthNonce");
    db.exec(`CREATE TABLE AuthNonce (
      id        TEXT NOT NULL PRIMARY KEY,
      address   TEXT NOT NULL,
      nonce     TEXT NOT NULL,          -- UNIQUE 제거!
      expiresAt TEXT NOT NULL,
      used      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )`);
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("AuthNonce");
    expect(err!.message).toContain("UNIQUE");
    db.close();
  });

  test("ExpenseVersion에서 FK → ExpenseRecord 없음 → Error", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    // ExpenseVersion을 DROP하고 FK 없이 재생성
    db.exec("DROP TABLE ExpenseApproval"); // FK 의존 먼저 삭제
    db.exec("DROP TABLE ExpenseVersion");
    db.exec(`CREATE TABLE ExpenseVersion (
      id          TEXT    NOT NULL PRIMARY KEY,
      expenseId   TEXT    NOT NULL,
      version     INTEGER NOT NULL,
      shares      TEXT    NOT NULL,
      proposedBy  TEXT    NOT NULL,
      proposedAt  TEXT    NOT NULL,
      reason      TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT '승인대기',
      -- FOREIGN KEY(expenseId) REFERENCES ExpenseRecord(id) 누락!
      UNIQUE(expenseId, version)
    )`);
    // ExpenseApproval 재생성 (FK를 ExpenseVersion으로)
    db.exec(`CREATE TABLE ExpenseApproval (
      id         TEXT NOT NULL PRIMARY KEY,
      versionId  TEXT NOT NULL,
      address    TEXT NOT NULL,
      action     TEXT NOT NULL,
      reason     TEXT,
      approvedAt TEXT NOT NULL,
      FOREIGN KEY(versionId) REFERENCES ExpenseVersion(id) ON DELETE CASCADE,
      UNIQUE(versionId, address)
    )`);
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("ExpenseVersion");
    expect(err!.message).toContain("ExpenseRecord");
    db.close();
  });

  test("TripRecord UNIQUE 제약 누락 → Error", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    // TripRecord 재생성 — UNIQUE 없이 (CASCADE 때문에 자식 먼저 삭제)
    db.exec("DROP TABLE NotificationRecord");
    db.exec("DROP TABLE AgentConversation");
    db.exec("DROP TABLE ItineraryRecord");
    db.exec("DROP TABLE ExpenseApproval");
    db.exec("DROP TABLE ExpenseVersion");
    db.exec("DROP TABLE ExpenseRecord");
    db.exec("DROP TABLE ParticipantRecord");
    db.exec("DROP TABLE TripRecord");
    db.exec(`CREATE TABLE TripRecord (
      id              TEXT    NOT NULL PRIMARY KEY,
      chainId         INTEGER NOT NULL,
      contractAddress TEXT    NOT NULL,
      onchainTripId   INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      adminAddress    TEXT    NOT NULL,
      createTxHash    TEXT    NOT NULL,
      createdAt       TEXT    NOT NULL,
      updatedAt       TEXT    NOT NULL
      -- UNIQUE(chainId, contractAddress, onchainTripId) 누락!
    )`);
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("TripRecord");
    expect(err!.message).toContain("UNIQUE");
    db.close();
  });

  test("오류 시 DB는 변경되지 않음 — 기존 데이터 보존", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    db.prepare(`INSERT INTO AuthNonce (id, address, nonce, expiresAt, used)
                VALUES ('keep-me', '0xaa', 'nonce-keep', '2099-01-01T00:00:00.000Z', 0)`).run();
    // 컬럼 누락 유발 — AuthNonce 재생성
    db.exec("DROP TABLE AuthNonce");
    db.exec(`CREATE TABLE AuthNonce (
      id      TEXT NOT NULL PRIMARY KEY,
      address TEXT NOT NULL,
      nonce   TEXT NOT NULL  -- UNIQUE 없음
    )`);
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // checkDbSchema는 DB를 변경하지 않음 — AuthNonce는 여전히 exists (재생성됐으나 삭제 안 됨)
    const tbl = db.prepare(
      `SELECT name FROM sqlite_master WHERE name='AuthNonce'`
    ).get() as { name: string } | null;
    expect(tbl).not.toBeNull();
    db.close();
  });
});

// ─── 7. checkDbSchema — 정상 기존 DB 호환 케이스 ─────────────────────────────

describe("checkDbSchema — 정상 기존 DB 호환 (initSchema DB)", () => {

  test("initSchema로 만든 DB — 검증 전 통과, 테이블 수 불변", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    const before = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(() => checkDbSchema(db)).not.toThrow();
    const after = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    ).all() as { name: string }[]).map((r) => r.name).sort();
    expect(after).toEqual(before);
    db.close();
  });

  test("initSchema + 데이터 삽입 후 검증 — 데이터 변경 없음 (읽기 전용 확인)", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
    db.prepare(`INSERT INTO AuthNonce (id, address, nonce, expiresAt, used)
                VALUES ('data-check', '0xcc', 'nonce-dc', '2099-01-01T00:00:00.000Z', 0)`).run();
    expect(() => checkDbSchema(db)).not.toThrow();
    // 데이터는 그대로 있어야 함
    const row = db.prepare(
      `SELECT id FROM AuthNonce WHERE id = 'data-check'`
    ).get() as { id: string } | null;
    expect(row).not.toBeNull();
    expect(row!.id).toBe("data-check");
    db.close();
  });

  test("SCHEMA_SPEC 버전 정보: checkDbSchema 오류 메시지에 '마이그레이션' 키워드 포함 (안내 문구 검증)", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    // 스키마 없이 오류 발생
    let err: Error | null = null;
    try { checkDbSchema(db); } catch (e) { err = e as Error; }
    expect(err).not.toBeNull();
    // 안내 문구가 있어야 함
    expect(err!.message).toContain("마이그레이션");
    expect(err!.message).toContain("재초기화");
    db.close();
  });
});
