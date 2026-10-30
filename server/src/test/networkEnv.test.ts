/**
 * 서버 네트워크 환경 검증 불변식 테스트 (순수 함수 + chain.ts 스모크).
 * DB·.env 를 사용하지 않고, 외부 인터넷에 연결하지 않습니다 (로컬 loopback 가짜 RPC 한 개만 사용).
 */

import { describe, test, expect } from "bun:test";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  CANONICAL_USDC,
  KNOWN_TESTNET_CONTRACTS,
  ZERO_ADDRESS,
  buildRpcUrls,
  resolveServerNetwork,
  type EnvLike,
} from "../lib/networkEnv";
import { arc, arcTestnet } from "viem/chains";

const MAINNET_CONTRACT = "0x1111111111111111111111111111111111111111";
const TESTNET_V3 = "0xf7a733fb2084b31591a0fbacded683efbe5b6728";

const mainnetEnv = (over: EnvLike = {}): EnvLike => ({
  MOARC_NETWORK: "mainnet",
  MOARC_CHAIN_ID: "5042",
  MOARC_USDC_ADDRESS: CANONICAL_USDC,
  MOARC_CONTRACT_ADDRESS: MAINNET_CONTRACT,
  MOARC_CONTRACT_VERSION: "MoaArc-3.0",
  ...over,
});
const testnetEnv = (over: EnvLike = {}): EnvLike => ({ MOARC_CONTRACT_ADDRESS: TESTNET_V3, ...over });

describe("상수는 viem 공식 체인과 일치", () => {
  test("체인 ID", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(arc.id);
    expect(ARC_TESTNET_CHAIN_ID).toBe(arcTestnet.id);
    expect(arc.id).toBe(5042);
  });
});

describe("resolveServerNetwork — testnet 기본값 유지", () => {
  test("컨트랙트만 있으면 testnet 기본값으로 유효", () => {
    const r = resolveServerNetwork(testnetEnv());
    expect(r).toMatchObject({
      network: "testnet",
      chainId: 5042002,
      officialChainId: 5042002,
      contractAddress: TESTNET_V3,
      usdcAddress: CANONICAL_USDC,
      contractVersion: "MoaArc-3.0",
    });
    expect(r.errors).toEqual([]);
  });

  test("MOARC_NETWORK: 미설정·빈 문자열·공백뿐인 값만 testnet 기본값 (프런트 VITE_NETWORK 와 동일)", () => {
    expect(resolveServerNetwork(testnetEnv()).network).toBe("testnet");
    expect(resolveServerNetwork(testnetEnv({ MOARC_NETWORK: "" })).network).toBe("testnet");
    expect(resolveServerNetwork(testnetEnv({ MOARC_NETWORK: "   " })).network).toBe("testnet");
    expect(resolveServerNetwork(testnetEnv({ MOARC_NETWORK: "testnet" })).network).toBe("testnet");
  });

  test("testnet 에서 컨트랙트 미설정은 오류 (기존 동작)", () => {
    const r = resolveServerNetwork({});
    expect(r.errors.some((e) => e.includes("MOARC_CONTRACT_ADDRESS"))).toBe(true);
    expect(r.contractAddress).toBeNull();
  });
});

describe("resolveServerNetwork — mainnet 정상 / 필수값", () => {
  test("완전한 mainnet 구성은 유효", () => {
    const r = resolveServerNetwork(mainnetEnv());
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ network: "mainnet", chainId: 5042, contractAddress: MAINNET_CONTRACT, usdcAddress: CANONICAL_USDC });
  });

  test.each(["MOARC_CHAIN_ID", "MOARC_USDC_ADDRESS", "MOARC_CONTRACT_ADDRESS"])("%s 누락 → 오류", (key) => {
    const env = mainnetEnv();
    delete env[key];
    const r = resolveServerNetwork(env);
    expect(r.errors.some((e) => e.includes(key))).toBe(true);
  });

  test("mainnet 에서 USDC 미설정 시 testnet 기본 USDC 로 대체되지 않음", () => {
    const env = mainnetEnv();
    delete env.MOARC_USDC_ADDRESS;
    expect(resolveServerNetwork(env).usdcAddress).toBeNull();
  });
});

describe("resolveServerNetwork — 잘못된 값 거부", () => {
  test.each(["5042abc", "5042.0", "05042", "0x13b2", "5e3", "-5042", "+5042", "abc", "0"])("MOARC_CHAIN_ID=%p 거부 (parseInt 접미사 금지)", (v) => {
    const mn = resolveServerNetwork(mainnetEnv({ MOARC_CHAIN_ID: v }));
    expect(mn.chainId).toBeNull();
    expect(mn.errors.some((e) => e.includes("MOARC_CHAIN_ID"))).toBe(true);
    const tn = resolveServerNetwork(testnetEnv({ MOARC_CHAIN_ID: v }));
    expect(tn.chainId).toBeNull();
    expect(tn.errors.length).toBeGreaterThan(0);
  });

  test("교차 네트워크 체인 ID 거부", () => {
    expect(resolveServerNetwork(mainnetEnv({ MOARC_CHAIN_ID: "5042002" })).chainId).toBeNull();
    expect(resolveServerNetwork(testnetEnv({ MOARC_CHAIN_ID: "5042" })).chainId).toBeNull();
    expect(resolveServerNetwork(mainnetEnv({ MOARC_CHAIN_ID: "31337" })).errors.length).toBeGreaterThan(0);
  });

  test.each(["Mainnet", "MAINNET", "TestNet", " Mainnet ", " mainnet", "mainnet ", " testnet ", "Mainnet-1", "main", "prod", "production", "sepolia", "mainnets", "0"])("정확히 일치하지 않는 MOARC_NETWORK=%p 거부", (name) => {
    const r = resolveServerNetwork(mainnetEnv({ MOARC_NETWORK: name }));
    expect(r.network).toBeNull();
    expect(r.chainId).toBeNull();
    expect(r.officialChainId).toBeNull();
    expect(r.errors.some((e) => e.includes("MOARC_NETWORK"))).toBe(true);
    expect(r.usdcAddress).toBeNull();
  });

  test("0 주소·형식 오류 주소 거부", () => {
    for (const bad of [ZERO_ADDRESS, "0x123", "zzz", "0x" + "g".repeat(40)]) {
      const r = resolveServerNetwork(mainnetEnv({ MOARC_CONTRACT_ADDRESS: bad }));
      expect(r.contractAddress).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
    }
    expect(resolveServerNetwork(mainnetEnv({ MOARC_USDC_ADDRESS: ZERO_ADDRESS })).usdcAddress).toBeNull();
  });

  test("mainnet 에서 알려진 모든 testnet 컨트랙트 거부 (대문자 포함)", () => {
    for (const addr of KNOWN_TESTNET_CONTRACTS) {
      for (const form of [addr, addr.toUpperCase().replace("0X", "0x")]) {
        const r = resolveServerNetwork(mainnetEnv({ MOARC_CONTRACT_ADDRESS: form }));
        expect(r.contractAddress).toBeNull();
        expect(r.errors.some((e) => /testnet/i.test(e))).toBe(true);
      }
    }
  });

  test("mainnet USDC 는 정확히 0x3600…0000", () => {
    const r = resolveServerNetwork(mainnetEnv({ MOARC_USDC_ADDRESS: "0x3600000000000000000000000000000000000001" }));
    expect(r.usdcAddress).toBeNull();
    expect(r.errors.some((e) => e.includes("MOARC_USDC_ADDRESS"))).toBe(true);
    expect(resolveServerNetwork(mainnetEnv({ MOARC_USDC_ADDRESS: CANONICAL_USDC.toUpperCase().replace("0X", "0x") })).errors).toEqual([]);
  });

  test("mainnet VERSION 은 MoaArc-3.0 고정, testnet 은 override 가능", () => {
    expect(resolveServerNetwork(mainnetEnv({ MOARC_CONTRACT_VERSION: "MoaArc-2.0" })).errors.some((e) => e.includes("VERSION") || e.includes("VERSION".toLowerCase()) || e.includes("MOARC_CONTRACT_VERSION"))).toBe(true);
    expect(resolveServerNetwork(testnetEnv({ MOARC_CONTRACT_VERSION: "MoaArc-3.1" }))).toMatchObject({ contractVersion: "MoaArc-3.1", errors: [] });
  });
});

describe("buildRpcUrls — 네트워크별 RPC, testnet fallback 누출 없음", () => {
  const ARC_DEFAULTS = arc.rpcUrls.default.http as readonly string[];
  const TESTNET_DEFAULTS = arcTestnet.rpcUrls.default.http as readonly string[];

  test("mainnet: ARC_MAINNET_RPC_URL* 먼저, 이후 viem mainnet 기본값만", () => {
    const r = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: "https://rpc-a.example.com", ARC_MAINNET_RPC_URL_2: "https://rpc-b.example.com" }, ARC_DEFAULTS);
    expect(r.errors).toEqual([]);
    expect(r.urls.slice(0, 2)).toEqual(["https://rpc-a.example.com", "https://rpc-b.example.com"]);
    expect(r.urls.slice(2)).toEqual([...ARC_DEFAULTS]);
    for (const t of TESTNET_DEFAULTS) expect(r.urls).not.toContain(t);
  });

  test("mainnet: ARC_TESTNET_RPC_FALLBACK 와 RPC_PROXY_* 는 있어도 무시", () => {
    const r = buildRpcUrls(
      "mainnet",
      {
        ARC_TESTNET_RPC_FALLBACK: "https://rpc.testnet.arc.io",
        RPC_PROXY_BASE_URL: "https://proxy.example.com",
        RPC_PROXY_TOKEN: "SECRET_TOKEN_VALUE",
        RPC_PROXY_CHAINS: "ARC-MAINNET,ARC-TESTNET",
      },
      ARC_DEFAULTS,
    );
    expect(r.errors).toEqual([]);
    expect(r.urls).toEqual([...ARC_DEFAULTS]);
    expect(JSON.stringify(r.urls)).not.toContain("SECRET_TOKEN_VALUE");
    expect(JSON.stringify(r.urls)).not.toContain("proxy.example.com");
  });

  test("mainnet: 범용 ARC_RPC_URL* 는 모호하므로 오류", () => {
    for (const k of ["ARC_RPC_URL", "ARC_RPC_URL_2", "ARC_RPC_URL_3"]) {
      const r = buildRpcUrls("mainnet", { [k]: "https://rpc.example.com" }, ARC_DEFAULTS);
      expect(r.errors.some((e) => e.includes(k))).toBe(true);
    }
  });

  test("mainnet: http / testnet 호스트 / 잘못된 URL 거부, 오류에 URL 값(토큰) 미포함", () => {
    const secret = "https://rpc.testnet.example.com/?_rpc_token=TOPSECRET";
    const r1 = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: "http://rpc.example.com" }, ARC_DEFAULTS);
    expect(r1.errors.some((e) => e.includes("https"))).toBe(true);
    const r2 = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: secret }, ARC_DEFAULTS);
    expect(r2.errors.some((e) => e.includes("testnet host"))).toBe(true);
    expect(r2.errors.join(" ")).not.toContain("TOPSECRET");
    expect(r2.urls.some((u) => u.includes("TOPSECRET"))).toBe(false);
    const r3 = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: "not a url" }, ARC_DEFAULTS);
    expect(r3.errors.length).toBe(1);
    expect(r3.errors[0]).not.toContain("not a url");
    const r4 = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: "ftp://rpc.example.com" }, ARC_DEFAULTS);
    expect(r4.errors.length).toBeGreaterThan(0);
  });

  test("testnet: 기존 변수와 fallback·프록시 동작 유지, viem testnet 기본값이 마지막", () => {
    const r = buildRpcUrls(
      "testnet",
      {
        ARC_RPC_URL: "https://custom.example.com",
        ARC_TESTNET_RPC_FALLBACK: "https://fallback.example.com",
        RPC_PROXY_BASE_URL: "https://proxy.example.com",
        RPC_PROXY_TOKEN: "tok",
        RPC_PROXY_CHAINS: "ARC-TESTNET",
      },
      TESTNET_DEFAULTS,
    );
    expect(r.errors).toEqual([]);
    expect(r.urls[0]).toBe("https://custom.example.com");
    expect(r.urls).toContain("https://fallback.example.com");
    expect(r.urls).toContain("https://proxy.example.com/api/rpc/arc-testnet?_rpc_token=tok");
    expect(r.urls.slice(-TESTNET_DEFAULTS.length)).toEqual([...TESTNET_DEFAULTS]);
  });

  test("testnet: 아무것도 없으면 viem testnet 기본값, mainnet 호스트는 거부", () => {
    expect(buildRpcUrls("testnet", {}, TESTNET_DEFAULTS).urls).toEqual([...TESTNET_DEFAULTS]);
    const r = buildRpcUrls("testnet", { ARC_RPC_URL: "https://rpc.mainnet.example.com" }, TESTNET_DEFAULTS);
    expect(r.errors.some((e) => e.includes("mainnet host"))).toBe(true);
  });

  test("중복 URL 은 한 번만", () => {
    const r = buildRpcUrls("mainnet", { ARC_MAINNET_RPC_URL: ARC_DEFAULTS[0] }, ARC_DEFAULTS);
    expect(r.urls.filter((u) => u === ARC_DEFAULTS[0]).length).toBe(1);
  });
});

// ─── chain.ts 스모크 (모듈 로드 시점 env → 서버 동작) ────────────────────────────

const ENV_KEYS = [
  "MOARC_NETWORK", "MOARC_CHAIN_ID", "MOARC_CONTRACT_ADDRESS", "MOARC_USDC_ADDRESS", "MOARC_CONTRACT_VERSION",
  "ARC_RPC_URL", "ARC_RPC_URL_2", "ARC_RPC_URL_3", "ARC_TESTNET_RPC_URL", "ARC_TESTNET_RPC_FALLBACK",
  "ARC_MAINNET_RPC_URL", "ARC_MAINNET_RPC_URL_2", "ARC_MAINNET_RPC_URL_3",
  "RPC_PROXY_BASE_URL", "RPC_PROXY_TOKEN", "RPC_PROXY_CHAINS",
];

async function withChain<T>(env: EnvLike, tag: string, fn: (m: typeof import("../lib/chain")) => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    const spec = `../lib/chain.js?netenv=${tag}`; // 쿼리로 모듈을 새로 평가 (다른 테스트의 chain.ts 인스턴스와 분리)
    const mod = (await import(spec)) as typeof import("../lib/chain");
    return await fn(mod);
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("chain.ts 스모크 — 잘못된 설정은 RPC 호출 없이 write API 차단", () => {
  test("testnet 기본: ACTIVE_CHAIN_ID=5042002, 컨트랙트 검증 통과", async () => {
    await withChain({ MOARC_CONTRACT_ADDRESS: TESTNET_V3 }, "tn", async (m) => {
      expect(m.ACTIVE_CHAIN_ID).toBe(5042002);
      expect(m.getMoarcContract()).toBe(TESTNET_V3);
    });
  });

  test("유효한 mainnet env: ACTIVE_CHAIN_ID=5042, 컨트랙트 반환", async () => {
    await withChain(mainnetEnv(), "mn-ok", async (m) => {
      expect(m.ACTIVE_CHAIN_ID).toBe(5042);
      expect(m.getMoarcContract()).toBe(MAINNET_CONTRACT);
    });
  });

  test("알 수 없는 MOARC_NETWORK: 체인 ID 0, verify 는 RPC 없이 실패, isNetworkReady=false", async () => {
    await withChain(mainnetEnv({ MOARC_NETWORK: "mainnet-typo" }), "bad-net", async (m) => {
      expect(m.ACTIVE_CHAIN_ID).toBe(0);
      const r = await m.verifyServerNetworkConfig();
      expect(r.ok).toBe(false);
      expect(r.chainId).toBeUndefined(); // RPC 를 호출하지 않았음
      expect(r.errors.join(" ")).toContain("MOARC_NETWORK");
      expect(m.isNetworkReady().ready).toBe(false);
      expect(() => m.getMoarcContract()).toThrow();
    });
  });

  test("MOARC_CHAIN_ID='5042abc' (parseInt 접미사): 체인 ID 0, verify 실패", async () => {
    await withChain(mainnetEnv({ MOARC_CHAIN_ID: "5042abc" }), "bad-chain", async (m) => {
      expect(m.ACTIVE_CHAIN_ID).toBe(0);
      const r = await m.verifyServerNetworkConfig();
      expect(r.ok).toBe(false);
      expect(r.chainId).toBeUndefined();
    });
  });

  test("mainnet + testnet 컨트랙트 주소: getMoarcContract 거부, verify 실패(RPC 없음)", async () => {
    await withChain(mainnetEnv({ MOARC_CONTRACT_ADDRESS: TESTNET_V3 }), "mn-testnet-contract", async (m) => {
      expect(() => m.getMoarcContract()).toThrow();
      const r = await m.verifyServerNetworkConfig();
      expect(r.ok).toBe(false);
      expect(r.chainId).toBeUndefined();
      expect(r.errors.join(" ")).toMatch(/testnet/i);
    });
  });

  test("mainnet + 비표준 USDC / 0 주소 컨트랙트 / 범용 RPC 변수: 모두 verify 실패(RPC 없음)", async () => {
    const cases: EnvLike[] = [
      mainnetEnv({ MOARC_USDC_ADDRESS: "0x3600000000000000000000000000000000000001" }),
      mainnetEnv({ MOARC_CONTRACT_ADDRESS: ZERO_ADDRESS }),
      mainnetEnv({ ARC_RPC_URL: "https://rpc.example.com" }),
      mainnetEnv({ ARC_MAINNET_RPC_URL: "http://insecure.example.com" }),
      mainnetEnv({ MOARC_CONTRACT_VERSION: "MoaArc-2.0" }),
    ];
    let i = 0;
    for (const env of cases) {
      await withChain(env, `mn-bad-${i++}`, async (m) => {
        const r = await m.verifyServerNetworkConfig();
        expect(r.ok).toBe(false);
        expect(r.chainId).toBeUndefined();
        expect(m.isNetworkReady().ready).toBe(false);
      });
    }
  });

  test("RPC 가 다른 체인 ID 를 반환하면 ok=false (write API 503) — 로컬 loopback 가짜 RPC", async () => {
    // 가짜 RPC: 모든 메서드에 성공 응답, eth_chainId 만 mainnet(5042)을 반환
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id: number; method: string };
        const result = body.method === "eth_chainId" ? "0x13b2" : body.method === "eth_getCode" ? "0x60" : "0x";
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    try {
      await withChain(
        { MOARC_CONTRACT_ADDRESS: TESTNET_V3, ARC_TESTNET_RPC_URL: `http://127.0.0.1:${server.port}` },
        "rpc-mismatch",
        async (m) => {
          const r = await m.verifyServerNetworkConfig();
          expect(r.ok).toBe(false);
          expect(r.chainId).toBe(5042);
          expect(r.errors.join(" ")).toContain("5042");
          expect(m.isNetworkReady().ready).toBe(false);
        },
      );
    } finally {
      await server.stop(true);
    }
  });
});
