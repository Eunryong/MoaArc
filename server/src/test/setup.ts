/**
 * 보안 테스트용 격리 SQLite DB 헬퍼 — bun:sqlite
 *
 * :memory: DB만 사용합니다. /tmp 파일을 만들거나 삭제하는 로직이 없습니다.
 * 공유 DB(dev.db)와 .env는 절대 건드리지 않습니다.
 *
 * 사용:
 *   const { db, cleanup } = createTestDb("security");
 *   _setTestDb(db);
 *   // ... 테스트 ...
 *   await cleanup();
 */

import { Database } from "bun:sqlite";
import { initSchema } from "../lib/schema.sql.js";
import { _setTestDb, _clearTestDb } from "../lib/db.js";

export { _setTestDb, _clearTestDb };

/**
 * 격리된 인메모리 SQLite DB를 생성하고 반환합니다.
 *
 * - new Database(":memory:", { safeIntegers: true })
 * - initSchema() 실행 (WAL은 :memory:에 적용되지 않으므로 skip)
 * - 파일을 만들지 않으므로 cleanup은 close()만 수행합니다.
 * - label 파라미터는 기존 호출부 호환을 위해 유지하나 경로 생성에 쓰이지 않습니다.
 */
export function createTestDb(_label?: string): {
  db: Database;
  cleanup: () => Promise<void>;
} {
  const db = new Database(":memory:", { safeIntegers: true });
  initSchema(db);

  const cleanup = async (): Promise<void> => {
    try { db.close(); } catch { /* 이미 닫혔으면 무시 */ }
  };

  return { db, cleanup };
}

/** 테스트용 지갑 주소 (실제 키 없음) */
export const TEST_ADDRESSES = {
  alice: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  bob:   "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  carol: "0xcccccccccccccccccccccccccccccccccccccccc",
} as const;

/** SQL injection 공격 문자열 목록 */
export const SQL_PAYLOADS = [
  "'; DROP TABLE TripRecord; --",
  "' OR '1'='1",
  "\" OR \"1\"=\"1",
  "1; SELECT * FROM AuthNonce; --",
  "\\'; INSERT INTO TripRecord VALUES('x','x','x',0,'x','x','x'); --",
  "<script>alert(1)</script>",
  "A".repeat(10000),
] as const;
