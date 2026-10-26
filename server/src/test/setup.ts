/**
 * 보안 테스트용 격리 SQLite DB 헬퍼
 *
 * 실제 Prisma 클라이언트로 임시 파일 DB를 생성하고,
 * 테스트 종료 후 연결을 먼저 끊은 뒤 파일을 삭제합니다.
 * 공유 DB(dev.db)는 건드리지 않습니다.
 * 네트워크·실제 지갑·공유 DB를 사용하지 않습니다.
 */

import { execFileSync } from "child_process";
import { unlinkSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";

// Prisma CLI 후보 경로 — 존재 여부만 검사, 실행하지 않음
const PRISMA_CLI_CANDIDATES = [
  "/home/user/app/node_modules/prisma/build/index.js",
];
const NODE_CANDIDATES = [
  "/usr/bin/node",
  "/usr/local/bin/node",
];

function resolveCli(candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`None of these paths exist: ${candidates.join(", ")}`);
}

const PRISMA_CLI = resolveCli(PRISMA_CLI_CANDIDATES);
const NODE_BIN  = resolveCli(NODE_CANDIDATES);

// schema.prisma 원본 경로 (읽기 전용)
const SCHEMA_SRC = path.resolve("/home/user/app/server/prisma/schema.prisma");

/** 격리된 테스트 DB를 생성하고 Prisma 클라이언트와 DB URL을 반환합니다 */
export function createTestDb(label: string): {
  prisma: PrismaClient;
  dbPath: string;
  dbUrl: string;
  cleanup: () => Promise<void>;
} {
  // label의 안전 문자만 유지 (영숫자·하이픈·밑줄) — 경로 탈출 방지
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const dbPath = path.resolve(
    `/tmp/moaarc-test-${safeLabel}-${randomUUID()}.db`
  );
  const dbUrl = `file:${dbPath}`;

  // 고유 임시 디렉터리에 schema.prisma만 복사
  // — .env가 없는 경로이므로 Prisma CLI가 어떤 .env도 탐색하지 않음
  const tmpSchemaDir = mkdtempSync("/tmp/moaarc-schema-");
  const tmpSchema = path.join(tmpSchemaDir, "schema.prisma");

  try {
    copyFileSync(SCHEMA_SRC, tmpSchema);

    // CLI child env allowlist — process.env 전체를 넘기지 않음
    // HOME/TMPDIR도 tmpSchemaDir로 격리해 홈 디렉터리 .env 탐색 차단
    const childEnv: Record<string, string> = {
      PATH:         process.env.PATH ?? "",
      HOME:         tmpSchemaDir,
      TMPDIR:       tmpSchemaDir,
      NODE_ENV:     "test",
      DATABASE_URL: dbUrl,
    };

    // execFileSync로 node + Prisma CLI 직접 호출
    // cwd=tmpSchemaDir → .env 탐색 기준이 /tmp 아래, .env 없음
    try {
      execFileSync(
        NODE_BIN,
        [
          PRISMA_CLI,
          "db", "push",
          "--schema", tmpSchema,
          "--skip-generate",
          "--force-reset",
        ],
        { cwd: tmpSchemaDir, env: childEnv, stdio: "pipe" }
      );
    } catch (pushErr) {
      // db push 실패 시 이미 생성됐을 수 있는 DB/WAL/SHM 파일 정리 후 재던짐
      for (const suffix of ["", "-wal", "-shm"]) {
        const fp = `${dbPath}${suffix}`;
        if (existsSync(fp)) unlinkSync(fp);
      }
      throw pushErr;
    }
  } finally {
    // 성공/실패 모두 임시 schema 디렉터리 삭제
    rmSync(tmpSchemaDir, { recursive: true, force: true });
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  // cleanup: Prisma 연결을 먼저 끊은 뒤 DB 파일과 WAL/SHM 파일을 삭제
  const cleanup = async (): Promise<void> => {
    await prisma.$disconnect();
    for (const suffix of ["", "-wal", "-shm"]) {
      const fp = `${dbPath}${suffix}`;
      if (existsSync(fp)) unlinkSync(fp);
    }
  };

  return { prisma, dbPath, dbUrl, cleanup };
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
  "A".repeat(10000), // 길이 초과
] as const;
