/**
 * 금액(마이크로USDC) 문자열 검증 테스트 — 서버 경계.
 * BigInt() 생성자는 "0x10"(16진), " 12 "(공백), ""(→0n)도 받아 주므로, 10진 정수 문자열만 허용하는지 확인합니다.
 *
 * 격리: 순수 함수 + 인메모리 SQLite(:memory:)만 사용합니다. 파일 DB·.env·네트워크를 사용하지 않습니다.
 */

import { describe, test, expect } from "bun:test";
import { decodeFunctionData, parseAbi } from "viem";
import { createTestDb, _setTestDb, _clearTestDb } from "./setup.js";
import { assertBigIntStr } from "../controllers/trips.controller.js";
import { prepareCreateTripIntent } from "../controllers/intent.controller.js";

const MAX_UINT256 = (1n << 256n) - 1n;

describe("assertBigIntStr — 10진 정수 문자열만", () => {
  test.each(["0", "1", "123456789", "0001"])("허용: %p", (v) => {
    expect(() => assertBigIntStr(v, "amount")).not.toThrow();
  });

  test("정확한 값 반환 (2^53 초과 포함)", () => {
    expect(assertBigIntStr("9007199254740993", "amount")).toBe(9007199254740993n);
    expect(assertBigIntStr(MAX_UINT256.toString(), "amount")).toBe(MAX_UINT256);
  });

  test.each(["", " ", " 12", "12 ", "0x10", "0b1", "1e3", "1.5", "1.0", "-1", "+1", "1,000", "12abc", "NaN", "Infinity", "٣"])(
    "거부: %p",
    (v) => {
      expect(() => assertBigIntStr(v, "amount")).toThrow(RangeError);
    },
  );

  test("문자열이 아니면 거부 (숫자·bigint·객체·배열·불리언·null)", () => {
    for (const v of [null, undefined, 12, 1.5, 12n, {}, [], true]) {
      expect(() => assertBigIntStr(v, "amount")).toThrow(RangeError);
    }
  });

  test("uint256 초과 거부", () => {
    expect(() => assertBigIntStr((MAX_UINT256 + 1n).toString(), "amount")).toThrow(RangeError);
  });
});

// ─── 여행방 생성 의도: targetBudget ───────────────────────────────────────────

type Reply = { body: unknown; status: number | undefined };

function fakeContext(body: unknown, caller: string) {
  return {
    get: (key: string) => (key === "callerAddress" ? caller : undefined),
    req: {
      query: () => undefined,
      json: async () => body,
    },
    json: (b: unknown, status?: number): Reply => ({ body: b, status }),
  };
}

const CALLER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baseBody = { tripName: "도쿄", participantAddresses: [] as string[] };

describe("prepareCreateTripIntent — targetBudget 엄격 검증", () => {
  test.each(["0x10", "1e3", "1.5", "-1", " 5", "", "12abc"])("400: %p", async (targetBudget) => {
    const c = fakeContext({ ...baseBody, targetBudget }, CALLER);
    const res = (await prepareCreateTripIntent(c as never)) as unknown as Reply;
    expect(res.status).toBe(400);
  });

  test("숫자 타입(부동소수) 도 거부", async () => {
    const c = fakeContext({ ...baseBody, targetBudget: 1.5 }, CALLER);
    const res = (await prepareCreateTripIntent(c as never)) as unknown as Reply;
    expect(res.status).toBe(400);
  });

  test("uint256 초과 400", async () => {
    const c = fakeContext({ ...baseBody, targetBudget: (MAX_UINT256 + 1n).toString() }, CALLER);
    const res = (await prepareCreateTripIntent(c as never)) as unknown as Reply;
    expect(res.status).toBe(400);
  });

  test("유효한 정수 문자열은 통과해 의도가 생성되고 calldata 에 정확한 값이 인코딩됨 (인메모리 DB)", async () => {
    const savedAddr = process.env.MOARC_CONTRACT_ADDRESS;
    process.env.MOARC_CONTRACT_ADDRESS = "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3";
    const { db, cleanup } = createTestDb("amount-validation");
    _setTestDb(db);
    try {
      const raw = "9007199254740993"; // 2^53+1 micro — Number 였다면 손실되는 값
      const c = fakeContext({ ...baseBody, targetBudget: raw }, CALLER);
      const res = (await prepareCreateTripIntent(c as never)) as unknown as Reply;
      expect(res.status).toBe(201);
      const data = (res.body as { tx: { data: string } }).tx.data;
      // calldata 를 디코딩하면 targetBudget 이 정확히 raw 와 같고, 참여자 목록은 비어 있다
      const abi = parseAbi([
        "function createTrip(string name, address[] participants, uint256 targetBudget) returns (uint256 tripId)",
      ]);
      const decoded = decodeFunctionData({ abi, data: data as `0x${string}` });
      expect(decoded.args?.[2]).toBe(9007199254740993n);
    } finally {
      _clearTestDb();
      await cleanup();
      if (savedAddr === undefined) delete process.env.MOARC_CONTRACT_ADDRESS;
      else process.env.MOARC_CONTRACT_ADDRESS = savedAddr;
    }
  });
});
