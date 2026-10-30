// ─── 온체인 읽기 결과 처리 (순수 함수 — wagmi / import.meta.env 의존 없음) ────────
//
// 목적: "읽기 실패 / 로딩 중"을 0 으로 위장하지 않고, 모든 금액을 bigint 로 유지합니다.
// 이 모듈은 단위 테스트 가능하도록 React/wagmi 를 import 하지 않습니다.

import type { OnchainReadStatus, Participant, Trip } from "./types";
import type { I18nKeys } from "./i18n/en";
import { fmtUsdc } from "./calculations";

// ─── 단일 읽기 분류 ──────────────────────────────────────────────────────────

export type ReadState<T> =
  | { kind: "disabled" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; value: T };

/**
 * wagmi/react-query 결과를 4상태로 분류합니다.
 * isError 이면 이전 캐시 값이 남아 있어도 error 로 취급합니다 (오래된 값을 최신처럼 보이지 않게).
 */
export function classifyRead<T>(input: {
  enabled: boolean;
  isError: boolean;
  data: T | undefined;
}): ReadState<T> {
  if (!input.enabled) return { kind: "disabled" };
  if (input.isError) return { kind: "error" };
  if (input.data === undefined) return { kind: "loading" };
  return { kind: "ok", value: input.data };
}

export type ReadStatusLabelKey = Extract<I18nKeys, "checking" | "read_failed" | "status_unknown">;

/** "ok" 가 아닌 상태를 표시할 i18n 키 */
export function statusLabelKey(status: Exclude<OnchainReadStatus, "ok">): ReadStatusLabelKey {
  switch (status) {
    case "loading": return "checking";
    case "error": return "read_failed";
    case "disabled": return "status_unknown";
  }
}

/** USDC 금액 표시. ok 가 아니면 label(상태 문구)을 반환 — 절대 "0.00" 으로 대체하지 않습니다. */
export function formatReadUsdc(
  state: ReadState<bigint>,
  label: (key: ReadStatusLabelKey) => string,
  minDigits = 2,
): string {
  if (state.kind === "ok") return `${fmtUsdc(state.value, minDigits)} USDC`;
  return label(statusLabelKey(state.kind));
}

// ─── 참여자별 온체인 잔액 (depositedAmount / allocatedBudget / spentFromBudget) ──

export interface ParticipantOnchainRow {
  deposited: bigint;
  allocated: bigint;
  spent: bigint;
}

/** useReadContracts(allowFailure: true) 결과 한 칸 */
export interface ContractReadResult {
  status: "success" | "failure";
  result?: unknown;
}

/** 참여자 1명당 읽는 함수 순서 — useParticipantBalances 의 contracts 배열과 반드시 일치해야 합니다. */
export const PARTICIPANT_READ_FUNCTIONS = ["depositedAmount", "allocatedBudget", "spentFromBudget"] as const;
export const READS_PER_PARTICIPANT = PARTICIPANT_READ_FUNCTIONS.length;

/**
 * 평탄화된 multicall 결과를 주소별 행으로 변환합니다.
 * 3개 읽기 중 하나라도 실패하거나 bigint 가 아니면 그 참여자는 결과에서 빠집니다 (0n 으로 채우지 않음).
 */
export function parseParticipantBalances(
  addresses: readonly string[],
  results: readonly ContractReadResult[] | undefined,
): Record<string, ParticipantOnchainRow> {
  const rows: Record<string, ParticipantOnchainRow> = {};
  if (!results) return rows;
  addresses.forEach((addr, i) => {
    const base = i * READS_PER_PARTICIPANT;
    const dep = results[base];
    const alloc = results[base + 1];
    const spent = results[base + 2];
    if (
      dep?.status === "success" && typeof dep.result === "bigint" &&
      alloc?.status === "success" && typeof alloc.result === "bigint" &&
      spent?.status === "success" && typeof spent.result === "bigint"
    ) {
      rows[addr.toLowerCase()] = {
        deposited: dep.result,
        allocated: alloc.result,
        spent: spent.result,
      };
    }
  });
  return rows;
}

export type BatchStatus = "disabled" | "loading" | "error" | "ok";

/**
 * Trip 의 참여자에게 온체인 값을 입힙니다.
 * - 값이 있는 참여자: 실제 bigint + onchainStatus "ok"
 * - 값이 없는 참여자: 세 필드는 0n 이지만 onchainStatus 가 "ok" 가 아니므로 UI 가 값을 표시하지 않습니다.
 */
export function applyOnchainBalances(
  trip: Trip,
  rows: Readonly<Record<string, ParticipantOnchainRow>>,
  batchStatus: BatchStatus,
): Trip {
  const participants: Participant[] = trip.participants.map((p) => {
    const row = rows[p.address.toLowerCase()];
    if (row) {
      return {
        ...p,
        depositedAmount: row.deposited,
        allocatedBudget: row.allocated,
        spentFromBudget: row.spent,
        onchainStatus: "ok",
      };
    }
    // 이 참여자의 값이 없음 — 배치가 ok 인데 행이 없으면 개별 읽기 실패
    const status: OnchainReadStatus = batchStatus === "ok" ? "error" : batchStatus;
    return {
      ...p,
      depositedAmount: 0n,
      allocatedBudget: 0n,
      spentFromBudget: 0n,
      onchainStatus: status,
    };
  });
  return { ...trip, participants };
}

/** 모든 참여자 상태를 하나로 요약: 전부 ok → ok, 하나라도 error → error, loading 이 있으면 loading */
export function overallStatus(participants: readonly Participant[]): OnchainReadStatus {
  if (participants.length === 0) return "disabled";
  const statuses = participants.map((p) => p.onchainStatus ?? "ok");
  if (statuses.every((s) => s === "ok")) return "ok";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("loading")) return "loading";
  return "disabled";
}

/**
 * 참여자 합계. 한 명이라도 ok 가 아니면 undefined (부분 합계를 전체처럼 보이지 않게).
 */
export function sumParticipantField(
  participants: readonly Participant[],
  field: "depositedAmount" | "allocatedBudget" | "spentFromBudget",
): bigint | undefined {
  if (overallStatus(participants) !== "ok") return undefined;
  return participants.reduce((sum, p) => sum + p[field], 0n);
}

/** 참여자 합계를 ReadState 로 반환 (전원 ok 일 때만 ok, 아니면 가장 심각한 상태) */
export function participantSumState(
  participants: readonly Participant[],
  field: "depositedAmount" | "allocatedBudget" | "spentFromBudget",
): ReadState<bigint> {
  const status = overallStatus(participants);
  if (status !== "ok") return { kind: status };
  return { kind: "ok", value: participants.reduce((sum, p) => sum + p[field], 0n) };
}

// ─── 주소 표시 ───────────────────────────────────────────────────────────────

/** 지갑 주소를 "0x1234…abcd" 형태로 축약 (동명이인 구분용). 이미 짧은 문자열은 그대로 반환. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

// ─── 이체 금액 검증 ──────────────────────────────────────────────────────────

/**
 * 공동지갑 현재 잔액(tripBalance)을 알고 있고 요청 금액이 그보다 클 때만 true.
 * 잔액을 모르면(로딩/실패) false — 시뮬레이션이 온체인에서 최종 방어합니다.
 */
export function exceedsKnownBalance(amount: bigint, available: bigint | undefined): boolean {
  return available !== undefined && amount > available;
}
