// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * i18n 네트워크 동적 문자열 테스트.
 *
 * 이 테스트는 네트워크 레이블(Arc Mainnet / Arc Testnet)이 user-visible 사용자 문자열에
 * 하드코딩되지 않고 {{network}} 보간으로 전달됨을 검증합니다.
 * DOM, 지갑, DB 없음.
 */

import { describe, test, expect } from "bun:test";
import en from "./i18n/en";
import ko from "./i18n/ko";

// 보간 함수를 i18n/index.tsx에서 복제하지 않고 직접 구현 — 같은 로직
function interpolate(s: string, params: Record<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? `{{${k}}}`);
}

const TESTNET_LABEL = "Arc Testnet";
const MAINNET_LABEL = "Arc Mainnet";

describe("i18n — network-dynamic strings contain {{network}} placeholder", () => {
  const keysWithNetwork = [
    "connect_wallet_desc",
    "no_trips_desc",
    "how_to_create_trip_step1",
    "err_wrong_chain_switch",
  ] as const;

  for (const key of keysWithNetwork) {
    test(`en.${key} contains {{network}}`, () => {
      expect(en[key]).toContain("{{network}}");
    });
    test(`ko.${key} contains {{network}}`, () => {
      expect(ko[key]).toContain("{{network}}");
    });
  }

  test("en.connect_wallet_desc interpolates Arc Testnet correctly", () => {
    expect(interpolate(en.connect_wallet_desc, { network: TESTNET_LABEL }))
      .toBe("Click the wallet button above to connect your Arc Testnet wallet.");
  });

  test("en.connect_wallet_desc interpolates Arc Mainnet correctly", () => {
    expect(interpolate(en.connect_wallet_desc, { network: MAINNET_LABEL }))
      .toBe("Click the wallet button above to connect your Arc Mainnet wallet.");
  });

  test("en.no_trips_desc interpolates Arc Testnet correctly", () => {
    expect(interpolate(en.no_trips_desc, { network: TESTNET_LABEL }))
      .toBe("Create a trip on Arc Testnet using the smart contract and register it here.");
  });

  test("en.no_trips_desc interpolates Arc Mainnet correctly", () => {
    expect(interpolate(en.no_trips_desc, { network: MAINNET_LABEL }))
      .toBe("Create a trip on Arc Mainnet using the smart contract and register it here.");
  });

  test("en.how_to_create_trip_step1 interpolates Arc Testnet correctly", () => {
    expect(interpolate(en.how_to_create_trip_step1, { network: TESTNET_LABEL }))
      .toBe("Call MoaArcTreasury.createTrip() from your Arc Testnet wallet");
  });

  test("en.how_to_create_trip_step1 interpolates Arc Mainnet correctly", () => {
    expect(interpolate(en.how_to_create_trip_step1, { network: MAINNET_LABEL }))
      .toBe("Call MoaArcTreasury.createTrip() from your Arc Mainnet wallet");
  });

  test("en.err_wrong_chain_switch interpolates Arc Mainnet correctly", () => {
    expect(interpolate(en.err_wrong_chain_switch, { network: MAINNET_LABEL }))
      .toBe("Switch wallet to Arc Mainnet.");
  });

  test("en.err_wrong_chain_switch interpolates Arc Testnet correctly", () => {
    expect(interpolate(en.err_wrong_chain_switch, { network: TESTNET_LABEL }))
      .toBe("Switch wallet to Arc Testnet.");
  });
});

describe("i18n — add-participant card strings (DashboardTab.tsx)", () => {
  // EN: must be in English (no Korean characters)
  test("en.add_participant_helper is English", () => {
    expect(en.add_participant_helper).toMatch(/Sign the onchain/);
    // Must not contain Korean characters (Hangul Unicode range U+AC00–U+D7A3 and jamo)
    expect(en.add_participant_helper).not.toMatch(/[\uAC00-\uD7A3\u3130-\u318F]/);
  });
  test("en.add_participant_addr_placeholder is English", () => {
    expect(en.add_participant_addr_placeholder).toMatch(/wallet address/i);
    expect(en.add_participant_addr_placeholder).not.toMatch(/[\uAC00-\uD7A3\u3130-\u318F]/);
  });
  test("en.add_participant_name_placeholder is English", () => {
    expect(en.add_participant_name_placeholder).toMatch(/display name/i);
    expect(en.add_participant_name_placeholder).not.toMatch(/[\uAC00-\uD7A3\u3130-\u318F]/);
  });

  // KO: must contain Korean characters
  test("ko.add_participant_helper is Korean", () => {
    expect(ko.add_participant_helper).toMatch(/[\uAC00-\uD7A3]/);
  });
  test("ko.add_participant_addr_placeholder is Korean", () => {
    expect(ko.add_participant_addr_placeholder).toMatch(/[\uAC00-\uD7A3]/);
  });
  test("ko.add_participant_name_placeholder is Korean", () => {
    expect(ko.add_participant_name_placeholder).toMatch(/[\uAC00-\uD7A3]/);
  });

  // Content parity: EN and KO must be distinct (not the same string)
  test("en and ko add_participant_helper are distinct", () => {
    expect(en.add_participant_helper).not.toBe(ko.add_participant_helper);
  });
  test("en and ko add_participant_addr_placeholder are distinct", () => {
    expect(en.add_participant_addr_placeholder).not.toBe(ko.add_participant_addr_placeholder);
  });
  test("en and ko add_participant_name_placeholder are distinct", () => {
    expect(en.add_participant_name_placeholder).not.toBe(ko.add_participant_name_placeholder);
  });

  // Exact values — pin the strings so a future accidental revert is caught
  test("en.add_participant_helper exact value", () => {
    expect(en.add_participant_helper)
      .toBe("Sign the onchain addParticipant transaction, then it will sync to the DB.");
  });
  test("en.add_participant_addr_placeholder exact value", () => {
    expect(en.add_participant_addr_placeholder).toBe("0x wallet address (EOA)");
  });
  test("en.add_participant_name_placeholder exact value", () => {
    expect(en.add_participant_name_placeholder).toBe("Display name (optional)");
  });
  test("ko.add_participant_helper exact value", () => {
    expect(ko.add_participant_helper)
      .toBe("onchain addParticipant 트랜잭션 서명 후 DB에 동기화됩니다.");
  });
  test("ko.add_participant_addr_placeholder exact value", () => {
    expect(ko.add_participant_addr_placeholder).toBe("0x 지갑 주소 (EOA)");
  });
  test("ko.add_participant_name_placeholder exact value", () => {
    expect(ko.add_participant_name_placeholder).toBe("표시 이름 (선택)");
  });
});

describe("i18n — spending transfer and pooled-wallet label keys (EN/KO)", () => {
  const HANGUL = /[\uAC00-\uD7A3\u3130-\u318F]/;

  // budget_transfer_title: renamed from "Budget Transfer" to "Send Spending Funds" / "결제비 지급"
  test("en.budget_transfer_title describes sending, not settlement", () => {
    expect(en.budget_transfer_title).toMatch(/send/i);
    expect(en.budget_transfer_title).not.toMatch(/settlement|refund/i);
    expect(en.budget_transfer_title).not.toMatch(HANGUL);
  });
  test("ko.budget_transfer_title is Korean", () => {
    expect(ko.budget_transfer_title).toMatch(HANGUL);
  });
  test("en and ko budget_transfer_title are distinct", () => {
    expect(en.budget_transfer_title).not.toBe(ko.budget_transfer_title);
  });

  // budget_transfer_desc: must say "not a settlement or refund" in EN
  test("en.budget_transfer_desc says not settlement/refund", () => {
    expect(en.budget_transfer_desc).toMatch(/not a settlement or refund/i);
  });
  test("ko.budget_transfer_desc mentions 정산 or 환급 as negation", () => {
    expect(ko.budget_transfer_desc).toMatch(/정산|환급/);
    expect(ko.budget_transfer_desc).toMatch(/아닙니다|아님/);
  });

  // budget_transfer_zero_balance
  test("en.budget_transfer_zero_balance mentions shared balance is 0", () => {
    expect(en.budget_transfer_zero_balance).toMatch(/0/);
    expect(en.budget_transfer_zero_balance).not.toMatch(HANGUL);
  });
  test("ko.budget_transfer_zero_balance is Korean", () => {
    expect(ko.budget_transfer_zero_balance).toMatch(HANGUL);
  });

  // budget_transfer_no_eligible
  test("en.budget_transfer_no_eligible is English", () => {
    expect(en.budget_transfer_no_eligible).not.toMatch(HANGUL);
  });
  test("ko.budget_transfer_no_eligible is Korean", () => {
    expect(ko.budget_transfer_no_eligible).toMatch(HANGUL);
  });

  // budget_transfer_add_participant_hint
  test("en.budget_transfer_add_participant_hint mentions participant", () => {
    expect(en.budget_transfer_add_participant_hint).toMatch(/participant/i);
    expect(en.budget_transfer_add_participant_hint).not.toMatch(HANGUL);
  });
  test("ko.budget_transfer_add_participant_hint is Korean", () => {
    expect(ko.budget_transfer_add_participant_hint).toMatch(HANGUL);
  });

  // my_deposit must NOT exist — pooled wallet hides individual deposits
  test("en locale does not have my_deposit key (pooled wallet: no per-user deposit row)", () => {
    expect("my_deposit" in en).toBe(false);
  });
  test("ko locale does not have my_deposit key", () => {
    expect("my_deposit" in ko).toBe(false);
  });

  // details_col_deposited must NOT exist
  test("en locale does not have details_col_deposited key", () => {
    expect("details_col_deposited" in en).toBe(false);
  });
  test("ko locale does not have details_col_deposited key", () => {
    expect("details_col_deposited" in ko).toBe(false);
  });

  // refresh keys exist in both
  test("en.refresh_balances and refreshing_balances exist", () => {
    expect(en.refresh_balances).toMatch(/refresh/i);
    expect(en.refreshing_balances).toMatch(/refresh|ing/i);
  });
  test("ko.refresh_balances is Korean", () => {
    expect(ko.refresh_balances).toMatch(HANGUL);
  });
});

describe("i18n — keys that previously had hard-coded network names no longer do", () => {
  // These keys are intentionally network-specific (testnet warning / mainnet warning)
  // and should remain as-is; they are NOT in scope for dynamic substitution.
  test("footer_disclaimer still refers to Arc Testnet (testnet-only key)", () => {
    expect(en.footer_disclaimer).toContain("Arc Testnet");
  });
  test("footer_disclaimer_mainnet still refers to Arc Mainnet (mainnet-only key)", () => {
    expect(en.footer_disclaimer_mainnet).toContain("Arc Mainnet");
  });
  // The keys that were previously hard-coded must NOT hard-code either network label.
  test("en.connect_wallet_desc does not hard-code Arc Testnet", () => {
    expect(en.connect_wallet_desc).not.toContain("Arc Testnet");
    expect(en.connect_wallet_desc).not.toContain("Arc Mainnet");
  });
  test("en.no_trips_desc does not hard-code Arc Testnet", () => {
    expect(en.no_trips_desc).not.toContain("Arc Testnet");
    expect(en.no_trips_desc).not.toContain("Arc Mainnet");
  });
  test("en.how_to_create_trip_step1 does not hard-code Arc Testnet", () => {
    expect(en.how_to_create_trip_step1).not.toContain("Arc Testnet");
    expect(en.how_to_create_trip_step1).not.toContain("Arc Mainnet");
  });
  test("en.err_wrong_chain_switch does not hard-code Arc Testnet", () => {
    expect(en.err_wrong_chain_switch).not.toContain("Arc Testnet");
    expect(en.err_wrong_chain_switch).not.toContain("Arc Mainnet");
  });
});
