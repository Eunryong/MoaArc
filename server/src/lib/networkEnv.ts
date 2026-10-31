/**
 * server/src/lib/networkEnv.ts — 서버 네트워크 환경변수 검증 (순수 함수, import 없음)
 *
 * chain.ts 가 process.env 로 이 함수들을 호출합니다. 원칙은 fail-closed:
 *  - MOARC_NETWORK 는 정확히 "testnet" | "mainnet" 만 허용 (대소문자·앞뒤 공백 불허, 프런트 VITE_NETWORK 와 동일).
 *    미설정 또는 공백뿐인 값만 기존 기본값 testnet 으로 취급. 그 외 값은 오류.
 *  - MOARC_CHAIN_ID 는 10진 정수 문자열만 (parseInt 식 접미사 허용 없음). mainnet 필수, 공식 id 와 정확히 일치.
 *  - mainnet 에서는 컨트랙트(테스트넷 배포 주소 거부)·USDC(정확히 0x3600…0000)·VERSION(MoaArc-3.0) 필수/고정.
 *  - RPC 는 네트워크별 변수만 사용. mainnet 에서 테스트넷 fallback / 범용 ARC_RPC_URL* 는 사용하지 않음.
 * 오류 메시지는 변수 이름만 포함하고 값(RPC URL·토큰)은 포함하지 않습니다.
 */

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;
export const CANONICAL_USDC = "0x3600000000000000000000000000000000000000";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const EXPECTED_CONTRACT_VERSION = "MoaArc-3.0";

/** src/networkConfigCore.ts 의 KNOWN_TESTNET_CONTRACTS 와 동일해야 합니다 (테스트가 검증). */
export const KNOWN_TESTNET_CONTRACTS: readonly string[] = [
  "0x0e540064015628b03ec62b44d94721b1b50e5d92",
  "0x3bc08cdabcf702e01b458923a946cd664e438c3e",
  "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3",
  "0xf7a733fb2084b31591a0fbacded683efbe5b6728",
];

export type ServerNetworkName = "testnet" | "mainnet";
export type EnvLike = Record<string, string | undefined>;

export interface ServerNetworkResolution {
  /** 알 수 없는 MOARC_NETWORK 이면 null */
  network: ServerNetworkName | null;
  /** 검증을 통과한 체인 ID. 네트워크나 MOARC_CHAIN_ID 가 잘못되면 null */
  chainId: number | null;
  /** 선택된 네트워크의 공식 체인 ID (network=null 이면 null) */
  officialChainId: number | null;
  contractAddress: string | null;
  usdcAddress: string | null;
  contractVersion: string;
  errors: string[];
}

const unset = (v: string | undefined): boolean => v === undefined || v.trim() === "";

export function resolveServerNetwork(env: EnvLike): ServerNetworkResolution {
  const errors: string[] = [];

  // ── 네트워크 이름 ──
  let network: ServerNetworkName | null;
  const rawNetwork = env.MOARC_NETWORK;
  if (unset(rawNetwork)) {
    network = "testnet"; // 미설정(또는 공백뿐) = 기존 기본값 (프런트 evaluateFrontendNetwork 와 동일)
  } else if (rawNetwork === "testnet" || rawNetwork === "mainnet") {
    network = rawNetwork; // 정확히 일치할 때만 (예: " Mainnet ", "MAINNET", "mainnet " 는 거부)
  } else {
    network = null;
    errors.push('MOARC_NETWORK is invalid — must be exactly "testnet" or "mainnet" (case-sensitive, no surrounding spaces).');
  }
  const officialChainId =
    network === "mainnet" ? ARC_MAINNET_CHAIN_ID : network === "testnet" ? ARC_TESTNET_CHAIN_ID : null;

  // ── 체인 ID ──
  let chainId: number | null = null;
  if (unset(env.MOARC_CHAIN_ID)) {
    if (network === "mainnet") errors.push("MOARC_CHAIN_ID is required for mainnet but not set.");
    else if (network === "testnet") chainId = ARC_TESTNET_CHAIN_ID;
  } else {
    const t = (env.MOARC_CHAIN_ID as string).trim();
    if (!/^[1-9][0-9]*$/.test(t) || !Number.isSafeInteger(Number(t))) {
      errors.push("MOARC_CHAIN_ID is not a valid integer.");
    } else if (officialChainId !== null) {
      if (Number(t) !== officialChainId) {
        errors.push(`MOARC_CHAIN_ID=${t} does not match the official ${network} chain id (${officialChainId}).`);
      } else {
        chainId = Number(t);
      }
    }
  }

  // ── 주소 ──
  const checkAddr = (v: string | undefined, name: string, required: boolean): string | null => {
    if (unset(v)) {
      if (required) errors.push(`${name} is required but not set.`);
      return null;
    }
    const t = (v as string).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
      errors.push(`${name} is not a valid 0x address (40 hex chars required).`);
      return null;
    }
    const lower = t.toLowerCase();
    if (lower === ZERO_ADDRESS) {
      errors.push(`${name} is the zero address.`);
      return null;
    }
    return lower;
  };

  // 컨트랙트는 두 네트워크 모두 필수 (testnet 도 기존처럼 미설정이면 write 불가)
  let contractAddress = checkAddr(env.MOARC_CONTRACT_ADDRESS, "MOARC_CONTRACT_ADDRESS", true);
  let usdcAddress: string | null;
  if (network === "mainnet") {
    usdcAddress = checkAddr(env.MOARC_USDC_ADDRESS, "MOARC_USDC_ADDRESS", true);
    if (contractAddress && KNOWN_TESTNET_CONTRACTS.includes(contractAddress)) {
      errors.push("MOARC_CONTRACT_ADDRESS is a known Arc Testnet deployment — not allowed on mainnet.");
      contractAddress = null;
    }
    if (usdcAddress && usdcAddress !== CANONICAL_USDC) {
      errors.push(`MOARC_USDC_ADDRESS must be exactly ${CANONICAL_USDC} on mainnet.`);
      usdcAddress = null;
    }
  } else {
    usdcAddress = unset(env.MOARC_USDC_ADDRESS)
      ? network === "testnet" ? CANONICAL_USDC : null
      : checkAddr(env.MOARC_USDC_ADDRESS, "MOARC_USDC_ADDRESS", false);
  }

  // 알 수 없는 네트워크에서는 어떤 주소도 유효하다고 보지 않음 (fail-closed)
  if (network === null) {
    contractAddress = null;
    usdcAddress = null;
  }

  // ── 컨트랙트 버전 ──
  let contractVersion = unset(env.MOARC_CONTRACT_VERSION)
    ? EXPECTED_CONTRACT_VERSION
    : (env.MOARC_CONTRACT_VERSION as string).trim();
  if (network === "mainnet" && contractVersion !== EXPECTED_CONTRACT_VERSION) {
    errors.push(`MOARC_CONTRACT_VERSION must be "${EXPECTED_CONTRACT_VERSION}" on mainnet.`);
    contractVersion = EXPECTED_CONTRACT_VERSION;
  }

  return { network, chainId, officialChainId, contractAddress, usdcAddress, contractVersion, errors };
}

// ─── RPC URL 구성 ─────────────────────────────────────────────────────────────

export interface RpcUrlResult {
  urls: string[];
  errors: string[];
}

function checkRpcUrl(raw: string, varName: string, network: ServerNetworkName, errors: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    errors.push(`${varName} is not a valid URL.`);
    return null;
  }
  if (network === "mainnet" && u.protocol !== "https:") {
    errors.push(`${varName} must use https on mainnet.`);
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    errors.push(`${varName} must be an http(s) URL.`);
    return null;
  }
  const host = u.hostname.toLowerCase();
  // 선택하지 않은 네트워크로 보이는 호스트는 거부 (대표적인 설정 실수 차단; 최종 방어선은 eth_chainId 검증)
  if (network === "mainnet" && host.includes("testnet")) {
    errors.push(`${varName} points to a testnet host — not allowed on mainnet.`);
    return null;
  }
  if (network === "testnet" && host.includes("mainnet")) {
    errors.push(`${varName} points to a mainnet host — not allowed on testnet.`);
    return null;
  }
  return raw.trim();
}

/**
 * 선택된 네트워크의 RPC 목록을 만듭니다.
 *  - mainnet: ARC_MAINNET_RPC_URL(_2,_3) + viem 공식 mainnet 기본값. 테스트넷 fallback·범용 ARC_RPC_URL*·
 *             Arc Studio 프록시는 사용하지 않으며, 범용 ARC_RPC_URL* 가 설정돼 있으면 오류.
 *  - testnet: ARC_TESTNET_RPC_URL(_2,_3), (기존 호환) ARC_RPC_URL(_2,_3), ARC_TESTNET_RPC_FALLBACK,
 *             Arc Studio 프록시(기존 동작 유지) + viem 공식 testnet 기본값.
 * chainDefaults 는 선택된 체인의 viem 기본 RPC 입니다.
 */
export function buildRpcUrls(
  network: ServerNetworkName,
  env: EnvLike,
  chainDefaults: readonly string[],
): RpcUrlResult {
  const errors: string[] = [];
  const urls: string[] = [];
  const add = (raw: string | undefined, name: string) => {
    if (unset(raw)) return;
    const ok = checkRpcUrl(raw as string, name, network, errors);
    if (ok && !urls.includes(ok)) urls.push(ok);
  };

  if (network === "mainnet") {
    for (const legacy of ["ARC_RPC_URL", "ARC_RPC_URL_2", "ARC_RPC_URL_3"]) {
      if (!unset(env[legacy])) {
        errors.push(`${legacy} is network-agnostic and not allowed on mainnet — use ARC_MAINNET_RPC_URL.`);
      }
    }
    add(env.ARC_MAINNET_RPC_URL, "ARC_MAINNET_RPC_URL");
    add(env.ARC_MAINNET_RPC_URL_2, "ARC_MAINNET_RPC_URL_2");
    add(env.ARC_MAINNET_RPC_URL_3, "ARC_MAINNET_RPC_URL_3");
    // ARC_TESTNET_RPC_FALLBACK 와 RPC_PROXY_* 는 mainnet 에서 의도적으로 무시
  } else {
    add(env.ARC_TESTNET_RPC_URL, "ARC_TESTNET_RPC_URL");
    add(env.ARC_TESTNET_RPC_URL_2, "ARC_TESTNET_RPC_URL_2");
    add(env.ARC_TESTNET_RPC_URL_3, "ARC_TESTNET_RPC_URL_3");
    add(env.ARC_RPC_URL, "ARC_RPC_URL");
    add(env.ARC_RPC_URL_2, "ARC_RPC_URL_2");
    add(env.ARC_RPC_URL_3, "ARC_RPC_URL_3");
    add(env.ARC_TESTNET_RPC_FALLBACK, "ARC_TESTNET_RPC_FALLBACK");
    const base = env.RPC_PROXY_BASE_URL;
    const token = env.RPC_PROXY_TOKEN;
    const chains = env.RPC_PROXY_CHAINS ?? "";
    if (base && token && chains.includes("ARC-TESTNET")) {
      urls.push(`${base}/api/rpc/arc-testnet?_rpc_token=${token}`);
    }
  }

  // 선택된 체인의 viem 공식 기본값을 마지막 fallback 으로 (다른 네트워크 값은 절대 추가하지 않음)
  for (const d of chainDefaults) {
    if (!urls.includes(d)) urls.push(d);
  }
  return { urls, errors };
}
