// 루트 tsconfig 는 bun 타입을 자동 포함하지 않으므로 bun:test 선언 파일을 명시적으로 로드합니다 (타입 전용, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * 온체인 잔액 표시 로직 단위 테스트 (bun test).
 *
 * - 네트워크·지갑·DB 를 사용하지 않는 순수 함수만 검증합니다.
 * - 핵심: 읽기 전/실패가 0 으로 위장되지 않고, 모든 금액이 bigint 정밀도를 유지한다.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyRead,
  formatReadUsdc,
  parseParticipantBalances,
  applyOnchainBalances,
  overallStatus,
  participantSumState,
  sumParticipantField,
  exceedsKnownBalance,
  shortAddress,
  statusLabelKey,
  type ContractReadResult,
} from "./onchainReads";
import { calcParticipantSummary, fmtUsdc } from "./calculations";
import { apiRecordToTrip } from "./tripMapping";
import type { Participant, Trip } from "./types";
import type { TripApiRecord } from "./apiClient";

const A = "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

const LABELS = { checking: "Loading…", read_failed: "Read failed", status_unknown: "Unknown" } as const;
const label = (k: keyof typeof LABELS) => LABELS[k];

function ok(value: bigint): ContractReadResult {
  return { status: "success", result: value };
}
const FAIL: ContractReadResult = { status: "failure" };

function participant(id: "A" | "B" | "C", address: string, over: Partial<Participant> = {}): Participant {
  return {
    id, name: id, address, isAdmin: id === "A",
    depositedAmount: 0n, plannedDeposit: 0n, allocatedBudget: 0n, spentFromBudget: 0n,
    personalPrepaid: 0n, paidDeficit: 0n, refundClaimed: false,
    ...over,
  };
}

function makeTrip(participants: Participant[]): Trip {
  return {
    id: "t1", name: "Trip", contractAddress: "0x" + "f".repeat(40), onchainTripId: 1n,
    adminId: "A", participants, targetBudget: 0n, expenses: [], itinerary: [],
    settlement: null, createdAt: "2026-01-01T00:00:00.000Z",
  };
}

// ─── classifyRead / formatReadUsdc ───────────────────────────────────────────

describe("classifyRead", () => {
  test("disabled 가 loading/error 보다 우선", () => {
    expect(classifyRead<bigint>({ enabled: false, isError: true, data: undefined }).kind).toBe("disabled");
  });

  test("데이터 없음 → loading, 실패 → error", () => {
    expect(classifyRead<bigint>({ enabled: true, isError: false, data: undefined }).kind).toBe("loading");
    expect(classifyRead<bigint>({ enabled: true, isError: true, data: undefined }).kind).toBe("error");
  });

  test("갱신 실패(isError) 시 이전 캐시 값이 있어도 최신 값으로 취급하지 않음", () => {
    expect(classifyRead<bigint>({ enabled: true, isError: true, data: 5n }).kind).toBe("error");
  });

  test("실제 0n 은 ok (로딩/실패와 구분)", () => {
    const s = classifyRead<bigint>({ enabled: true, isError: false, data: 0n });
    expect(s).toEqual({ kind: "ok", value: 0n });
  });
});

describe("formatReadUsdc", () => {
  test("로딩/실패/비활성은 상태 문구이며 0.00 이 아님", () => {
    const loading = formatReadUsdc({ kind: "loading" }, label);
    const error = formatReadUsdc({ kind: "error" }, label);
    const disabled = formatReadUsdc({ kind: "disabled" }, label);
    expect(loading).toBe("Loading…");
    expect(error).toBe("Read failed");
    expect(disabled).toBe("Unknown");
    for (const text of [loading, error, disabled]) expect(text).not.toContain("0.00");
  });

  test("진짜 0 은 '0.00 USDC' 로 표시", () => {
    expect(formatReadUsdc({ kind: "ok", value: 0n }, label)).toBe("0.00 USDC");
  });

  test("상태 → i18n 키 매핑", () => {
    expect(statusLabelKey("loading")).toBe("checking");
    expect(statusLabelKey("error")).toBe("read_failed");
    expect(statusLabelKey("disabled")).toBe("status_unknown");
  });
});

// ─── bigint 정밀도 ───────────────────────────────────────────────────────────

describe("bigint precision", () => {
  test("Number 로 표현 불가능한 큰 값도 정확히 표시", () => {
    const huge = 2n ** 80n; // 1208925819614629174706176 micro-USDC
    expect(Number.isSafeInteger(Number(huge))).toBe(false);
    expect(fmtUsdc(huge)).toBe("1,208,925,819,614,629,174.706176");
  });

  test("2^53+1 같은 경계값이 손실 없이 합산·유지", () => {
    const big = 2n ** 53n + 1n;
    const rows = parseParticipantBalances([A, B], [
      ok(big), ok(big + 1n), ok(0n),
      ok(big), ok(0n), ok(0n),
    ]);
    expect(rows[A.toLowerCase()].deposited).toBe(big);
    expect(rows[A.toLowerCase()].allocated).toBe(big + 1n);
    const trip = applyOnchainBalances(makeTrip([participant("A", A), participant("B", B)]), rows, "ok");
    expect(sumParticipantField(trip.participants, "depositedAmount")).toBe(big * 2n);
  });
});

// ─── parseParticipantBalances ────────────────────────────────────────────────

describe("parseParticipantBalances", () => {
  test("읽기 결과가 없으면 빈 객체", () => {
    expect(parseParticipantBalances([A], undefined)).toEqual({});
  });

  test("주소 키는 소문자로 정규화", () => {
    const rows = parseParticipantBalances([A], [ok(1n), ok(2n), ok(3n)]);
    expect(Object.keys(rows)).toEqual([A.toLowerCase()]);
    expect(rows[A.toLowerCase()]).toEqual({ deposited: 1n, allocated: 2n, spent: 3n });
  });

  test("3개 읽기 중 하나라도 실패하면 그 참여자는 제외 (0n 으로 채우지 않음)", () => {
    const rows = parseParticipantBalances([A, B], [
      ok(10n), ok(0n), ok(0n),
      ok(5n), FAIL, ok(0n),
    ]);
    expect(Object.keys(rows)).toEqual([A.toLowerCase()]);
  });

  test("bigint 가 아닌 결과는 거부", () => {
    const rows = parseParticipantBalances([A], [
      ok(1n), { status: "success", result: 7 }, ok(0n),
    ]);
    expect(rows).toEqual({});
  });
});

// ─── applyOnchainBalances / 상태 요약 ────────────────────────────────────────

describe("applyOnchainBalances", () => {
  const base = () => makeTrip([participant("A", A), participant("B", B), participant("C", C)]);

  test("읽은 참여자에는 실제 값과 ok, 입력 trip 은 변경하지 않음", () => {
    const input = base();
    const rows = parseParticipantBalances([A, B, C], [
      ok(100n), ok(0n), ok(0n),
      ok(0n), ok(40n), ok(15n),
      ok(0n), ok(0n), ok(0n),
    ]);
    const out = applyOnchainBalances(input, rows, "ok");
    expect(out.participants[1].allocatedBudget).toBe(40n);
    expect(out.participants[1].spentFromBudget).toBe(15n);
    expect(out.participants.every((p) => p.onchainStatus === "ok")).toBe(true);
    // 원본 불변
    expect(input.participants[1].allocatedBudget).toBe(0n);
    expect(input.participants[1].onchainStatus).toBeUndefined();
  });

  test("배치가 ok 인데 행이 빠진 참여자는 error (가짜 0 아님)", () => {
    const rows = parseParticipantBalances([A, B, C], [
      ok(1n), ok(1n), ok(1n),
      FAIL, ok(1n), ok(1n),
      ok(1n), ok(1n), ok(1n),
    ]);
    const out = applyOnchainBalances(base(), rows, "ok");
    expect(out.participants.map((p) => p.onchainStatus)).toEqual(["ok", "error", "ok"]);
    expect(overallStatus(out.participants)).toBe("error");
  });

  test.each(["loading", "error", "disabled"] as const)("배치 %s → 모든 참여자 동일 상태, 금액 필드는 0n", (status) => {
    const out = applyOnchainBalances(base(), {}, status);
    expect(out.participants.every((p) => p.onchainStatus === status)).toBe(true);
    expect(out.participants.every((p) => p.allocatedBudget === 0n && p.depositedAmount === 0n)).toBe(true);
    expect(overallStatus(out.participants)).toBe(status);
  });

  test("이전 값이 남은 trip 도 읽기 실패 시 값이 초기화됨 (stale 값 노출 방지)", () => {
    const stale = makeTrip([participant("A", A, { allocatedBudget: 99n, onchainStatus: "ok" })]);
    const out = applyOnchainBalances(stale, {}, "error");
    expect(out.participants[0].allocatedBudget).toBe(0n);
    expect(out.participants[0].onchainStatus).toBe("error");
  });
});

describe("participantSumState", () => {
  test("전원 ok 일 때만 합계, 하나라도 아니면 부분 합계 없이 해당 상태", () => {
    const okP = [participant("A", A, { allocatedBudget: 30n, onchainStatus: "ok" }), participant("B", B, { allocatedBudget: 10n, onchainStatus: "ok" })];
    expect(participantSumState(okP, "allocatedBudget")).toEqual({ kind: "ok", value: 40n });

    const mixed = [okP[0], participant("B", B, { onchainStatus: "error" })];
    expect(participantSumState(mixed, "allocatedBudget")).toEqual({ kind: "error" });
    expect(sumParticipantField(mixed, "allocatedBudget")).toBeUndefined();

    const loading = [okP[0], participant("B", B, { onchainStatus: "loading" })];
    expect(participantSumState(loading, "allocatedBudget")).toEqual({ kind: "loading" });
  });

  test("참여자가 없으면 disabled", () => {
    expect(participantSumState([], "depositedAmount")).toEqual({ kind: "disabled" });
  });
});

// ─── 세 가지 금액이 서로 다른 값임을 확인 ────────────────────────────────────

describe("tripBalance vs 누적 입금 vs 참여자별 배정", () => {
  test("입금 100 → B 에게 40 이체 → B 가 10 반납: 현재 잔액 70, 누적 입금 100, 배정 합계 30", () => {
    // 컨트랙트 의미: tripBalance = 입금 − release + return,  allocatedBudget[B] = release − return
    const tripBalance = 100n - 40n + 10n;
    const rows = parseParticipantBalances([A, B], [
      ok(100n), ok(0n), ok(0n),
      ok(0n), ok(30n), ok(5n),
    ]);
    const trip = applyOnchainBalances(makeTrip([participant("A", A), participant("B", B)]), rows, "ok");

    const cumulative = participantSumState(trip.participants, "depositedAmount");
    const allocated = participantSumState(trip.participants, "allocatedBudget");

    expect(cumulative).toEqual({ kind: "ok", value: 100n });
    expect(allocated).toEqual({ kind: "ok", value: 30n });
    expect(tripBalance).toBe(70n);
    // 세 값은 서로 다르며(레이블이 구분되어야 함), 이 시나리오에선 tripBalance = 누적 입금 − 배정 합계
    expect(new Set([100n, 30n, tripBalance]).size).toBe(3);
    expect(tripBalance).toBe(100n - 30n);
  });
});

// ─── 주소 축약 (이체 대상 선택 UI) ───────────────────────────────────────────

describe("shortAddress", () => {
  test("앞 6자 + … + 뒤 4자", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });

  test("동명이인도 주소 축약값으로 구분됨", () => {
    expect(shortAddress(B)).not.toBe(shortAddress(C));
  });

  test("이미 짧은 값은 그대로", () => {
    expect(shortAddress("0x12")).toBe("0x12");
  });
});

// ─── 이체 금액 사전 검증 ─────────────────────────────────────────────────────

describe("exceedsKnownBalance", () => {
  test("경계값: 같으면 허용, 1 초과면 차단", () => {
    expect(exceedsKnownBalance(70n, 70n)).toBe(false);
    expect(exceedsKnownBalance(71n, 70n)).toBe(true);
  });

  test("잔액을 모르면(로딩/실패) 사전 차단하지 않음 — 온체인 시뮬레이션이 최종 방어", () => {
    expect(exceedsKnownBalance(10n ** 30n, undefined)).toBe(false);
  });

  test("실제 0 잔액이면 어떤 양수 이체도 차단", () => {
    expect(exceedsKnownBalance(1n, 0n)).toBe(true);
  });
});

// ─── calcParticipantSummary / apiRecordToTrip 회귀 방지 ──────────────────────

describe("calcParticipantSummary balancesStatus", () => {
  test("참여자 onchainStatus 를 그대로 전달, 미지정(로컬 데이터)은 ok", () => {
    const trip = makeTrip([
      participant("A", A, { onchainStatus: "error" }),
      participant("B", B),
    ]);
    expect(calcParticipantSummary(trip, "A").balancesStatus).toBe("error");
    expect(calcParticipantSummary(trip, "B").balancesStatus).toBe("ok");
  });
});

describe("apiRecordToTrip", () => {
  const record: TripApiRecord = {
    id: "db-1", chainId: 5042002, contractAddress: "0x" + "f".repeat(40),
    onchainTripId: "12345678901234567890", name: "T", adminAddress: A, createTxHash: "0x" + "1".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    participants: [
      { id: "p1", address: A, displayName: "Alice", isAdmin: true },
      { id: "p2", address: B, displayName: "Bob", isAdmin: false },
    ],
  };

  test("금액 필드를 가짜 0 이 아니라 '로딩 중'으로 초기화", () => {
    const trip = apiRecordToTrip(record);
    expect(trip.participants.map((p) => p.onchainStatus)).toEqual(["loading", "loading"]);
    expect(calcParticipantSummary(trip, "A").balancesStatus).toBe("loading");
  });

  test("onchainTripId 는 bigint 정밀도 유지", () => {
    expect(apiRecordToTrip(record).onchainTripId).toBe(12345678901234567890n);
  });
});
