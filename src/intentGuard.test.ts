// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/** createTrip 트랜잭션을 지갑에 넘기기 전 검증(intentGuard) 테스트 — 지갑·네트워크·DB 미사용 */

import { describe, test, expect } from "bun:test";
import { encodeFunctionData, parseAbi } from "viem";
import { IntentTxMismatchError, assertIntentTxMatchesConfig, type IntentExpectation } from "./intentGuard";

const ABI = parseAbi(["function createTrip(string name, address[] participants, uint256 targetBudget) returns (uint256 tripId)"]);
const CONTRACT = "0x1111111111111111111111111111111111111111";
const TESTNET = "0xf7a733fb2084b31591a0fbacded683efbe5b6728";
const P1 = "0x2222222222222222222222222222222222222222";
const P2 = "0x3333333333333333333333333333333333333333";

const expectation = (over: Partial<IntentExpectation> = {}): IntentExpectation => ({
  configValid: true,
  chainId: 5042,
  contractAddress: CONTRACT,
  tripName: "제주 여행",
  participantAddresses: [P1, P2],
  targetBudgetMicro: 1_500_000n,
  ...over,
});

const data = (name = "제주 여행", ps: `0x${string}`[] = [P1, P2], budget = 1_500_000n) =>
  encodeFunctionData({ abi: ABI, functionName: "createTrip", args: [name, ps, budget] });

const tx = (over: Partial<{ to: string; data: string; value: string; chainId: number }> = {}) => ({
  to: CONTRACT,
  data: data(),
  value: "0x0", // 서버가 실제로 보내는 표기
  chainId: 5042,
  ...over,
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof IntentTxMismatchError) return e.code;
    throw e;
  }
  return "no-throw";
}

describe("assertIntentTxMatchesConfig", () => {
  test("정상 tx 는 통과 (value 는 '0' / '0x0' / '0x00' 허용, 주소 대소문자 무관)", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx(), expectation()))).toBe("no-throw");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ value: "0" }), expectation()))).toBe("no-throw");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ value: "0x00" }), expectation()))).toBe("no-throw");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ to: CONTRACT.toUpperCase().replace("0X", "0x") }), expectation()))).toBe("no-throw");
    expect(
      codeOf(() => assertIntentTxMatchesConfig(tx(), expectation({ participantAddresses: [P1.toUpperCase().replace("0X", "0x"), P2] }))),
    ).toBe("no-throw");
  });

  test("참여자 없음 / 예산 0 도 정확히 일치하면 통과", () => {
    expect(
      codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("a", [], 0n) }), expectation({ tripName: "a", participantAddresses: [], targetBudgetMicro: 0n }))),
    ).toBe("no-throw");
  });

  test("프런트 설정이 무효(CONFIG_VALID=false)이면 어떤 tx 도 거부", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx(), expectation({ configValid: false })))).toBe("config_invalid");
  });

  test("체인 ID 불일치 (서버가 testnet id 를 보냄)", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ chainId: 5042002 }), expectation()))).toBe("chain_id");
  });

  test("다른 컨트랙트로 보내려는 tx 거부 (testnet 컨트랙트 포함)", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ to: TESTNET }), expectation()))).toBe("to");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ to: P1 }), expectation()))).toBe("to");
  });

  test("value 가 0 이 아니면 거부", () => {
    for (const v of ["1", "0x1", "0x0de0b6b3a7640000", "", "0x"]) {
      expect(codeOf(() => assertIntentTxMatchesConfig(tx({ value: v }), expectation()))).toBe("value");
    }
  });

  test("calldata 가 createTrip 이 아니거나 손상되면 거부", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: "0x" }), expectation()))).toBe("calldata");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: "0xdeadbeef" }), expectation()))).toBe("calldata");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data().slice(0, 40) }), expectation()))).toBe("calldata");
  });

  test("인자가 사용자 입력과 다르면 거부: 이름 / 예산 / 참여자(추가·누락·순서)", () => {
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("다른 이름") }), expectation()))).toBe("trip_name");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P1, P2], 1_500_001n) }), expectation()))).toBe("target_budget");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P1]) }), expectation()))).toBe("participants");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P1, P2, CONTRACT]) }), expectation()))).toBe("participants");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P2, P1]) }), expectation()))).toBe("participants");
  });

  test("매우 큰 예산(2^80 micro)도 정확히 비교", () => {
    const big = 2n ** 80n;
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P1, P2], big) }), expectation({ targetBudgetMicro: big })))).toBe("no-throw");
    expect(codeOf(() => assertIntentTxMatchesConfig(tx({ data: data("제주 여행", [P1, P2], big) }), expectation({ targetBudgetMicro: big + 1n })))).toBe("target_budget");
  });
});
