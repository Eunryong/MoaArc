// bun:test 타입 선언 파일을 명시적으로 로드합니다 (루트 tsconfig 는 bun 타입을 자동 포함하지 않음, 런타임 영향 없음).
// eslint-disable-next-line typescript/triple-slash-reference
/// <reference path="../node_modules/bun-types/test.d.ts" />
/**
 * 프런트엔드 네트워크 설정 불변식 테스트.
 *  - evaluateFrontendNetwork: 순수 함수 매트릭스 (mainnet/testnet/잘못된 값/교차 네트워크)
 *  - backendNetworkMismatch: 서버 /api/network ↔ 프런트 설정 비교
 *  - networkConfig.ts 모듈 스모크 (빌드타임 env 연결)
 *  - 정적 점검: 모든 write 훅의 CONFIG_VALID 가드, 코드에 하드코딩된 테스트넷 값 없음
 * 네트워크·DB·.env 를 사용하지 않습니다 (process.env 는 테스트 안에서만 임시 설정 후 복원).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  CANONICAL_USDC,
  EXPECTED_CONTRACT_VERSION,
  KNOWN_TESTNET_CONTRACTS,
  TESTNET_CONTRACT,
  ZERO_ADDRESS,
  backendNetworkMismatch,
  evaluateFrontendNetwork,
  type RawFrontendEnv,
} from "./networkConfigCore";
import * as serverEnv from "../server/src/lib/networkEnv";

const MAINNET_CONTRACT = "0x1111111111111111111111111111111111111111";

const mainnetEnv = (over: RawFrontendEnv = {}): RawFrontendEnv => ({
  VITE_NETWORK: "mainnet",
  VITE_CHAIN_ID: "5042",
  VITE_USDC_ADDRESS: CANONICAL_USDC,
  VITE_CONTRACT_ADDRESS: MAINNET_CONTRACT,
  ...over,
});

describe("상수", () => {
  test("체인 ID 와 USDC 가 정확한 값", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(5042);
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(CANONICAL_USDC).toBe("0x3600000000000000000000000000000000000000");
    expect(EXPECTED_CONTRACT_VERSION).toBe("MoaArc-3.0");
  });

  test("프런트와 서버의 알려진 테스트넷 컨트랙트 목록·상수가 동일", () => {
    expect([...serverEnv.KNOWN_TESTNET_CONTRACTS]).toEqual([...KNOWN_TESTNET_CONTRACTS]);
    expect(serverEnv.CANONICAL_USDC).toBe(CANONICAL_USDC);
    expect(serverEnv.ARC_MAINNET_CHAIN_ID).toBe(ARC_MAINNET_CHAIN_ID);
    expect(serverEnv.ARC_TESTNET_CHAIN_ID).toBe(ARC_TESTNET_CHAIN_ID);
    expect(serverEnv.EXPECTED_CONTRACT_VERSION).toBe(EXPECTED_CONTRACT_VERSION);
    expect(KNOWN_TESTNET_CONTRACTS).toContain(TESTNET_CONTRACT);
  });
});

describe("서버 MOARC_NETWORK ↔ 프런트 VITE_NETWORK 판정 일치 (정확히 소문자 testnet/mainnet 만 유효)", () => {
  const names = [undefined, "", "  ", "testnet", "mainnet", "Mainnet", "MAINNET", " mainnet", "mainnet ", " Mainnet ", "TestNet", " testnet ", "main", "prod"];
  test("모든 입력에서 두 구현이 같은 결과", () => {
    for (const name of names) {
      const server = serverEnv.resolveServerNetwork({ MOARC_NETWORK: name }).network;
      const front = evaluateFrontendNetwork({ VITE_NETWORK: name }).network;
      expect(server, `network=${JSON.stringify(name)}`).toBe(front);
    }
  });

  test("미설정·빈 값·공백뿐인 값만 testnet 기본값, 대소문자/공백이 다른 이름은 null(거부)", () => {
    for (const ok of [undefined, "", "  "]) expect(serverEnv.resolveServerNetwork({ MOARC_NETWORK: ok }).network).toBe("testnet");
    for (const bad of ["Mainnet", "MAINNET", " mainnet", "mainnet ", " Mainnet ", "TestNet", " testnet "]) {
      expect(serverEnv.resolveServerNetwork({ MOARC_NETWORK: bad }).network).toBeNull();
      expect(evaluateFrontendNetwork({ VITE_NETWORK: bad }).network).toBeNull();
    }
  });
});

describe("testnet 기본값 유지", () => {
  test("env 가 비어 있으면 testnet 기본값으로 유효", () => {
    const r = evaluateFrontendNetwork({});
    expect(r).toMatchObject({
      network: "testnet",
      isMainnet: false,
      chainId: 5042002,
      contractAddress: TESTNET_CONTRACT,
      usdcAddress: CANONICAL_USDC,
      contractVersion: "MoaArc-3.0",
      valid: true,
    });
    expect(r.errors).toEqual([]);
  });

  test("명시적 testnet + 정확한 체인 ID 는 유효, 공백만 있는 값은 미설정으로 취급", () => {
    expect(evaluateFrontendNetwork({ VITE_NETWORK: "testnet", VITE_CHAIN_ID: "5042002" }).valid).toBe(true);
    expect(evaluateFrontendNetwork({ VITE_NETWORK: "  ", VITE_CHAIN_ID: " " }).valid).toBe(true);
  });

  test("testnet 에서 컨트랙트 주소 override 는 검증 후 사용 (소문자 정규화)", () => {
    const r = evaluateFrontendNetwork({ VITE_CONTRACT_ADDRESS: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" });
    expect(r.valid).toBe(true);
    expect(r.contractAddress).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  });
});

describe("mainnet 정상 구성", () => {
  test("모든 값이 올바르면 유효하고 mainnet 값이 사용됨", () => {
    const r = evaluateFrontendNetwork(mainnetEnv());
    expect(r.valid).toBe(true);
    expect(r.network).toBe("mainnet");
    expect(r.chainId).toBe(5042);
    expect(r.contractAddress).toBe(MAINNET_CONTRACT);
    expect(r.usdcAddress).toBe(CANONICAL_USDC);
    expect(r.contractVersion).toBe("MoaArc-3.0");
  });

  test("대문자 주소는 소문자로 정규화, VERSION 을 같은 값으로 명시해도 유효", () => {
    const r = evaluateFrontendNetwork(
      mainnetEnv({ VITE_CONTRACT_ADDRESS: MAINNET_CONTRACT.toUpperCase().replace("0X", "0x"), VITE_CONTRACT_VERSION: "MoaArc-3.0" }),
    );
    expect(r.valid).toBe(true);
    expect(r.contractAddress).toBe(MAINNET_CONTRACT);
  });
});

describe("mainnet 필수값 누락 → fail-closed (testnet 값으로 대체되지 않음)", () => {
  test.each(["VITE_CHAIN_ID", "VITE_USDC_ADDRESS", "VITE_CONTRACT_ADDRESS"] as const)("%s 누락", (key) => {
    const env = mainnetEnv();
    delete env[key];
    const r = evaluateFrontendNetwork(env);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes(key))).toBe(true);
    expect(r.contractAddress).toBeNull();
    expect(r.usdcAddress).toBeNull();
  });

  test("mainnet 에서 주소가 전혀 없으면 testnet 기본 컨트랙트가 쓰이지 않음", () => {
    const r = evaluateFrontendNetwork({ VITE_NETWORK: "mainnet", VITE_CHAIN_ID: "5042" });
    expect(r.valid).toBe(false);
    expect(r.contractAddress).toBeNull();
    expect(r.usdcAddress).toBeNull();
    expect(r.contractAddress).not.toBe(TESTNET_CONTRACT);
  });
});

describe("체인 ID 검증", () => {
  const bad = ["5042abc", "5042.0", "05042", "0x13b2", "5e3", "-5042", "+5042", "5 042", "abc", "0", "5042 5042"];
  test.each(bad)("mainnet: 잘못된 형식 %p 거부 (parseInt 접미사 허용 없음)", (v) => {
    const r = evaluateFrontendNetwork(mainnetEnv({ VITE_CHAIN_ID: v }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("VITE_CHAIN_ID"))).toBe(true);
    expect(r.contractAddress).toBeNull();
  });

  test.each(bad)("testnet: 잘못된 형식 %p 거부", (v) => {
    expect(evaluateFrontendNetwork({ VITE_CHAIN_ID: v }).valid).toBe(false);
  });

  test("교차 네트워크 체인 ID 거부 (mainnet 에 5042002, testnet 에 5042)", () => {
    expect(evaluateFrontendNetwork(mainnetEnv({ VITE_CHAIN_ID: "5042002" })).valid).toBe(false);
    expect(evaluateFrontendNetwork({ VITE_NETWORK: "testnet", VITE_CHAIN_ID: "5042" }).valid).toBe(false);
    expect(evaluateFrontendNetwork(mainnetEnv({ VITE_CHAIN_ID: "31337" })).valid).toBe(false);
  });

  test("앞뒤 공백은 허용하되 값은 정확히 일치해야 함", () => {
    expect(evaluateFrontendNetwork(mainnetEnv({ VITE_CHAIN_ID: " 5042 " })).valid).toBe(true);
  });
});

describe("알 수 없는 네트워크 이름", () => {
  test.each(["Mainnet", "MAINNET", "main", "prod", "production", "mainnet ", "sepolia", "devnet", "0"])(
    "%p 는 거부되고 어떤 주소도 노출하지 않음",
    (name) => {
      const r = evaluateFrontendNetwork(mainnetEnv({ VITE_NETWORK: name }));
      expect(r.valid).toBe(false);
      expect(r.network).toBeNull();
      expect(r.contractAddress).toBeNull();
      expect(r.usdcAddress).toBeNull();
      expect(r.errors.some((e) => e.includes("VITE_NETWORK"))).toBe(true);
    },
  );

  test("알 수 없는 네트워크 + 아무 주소도 없을 때 testnet 기본값으로 떨어지지 않음", () => {
    const r = evaluateFrontendNetwork({ VITE_NETWORK: "typo" });
    expect(r.valid).toBe(false);
    expect(r.contractAddress).toBeNull();
    expect(r.usdcAddress).toBeNull();
  });
});

describe("주소 검증", () => {
  test("0 주소·형식 오류·길이 오류 거부 (mainnet)", () => {
    for (const bad of [ZERO_ADDRESS, "0x123", "not-an-address", "0x" + "g".repeat(40), MAINNET_CONTRACT + "00"]) {
      const r = evaluateFrontendNetwork(mainnetEnv({ VITE_CONTRACT_ADDRESS: bad }));
      expect(r.valid).toBe(false);
      expect(r.contractAddress).toBeNull();
    }
  });

  test("testnet override 의 형식 오류는 기본값으로 덮이지 않고 무효 처리", () => {
    const r = evaluateFrontendNetwork({ VITE_CONTRACT_ADDRESS: "0x123" });
    expect(r.valid).toBe(false);
    expect(r.contractAddress).toBeNull();
    const z = evaluateFrontendNetwork({ VITE_USDC_ADDRESS: ZERO_ADDRESS });
    expect(z.valid).toBe(false);
  });

  test("mainnet 에서 알려진 모든 테스트넷 컨트랙트 주소 거부", () => {
    for (const addr of KNOWN_TESTNET_CONTRACTS) {
      const r = evaluateFrontendNetwork(mainnetEnv({ VITE_CONTRACT_ADDRESS: addr }));
      expect(r.valid).toBe(false);
      expect(r.contractAddress).toBeNull();
      expect(r.errors.some((e) => /testnet/i.test(e))).toBe(true);
      // 대문자 표기로 우회 불가
      const up = evaluateFrontendNetwork(mainnetEnv({ VITE_CONTRACT_ADDRESS: addr.toUpperCase().replace("0X", "0x") }));
      expect(up.valid).toBe(false);
    }
  });

  test("mainnet USDC 는 정확히 0x3600…0000 이어야 함", () => {
    for (const bad of ["0x3600000000000000000000000000000000000001", MAINNET_CONTRACT, ZERO_ADDRESS]) {
      const r = evaluateFrontendNetwork(mainnetEnv({ VITE_USDC_ADDRESS: bad }));
      expect(r.valid).toBe(false);
      expect(r.usdcAddress).toBeNull();
    }
    expect(evaluateFrontendNetwork(mainnetEnv({ VITE_USDC_ADDRESS: CANONICAL_USDC.toUpperCase().replace("0X", "0x") })).valid).toBe(
      true,
    );
  });
});

describe("컨트랙트 버전", () => {
  test("mainnet 에서 다른 VERSION 은 거부, testnet 에서는 override 허용", () => {
    expect(evaluateFrontendNetwork(mainnetEnv({ VITE_CONTRACT_VERSION: "MoaArc-2.0" })).valid).toBe(false);
    expect(evaluateFrontendNetwork({ VITE_CONTRACT_VERSION: "MoaArc-3.1" })).toMatchObject({
      valid: true,
      contractVersion: "MoaArc-3.1",
    });
  });
});

describe("어떤 오류든 contractAddress/usdcAddress 는 null (오래된 testnet 값 write 불가)", () => {
  const invalidEnvs: RawFrontendEnv[] = [
    { VITE_NETWORK: "x" },
    { VITE_CHAIN_ID: "1" },
    { VITE_CONTRACT_ADDRESS: "0x1" },
    mainnetEnv({ VITE_CHAIN_ID: undefined }),
    mainnetEnv({ VITE_USDC_ADDRESS: "0x3600000000000000000000000000000000000001" }),
    mainnetEnv({ VITE_CONTRACT_ADDRESS: TESTNET_CONTRACT }),
  ];
  test.each(invalidEnvs.map((e, i) => [i, e] as const))("invalid case #%i", (_i, env) => {
    const r = evaluateFrontendNetwork(env);
    expect(r.valid).toBe(false);
    expect(r.contractAddress).toBeNull();
    expect(r.usdcAddress).toBeNull();
  });
});

describe("backendNetworkMismatch (서명 직전 /api/network 비교)", () => {
  const cfg = { network: "mainnet" as const, chainId: 5042, contractAddress: MAINNET_CONTRACT, usdcAddress: CANONICAL_USDC, contractVersion: "MoaArc-3.0" };
  const ok = { status: "ok", network: "mainnet", chainId: 5042, contractAddress: MAINNET_CONTRACT, usdcAddress: CANONICAL_USDC, version: "MoaArc-3.0" };

  test("완전히 일치하면 null", () => {
    expect(backendNetworkMismatch(ok, cfg)).toBeNull();
    expect(backendNetworkMismatch({ ...ok, contractAddress: MAINNET_CONTRACT.toUpperCase().replace("0X", "0x") }, cfg)).toBeNull();
  });

  test("서버 없음 / 상태 not ok / 필드 누락", () => {
    expect(backendNetworkMismatch(null, cfg)).toBe("backend_unavailable");
    expect(backendNetworkMismatch({ ...ok, status: "mismatch" }, cfg)).toBe("backend_not_ok");
    expect(backendNetworkMismatch({ ...ok, network: undefined }, cfg)).toBe("backend_fields_missing");
    expect(backendNetworkMismatch({ ...ok, version: "" }, cfg)).toBe("backend_fields_missing");
  });

  test("network 이름이 다르면 (서버 testnet / 프런트 mainnet) 차단", () => {
    expect(backendNetworkMismatch({ ...ok, network: "testnet" }, cfg)).toBe("network_name");
    expect(backendNetworkMismatch(ok, { ...cfg, network: null })).toBe("network_name");
  });

  test("체인·컨트랙트·USDC·VERSION 불일치", () => {
    expect(backendNetworkMismatch({ ...ok, chainId: 5042002 }, cfg)).toBe("chain_id");
    expect(backendNetworkMismatch({ ...ok, contractAddress: TESTNET_CONTRACT }, cfg)).toBe("contract_address");
    expect(backendNetworkMismatch({ ...ok, usdcAddress: MAINNET_CONTRACT }, cfg)).toBe("usdc_address");
    expect(backendNetworkMismatch({ ...ok, version: "MoaArc-2.0" }, cfg)).toBe("contract_version");
  });
});

// ─── networkConfig.ts 모듈 스모크 (import.meta.env 연결) ──────────────────────

const VITE_KEYS = ["VITE_NETWORK", "VITE_CHAIN_ID", "VITE_CONTRACT_ADDRESS", "VITE_USDC_ADDRESS", "VITE_CONTRACT_VERSION"] as const;

async function loadConfigWith(env: RawFrontendEnv, tag: string) {
  const saved: Record<string, string | undefined> = {};
  for (const k of VITE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  const origError = console.error;
  console.error = () => undefined; // 의도적으로 잘못된 설정의 로그 출력 억제
  try {
    const spec = `./networkConfig.ts?smoke=${tag}`; // 변수 specifier + 쿼리로 모듈을 새로 평가
    return (await import(spec)) as typeof import("./networkConfig");
  } finally {
    console.error = origError;
    for (const k of VITE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("networkConfig.ts 스모크", () => {
  test("env 없음 → testnet 기본값, CONFIG_VALID=true", async () => {
    const m = await loadConfigWith({}, "default");
    expect(m.CONFIG_VALID).toBe(true);
    expect(m.NETWORK_CONFIG.network).toBe("testnet");
    expect(m.NETWORK_CONFIG.chainId).toBe(5042002);
    expect(m.NETWORK_CONFIG.contractAddress).toBe(TESTNET_CONTRACT);
    expect(m.NETWORK_CONFIG.explorerBase).toContain("testnet");
    expect(m.NETWORK_LABEL).toBe("Arc Testnet (5042002)");
  });

  test("유효한 mainnet env → mainnet 체인·탐색기, testnet 값 없음", async () => {
    const m = await loadConfigWith(mainnetEnv(), "mainnet-ok");
    expect(m.CONFIG_VALID).toBe(true);
    expect(m.NETWORK_CONFIG.isMainnet).toBe(true);
    expect(m.NETWORK_CONFIG.chainId).toBe(5042);
    expect(m.NETWORK_CONFIG.viemChain.id).toBe(5042);
    expect(m.NETWORK_CONFIG.contractAddress).toBe(MAINNET_CONTRACT);
    expect(m.NETWORK_CONFIG.explorerBase).not.toContain("testnet");
    expect(m.NETWORK_CONFIG.rpcUrls.some((u) => u.includes("testnet"))).toBe(false);
    expect(m.NETWORK_LABEL).toBe("Arc Mainnet (5042)");
  });

  test("mainnet 인데 설정 불완전 → CONFIG_VALID=false, 주소는 ZERO sentinel (testnet 컨트랙트 아님)", async () => {
    const m = await loadConfigWith({ VITE_NETWORK: "mainnet" }, "mainnet-missing");
    expect(m.CONFIG_VALID).toBe(false);
    expect(m.NETWORK_CONFIG.contractAddress).toBe(ZERO_ADDRESS);
    expect(m.NETWORK_CONFIG.usdcAddress).toBe(ZERO_ADDRESS);
    expect(m.NETWORK_CONFIG.chainId).toBe(5042);
    expect(m.NETWORK_CONFIG.configErrors.length).toBeGreaterThan(0);
  });

  test("알 수 없는 VITE_NETWORK → 무효, 주소 ZERO", async () => {
    const m = await loadConfigWith({ VITE_NETWORK: "Mainnet" }, "bad-name");
    expect(m.CONFIG_VALID).toBe(false);
    expect(m.NETWORK_CONFIG.network).toBeNull();
    expect(m.NETWORK_CONFIG.contractAddress).toBe(ZERO_ADDRESS);
  });
});

// ─── 정적 점검: write 경로 ─────────────────────────────────────────────────────

const SRC = new URL(".", import.meta.url).pathname;

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSources(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".testkit.ts")) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("write 경로 정적 점검", () => {
  const writeSrc = readFileSync(join(SRC, "useContractWrite.ts"), "utf8");

  test("writeContractAsync 를 쓰는 모든 훅은 CONFIG_VALID 를 먼저 확인하고 chainId 를 고정", () => {
    const hooks = writeSrc.split(/^export function /m).slice(1).filter((h) => h.includes("writeContractAsync({"));
    expect(hooks.length).toBeGreaterThanOrEqual(8);
    for (const h of hooks) {
      const name = h.slice(0, h.indexOf("("));
      expect(h.indexOf("!CONFIG_VALID"), `${name}: CONFIG_VALID 가드`).toBeGreaterThan(-1);
      expect(h.indexOf("!CONFIG_VALID"), `${name}: 가드가 write 보다 먼저`).toBeLessThan(h.indexOf("writeContractAsync({"));
      expect(h.includes("chainId: CHAIN_ID"), `${name}: chainId 고정`).toBe(true);
    }
  });

  test("지갑 서명 직전 서버 설정 비교는 network 이름까지 확인", () => {
    expect(writeSrc).toContain("backendNetworkMismatch(ns, NETWORK_CONFIG)");
  });

  test("CreateTripModal: 서버 tx 검증 후에만 지갑 호출, 체인 고정, value 0", () => {
    const src = readFileSync(join(SRC, "components/CreateTripModal.tsx"), "utf8");
    const guard = src.indexOf("assertIntentTxMatchesConfig(");
    const send = src.indexOf("sendTransactionAsync({");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
    expect(src.slice(send, send + 300)).toContain("chainId: NETWORK_CONFIG.chainId");
    expect(src.slice(send, send + 300)).toContain("value: 0n");
    expect(src).not.toContain("ARC_TESTNET_CHAIN_ID");
  });

  test("테스트넷 chain id / 컨트랙트 / 탐색기가 설정 모듈 밖에 하드코딩되어 있지 않음", () => {
    const allowed = new Set(["networkConfigCore.ts", "networkConfig.ts", "config.ts", "onchain-facts.ts"]);
    const offenders: string[] = [];
    for (const file of listSources(SRC)) {
      const base = file.split("/").pop() as string;
      if (allowed.has(base)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      for (const needle of ["5042002", "0xf7a733fb", "explorer.testnet", "rpc.testnet", "arcTestnet"]) {
        if (code.includes(needle)) offenders.push(`${file.replace(SRC, "src/")}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("wagmi 설정은 NETWORK_CONFIG 의 체인 하나만 사용", () => {
    const cfg = readFileSync(join(SRC, "config.ts"), "utf8");
    expect(cfg).toContain("NETWORK_CONFIG.isMainnet");
    expect(cfg).toContain("chains: [arc]");
    expect(cfg).toContain("chains: [arcTestnet]");
    expect(cfg).not.toMatch(/chains:\s*\[[^\]]*,/); // 다중 체인 금지
  });
});
