// ─── 쓰기 트랜잭션 공통 헬퍼 (React / wagmi / import.meta.env 의존 없음 — 단위 테스트 가능) ──
//
// 1. simulateAs      : simulateContract 를 반드시 "연결된 지갑 주소"를 sender 로 실행
// 2. extractRevertReason : viem 오류에서 사용자가 이해할 수 있는 revert 사유를 추출 (비밀값 제거)

import { BaseError, ContractFunctionRevertedError } from "viem";

// ─── simulate ────────────────────────────────────────────────────────────────

export interface SimulateParams {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/**
 * simulateContract 를 호출하되 account(= msg.sender)를 반드시 지정합니다.
 *
 * account 없이 eth_call 하면 from 이 비어 msg.sender 가 0x0 이 되어
 * onlyAdmin / onlyParticipant 같은 msg.sender 기반 검사가 지갑 서명 전에 항상 revert 합니다.
 */
export async function simulateAs(
  // viem PublicClient 의 simulateContract 는 제네릭 오버로드라 인자를 느슨하게 받습니다.
  // oxlint-disable-next-line typescript/no-explicit-any
  publicClient: { simulateContract: (args: any) => Promise<unknown> },
  params: SimulateParams,
  account: `0x${string}`,
): Promise<void> {
  if (!account) throw new Error("simulateAs: account(연결된 지갑 주소)가 필요합니다.");
  await publicClient.simulateContract({ ...params, account });
}

// ─── 오류 문구 정리 ──────────────────────────────────────────────────────────

const MAX_ERROR_LEN = 300;

/**
 * 사용자에게 보여줄 문자열에서 비밀값 가능성이 있는 부분을 제거합니다.
 *  - URL 의 쿼리스트링(_rpc_token 등) / 인증 헤더 / key=value 형태 비밀
 *  - 64자리 hex (개인키와 구별 불가) — 4바이트 selector 와 주소(40자리)는 유지
 *  - 첫 줄만, 길이 제한
 */
export function sanitizeErrorText(raw: string): string {
  const firstLine = raw.split("\n")[0] ?? "";
  return firstLine
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/gi, "$1?…")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(token|_rpc_token|api[_-]?key|apikey|secret|password|authorization|private[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/0x[0-9a-fA-F]{64,}/g, "0x…[redacted]")
    .trim()
    .slice(0, MAX_ERROR_LEN);
}

// ─── revert 사유 추출 ────────────────────────────────────────────────────────

/** 자주 만나는 컨트랙트 오류에 대한 사용자 안내 (영문 오류명은 항상 함께 표시) */
const CONTRACT_ERROR_HINTS: Record<string, string> = {
  NotAdmin: "관리자 지갑만 실행할 수 있습니다",
  NotParticipant: "이 여행방의 참여자가 아닙니다",
  SpenderNotParticipant: "받는 사람이 이 여행방의 참여자가 아닙니다",
  InsufficientContractBalance: "공동지갑 잔액이 부족합니다",
  InvalidAmount: "금액은 0보다 커야 합니다",
  ExceedsAllocated: "배정된 예산을 초과했습니다",
  SettlementProposedLock: "정산이 진행 중이라 지금은 실행할 수 없습니다",
  SettlementAlreadyInProgress: "정산이 이미 진행 중입니다",
  TripLocked: "종료된 여행방입니다",
  TripNotFound: "여행방을 찾을 수 없습니다",
  ZeroAddress: "0x0 주소는 사용할 수 없습니다",
};

type AbiInputLike = { name?: string };

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeErrorText(value);
  return String(value);
}

function describeRevert(revert: ContractFunctionRevertedError): string | null {
  const data = revert.data;
  if (data?.errorName) {
    const inputs = ((data.abiItem as { inputs?: readonly AbiInputLike[] } | undefined)?.inputs) ?? [];
    const args = (data.args ?? []);
    const argText = args
      .map((v, i) => {
        const name = inputs[i]?.name;
        return name ? `${name}=${formatArg(v)}` : formatArg(v);
      })
      .join(", ");
    const sig = `${data.errorName}(${argText})`;
    const hint = CONTRACT_ERROR_HINTS[data.errorName];
    return hint ? `${hint} — ${sig}` : sig;
  }
  if (revert.reason) return `컨트랙트 revert: ${sanitizeErrorText(revert.reason)}`;
  if (revert.signature) return `알 수 없는 컨트랙트 오류 (selector ${revert.signature})`;
  return null;
}

function isUserRejection(e: BaseError): boolean {
  const hit = e.walk((x) => {
    const err = x as { name?: string; code?: number };
    return err.name === "UserRejectedRequestError" || err.code === 4001;
  });
  return !!hit;
}

/**
 * 트랜잭션 실패 오류 → 사용자용 문구.
 * 우선순위: 사용자 거절 → 컨트랙트 커스텀 오류/Error(string)/Panic → viem shortMessage → 일반 message.
 * 반환값은 항상 sanitizeErrorText 를 거쳐 RPC 토큰·긴 hex 등이 노출되지 않습니다.
 */
export function extractRevertReason(e: unknown): string {
  if (e instanceof BaseError) {
    if (isUserRejection(e)) return "지갑에서 요청을 거부했습니다.";
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const described = describeRevert(revert);
      if (described) return described.length > MAX_ERROR_LEN ? described.slice(0, MAX_ERROR_LEN) : described;
    }
    return sanitizeErrorText(e.shortMessage || e.message);
  }
  const short = (e as { shortMessage?: unknown } | null)?.shortMessage;
  if (typeof short === "string" && short) return sanitizeErrorText(short);
  return sanitizeErrorText(e instanceof Error ? e.message : String(e));
}
