// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * USDC 금액 입력/표시 정확성 테스트 (메인넷 사전 점검).
 *  - 0~6자리 소수는 bigint 로 정확히, 7자리 이상은 절사/반올림 없이 거부
 *  - 지수 표기·부호·쉼표 등 비정상 입력 거부
 *  - 표시는 최소 2자리, 0 이 아닌 마이크로 단위는 6자리까지 정확히
 *  - 영향받는 UI 경로(입금·이체·반납·목표예산·지출/분담·정산)가 API/지갑 호출 전에 검증하는지 정적 점검
 * 네트워크·DB·지갑을 사용하지 않습니다.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  MAX_USDC_RAW,
  USDC_SCALE,
  fmtUsdc,
  formatUsdcExact,
  parseOptionalUsdc,
  parsePositiveUsdc,
  parseUsdcInput,
  parseUsdcStrict,
  usdcFailureKey,
  usdcInputProblem,
  type UsdcParseFailure,
} from "./calculations";
import en from "./i18n/en";
import ko from "./i18n/ko";

const ok = (raw: bigint) => ({ ok: true as const, value: raw });
const fail = (reason: UsdcParseFailure) => ({ ok: false as const, reason });

// ─── 파서: 경계 ──────────────────────────────────────────────────────────────

describe("parseUsdcStrict — 0~6자리 소수는 정확", () => {
  test.each([
    ["0", 0n],
    ["0.0", 0n],
    ["0.000000", 0n],
    ["0.000001", 1n],
    ["0.1", 100_000n],
    ["0.123456", 123_456n],
    ["1", 1_000_000n],
    ["1.", 1_000_000n],
    [".5", 500_000n],
    ["1.5", 1_500_000n],
    ["1.123456", 1_123_456n],
    ["007.10", 7_100_000n],
    ["  12.34  ", 12_340_000n],
    ["999999.999999", 999_999_999_999n],
  ] as const)("%p → %p", (input, raw) => {
    expect(parseUsdcStrict(input)).toEqual(ok(raw));
  });

  test("0.1 + 0.2 는 bigint 로 정확히 0.3 (부동소수점 오차 없음)", () => {
    const a = parseUsdcInput("0.1");
    const b = parseUsdcInput("0.2");
    expect(a! + b!).toBe(parseUsdcInput("0.3")!);
    expect(0.1 + 0.2).not.toBe(0.3); // 비교용: Number 였다면 틀렸을 값
  });
});

describe("parseUsdcStrict — 7자리 이상 소수는 절사/반올림 없이 거부", () => {
  test.each(["1.1234567", "1.0000000", "0.0000001", "0.1234569", "12.12345678901", "5.0000000000000000"])(
    "%p → too_many_decimals",
    (input) => {
      expect(parseUsdcStrict(input)).toEqual(fail("too_many_decimals"));
    },
  );

  test("과거 버그 재현 방지: 1.1234567 이 1.123456 으로 조용히 바뀌지 않는다", () => {
    expect(parseUsdcInput("1.1234567")).toBeNull();
    expect(parseUsdcStrict("1.1234567").ok).toBe(false);
  });

  test("6자리와 7자리의 경계", () => {
    expect(parseUsdcStrict("0.999999").ok).toBe(true);
    expect(parseUsdcStrict("0.9999999").ok).toBe(false);
  });
});

describe("parseUsdcStrict — 비정상 입력", () => {
  test.each(["abc", "1e3", "1E3", "1e-7", "1e", "0x10", "+1", "1,000", "1 000", "1..2", "1.2.3", ".", "-", "NaN", "Infinity", "１２", "1_000", "٣"])(
    "%p → format",
    (input) => {
      expect(parseUsdcStrict(input)).toEqual(fail("format"));
    },
  );

  test.each(["", "   ", "\t\n"])("빈 입력 %p → empty", (input) => {
    expect(parseUsdcStrict(input)).toEqual(fail("empty"));
  });

  test.each(["-1", "-0.5", "-.5", "-1.", "-0.000001"])("음수 %p → negative", (input) => {
    expect(parseUsdcStrict(input)).toEqual(fail("negative"));
  });

  test("지수 표기는 값이 같아도(1e3 = 1000) 거부된다 — <input type=number> 가 허용하는 형식이므로 중요", () => {
    expect(parseUsdcInput("1e3")).toBeNull();
    expect(parseUsdcInput("1000")).toBe(1_000n * USDC_SCALE);
  });
});

describe("parseUsdcStrict — 큰 값 (bigint)", () => {
  test("2^53 을 넘는 정수 USDC 도 정확", () => {
    expect(parseUsdcStrict("9007199254740993")).toEqual(ok(9_007_199_254_740_993n * USDC_SCALE));
    expect(parseUsdcStrict("9007199254740993.000001")).toEqual(ok(9_007_199_254_740_993_000_001n));
  });

  test("uint256 최대 raw 값까지 허용, 1 micro 초과는 too_large", () => {
    const whole = MAX_USDC_RAW / USDC_SCALE;
    const frac = (MAX_USDC_RAW % USDC_SCALE).toString().padStart(6, "0");
    expect(parseUsdcStrict(`${whole}.${frac}`)).toEqual(ok(MAX_USDC_RAW));
    const over = (BigInt(frac) + 1n).toString().padStart(6, "0");
    expect(parseUsdcStrict(`${whole}.${over}`)).toEqual(fail("too_large"));
    expect(parseUsdcStrict("9".repeat(100))).toEqual(fail("too_large"));
  });
});

// ─── 왕복(round-trip) ───────────────────────────────────────────────────────

describe("round-trip", () => {
  const samples: bigint[] = [
    0n, 1n, 9n, 10n, 99n, 100_000n, 999_999n, 1_000_000n, 1_000_001n, 1_234_567n, 12_345_678_901n,
    2n ** 53n + 1n, 2n ** 64n, 10n ** 30n + 1n, MAX_USDC_RAW,
  ];

  test("formatUsdcExact → parseUsdcStrict 가 항상 원래 raw", () => {
    for (const raw of samples) {
      expect(parseUsdcStrict(formatUsdcExact(raw))).toEqual(ok(raw));
    }
  });

  test("fmtUsdc(천 단위 쉼표 제거) → parseUsdcStrict 가 항상 원래 raw (표시가 값을 바꾸지 않음)", () => {
    for (const raw of samples) {
      expect(parseUsdcStrict(fmtUsdc(raw).replace(/,/g, ""))).toEqual(ok(raw));
    }
  });

  test("결정적 의사난수 500개: 표시/입력 왕복에서 손실 없음", () => {
    let seed = 123456789n;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      const raw = seed * (seed % 7n === 0n ? 1_000_003n : 1n); // 가끔 더 큰 값
      expect(parseUsdcStrict(formatUsdcExact(raw))).toEqual(ok(raw));
      expect(parseUsdcStrict(fmtUsdc(raw).replace(/,/g, ""))).toEqual(ok(raw));
    }
  });
});

// ─── 표시 ────────────────────────────────────────────────────────────────────

describe("fmtUsdc — 최소 2자리, 0 이 아닌 마이크로 단위는 6자리까지 정확히", () => {
  test.each([
    [0n, "0.00"],
    [1n, "0.000001"],
    [10n, "0.00001"],
    [100n, "0.0001"],
    [10_000n, "0.01"],
    [100_000n, "0.10"],
    [999_999n, "0.999999"],
    [1_000_000n, "1.00"],
    [1_500_000n, "1.50"],
    [1_230_000n, "1.23"],
    [1_234_560n, "1.23456"],
    [1_234_567n, "1.234567"],
    [1_000_001n, "1.000001"],
    [1_234_567_890_000n, "1,234,567.89"],
    [-1n, "-0.000001"],
    [-1_500_000n, "-1.50"],
  ] as const)("%p → %p", (raw, text) => {
    expect(fmtUsdc(raw)).toBe(text);
  });

  test("0.000001 USDC 가 더 이상 0.00 으로 보이지 않는다", () => {
    expect(fmtUsdc(1n)).not.toBe("0.00");
  });

  test("매우 큰 bigint 도 정확 (Number 미사용)", () => {
    expect(fmtUsdc(2n ** 80n)).toBe("1,208,925,819,614,629,174.706176");
    const frac = (MAX_USDC_RAW % USDC_SCALE).toString().padStart(6, "0");
    expect(fmtUsdc(MAX_USDC_RAW)).toBe(`${(MAX_USDC_RAW / USDC_SCALE).toLocaleString("ko-KR")}.${frac}`);
  });

  test("minDigits 조절: 0 이면 정수는 소수부 생략, 6 이면 고정 6자리", () => {
    expect(fmtUsdc(1_000_000n, 0)).toBe("1");
    expect(fmtUsdc(1n, 0)).toBe("0.000001");
    expect(fmtUsdc(1_000_000n, 6)).toBe("1.000000");
  });

  test("합계 의미 보존: 표시가 늘어도 합은 bigint 정확 합과 일치", () => {
    const parts = ["0.000001", "0.000002", "0.1", "1.234567"].map((s) => parseUsdcInput(s)!);
    const sum = parts.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(1_334_570n);
    expect(fmtUsdc(sum)).toBe("1.33457");
  });

  test("균등 분배(나머지는 첫 사람) 합이 총액과 정확히 일치", () => {
    const total = parseUsdcInput("0.000001")!;
    const n = 3n;
    const base = total / n;
    const shares = [base + (total % n), base, base];
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
    expect(fmtUsdc(shares[0])).toBe("0.000001");
    expect(fmtUsdc(shares[1])).toBe("0.00");
  });
});

// ─── 검증 래퍼 / i18n ───────────────────────────────────────────────────────

describe("검증 래퍼", () => {
  test("parsePositiveUsdc: 0·빈 값·형식 오류·7자리 소수를 구분해 거부", () => {
    expect(parsePositiveUsdc("1.5")).toEqual({ ok: true, value: 1_500_000n });
    expect(parsePositiveUsdc("0")).toEqual({ ok: false, key: "err_amount_required" });
    expect(parsePositiveUsdc("0.000000")).toEqual({ ok: false, key: "err_amount_required" });
    expect(parsePositiveUsdc("")).toEqual({ ok: false, key: "err_amount_required" });
    expect(parsePositiveUsdc("1e3")).toEqual({ ok: false, key: "err_amount_format" });
    expect(parsePositiveUsdc("-1")).toEqual({ ok: false, key: "err_amount_negative" });
    expect(parsePositiveUsdc("1.1234567")).toEqual({ ok: false, key: "err_amount_decimals" });
    expect(parsePositiveUsdc("9".repeat(90))).toEqual({ ok: false, key: "err_amount_too_large" });
  });

  test("parseOptionalUsdc: 빈 값은 0 (목표 예산·분담 칸), 나머지는 엄격", () => {
    expect(parseOptionalUsdc("")).toEqual({ ok: true, value: 0n });
    expect(parseOptionalUsdc("  ")).toEqual({ ok: true, value: 0n });
    expect(parseOptionalUsdc("500")).toEqual({ ok: true, value: 500_000_000n });
    expect(parseOptionalUsdc("500.1234567")).toEqual({ ok: false, key: "err_amount_decimals" });
    expect(parseOptionalUsdc("5e2")).toEqual({ ok: false, key: "err_amount_format" });
  });

  test("usdcInputProblem: 입력 중 경고 — 비었거나 유효하면 null", () => {
    expect(usdcInputProblem("")).toBeNull();
    expect(usdcInputProblem("0")).toBeNull();
    expect(usdcInputProblem("12.5")).toBeNull();
    expect(usdcInputProblem("12.1234567")).toBe("err_amount_decimals");
    expect(usdcInputProblem("abc")).toBe("err_amount_format");
  });

  test("모든 오류 키가 영어/한국어 사전에 있고, 소수 자릿수 메시지는 '6' 을 명시", () => {
    const reasons: UsdcParseFailure[] = ["empty", "format", "negative", "too_many_decimals", "too_large"];
    for (const r of reasons) {
      const key = usdcFailureKey(r);
      expect(typeof (en as Record<string, string>)[key]).toBe("string");
      expect((en as Record<string, string>)[key].length).toBeGreaterThan(5);
      expect(typeof (ko as Record<string, string>)[key]).toBe("string");
      expect((ko as Record<string, string>)[key].length).toBeGreaterThan(5);
    }
    expect(en.err_amount_decimals).toContain("6");
    expect(ko.err_amount_decimals).toContain("6");
    // 한국어 메시지는 한글을 포함
    expect(/[가-힣]/.test(ko.err_amount_decimals)).toBe(true);
    expect(/[가-힣]/.test(ko.err_amount_format)).toBe(true);
  });
});

// ─── 영향받는 UI 경로: API/지갑 호출 전에 검증하는지 정적 점검 ───────────────────

describe("UI 경로 정적 점검 (React 렌더러 없이 소스 순서/금지 패턴 확인)", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const before = (src: string, a: string, b: string) => {
    const ia = src.indexOf(a);
    const ib = src.indexOf(b);
    expect(ia).toBeGreaterThan(-1);
    expect(ib).toBeGreaterThan(-1);
    expect(ia).toBeLessThan(ib);
  };

  test("대시보드: 입금·이체·반납 모두 엄격 검증 후에만 훅 실행", () => {
    const src = read("./components/DashboardTab.tsx");
    before(src, "parsePositiveUsdc(depositInput)", "depositHook.execute(");
    before(src, "parsePositiveUsdc(releaseInput)", "releaseHook.execute(");
    before(src, "parsePositiveUsdc(returnInput)", "returnHook.execute(");
    expect(src).not.toContain("parseUsdcInput(");
    // 잘못된 입력이면 버튼도 비활성화
    expect(src).toContain("!!depositProblem");
    expect(src).toContain("!!releaseProblem");
    expect(src).toContain("!!returnProblem");
  });

  test("여행방 생성: 목표 예산을 Number/Math.round 없이 엄격 파싱, 의도(API) 호출 전에 검증", () => {
    const src = read("./components/CreateTripModal.tsx");
    expect(src).not.toContain("Math.round");
    expect(src).not.toMatch(/Number\(budget/);
    before(src, "parseOptionalUsdc(budgetInput)", "prepareCreateTripIntent(");
  });

  test("지출 추가: 총액·직접 입력 분담액을 addExpense 호출 전에 검증", () => {
    const src = read("./components/ExpenseListTab.tsx");
    before(src, "parsePositiveUsdc(amountStr)", "await addExpense(");
    before(src, "usdcInputProblem(customShares[pid]", "await addExpense(");
    expect(src).not.toContain("toDisplayNumber");
  });

  test("정산 부족분 납입도 엄격 검증", () => {
    const src = read("./components/SettlementTab.tsx");
    expect(src).toContain("parsePositiveUsdc(deficitInput");
    expect(src).not.toContain("toDisplayNumber");
  });

  test("금액 입력칸은 모두 type=text(inputMode=decimal) — number 입력의 지수 표기/암묵 변환 배제", () => {
    const dir = new URL("./components/", import.meta.url);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".tsx")) continue;
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src).not.toContain('type="number"');
    }
  });

  test("앱 소스 어디에도 금액용 parseFloat / toFixed / toDisplayNumber 가 없다", () => {
    const walk = (dir: URL): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(new URL(`${e.name}/`, dir))
          : e.name.endsWith(".ts") || e.name.endsWith(".tsx")
            ? [new URL(e.name, dir).pathname]
            : [],
      );
    const files = walk(new URL("./", import.meta.url)).filter(
      (p) => !p.endsWith(".test.ts") && !p.endsWith("onchain-money.ts") && !p.endsWith("onchain-wait.ts"),
    );
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      expect(src.includes("parseFloat(")).toBe(false);
      expect(src.includes("toDisplayNumber")).toBe(false);
      // 비율 표시(ExpenseListTab 퍼센트)를 제외하고 toFixed 로 금액을 만들지 않는다
      if (!p.endsWith("ExpenseListTab.tsx")) expect(src.includes(".toFixed(")).toBe(false);
    }
  });
});
