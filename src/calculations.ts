// ─── 정산 계산 로직 ───────────────────────────────────────────────────────────
//
// 모든 금액은 마이크로USDC bigint (1 USDC = 1_000_000n) 단위로 처리합니다.
// JavaScript number/parseFloat 는 정산 금액 계산에 사용하지 않습니다.

import type {
  Trip,
  ParticipantId,
  Expense,
  ParticipantSummary,
  ShareEntry,
  Refund,
} from "./types";

// ─── USDC 단위 상수 ────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;
export const USDC_SCALE = 1_000_000n; // 1 USDC = 1_000_000 최소단위

/** uint256 최대값 — 컨트랙트 금액 인자의 상한 (마이크로USDC 단위) */
export const MAX_USDC_RAW = (1n << 256n) - 1n;

export type UsdcParseFailure =
  | "empty"              // 빈 입력
  | "format"             // 숫자·소수점 외 문자, 지수 표기(1e3), 부호(+), 쉼표, 중복 소수점 등
  | "negative"           // 음수
  | "too_many_decimals"  // 소수점 이하 7자리 이상 (반올림/절사 없이 거부)
  | "too_large";         // uint256 초과

export type UsdcParseResult =
  | { ok: true; value: bigint }
  | { ok: false; reason: UsdcParseFailure };

// "12", "12.", "12.5", ".5" 만 허용. 지수 표기·부호·쉼표·공백 포함 입력은 모두 거부.
const USDC_INPUT_RE = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;
const NEGATIVE_LOOKING_RE = /^-\d*\.?\d+$|^-\d+\.$/;

/**
 * 사람이 입력한 USDC 문자열 → 마이크로USDC bigint (정확히 0~6자리 소수만 허용).
 * 소수점 이하가 7자리 이상이면 잘라내거나 반올림하지 않고 "too_many_decimals" 로 거부합니다
 * (끝자리가 0 이어도 거부 — 입력 의도와 온체인 단위 불일치 방지).
 */
export function parseUsdcStrict(input: string): UsdcParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const m = USDC_INPUT_RE.exec(trimmed);
  if (!m) {
    return { ok: false, reason: NEGATIVE_LOOKING_RE.test(trimmed) ? "negative" : "format" };
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > USDC_DECIMALS) return { ok: false, reason: "too_many_decimals" };
  const value = BigInt(whole) * USDC_SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
  if (value > MAX_USDC_RAW) return { ok: false, reason: "too_large" };
  return { ok: true, value };
}

/** 하위 호환: 유효하면 bigint, 어떤 이유로든 유효하지 않으면 null (절대 잘라내지 않음). 오류 이유가 필요하면 parseUsdcStrict 사용 */
export function parseUsdcInput(input: string): bigint | null {
  const r = parseUsdcStrict(input);
  return r.ok ? r.value : null;
}

/** 실패 이유 → i18n 키 */
export function usdcFailureKey(
  reason: UsdcParseFailure,
): "err_amount_required" | "err_amount_format" | "err_amount_negative" | "err_amount_decimals" | "err_amount_too_large" {
  switch (reason) {
    case "empty": return "err_amount_required";
    case "format": return "err_amount_format";
    case "negative": return "err_amount_negative";
    case "too_many_decimals": return "err_amount_decimals";
    case "too_large": return "err_amount_too_large";
  }
}

export type UsdcKey = ReturnType<typeof usdcFailureKey>;
export type UsdcValidation = { ok: true; value: bigint } | { ok: false; key: UsdcKey };

/** 0 보다 커야 하는 금액 (입금·이체·반납·지출 총액) */
export function parsePositiveUsdc(input: string): UsdcValidation {
  const r = parseUsdcStrict(input);
  if (!r.ok) return { ok: false, key: usdcFailureKey(r.reason) };
  if (r.value <= 0n) return { ok: false, key: "err_amount_required" };
  return { ok: true, value: r.value };
}

/** 비어 있으면 0 으로 허용하는 선택 금액 (여행방 목표 예산, 분담 금액 칸) */
export function parseOptionalUsdc(input: string): UsdcValidation {
  if (input.trim() === "") return { ok: true, value: 0n };
  const r = parseUsdcStrict(input);
  return r.ok ? { ok: true, value: r.value } : { ok: false, key: usdcFailureKey(r.reason) };
}

/** 입력 도중 즉시 보여줄 경고: 비어 있지 않은데 형식이 잘못된 경우의 i18n 키 (빈 입력·0 은 null) */
export function usdcInputProblem(input: string): UsdcKey | null {
  if (input.trim() === "") return null;
  const r = parseUsdcStrict(input);
  return r.ok ? null : usdcFailureKey(r.reason);
}

/**
 * 마이크로USDC bigint → 표시 문자열. 반올림·절사 없이 정확히 표시합니다.
 *  - 소수점 이하는 최소 minDigits(기본 2)자리, 0 이 아닌 마이크로 단위가 있으면 최대 6자리까지
 *    (뒤쪽 불필요한 0 은 minDigits 까지만 유지). 예: 1_000_000n → "1.00", 1n → "0.000001", 1_234_560n → "1.23456"
 *  - 정수부는 천 단위 구분. Number 를 쓰지 않으므로 아무리 큰 bigint 도 정확합니다.
 */
export function fmtUsdc(amount: bigint, minDigits = 2): string {
  if (typeof amount !== "bigint") return fmtUsdc(0n, minDigits);
  const isNeg = amount < 0n;
  const abs = isNeg ? -amount : amount;
  const whole = abs / USDC_SCALE;
  const min = Math.min(Math.max(Math.trunc(minDigits), 0), USDC_DECIMALS);
  let frac = (abs % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0");
  let end = frac.length;
  while (end > min && frac[end - 1] === "0") end -= 1;
  frac = frac.slice(0, end);
  const wholeFormatted = whole.toLocaleString("ko-KR");
  return `${isNeg ? "-" : ""}${wholeFormatted}${frac ? `.${frac}` : ""}`;
}

/**
 * 입력칸 초기값/속성용 정확한 문자열 (천 단위 구분 없음, 뒤쪽 0 제거). parseUsdcStrict 와 왕복 가능.
 * 예: 1_500_000n → "1.5", 1n → "0.000001", 2_000_000n → "2"
 */
export function formatUsdcExact(amount: bigint): string {
  const isNeg = amount < 0n;
  const abs = isNeg ? -amount : amount;
  const whole = (abs / USDC_SCALE).toString();
  const frac = (abs % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${isNeg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// ─── 지출 헬퍼 ─────────────────────────────────────────────────────────────

/** 현재 활성 버전의 분담 데이터를 가져온다 */
export function getActiveVersion(expense: Expense) {
  return expense.versions.find((v) => v.version === expense.currentVersion)!;
}

/** 해당 지출에서 특정 참여자의 현재 부담액 (마이크로USDC bigint) */
export function getParticipantShare(expense: Expense, pid: ParticipantId): bigint {
  const ver = getActiveVersion(expense);
  if (!ver) return 0n;
  const entry = ver.shares.find((s) => s.participantId === pid);
  return entry?.amount ?? 0n;
}

/** 특정 지출이 전원 승인된 상태인지 확인 */
export function isExpenseConfirmed(expense: Expense): boolean {
  const ver = getActiveVersion(expense);
  if (!ver) return false;
  return (
    ver.status === "확정" &&
    ver.approvals
      .filter((a) => expense.participants.includes(a.participantId))
      .every((a) => a.action === "승인")
  );
}

/** 지출이 승인 대기 상태인지 확인 */
export function isExpensePending(expense: Expense): boolean {
  const ver = getActiveVersion(expense);
  if (!ver) return false;
  return ver.status === "승인대기" || ver.status === "수정안투표중";
}

/** 확정 지출에서 참여자의 부담액 합계 (마이크로USDC bigint) */
export function getConfirmedBurden(trip: Trip, pid: ParticipantId): bigint {
  return trip.expenses
    .filter(isExpenseConfirmed)
    .reduce((sum, exp) => sum + getParticipantShare(exp, pid), 0n);
}

/** 승인 대기 지출에서 참여자의 잠정 부담액 합계 (마이크로USDC bigint) */
export function getPendingBurden(trip: Trip, pid: ParticipantId): bigint {
  return trip.expenses
    .filter(isExpensePending)
    .reduce((sum, exp) => sum + getParticipantShare(exp, pid), 0n);
}

/** 카테고리별 확정 부담액 (마이크로USDC bigint) */
export function getBurdenByCategory(trip: Trip, pid: ParticipantId): Record<string, bigint> {
  const result: Record<string, bigint> = { 식비: 0n, 숙박: 0n, 교통: 0n, 기타: 0n };
  for (const exp of trip.expenses) {
    if (isExpenseConfirmed(exp)) {
      const cat = exp.category;
      result[cat] = (result[cat] ?? 0n) + getParticipantShare(exp, pid);
    }
  }
  return result;
}

/** 참여자 정산 요약 계산 */
export function calcParticipantSummary(trip: Trip, pid: ParticipantId): ParticipantSummary {
  const p = trip.participants.find((x) => x.id === pid)!;
  if (!p) {
    return {
      depositedAmount: 0n,
      plannedDeposit: 0n,
      confirmedBurden: 0n,
      pendingBurden: 0n,
      allocatedBudget: 0n,
      spentFromBudget: 0n,
      personalPrepaid: 0n,
      paidDeficit: 0n,
      netBalance: 0n,
      refundClaimed: false,
      balancesStatus: "disabled",
    };
  }
  const confirmedBurden = getConfirmedBurden(trip, pid);
  const pendingBurden = getPendingBurden(trip, pid);
  const allocatedBudget = p.allocatedBudget;
  const spentFromBudget = p.spentFromBudget;
  const personalPrepaid = p.personalPrepaid;
  const paidDeficit = p.paidDeficit;
  const depositedAmount = p.depositedAmount;

  // 순 정산 차액 = 납입액 - 확정 부담액 - 미반납 결제예산
  // 양수: 돌려받을 금액 / 음수: 추가 납부 필요
  const netBalance = depositedAmount - confirmedBurden - allocatedBudget;

  return {
    depositedAmount,
    plannedDeposit: p.plannedDeposit,
    confirmedBurden,
    pendingBurden,
    allocatedBudget,
    spentFromBudget,
    personalPrepaid,
    paidDeficit,
    netBalance,
    refundClaimed: p.refundClaimed,
    balancesStatus: p.onchainStatus ?? "ok",
  };
}

/** 공동지갑 실제 잔액 = 총 입금액 - 외부로 나간 공동자금 (마이크로USDC bigint) */
export function getContractBalance(trip: Trip): bigint {
  // onchainTripBalance가 있으면 그것을 사용 (더 정확)
  if (trip.onchainTripBalance !== undefined) return trip.onchainTripBalance;
  const totalDeposited = trip.participants.reduce((sum, p) => sum + p.depositedAmount, 0n);
  const totalAllocated = trip.participants.reduce((sum, p) => sum + p.allocatedBudget, 0n);
  return totalDeposited - totalAllocated;
}

/** 외부 결제지갑에 나가있는 공동자금 합계 (마이크로USDC bigint) */
export function getTotalAllocated(trip: Trip): bigint {
  return trip.participants.reduce((sum, p) => sum + p.allocatedBudget, 0n);
}

/** 총 입금액 (마이크로USDC bigint) */
export function getTotalDeposited(trip: Trip): bigint {
  return trip.participants.reduce((sum, p) => sum + p.depositedAmount, 0n);
}

/** 확정 지출 합계 (마이크로USDC bigint) */
export function getTotalConfirmedExpenses(trip: Trip): bigint {
  return trip.expenses
    .filter(isExpenseConfirmed)
    .reduce((sum, e) => sum + e.totalAmount, 0n);
}

/** 대기 지출 합계 (마이크로USDC bigint) */
export function getTotalPendingExpenses(trip: Trip): bigint {
  return trip.expenses
    .filter(isExpensePending)
    .reduce((sum, e) => sum + e.totalAmount, 0n);
}

/** 미확정 지출 수 */
export function getPendingExpenseCount(trip: Trip): number {
  return trip.expenses.filter(isExpensePending).length;
}

// ─── 분담 검증 ─────────────────────────────────────────────────────────────

/**
 * 분담액 합계가 지출 총액과 정확히 일치하는지 확인 (bigint 정수 비교)
 * 허용 오차 없음 — 차이가 있으면 false 반환
 */
/** @alias validateSharesExact */
export function validateShares(shares: ShareEntry[], totalAmount: bigint): boolean {
  return validateSharesExact(shares, totalAmount);
}

export function validateSharesExact(shares: ShareEntry[], totalAmount: bigint): boolean {
  const sharesTotal = shares.reduce((sum, s) => sum + s.amount, 0n);
  return sharesTotal === totalAmount;
}

/** 분담액 합계와 총액의 차이 (bigint, 음수면 부족, 양수면 초과) */
export function sharesDiscrepancy(shares: ShareEntry[], totalAmount: bigint): bigint {
  const sharesTotal = shares.reduce((sum, s) => sum + s.amount, 0n);
  return sharesTotal - totalAmount;
}

// ─── 환불 처리 ─────────────────────────────────────────────────────────────

/**
 * 전액환불: 분담액을 0으로 되돌린다.
 * 주의: 실제 환불이 공동지갑에 입금 확인된 후에만 호출해야 합니다.
 */
export function applyFullRefund(expense: Expense): Expense {
  const newVersion = expense.currentVersion + 1;
  const newShares: ShareEntry[] = expense.participants.map((pid) => ({
    participantId: pid,
    amount: 0n,
  }));
  const refund: Refund = {
    id: `ref-${expense.id}-${String(Date.now())}`,
    expenseId: expense.id,
    type: "전액환불",
    amount: expense.totalAmount,
    returnedTo: "공동지갑",
    onchainStatus: "pending_external", // 실제 환불 확인 전
    note: "전액 환불 처리 (수동 기록 — 온체인 확인 필요)",
  };
  return {
    ...expense,
    totalAmount: 0n,
    currentVersion: newVersion,
    refunds: [...expense.refunds, refund],
    versions: [
      ...expense.versions,
      {
        version: newVersion,
        shares: newShares,
        proposedBy: expense.versions[0]?.proposedBy ?? ("A"),
        proposedAt: new Date().toISOString(),
        reason: "전액 환불 처리",
        approvals: expense.participants.map((pid) => ({
          participantId: pid,
          approvedAt: null,
          action: null,
        })),
        status: "승인대기",
      },
    ],
  };
}

/**
 * 부분환불 (비례): 원래 확정 분담 비율에 따라 환불액을 차감.
 *
 * 규칙:
 * - ratio_i = share_i / originalTotal (마이크로USDC 정수 나눗셈)
 * - reduction_i = floor(refundAmount * share_i / originalTotal)
 * - 나머지는 마지막 참여자에게 보정하여 합계가 정확히 일치하게 함
 */
export function applyProportionalRefund(expense: Expense, refundAmount: bigint): Expense {
  const activeVer = getActiveVersion(expense);
  if (!activeVer) return expense;
  if (refundAmount <= 0n || refundAmount > expense.totalAmount) return expense;

  const originalTotal = expense.totalAmount;
  const newTotal = originalTotal - refundAmount;

  // 비례 차감: floor(refundAmount * share_i / originalTotal)
  let allocated = 0n;
  const reductions: bigint[] = activeVer.shares.map((s, idx) => {
    if (idx === activeVer.shares.length - 1) {
      // 마지막 참여자: 나머지 전부 (합계 보정)
      return refundAmount - allocated;
    }
    const reduction = (refundAmount * s.amount) / originalTotal;
    allocated += reduction;
    return reduction;
  });

  const newShares: ShareEntry[] = activeVer.shares.map((s, idx) => ({
    participantId: s.participantId,
    amount: s.amount - reductions[idx] < 0n ? 0n : s.amount - reductions[idx],
  }));

  // 합계 검증
  const sharesSum = newShares.reduce((sum, s) => sum + s.amount, 0n);
  if (sharesSum !== newTotal) {
    // 보정: 마지막 항목에 차이 반영
    const diff = newTotal - sharesSum;
    const last = newShares[newShares.length - 1];
    if (last) {
      last.amount = last.amount + diff < 0n ? 0n : last.amount + diff;
    }
  }

  const newVersion = expense.currentVersion + 1;
  const refund: Refund = {
    id: `ref-${expense.id}-${String(Date.now())}`,
    expenseId: expense.id,
    type: "부분환불비례",
    amount: refundAmount,
    returnedTo: "공동지갑",
    onchainStatus: "pending_external", // 실제 환불 확인 전
    note: `부분 환불 ${fmtUsdc(refundAmount)} USDC (비율 자동 적용, 수동 기록 — 온체인 확인 필요)`,
    shareAdjustments: newShares,
  };

  return {
    ...expense,
    totalAmount: newTotal,
    currentVersion: newVersion,
    refunds: [...expense.refunds, refund],
    versions: [
      ...expense.versions,
      {
        version: newVersion,
        shares: newShares,
        proposedBy: activeVer.proposedBy,
        proposedAt: new Date().toISOString(),
        reason: `부분 환불 ${fmtUsdc(refundAmount)} USDC — 비율 자동 차감`,
        approvals: expense.participants.map((pid) => ({
          participantId: pid,
          approvedAt: null,
          action: null,
        })),
        status: "승인대기",
      },
    ],
  };
}

// ─── 정산 잔액 검증 ─────────────────────────────────────────────────────────

/**
 * 정산안의 환급 합계와 컨트랙트 tripBalance가 일치하는지 검증.
 * 불일치면 이유 문자열 반환, 일치하면 null 반환.
 */
export function validateSettlementBalance(
  refundAmounts: Record<string, bigint>,
  contractTripBalance: bigint
): string | null {
  const totalRefunds = Object.values(refundAmounts).reduce((s, v) => s + v, 0n);
  if (totalRefunds !== contractTripBalance) {
    const diff = contractTripBalance - totalRefunds;
    return `컨트랙트 잔액(${fmtUsdc(contractTripBalance)} USDC) ≠ 환급 합계(${fmtUsdc(totalRefunds)} USDC), 차이: ${fmtUsdc(diff)} USDC`;
  }
  return null;
}
