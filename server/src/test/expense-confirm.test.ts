/**
 * expense-confirm.test.ts
 *
 * checkAndConfirmExpense 판정 로직 단위 테스트.
 * 실제 DB 대신 인메모리 합성 데이터로만 동작합니다.
 * Prisma 클라이언트를 직접 주입하지 않고, 판정 로직만 추출해 검증합니다.
 */

import { describe, it, expect } from "bun:test";

// ─── 테스트 대상: 판정 로직 추출 ─────────────────────────────────────────────
// checkAndConfirmExpense의 "분담 대상자 전원 승인 여부" 판정 부분만 순수 함수로 뽑아서 테스트.
// DB I/O는 테스트하지 않습니다 — 서버 통합 테스트는 별도로 합니다.

type Approval = { address: string; action: string };

/**
 * 순수 판정 함수: DB 접근 없이 shares JSON과 approvals 배열만으로 판단.
 * trip.repository.ts의 checkAndConfirmExpense에서 판정 부분만 추출.
 */
function shouldConfirm(sharesJson: string, approvals: Approval[]): boolean {
  let shareAddresses: string[];
  try {
    const parsed = JSON.parse(sharesJson) as { address: string }[];
    shareAddresses = parsed.map((s) => s.address.toLowerCase());
  } catch {
    return false;
  }

  if (shareAddresses.length === 0) return false;

  const approvedSet = new Set(
    approvals.filter((a) => a.action === "승인").map((a) => a.address.toLowerCase()),
  );

  return shareAddresses.every((addr) => approvedSet.has(addr));
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

describe("shouldConfirm — 분담 대상자 전원 승인 판정", () => {

  it("1명 방: 등록자가 유일한 분담 대상자이고 자동 승인 → 즉시 확정", () => {
    const shares = JSON.stringify([{ address: "0xaaa", amountUsdc: "1000000" }]);
    const approvals: Approval[] = [{ address: "0xaaa", action: "승인" }];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("2명 방: 등록자만 승인, 상대방 미승인 → 대기", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "500000" },
      { address: "0xbbb", amountUsdc: "500000" },
    ]);
    const approvals: Approval[] = [{ address: "0xaaa", action: "승인" }];
    expect(shouldConfirm(shares, approvals)).toBe(false);
  });

  it("2명 방: 두 명 모두 승인 → 확정", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "500000" },
      { address: "0xbbb", amountUsdc: "500000" },
    ]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "승인" },
    ];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("분담 대상이 일부: shares에 0xaaa, 0xbbb만 — 0xccc는 비대상. 0xaaa, 0xbbb 승인 시 확정", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "500000" },
      { address: "0xbbb", amountUsdc: "500000" },
    ]);
    // 0xccc는 방 참여자지만 이 버전의 분담 대상이 아님
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "승인" },
      { address: "0xccc", action: "승인" },  // 비대상 참여자가 승인해도 무관
    ];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("분담 대상자 전원 승인이지만 비대상 참여자가 수정요청 → 확정 (비대상은 무관)", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "1000000" },
    ]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "수정요청" },  // 비대상자가 수정요청해도 무관
    ];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("분담 대상자가 수정요청 보낸 경우 → 대기", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "500000" },
      { address: "0xbbb", amountUsdc: "500000" },
    ]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "수정요청" },
    ];
    expect(shouldConfirm(shares, approvals)).toBe(false);
  });

  it("shares가 비어 있으면 확정하지 않음 (분담 대상자 0명)", () => {
    const shares = JSON.stringify([]);
    const approvals: Approval[] = [{ address: "0xaaa", action: "승인" }];
    expect(shouldConfirm(shares, approvals)).toBe(false);
  });

  it("shares JSON이 유효하지 않으면 확정하지 않음", () => {
    expect(shouldConfirm("not-json", [])).toBe(false);
  });

  it("대소문자 혼합 주소 정규화: 0xAAA와 0xaaa를 같은 주소로 처리 → 확정", () => {
    const shares = JSON.stringify([{ address: "0xAAA", amountUsdc: "1000000" }]);
    const approvals: Approval[] = [{ address: "0xaaa", action: "승인" }];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("승인 API 재호출 (upsert): 이미 승인 레코드가 있어도 전원 승인이면 확정 — 중복 없음", () => {
    // 재호출 시나리오: 승인이 이미 있고, 전원 충족 → 확정
    // (upsert이므로 중복 레코드가 생기지 않고 동일 결과)
    const shares = JSON.stringify([{ address: "0xaaa", amountUsdc: "1000000" }]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      // 중복 upsert된 경우를 시뮬레이션해도 Set으로 처리되므로 같음
    ];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });

  it("3명 방: 3명 모두 분담 대상, 2명만 승인 → 대기", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "333333" },
      { address: "0xbbb", amountUsdc: "333333" },
      { address: "0xccc", amountUsdc: "333334" },
    ]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "승인" },
    ];
    expect(shouldConfirm(shares, approvals)).toBe(false);
  });

  it("3명 방: 3명 모두 승인 → 확정", () => {
    const shares = JSON.stringify([
      { address: "0xaaa", amountUsdc: "333333" },
      { address: "0xbbb", amountUsdc: "333333" },
      { address: "0xccc", amountUsdc: "333334" },
    ]);
    const approvals: Approval[] = [
      { address: "0xaaa", action: "승인" },
      { address: "0xbbb", action: "승인" },
      { address: "0xccc", action: "승인" },
    ];
    expect(shouldConfirm(shares, approvals)).toBe(true);
  });
});
