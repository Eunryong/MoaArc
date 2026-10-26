import { PrismaClient } from "@prisma/client";
import path from "path";
import { fileURLToPath } from "url";

// schema.prisma 위치 기준 절대 경로로 DB 파일 위치를 고정
// DATABASE_URL 환경변수의 상대경로 해석 오류를 방지
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/src/lib/ → server/prisma/dev.db
const DEV_DB_PATH = path.resolve(__dirname, "../../prisma/dev.db");

function resolvedDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  // SQLite 파일 URL이고 경로가 절대 경로가 아닌 경우 절대 경로로 변환
  if (url.startsWith("file:") && !url.startsWith("file:/")) {
    return `file:${DEV_DB_PATH}`;
  }
  return url;
}

// DB 경로 진단 (경로만 출력, 값 없음)
const resolvedUrl = resolvedDatasourceUrl() ?? `file:${DEV_DB_PATH}`;
console.log(`[prisma] DB URL path: ${resolvedUrl.replace(/file:/, "").split("?")[0]}`);

// 개발 환경에서 HMR 재시작마다 새 PrismaClient 생성을 방지
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    datasources: {
      db: { url: resolvedUrl },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
