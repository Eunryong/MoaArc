/**
 * intentGuard.ts — 서버가 준 createTrip 트랜잭션을 지갑에 넘기기 전 검증 (순수 함수)
 *
 * 서버 응답(to / data / value / chainId)을 그대로 서명시키면, 서버 설정 오류나 침해가 있을 때
 * 다른 컨트랙트·다른 체인·금액이 있는 트랜잭션을 서명하게 될 수 있습니다. 따라서 프런트 설정과
 * 사용자가 입력한 값에 대해 다음을 모두 확인하고, 하나라도 다르면 지갑 호출 전에 예외를 던집니다.
 *  - 프런트 설정이 유효(CONFIG_VALID)하고 서버 응답 chainId / to 가 설정과 정확히 일치
 *  - value 가 0 ("0" / "0x0") — createTrip 은 payable 이 아님
 *  - data 가 createTrip(name, participants, targetBudget) 호출이며 인자가 사용자 입력과 정확히 일치
 */

import { decodeFunctionData, parseAbi } from "viem";

const CREATE_TRIP_ABI = parseAbi([
  "function createTrip(string name, address[] participants, uint256 targetBudget) returns (uint256 tripId)",
]);

export interface IntentTxLike {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

export interface IntentExpectation {
  configValid: boolean;
  chainId: number;
  contractAddress: string;
  tripName: string;
  participantAddresses: readonly string[];
  targetBudgetMicro: bigint;
}

export class IntentTxMismatchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`intent_tx_mismatch:${code}`);
    this.name = "IntentTxMismatchError";
    this.code = code;
  }
}

export function assertIntentTxMatchesConfig(tx: IntentTxLike, expected: IntentExpectation): void {
  if (!expected.configValid) throw new IntentTxMismatchError("config_invalid");
  if (tx.chainId !== expected.chainId) throw new IntentTxMismatchError("chain_id");
  if (typeof tx.to !== "string" || tx.to.toLowerCase() !== expected.contractAddress.toLowerCase()) {
    throw new IntentTxMismatchError("to");
  }
  // 서버는 "0x0" 을 보냅니다. 0 을 뜻하는 표기만 허용 (그 외 값은 송금이 포함된 것)
  if (typeof tx.value !== "string" || !/^(0|0x0+)$/i.test(tx.value)) throw new IntentTxMismatchError("value");

  let decoded: ReturnType<typeof decodeFunctionData<typeof CREATE_TRIP_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: CREATE_TRIP_ABI, data: tx.data as `0x${string}` });
  } catch {
    throw new IntentTxMismatchError("calldata");
  }
  if (decoded.functionName !== "createTrip") throw new IntentTxMismatchError("function");
  const [name, participants, budget] = decoded.args;
  if (name !== expected.tripName) throw new IntentTxMismatchError("trip_name");
  if (budget !== expected.targetBudgetMicro) throw new IntentTxMismatchError("target_budget");
  const got = participants.map((a) => a.toLowerCase());
  const want = expected.participantAddresses.map((a) => a.toLowerCase());
  if (got.length !== want.length || got.some((a, i) => a !== want[i])) {
    throw new IntentTxMismatchError("participants");
  }
}
