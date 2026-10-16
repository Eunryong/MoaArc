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

/** 사람이 읽을 수 있는 USDC 문자열 → 마이크로USDC bigint */
export function parseUsdcInput(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "") return null;
  // "123.456" 형태 허용, 소수점 7자리 이상은 에러
  const parts = trimmed.split(".");
  if (parts.length > 2) return null;
  const intPart = parts[0] ?? "0";
  const fracPart = (parts[1] ?? "").slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0");
  // 정수 부분 검증
  if (!/^\d+$/.test(intPart)) return null;
  if (!/^\d+$/.test(fracPart)) return null;
  try {
    return BigInt(intPart) * USDC_SCALE + BigInt(fracPart);
  } catch {
    return null;
  }
}

/** 마이크로USDC bigint → "1,234.56" 형태 표시 문자열 */
export function fmtUsdc(amount: bigint, digits = 2): string {
  if (typeof amount !== "bigint") return "0.00";
  const isNeg = amount < 0n;
  const abs = isNeg ? -amount : amount;
  const whole = abs / USDC_SCALE;
  const frac = abs % USDC_SCALE;
  // 소수점 digits 자리로 반올림
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, digits);
  const wholeFormatted = whole.toLocaleString("ko-KR");
  return `${isNeg ? "-" : ""}${wholeFormatted}.${fracStr}`;
}

/** 마이크로USDC bigint → number (표시 전용, 정산 계산에 사용 금지) */
export function toDisplayNumber(amount: bigint): number {
  return Number(amount) / 1_000_000;
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
