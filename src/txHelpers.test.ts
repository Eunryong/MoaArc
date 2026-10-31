// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * 쓰기 트랜잭션 헬퍼 테스트 (bun test).
 *
 * - 실제 viem 클라이언트에 "가짜 transport" 를 연결해 eth_call 의 `from` 과 revert 데이터를 검증합니다.
 * - 네트워크·지갑·DB 를 사용하지 않습니다.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  custom,
  encodeErrorResult,
  UserRejectedRequestError,
  BaseError,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { simulateAs, extractRevertReason, sanitizeErrorText } from "./txHelpers";
import { MOAARK_ABI } from "./contractAbi";

const ADMIN = "0x1111111111111111111111111111111111111111" as const;
const SPENDER = "0x2222222222222222222222222222222222222222" as const;
const CONTRACT = "0xf7a733fb2084b31591a0fbacded683efbe5b6728" as const;

type EthCall = { from?: string; to?: string; data?: string };

/** eth_call 파라미터를 기록하고, revertData 가 있으면 revert 로 응답하는 클라이언트 */
function makeClient(revertData?: Hex) {
  const calls: EthCall[] = [];
  const client = createPublicClient({
    chain: arcTestnet,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_call") {
          calls.push((params as [EthCall])[0]);
          if (revertData) {
            throw Object.assign(new Error("execution reverted"), { code: 3, data: revertData });
          }
          return "0x";
        }
        throw new Error(`unexpected rpc method ${method}`);
      },
    }),
  });
  return { client, calls };
}

const RELEASE = {
  address: CONTRACT,
  abi: MOAARK_ABI,
  functionName: "releaseBudget",
  args: [1n, SPENDER, 1_000_000n, "hotel"],
} as const;

// ─── simulateAs: 시뮬레이션 sender ───────────────────────────────────────────

describe("simulateAs — 연결된 지갑을 sender 로 사용", () => {
  test("account 를 simulateContract 인자에 합쳐서 전달", async () => {
    const seen: unknown[] = [];
    await simulateAs({ simulateContract: async (a) => { seen.push(a); return {}; } }, RELEASE, ADMIN);
    expect(seen).toHaveLength(1);
    const arg = seen[0] as { account: string; functionName: string; args: unknown[] };
    expect(arg.account).toBe(ADMIN);
    expect(arg.functionName).toBe("releaseBudget");
    expect(arg.args[3]).toBe("hotel");
  });

  test("account 가 비어 있으면 시뮬레이션을 호출하지 않고 오류", async () => {
    let called = false;
    const client = { simulateContract: async () => { called = true; return {}; } };
    await expect(simulateAs(client, RELEASE, "" as `0x${string}`)).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("실제 eth_call 의 from 이 연결된 지갑 주소", async () => {
    const { client, calls } = makeClient();
    await simulateAs(client, RELEASE, ADMIN);
    expect(calls).toHaveLength(1);
    expect(calls[0].from?.toLowerCase()).toBe(ADMIN);
    expect(calls[0].to?.toLowerCase()).toBe(CONTRACT);
  });

  test("[회귀 원인] account 없이 simulateContract 를 부르면 from 이 비어 msg.sender 가 0x0 이 됨", async () => {
    const { client, calls } = makeClient();
    await client.simulateContract({ ...RELEASE });
    expect(calls[0].from).toBeUndefined();
  });
});

// ─── extractRevertReason ─────────────────────────────────────────────────────

async function revertReasonFor(revertData: Hex): Promise<string> {
  const { client } = makeClient(revertData);
  try {
    await simulateAs(client, RELEASE, ADMIN);
  } catch (e) {
    return extractRevertReason(e);
  }
  throw new Error("revert 가 발생해야 합니다");
}

describe("extractRevertReason — 컨트랙트 revert 사유", () => {
  test("커스텀 오류 NotAdmin(tripId) → 오류명·인자·안내 포함 (generic shortMessage 아님)", async () => {
    const data = encodeErrorResult({ abi: MOAARK_ABI, errorName: "NotAdmin", args: [7n] });
    const msg = await revertReasonFor(data);
    expect(msg).toContain("NotAdmin(tripId=7)");
    expect(msg).toContain("관리자");
    expect(msg).not.toContain("execution reverted");
  });

  test("bigint 인자는 정밀도 손실 없이 표시 (InsufficientContractBalance)", async () => {
    const available = 2n ** 64n + 1n;
    const data = encodeErrorResult({
      abi: MOAARK_ABI, errorName: "InsufficientContractBalance", args: [available, 5_000_000n],
    });
    const msg = await revertReasonFor(data);
    expect(msg).toContain(`available=${available.toString()}`);
    expect(msg).toContain("requested=5000000");
  });

  test("인자 없는 오류(InvalidAmount)", async () => {
    const data = encodeErrorResult({ abi: MOAARK_ABI, errorName: "InvalidAmount" });
    expect(await revertReasonFor(data)).toContain("InvalidAmount()");
  });

  test("Error(string) revert → 사유 문자열 노출", async () => {
    const data = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["ERC20: transfer amount exceeds balance"],
    });
    expect(await revertReasonFor(data)).toContain("ERC20: transfer amount exceeds balance");
  });

  test("ABI 에 없는 selector → selector 만 안내", async () => {
    const msg = await revertReasonFor("0xdeadbeef");
    expect(msg).toContain("0xdeadbeef");
  });

  test("사용자가 지갑에서 거부", () => {
    const e = new UserRejectedRequestError(new Error("User rejected the request."));
    expect(extractRevertReason(e)).toContain("거부");
  });

  test("viem 오류가 아닌 값도 문자열로 처리", () => {
    expect(extractRevertReason("boom")).toBe("boom");
    expect(extractRevertReason(new Error("plain failure"))).toBe("plain failure");
    expect(extractRevertReason(undefined)).toBe("undefined");
  });

  test("BaseError 는 멀티라인 details 대신 shortMessage 만 사용", () => {
    const e = new BaseError("short summary", { details: "SECRET_DETAILS_LINE" });
    const msg = extractRevertReason(e);
    expect(msg).toBe("short summary");
    expect(msg).not.toContain("SECRET_DETAILS_LINE");
  });
});

describe("sanitizeErrorText — 비밀값 노출 방지", () => {
  test("URL 쿼리스트링(_rpc_token) 제거", () => {
    const out = sanitizeErrorText("HTTP request failed. URL: https://rpc.example.com/api/rpc/arc?_rpc_token=SUPERSECRET123&x=1");
    expect(out).not.toContain("SUPERSECRET123");
    expect(out).toContain("https://rpc.example.com/api/rpc/arc?…");
  });

  test("Bearer / key=value 비밀 제거", () => {
    expect(sanitizeErrorText("Authorization: Bearer abc.DEF-123")).not.toContain("abc.DEF-123");
    expect(sanitizeErrorText("api_key=sk_live_999 failed")).not.toContain("sk_live_999");
  });

  test("64자리 hex(개인키와 구분 불가)는 가리고 selector·주소는 유지", () => {
    const key = "0x" + "ab".repeat(32);
    const out = sanitizeErrorText(`bad ${key} and ${ADMIN} and 0xdeadbeef`);
    expect(out).not.toContain(key);
    expect(out).toContain(ADMIN);
    expect(out).toContain("0xdeadbeef");
  });

  test("첫 줄만, 300자 이내", () => {
    const out = sanitizeErrorText("first line\nRequest Arguments:\n  from: 0xabc");
    expect(out).toBe("first line");
    expect(sanitizeErrorText("x".repeat(1000))).toHaveLength(300);
  });

  test("일반 Error.message 의 RPC 토큰도 extractRevertReason 을 거치며 제거", () => {
    const out = extractRevertReason(new Error("fetch failed https://h.example/p?_rpc_token=TOPSECRET"));
    expect(out).not.toContain("TOPSECRET");
  });
});

// ─── ABI 가 컨트랙트의 모든 custom error 를 포함하는지 ───────────────────────

describe("MOAARK_ABI custom errors", () => {
  test("MoaArcTreasury.sol 의 모든 error 선언이 ABI 에 있고 인자 개수가 일치", () => {
    const src = readFileSync(new URL("../contracts/MoaArcTreasury.sol", import.meta.url), "utf8");
    const declared = [...src.matchAll(/^\s*error\s+(\w+)\(([^)]*)\);/gm)].map((m) => ({
      name: m[1],
      argc: m[2].trim() === "" ? 0 : m[2].split(",").length,
    }));
    expect(declared.length).toBeGreaterThan(20);

    const abiItems: readonly { type: string; name?: string; inputs?: readonly unknown[] }[] = MOAARK_ABI;
    const abiErrors = new Map(
      abiItems.filter((x) => x.type === "error").map((x) => [x.name ?? "", x.inputs?.length ?? 0] as const),
    );
    for (const d of declared) {
      expect(abiErrors.has(d.name)).toBe(true);
      expect(abiErrors.get(d.name)).toBe(d.argc);
    }
  });
});

// ─── 회귀 방지: useContractWrite 의 모든 사전 시뮬레이션이 연결된 지갑을 sender 로 사용 ────

describe("useContractWrite — 시뮬레이션 sender 정적 점검", () => {
  const src = readFileSync(new URL("./useContractWrite.ts", import.meta.url), "utf8");

  test("account 없는 simulate()/simulateContract() 직접 호출이 없음", () => {
    expect(src).not.toMatch(/\bawait simulate\(/);
    expect(src).not.toMatch(/\.simulateContract\(/);
  });

  test("모든 simulateAs 호출이 연결된 지갑 주소(address)를 마지막 인자로 전달", () => {
    const calls = src.match(/simulateAs\(publicClient, \{[\s\S]*?\}, address\);/g) ?? [];
    const total = (src.match(/await simulateAs\(/g) ?? []).length;
    expect(total).toBeGreaterThanOrEqual(6); // deposit, release, approve, claim, cancel, addParticipant
    expect(calls.length).toBe(total);
  });

  test("releaseBudget 훅은 useAccount() 지갑이 없으면 시뮬레이션 전에 중단하고 address 를 의존성에 포함", () => {
    const start = src.indexOf("export function useReleaseBudget");
    const end = src.indexOf("export function useReturnUnusedBudget");
    const block = src.slice(start, end);
    expect(block).toContain("useAccount()");
    expect(block).toMatch(/if \(!address \|\| !publicClient\)/);
    expect(block).toMatch(/simulateAs\([\s\S]*"releaseBudget"[\s\S]*\}, address\)/);
    expect(block).toMatch(/\[address, publicClient, writeContractAsync, tripId, tripContractAddress\]/);
    // 지갑 확인이 시뮬레이션보다 앞선다
    expect(block.indexOf("!address")).toBeLessThan(block.indexOf("simulateAs("));
  });
});
