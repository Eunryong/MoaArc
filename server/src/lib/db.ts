/**
 * MoaArc SQLite 클라이언트 — bun:sqlite
 *
 * DATABASE_PATH 환경변수 (파일 경로) 또는 DATABASE_URL ("file:./path" 형식) 중
 * DATABASE_PATH를 우선합니다. 둘 다 없으면 소스 기준 상대 경로로 결정합니다.
 *
 * 싱글턴: globalThis.__moaarcDb 에 캐시하여 HMR 재시작 시 재사용합니다.
 *
 * 사용:
 *   import { getDb } from "./db.js";
 *   const db = getDb();
 *   // 이후 db.query(...), db.transaction(...) 등
 *
 * 테스트에서는 openDb(path) 로 격리 DB를 직접 열고, setTestDb(db) 로 주입합니다.
 */

import { Database } from "bun:sqlite";
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { initSchema } from "./schema.sql.js";

// ─── 경로 결정 ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir = path.dirname(__filename);
// server/src/lib → server/src → server → server/prisma/dev.db
// schema.prisma는 삭제됐지만 dev.db 파일 경로는 하위 호환을 위해 유지합니다.
const DEFAULT_DB_PATH = path.resolve(__dir, "../../prisma/dev.db");

function resolveDbPath(): string {
  // 1. DATABASE_PATH 직접 경로
  const dp = process.env.DATABASE_PATH;
  if (dp && dp.trim()) return dp.trim();

  // 2. DATABASE_URL (file:... 형식)
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) {
    const raw = url.trim();
    if (raw.startsWith("file:")) {
      const p = raw.slice(5);
      // 절대 경로이면 그대로, 상대 경로이면 cwd 기준
      return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    }
    // "file:..." 아닌 값은 그대로 경로로 사용
    return raw;
  }

  return DEFAULT_DB_PATH;
}

// ─── 싱글턴 ───────────────────────────────────────────────────────────────────

const g = globalThis as unknown as Record<string, unknown>;

/**
 * 격리 테스트에서 싱글턴을 교체합니다.
 * 테스트 코드만 호출해야 합니다.
 */
export function _setTestDb(db: Database): void {
  g.__moaarcDb = db;
}

export function _clearTestDb(): void {
  delete g.__moaarcDb;
}

// ─── 스키마 기대 명세 ─────────────────────────────────────────────────────────
//
// 각 항목:
//   cols    : 필수 컬럼 이름 목록 (notnull 여부 포함)
//   fkTables: 이 테이블의 FK가 참조해야 하는 부모 테이블 이름 목록
//   hasUniq : UNIQUE 제약 (origin="u" 또는 "c", 단 sqlite_autoindex_PK 제외)이
//             1개 이상 있어야 하는지 여부
//
// 스키마가 변경될 때 이 명세도 함께 업데이트해야 합니다.
// PRAGMA table_info / foreign_key_list / index_list 만 사용 — 읽기 전용.

interface ColSpec { name: string; notnull: boolean }
interface TableSpec {
  cols: ColSpec[];
  fkTables?: string[];  // FK → 부모 테이블 이름(들)
  hasUniq?: boolean;    // UNIQUE 인덱스(origin="u") 존재 여부
}

const SCHEMA_SPEC: Record<string, TableSpec> = {
  TripRecord: {
    cols: [
      { name: "id",              notnull: true  },
      { name: "chainId",         notnull: true  },
      { name: "contractAddress", notnull: true  },
      { name: "onchainTripId",   notnull: true  },
      { name: "name",            notnull: true  },
      { name: "adminAddress",    notnull: true  },
      { name: "createTxHash",    notnull: true  },
      { name: "createdAt",       notnull: true  },
      { name: "updatedAt",       notnull: true  },
    ],
    hasUniq: true,  // UNIQUE(chainId, contractAddress, onchainTripId)
  },
  ParticipantRecord: {
    cols: [
      { name: "id",          notnull: true  },
      { name: "tripId",      notnull: true  },
      { name: "address",     notnull: true  },
      { name: "displayName", notnull: true  },
      { name: "isAdmin",     notnull: true  },
    ],
    fkTables: ["TripRecord"],
    hasUniq: true,  // UNIQUE(tripId, address)
  },
  AuthNonce: {
    cols: [
      { name: "id",        notnull: true  },
      { name: "address",   notnull: true  },
      { name: "nonce",     notnull: true  },
      { name: "expiresAt", notnull: true  },
      { name: "used",      notnull: true  },
      { name: "createdAt", notnull: true  },
    ],
    hasUniq: true,  // UNIQUE(nonce)
  },
  ItineraryRecord: {
    cols: [
      { name: "id",        notnull: true  },
      { name: "tripId",    notnull: true  },
      { name: "date",      notnull: true  },
      { name: "location",  notnull: true  },
      { name: "activity",  notnull: true  },
      { name: "createdBy", notnull: true  },
      { name: "createdAt", notnull: true  },
      { name: "updatedAt", notnull: true  },
    ],
    fkTables: ["TripRecord"],
  },
  ExpenseRecord: {
    cols: [
      { name: "id",           notnull: true  },
      { name: "tripId",       notnull: true  },
      { name: "payerAddress", notnull: true  },
      { name: "title",        notnull: true  },
      { name: "category",     notnull: true  },
      { name: "date",         notnull: true  },
      { name: "totalUsdc",    notnull: true  },
      { name: "paymentFlow",  notnull: true  },
      { name: "status",       notnull: true  },
      { name: "createdBy",    notnull: true  },
      { name: "createdAt",    notnull: true  },
      { name: "updatedAt",    notnull: true  },
    ],
    fkTables: ["TripRecord"],
  },
  ExpenseVersion: {
    cols: [
      { name: "id",         notnull: true  },
      { name: "expenseId",  notnull: true  },
      { name: "version",    notnull: true  },
      { name: "shares",     notnull: true  },
      { name: "proposedBy", notnull: true  },
      { name: "proposedAt", notnull: true  },
      { name: "status",     notnull: true  },
    ],
    fkTables: ["ExpenseRecord"],
    hasUniq: true,  // UNIQUE(expenseId, version)
  },
  ExpenseApproval: {
    cols: [
      { name: "id",         notnull: true  },
      { name: "versionId",  notnull: true  },
      { name: "address",    notnull: true  },
      { name: "action",     notnull: true  },
      { name: "approvedAt", notnull: true  },
    ],
    fkTables: ["ExpenseVersion"],
    hasUniq: true,  // UNIQUE(versionId, address)
  },
  TripCreationIntent: {
    cols: [
      { name: "id",                   notnull: true  },
      { name: "creatorAddress",        notnull: true  },
      { name: "chainId",               notnull: true  },
      { name: "contractAddress",       notnull: true  },
      { name: "tripName",              notnull: true  },
      { name: "participantAddresses",  notnull: true  },
      { name: "targetBudget",          notnull: true  },
      { name: "calldata",              notnull: true  },
      { name: "status",                notnull: true  },
      { name: "createdAt",             notnull: true  },
      { name: "updatedAt",             notnull: true  },
    ],
  },
  AgentConversation: {
    cols: [
      { name: "id",        notnull: true  },
      { name: "tripId",    notnull: true  },
      { name: "address",   notnull: true  },
      { name: "role",      notnull: true  },
      { name: "content",   notnull: true  },
      { name: "hasError",  notnull: true  },
      { name: "createdAt", notnull: true  },
    ],
  },
  NotificationRecord: {
    cols: [
      { name: "id",        notnull: true  },
      { name: "tripId",    notnull: true  },
      { name: "address",   notnull: true  },
      { name: "type",      notnull: true  },
      { name: "title",     notnull: true  },
      { name: "body",      notnull: true  },
      { name: "read",      notnull: true  },
      { name: "createdAt", notnull: true  },
    ],
    fkTables: ["TripRecord"],
  },
} as const;

// PRAGMA table_info 행 타입
interface PragmaColInfo {
  name: string;
  notnull: number; // 0 or 1
}
// PRAGMA foreign_key_list 행 타입
interface PragmaFkInfo {
  table: string;   // 참조 대상 테이블
}
// PRAGMA index_list 행 타입
interface PragmaIndexInfo {
  origin: string;  // "pk" | "u" | "c"
  unique: number;  // 0 or 1
}

/**
 * DB 스키마가 현재 코드베이스와 호환되는지 검증합니다.
 *
 * 검증 범위 (읽기 전용 PRAGMA, DB 변경 없음):
 *   1. 테이블 존재 여부  — sqlite_master
 *   2. 필수 컬럼 존재 + notnull 여부  — PRAGMA table_info
 *   3. FK → 부모 테이블 참조 여부  — PRAGMA foreign_key_list
 *   4. UNIQUE 제약 존재 여부  — PRAGMA index_list (origin="u")
 *
 * 불일치 시 변경 없이 오류 메시지와 함께 Error를 던집니다.
 * 마이그레이션이 필요하면 별도의 명시적 명령을 사용해야 합니다.
 */
export function checkDbSchema(db: Database): void {
  // DB를 safeIntegers=false 로 직접 접근해도 되지만, 전달받은 db를 그대로 사용합니다.
  // PRAGMA 결과의 notnull/unique는 0/1 정수이므로 Number()로 정규화합니다.

  const tableRows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all() as { name: string }[];
  const existingTables = new Set(tableRows.map((r) => r.name));

  const errors: string[] = [];

  for (const [tableName, spec] of Object.entries(SCHEMA_SPEC)) {
    // 1. 테이블 존재 여부
    if (!existingTables.has(tableName)) {
      errors.push(`테이블 없음: ${tableName}`);
      continue; // 컬럼/제약 검사는 테이블이 있어야 의미 있음
    }

    // 2. 필수 컬럼 존재 + notnull
    const colRows = db.prepare(`PRAGMA table_info('${tableName}')`).all() as PragmaColInfo[];
    const colMap = new Map(colRows.map((c) => [c.name, c]));
    for (const expected of spec.cols) {
      const actual = colMap.get(expected.name);
      if (!actual) {
        errors.push(`${tableName}: 컬럼 없음 — ${expected.name}`);
      } else if (expected.notnull && Number(actual.notnull) === 0) {
        errors.push(`${tableName}.${expected.name}: NOT NULL 제약 없음`);
      }
    }

    // 3. FK → 부모 테이블
    if (spec.fkTables && spec.fkTables.length > 0) {
      const fkRows = db.prepare(`PRAGMA foreign_key_list('${tableName}')`).all() as PragmaFkInfo[];
      const fkTargets = new Set(fkRows.map((r) => r.table));
      for (const required of spec.fkTables) {
        if (!fkTargets.has(required)) {
          errors.push(`${tableName}: FK → ${required} 없음`);
        }
      }
    }

    // 4. UNIQUE 제약 (origin="u": UNIQUE constraint; "c": CREATE INDEX UNIQUE)
    if (spec.hasUniq) {
      const idxRows = db.prepare(`PRAGMA index_list('${tableName}')`).all() as PragmaIndexInfo[];
      const hasUniqueConstraint = idxRows.some(
        (r) => (r.origin === "u" || r.origin === "c") && Number(r.unique) === 1
      );
      if (!hasUniqueConstraint) {
        errors.push(`${tableName}: UNIQUE 제약 없음`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `DB 스키마 불일치 (${errors.length}건) — 마이그레이션이나 DB 재초기화가 필요합니다:\n` +
      errors.map((e) => `  • ${e}`).join("\n")
    );
  }
}

/**
 * 새 DB 파일을 생성하고 스키마를 초기화합니다.
 * 테스트용 격리 DB(:memory:)에서는 setup.ts가 직접 new Database(":memory:")를 씁니다.
 * 이 함수는 서버 첫 실행 시 빈 DB 파일에서 스키마를 세팅할 때만 호출합니다.
 *
 * safeIntegers: true — 모든 INTEGER 컬럼을 bigint로 반환합니다.
 * row 타입에서 INTEGER 필드를 number | bigint로 선언하고 fromRow 함수에서
 * Number() / toBigIntSafe()로 정규화합니다.
 */
export function openDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true, safeIntegers: true });
  initSchema(db);
  return db;
}

/**
 * 기존 DB 파일을 엽니다. 스키마를 변경하지 않습니다.
 *
 * - create: false — 파일이 없으면 Error를 던집니다.
 * - checkDbSchema()로 테이블 존재 여부를 검증합니다.
 *   불일치 시 마이그레이션 없이 즉시 오류를 던집니다(fail-closed).
 */
export function openExistingDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: false, safeIntegers: true });
  db.exec("PRAGMA foreign_keys = ON;");
  checkDbSchema(db);
  return db;
}

/**
 * 프로덕션/서버 싱글턴 DB를 반환합니다.
 *
 * fail-closed 설계:
 *  - DB 파일이 없는 첫 실행: openDb()로 생성 + 스키마 초기화
 *  - DB 파일이 있는 재실행:  openExistingDb()로 열기 + 스키마 검증
 *    → 테이블 누락 시 스키마를 자동 변경하지 않고 오류를 던집니다.
 *
 * 새 DB인지 기존 DB인지는 파일 존재 여부로 판단합니다.
 * :memory: 경로는 항상 openDb()를 사용합니다(테스트 전용).
 */
export function getDb(): Database {
  if (g.__moaarcDb instanceof Database) return g.__moaarcDb as Database;
  const dbPath = resolveDbPath();

  let db: Database;
  if (dbPath === ":memory:") {
    // 테스트에서 _setTestDb() 없이 직접 getDb()를 부르는 경우
    db = new Database(":memory:", { safeIntegers: true });
    initSchema(db);
  } else {
    // 파일 존재 여부로 새 DB / 기존 DB 분기
    if (existsSync(dbPath)) {
      db = openExistingDb(dbPath);
    } else {
      db = openDb(dbPath);
    }
  }

  g.__moaarcDb = db;
  return db;
}

// ─── ID 생성 ──────────────────────────────────────────────────────────────────
// cuid() 대체: crypto.randomUUID() (128-bit, URL-safe)

import { randomUUID } from "crypto";

export function newId(): string {
  return randomUUID();
}

// ─── 날짜 직렬화 헬퍼 ────────────────────────────────────────────────────────

export function toIso(d: Date): string {
  return d.toISOString();
}

export function fromIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(s);
}

/**
 * DB에서 읽은 날짜 필드를 Date로 변환합니다.
 *
 * 두 가지 저장 형식을 모두 처리합니다:
 *  - TEXT  "YYYY-MM-DDTHH:mm:ss.sssZ" (bun:sqlite 기본 — 이 코드베이스가 쓰는 형식)
 *  - INTEGER Unix epoch 밀리초         (Prisma quaint native driver가 쓴 기존 행과의 하위 호환)
 *
 * null/undefined/빈 문자열 → null 반환.
 */
export function parseDateField(v: string | number | bigint | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || typeof v === "bigint") {
    // Prisma 기존 형식: INTEGER 밀리초 epoch (컬럼 타입이 NUMERIC/INTEGER)
    return new Date(Number(v));
  }
  // TEXT 컬럼 — 두 가지 경우:
  //   1. Prisma가 NUMERIC/INTEGER를 TEXT 컬럼에 저장 → 숫자 문자열 "1735689600000"
  //   2. 현재 코드베이스: ISO-8601 "2025-01-01T00:00:00.000Z"
  //   3. quaint TEXT fallback: "%Y-%m-%d %H:%M:%S"
  const trimmed = v.trim();
  // 순수 정수 문자열(밀리초 epoch) — Prisma가 TEXT 컬럼에 INTEGER 삽입 시 저장 형태
  if (/^-?\d+$/.test(trimmed)) {
    return new Date(parseInt(trimmed, 10));
  }
  // ISO-8601 / RFC-2822 / "%Y-%m-%d %H:%M:%S"
  return new Date(trimmed);
}

/**
 * DB에서 읽은 row의 날짜 필드를 Date로 변환합니다.
 * 날짜 필드 목록을 명시적으로 전달해야 합니다.
 * TEXT(ISO) 및 INTEGER(밀리초) 두 형식 모두 허용합니다.
 */
export function hydrateDates<T extends Record<string, unknown>>(
  row: T,
  fields: (keyof T)[],
): T {
  const out = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (v !== null && v !== undefined && v !== "") {
      (out as Record<string, unknown>)[f as string] = parseDateField(
        v as string | number | bigint,
      );
    }
  }
  return out;
}

// ─── BigInt 안전 변환 ─────────────────────────────────────────────────────────

/**
 * DB에서 읽은 INTEGER 컬럼 값을 BigInt로 변환합니다.
 *
 * bun:sqlite는 safeIntegers=false(기본)일 때 INTEGER를 number로 반환합니다.
 * Number.MAX_SAFE_INTEGER(2^53-1) 초과 값은 정밀도가 손실되므로, 저장 시
 * TEXT로 기록된 bigint 값도 파싱합니다.
 *
 * 처리 순서:
 *  1. bigint  → 그대로 반환
 *  2. number  → BigInt(v) (JS number 범위: 최대 2^53-1, 그 이내면 손실 없음)
 *  3. string  → BigInt(v) (저장 시 .toString()한 큰 값)
 *  4. null/undefined → null
 */
export function toBigIntSafe(v: bigint | number | string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  // string: "123" or "0x..." — strip trailing 'n' if any
  const s = v.replace(/n$/, "").trim();
  if (s === "") return null;
  return BigInt(s);
}

/**
 * BigInt를 JSON 직렬화할 수 있도록 전역 처리합니다.
 * getDb() 첫 호출 시 한 번 실행됩니다.
 */
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
