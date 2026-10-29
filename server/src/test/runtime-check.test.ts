import { describe, test, expect } from "bun:test";
import { execSync, execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

function resolveJsRuntimeUnderTest(): { runtime: string; source: string } {
  for (const bin of ["node", "bun"]) {
    try {
      const cmd = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
      const found = execSync(cmd, { stdio: ["pipe","pipe","pipe"] })
        .toString().split("\n")[0].trim();
      if (found && existsSync(found)) return { runtime: found, source: `which ${bin}` };
    } catch { /* 계속 */ }
  }
  const ep = process.execPath;
  const epBase = path.basename(ep);
  if ((epBase.startsWith("node") || epBase.startsWith("bun")) && existsSync(ep))
    return { runtime: ep, source: "process.execPath" };
  throw new Error("no runtime found");
}

describe("JS runtime 탐색 (setup.ts 동일 로직)", () => {
  test("bun test 환경에서 실행 가능한 런타임을 찾음", () => {
    const { runtime, source } = resolveJsRuntimeUnderTest();
    console.log(`resolved: ${runtime} (via ${source})`);
    expect(existsSync(runtime)).toBe(true);
    const base = path.basename(runtime);
    expect(base.startsWith("node") || base.startsWith("bun")).toBe(true);
  });

  test("process.execPath basename이 node 또는 bun", () => {
    const base = path.basename(process.execPath);
    console.log(`process.execPath: ${process.execPath} → basename: ${base}`);
    // bun test에서는 bun, CI에서 node로 실행하면 node — 둘 다 허용
    expect(base.startsWith("node") || base.startsWith("bun")).toBe(true);
  });

  test("찾은 런타임으로 Prisma CLI --version 실행 성공", () => {
    const { runtime, source } = resolveJsRuntimeUnderTest();
    const prismaCli = path.resolve(__dir, "../../..", "node_modules/prisma/build/index.js");
    expect(existsSync(prismaCli)).toBe(true);
    const out = execFileSync(
      runtime,
      [prismaCli, "--version"],
      {
        env: { PATH: process.env.PATH ?? "", HOME: "/tmp", DATABASE_URL: "file:/tmp/ver-check.db" },
        stdio: "pipe",
      }
    ).toString();
    console.log(`runtime=${runtime} (${source}), prisma output:`, out.trim().slice(0, 80));
    expect(out.toLowerCase()).toContain("prisma");
  });

  test("찾은 런타임으로 Prisma CLI db push 실제 격리 DB 생성 성공", () => {
    const { runtime } = resolveJsRuntimeUnderTest();
    const prismaCli = path.resolve(__dir, "../../..", "node_modules/prisma/build/index.js");
    const schemaSrc = path.resolve(__dir, "../../prisma/schema.prisma");
    const { mkdtempSync, copyFileSync, rmSync } = require("fs");
    const tmpDir = mkdtempSync("/tmp/moaarc-runtimetest-");
    const tmpSchema = path.join(tmpDir, "schema.prisma");
    const dbPath = path.join(tmpDir, "isolated.db");
    try {
      copyFileSync(schemaSrc, tmpSchema);
      execFileSync(
        runtime,
        [prismaCli, "db", "push", "--schema", tmpSchema, "--skip-generate", "--force-reset"],
        {
          cwd: tmpDir,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: tmpDir,
            TMPDIR: tmpDir,
            NODE_ENV: "test",
            DATABASE_URL: `file:${dbPath}`,
          },
          stdio: "pipe",
        }
      );
      expect(existsSync(dbPath)).toBe(true);
      console.log(`db push succeeded with runtime: ${runtime}, db: ${dbPath}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
