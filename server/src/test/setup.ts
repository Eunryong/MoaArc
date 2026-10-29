/**
 * 보안 테스트용 격리 SQLite DB 헬퍼
 *
 * 실제 Prisma 클라이언트로 임시 파일 DB를 생성하고,
 * 테스트 종료 후 연결을 먼저 끊은 뒤 파일을 삭제합니다.
 * 공유 DB(dev.db)는 건드리지 않습니다.
 * 네트워크·실제 지갑·공유 DB를 사용하지 않습니다.
 *
 * 경로 결정 전략 (Studio, macOS, Linux 공통):
 *  - 소스 파일 위치는 import.meta.url + fileURLToPath로 구합니다
 *    (bun test가 .ts를 직접 실행하므로 __filename이 실제 소스 경로임)
 *  - schema.prisma: 이 파일 기준 ../../prisma/schema.prisma
 *    (server/src/test → server/src → server → server/prisma)
 *  - 프로젝트 루트(node_modules 있는 디렉터리): ../../..
 *    (server/src/test → server/src → server → [프로젝트 루트])
 *  - Prisma CLI: 루트/node_modules/prisma/build/index.js 우선,
 *    없으면 루트/node_modules/.bin/prisma
 *  - Node 실행 파일: `which node` 우선(동기 실행), 없으면
 *    플랫폼 공통 후보 경로 탐색, 마지막으로 process.execPath(node일 때만)
 */

import { execFileSync, execSync } from "child_process";
import { unlinkSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

// ─── 소스 파일 위치 ───────────────────────────────────────────────────────────
// bun test는 TypeScript를 직접 실행하므로 import.meta.url이 .ts 소스 경로를 가리킴
const __filename = fileURLToPath(import.meta.url);
const __dir = path.dirname(__filename);

// ─── 프로젝트 루트 ────────────────────────────────────────────────────────────
// 이 파일: server/src/test/setup.ts
// 루트:    ../../..  →  server/src/test → server/src → server → [root]
const PROJECT_ROOT = path.resolve(__dir, "../../..");

// ─── schema.prisma 경로 ───────────────────────────────────────────────────────
// server/prisma/schema.prisma → 이 파일에서 2단계 위 → server → server/prisma
const SCHEMA_SRC = path.resolve(__dir, "../../prisma/schema.prisma");

if (!existsSync(SCHEMA_SRC)) {
  throw new Error(
    `[setup.ts] schema.prisma not found at: ${SCHEMA_SRC}\n` +
    `Expected location relative to ${__filename}: ../../prisma/schema.prisma`
  );
}

// ─── Prisma CLI 경로 ──────────────────────────────────────────────────────────
// node_modules は PROJECT_ROOT 아래에 있음
function resolvePrismaCli(): string {
  const candidates = [
    path.resolve(PROJECT_ROOT, "node_modules/prisma/build/index.js"),
    path.resolve(PROJECT_ROOT, "node_modules/.bin/prisma"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `[setup.ts] Prisma CLI not found. Tried:\n${candidates.map(c => `  ${c}`).join("\n")}\n` +
    `Make sure you ran 'bun install' (or 'npm install') in the project root: ${PROJECT_ROOT}`
  );
}

const PRISMA_CLI = resolvePrismaCli();

// ─── Node 실행 파일 ───────────────────────────────────────────────────────────
// Prisma CLI는 node로 실행해야 합니다 (bun과 호환 문제 방지).
// 1순위: PATH에서 node를 찾음 (which node / where node)
// 2순위: 플랫폼 공통 후보 경로
// 3순위: process.execPath가 node 계열이면 사용
function resolveNodeBin(): string {
  // 1순위: PATH 탐색
  try {
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const found = execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .split("\n")[0]
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    // which/where 실패 — 후보 경로로 계속
  }

  // 2순위: 플랫폼별 공통 후보 경로
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files (x86)\\nodejs\\node.exe",
        ]
      : [
          "/usr/local/bin/node",
          "/usr/bin/node",
          "/opt/homebrew/bin/node",       // macOS ARM Homebrew
          "/opt/homebrew/opt/node/bin/node",
          "/usr/local/opt/node/bin/node",  // macOS Intel Homebrew
          "/nix/var/nix/profiles/default/bin/node", // Nix
        ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 3순위: process.execPath가 node 계열이면 허용
  const ep = process.execPath;
  if (path.basename(ep).startsWith("node") && existsSync(ep)) return ep;

  throw new Error(
    `[setup.ts] Node.js executable not found.\n` +
    `'which node' returned nothing, and none of the fallback paths exist.\n` +
    `Make sure Node.js is installed and available in PATH.`
  );
}

const NODE_BIN = resolveNodeBin();

// ─── createTestDb ─────────────────────────────────────────────────────────────

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
