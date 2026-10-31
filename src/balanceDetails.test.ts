// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * 잔액 상세(Details) 대화상자 테스트.
 *  - 뷰 모델(buildBalanceDetails): 6자리 정확 표기, 로딩/실패/비활성은 0 이 아닌 상태 문구, 동명이인 구분
 *  - 실제 렌더(react-dom/server): 접근성 속성, 단위 표기, 가짜 0 없음
 *  - 대시보드 연결(정적): Details 버튼, 금액 로직 미변경
 * localStorage 는 메모리 가짜로 대체합니다 — DB·.env·네트워크를 쓰지 않습니다.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MemoryStorage } from "./session.testkit";
import { buildBalanceDetails, DETAIL_DIGITS, type BalanceDetails } from "./balanceDetails";
import type { ReadState } from "./onchainReads";
import type { Participant } from "./types";

const ok = (v: bigint): ReadState<bigint> => ({ kind: "ok", value: v });
const label = (key: "checking" | "read_failed" | "status_unknown") =>
  ({ checking: "Loading…", read_failed: "Read failed", status_unknown: "Unknown" })[key];

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

function participant(over: Partial<Participant> & { address: string; name: string }): Participant {
  return {
    id: "A",
    isAdmin: false,
    depositedAmount: 0n,
    plannedDeposit: 0n,
    allocatedBudget: 0n,
    spentFromBudget: 0n,
    personalPrepaid: 0n,
    paidDeficit: 0n,
    refundClaimed: false,
    onchainStatus: "ok",
    ...over,
  };
}

function baseInput(over: Partial<Parameters<typeof buildBalanceDetails>[0]> = {}) {
  return {
    sharedBalance: ok(4_999_999n),
    cumulativeDeposits: ok(5_000_000n),
    allocatedTotal: ok(1n),
    participants: [
      participant({ address: A, name: "Alice", depositedAmount: 3_000_000n, allocatedBudget: 1n, spentFromBudget: 0n }),
      participant({ address: B, name: "Bob", id: "B", depositedAmount: 2_000_000n }),
    ],
    connectedAddress: A,
    ...over,
  };
}

describe("buildBalanceDetails — 6자리 정확 표기", () => {
  test("DETAIL_DIGITS 는 6", () => {
    expect(DETAIL_DIGITS).toBe(6);
  });

  test("요약 금액이 소수점 6자리 고정 + USDC 단위로 표시됨 (2자리로 줄어들지 않음)", () => {
    const d = buildBalanceDetails(baseInput(), label);
    expect(d.sharedBalance).toEqual({ text: "4.999999 USDC", status: "ok" });
    expect(d.cumulativeDeposits.text).toBe("5.000000 USDC");
    expect(d.allocatedTotal.text).toBe("0.000001 USDC");
  });

  test("참여자별 값도 6자리 고정 (단위는 표 머리글에서 표기) — deposited 없음, allocated/spent 만", () => {
    const d = buildBalanceDetails(baseInput(), label);
    const alice = d.participants[0];
    expect(alice.allocated.text).toBe("0.000001");
    expect(alice.spent.text).toBe("0.000000"); // 실제로 읽은 0 은 0.000000 으로 표시 (ok)
    expect(alice.spent.status).toBe("ok");
    // deposited 는 풀링 지갑 모델에서 개인 기여액을 노출하지 않으므로 존재하지 않아야 함
    expect("deposited" in alice).toBe(false);
  });

  test("정말 0 인 값은 0.000000, 아주 큰 bigint 도 정확 (Number 미사용)", () => {
    const huge = 2n ** 80n; // 1208925819614629174706176
    const d = buildBalanceDetails(
      baseInput({ sharedBalance: ok(0n), cumulativeDeposits: ok(huge) }),
      label,
    );
    expect(d.sharedBalance.text).toBe("0.000000 USDC");
    expect(d.cumulativeDeposits.text).toBe("1,208,925,819,614,629,174.706176 USDC");
  });
});

describe("buildBalanceDetails — 로딩/실패는 가짜 0 이 아님", () => {
  test("loading / error / disabled 요약은 상태 문구만", () => {
    const d = buildBalanceDetails(
      baseInput({
        sharedBalance: { kind: "loading" },
        cumulativeDeposits: { kind: "error" },
        allocatedTotal: { kind: "error" },
      }),
      label,
    );
    expect(d.sharedBalance).toEqual({ text: "Loading…", status: "loading" });
    expect(d.cumulativeDeposits).toEqual({ text: "Read failed", status: "error" });
    for (const v of [d.sharedBalance, d.cumulativeDeposits, d.allocatedTotal]) {
      expect(v.text).not.toMatch(/\d/);
    }
    // myDeposit 필드가 아예 없어야 함
    expect("myDeposit" in d).toBe(false);
  });

  test("onchainStatus 가 ok 가 아닌 참여자는 allocated/spent 모두 상태 문구 (값 0n 이 있어도 숨김)", () => {
    const d = buildBalanceDetails(
      baseInput({
        participants: [
          participant({ address: A, name: "Alice", onchainStatus: "loading" }),
          participant({ address: B, name: "Bob", onchainStatus: "error", depositedAmount: 0n }),
          participant({ address: C, name: "Cara", onchainStatus: "disabled" }),
        ],
      }),
      label,
    );
    for (const p of d.participants) {
      for (const amt of [p.allocated, p.spent]) {
        expect(amt.text).not.toMatch(/\d/);
        expect(amt.status).not.toBe("ok");
      }
      // deposited 필드가 없어야 함
      expect("deposited" in p).toBe(false);
    }
  });

  test("onchainStatus 가 없는 참여자(로컬 데이터)는 allocated/spent 값 그대로 — deposited 없음", () => {
    const p = participant({ address: A, name: "Alice", allocatedBudget: 1_500_000n });
    delete p.onchainStatus;
    const d = buildBalanceDetails(baseInput({ participants: [p] }), label);
    expect(d.participants[0].allocated.text).toBe("1.500000");
    expect("deposited" in d.participants[0]).toBe(false);
  });
});

describe("buildBalanceDetails — 동명이인/내 지갑 구분", () => {
  const dupes = baseInput({
    participants: [
      participant({ address: A, name: "민수" }),
      participant({ address: B, name: " 민수 ", id: "B" }),
      participant({ address: C, name: "Cara", id: "C" }),
    ],
    connectedAddress: B.toUpperCase().replace("0X", "0x"),
  });

  test("이름이 같으면 hasDuplicateName, 주소(키)는 모두 서로 다름", () => {
    const d = buildBalanceDetails(dupes, label);
    expect(d.participants.map((p) => p.hasDuplicateName)).toEqual([true, true, false]);
    expect(new Set(d.participants.map((p) => p.key)).size).toBe(3);
    expect(new Set(d.participants.map((p) => p.shortAddress)).size).toBe(3);
  });

  test("연결된 지갑(대소문자 무관)만 isMe", () => {
    const d = buildBalanceDetails(dupes, label);
    expect(d.participants.map((p) => p.isMe)).toEqual([false, true, false]);
  });
});

// ─── 실제 렌더 (react-dom/server) ─────────────────────────────────────────────

describe("BalanceDetailsDialog 렌더", () => {
  const g = globalThis as unknown as { localStorage: unknown };
  let saved: unknown;
  let renderDialog: (open: boolean, details: BalanceDetails) => string;

  beforeAll(async () => {
    saved = g.localStorage;
    g.localStorage = new MemoryStorage(); // I18nProvider 가 언어 설정을 읽음 (비어 있으면 en)
    const { I18nProvider } = await import("./i18n");
    const { default: Dialog } = await import("./components/BalanceDetailsDialog");
    renderDialog = (open, details) =>
      renderToString(
        createElement(I18nProvider, null, createElement(Dialog, { open, onClose: () => undefined, details })),
      );
  });

  afterAll(() => {
    g.localStorage = saved;
  });

  test("닫혀 있으면 아무것도 렌더하지 않음", () => {
    expect(renderDialog(false, buildBalanceDetails(baseInput(), label))).toBe("");
  });

  test("접근성: dialog 역할, aria-modal, 제목/설명 연결, 표 caption·scope, 닫기 버튼", () => {
    const html = renderDialog(true, buildBalanceDetails(baseInput(), label));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain(">Close<");
    expect(html).toContain("Balance details");
  });

  test("단위가 명확: 머리글에 Allocated/Spent USDC, Deposited 열 없음, 6자리 안내", () => {
    const html = renderDialog(true, buildBalanceDetails(baseInput(), label));
    expect(html).not.toContain("Deposited (USDC)"); // 개인 입금액 열 제거됨
    expect(html).toContain("Allocated (USDC)");
    expect(html).toContain("Spent from allocation (USDC)");
    expect(html).toContain("4.999999 USDC");
    expect(html).toContain("6 decimal places");
  });

  test("정확한 6자리 값이 표시되고 로딩/실패 상태에서는 0.000000 이 나타나지 않음", () => {
    const exact = renderDialog(true, buildBalanceDetails(baseInput(), label));
    expect(exact).toContain("0.000001");
    // myDeposit summary 행이 없으므로 "1.000001 USDC"는 렌더되지 않아야 함
    expect(exact).not.toContain("1.000001 USDC");

    const pending = renderDialog(
      true,
      buildBalanceDetails(
        baseInput({
          sharedBalance: { kind: "loading" },
          cumulativeDeposits: { kind: "error" },
          allocatedTotal: { kind: "error" },
          participants: [
            participant({ address: A, name: "Alice", onchainStatus: "loading" }),
            participant({ address: B, name: "Bob", onchainStatus: "error" }),
          ],
        }),
        label,
      ),
    );
    expect(pending).toContain("Loading…");
    expect(pending).toContain("Read failed");
    expect(pending).not.toContain("0.000000");
    expect(pending).not.toMatch(/0\.00 USDC/);
  });

  test("동명이인은 전체 주소로 구분되어 렌더됨", () => {
    const html = renderDialog(
      true,
      buildBalanceDetails(
        baseInput({
          participants: [participant({ address: A, name: "민수" }), participant({ address: B, name: "민수", id: "B" })],
        }),
        label,
      ),
    );
    expect(html).toContain(A);
    expect(html).toContain(B);
    expect(html.split("민수").length - 1).toBeGreaterThanOrEqual(2);
  });
});

// ─── 대시보드 연결 / 금액 로직 미변경 (정적 점검) ──────────────────────────────

describe("DashboardTab — Details 버튼 연결", () => {
  const src = readFileSync(new URL("./components/DashboardTab.tsx", import.meta.url), "utf8");
  const dialogSrc = readFileSync(new URL("./components/BalanceDetailsDialog.tsx", import.meta.url), "utf8");
  const detailsSrc = readFileSync(new URL("./balanceDetails.ts", import.meta.url), "utf8");

  test("공동지갑 카드에 접근 가능한 Details 버튼 (aria-haspopup/expanded, 44px 터치 영역)", () => {
    expect(src).toContain('aria-haspopup="dialog"');
    expect(src).toContain("aria-expanded={detailsOpen}");
    expect(src).toContain('t("details_btn")');
    expect(src).toContain("min-h-[44px]");
    expect(src).toContain("<BalanceDetailsDialog");
  });

  test("대화상자는 Esc/포커스 복귀/Tab 순환을 구현", () => {
    expect(dialogSrc).toContain('"Escape"');
    expect(dialogSrc).toContain("returnTo?.focus()");
    expect(dialogSrc).toContain('e.key !== "Tab"');
  });

  test("상세 표시 코드는 Number/parseFloat/toFixed 로 금액을 다루지 않음", () => {
    for (const code of [dialogSrc, detailsSrc]) {
      expect(code).not.toMatch(/\bNumber\(/);
      expect(code).not.toMatch(/parseFloat|\.toFixed\(/);
    }
  });

  test("트랜잭션 금액 로직(파싱 후 execute)은 그대로", () => {
    expect(src.indexOf("parsePositiveUsdc(depositInput)")).toBeGreaterThan(-1);
    expect(src.indexOf("parsePositiveUsdc(depositInput)")).toBeLessThan(src.indexOf("depositHook.execute("));
    expect(src.indexOf("parsePositiveUsdc(releaseInput)")).toBeLessThan(src.indexOf("releaseHook.execute("));
    expect(src.indexOf("parsePositiveUsdc(returnInput)")).toBeLessThan(src.indexOf("returnHook.execute("));
  });
});
