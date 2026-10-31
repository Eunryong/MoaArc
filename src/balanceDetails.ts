// ─── 잔액 상세(Details) 뷰 모델 — 순수 함수 (React / wagmi 의존 없음) ───────────────
//
// 요약 카드는 간결하게 두고, 상세 대화상자에서는 모든 금액을 소수점 6자리로 정확히 보여 줍니다.
// 읽는 중/실패는 절대 "0.000000" 으로 표시하지 않고 상태 문구를 보여 줍니다.
// 이 모듈은 금액을 계산하지 않고 표시 문자열만 만듭니다 (모든 값은 bigint 그대로 포맷).

import type { Participant } from "./types";
import { fmtUsdc } from "./calculations";
import {
  formatReadUsdc,
  shortAddress,
  statusLabelKey,
  type ReadState,
  type ReadStatusLabelKey,
} from "./onchainReads";

/** 상세 화면의 소수 자릿수 (USDC 는 6자리) */
export const DETAIL_DIGITS = 6;

export type DetailStatus = "ok" | "loading" | "error" | "disabled";

export interface DetailAmount {
  /** 화면에 그대로 쓰는 문자열. ok 이면 "1,234.500000", 아니면 상태 문구("조회 중…"/"읽기 실패"/…) */
  text: string;
  status: DetailStatus;
}

export type StatusLabel = (key: ReadStatusLabelKey) => string;

export function detailAmount(state: ReadState<bigint>, label: StatusLabel): DetailAmount {
  if (state.kind === "ok") return { text: fmtUsdc(state.value, DETAIL_DIGITS), status: "ok" };
  return { text: label(statusLabelKey(state.kind)), status: state.kind };
}

export interface BalanceDetailsInput {
  sharedBalance: ReadState<bigint>;
  cumulativeDeposits: ReadState<bigint>;
  allocatedTotal: ReadState<bigint>;
  participants: readonly Participant[];
  connectedAddress?: string;
}

export interface SummaryDetail {
  /** 요약 한 줄의 값 — 단위(USDC)가 붙은 문자열. ok 가 아니면 상태 문구만 */
  text: string;
  status: DetailStatus;
}

export interface ParticipantDetail {
  /** React key 용 — 주소 (이름이 같아도 유일) */
  key: string;
  name: string;
  address: string;
  shortAddress: string;
  isMe: boolean;
  /** 같은 이름을 쓰는 참여자가 더 있는지 (화면에서 주소를 강조해 구분) */
  hasDuplicateName: boolean;
  allocated: DetailAmount;
  spent: DetailAmount;
}

export interface BalanceDetails {
  sharedBalance: SummaryDetail;
  cumulativeDeposits: SummaryDetail;
  allocatedTotal: SummaryDetail;
  participants: ParticipantDetail[];
}

function withUnit(state: ReadState<bigint>, label: StatusLabel): SummaryDetail {
  return {
    text: formatReadUsdc(state, label, DETAIL_DIGITS),
    status: state.kind === "ok" ? "ok" : state.kind,
  };
}

const normalizeName = (name: string) => name.trim().toLocaleLowerCase();

export function buildBalanceDetails(input: BalanceDetailsInput, label: StatusLabel): BalanceDetails {
  const me = input.connectedAddress?.toLowerCase();

  const nameCounts = new Map<string, number>();
  for (const p of input.participants) {
    const n = normalizeName(p.name);
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }

  const participants: ParticipantDetail[] = input.participants.map((p) => {
    // onchainStatus 가 undefined 이면 로컬(시연) 데이터로 간주하되, "ok" 가 아니면 값 대신 상태 문구
    const status = p.onchainStatus ?? "ok";
    const amount = (value: bigint): DetailAmount =>
      status === "ok"
        ? { text: fmtUsdc(value, DETAIL_DIGITS), status: "ok" }
        : { text: label(statusLabelKey(status)), status };
    return {
      key: p.address.toLowerCase(),
      name: p.name,
      address: p.address,
      shortAddress: shortAddress(p.address),
      isMe: !!me && p.address.toLowerCase() === me,
      hasDuplicateName: (nameCounts.get(normalizeName(p.name)) ?? 0) > 1,
      allocated: amount(p.allocatedBudget),
      spent: amount(p.spentFromBudget),
    };
  });

  return {
    sharedBalance: withUnit(input.sharedBalance, label),
    cumulativeDeposits: withUnit(input.cumulativeDeposits, label),
    allocatedTotal: withUnit(input.allocatedTotal, label),
    participants,
  };
}
