/**
 * networkConfigCore.ts — 프런트엔드 네트워크 설정 검증 (순수 함수, import.meta / viem / React 의존 없음)
 *
 * networkConfig.ts 가 빌드타임 env 로 이 함수를 호출합니다. 순수 함수이므로 mainnet / testnet /
 * 잘못된 조합을 모두 단위 테스트로 검증할 수 있습니다.
 *
 * 원칙: fail-closed.
 *  - 알 수 없는 네트워크 이름, 잘못된 체인 ID, 형식 오류·0 주소는 모두 errors 에 기록되고 valid=false.
 *  - 설정이 하나라도 잘못되면 contractAddress / usdcAddress 는 null (testnet 기본값으로 조용히 대체 금지).
 *  - mainnet 에서는 테스트넷 컨트랙트(과거 배포 포함)와 비표준 USDC 주소를 거부.
 */

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_MAINNET_CHAIN_ID = 5042;

/** Arc 공식 USDC (native-gas ERC-20 인터페이스). 이 앱은 mainnet 에서 이 주소만 허용합니다. */
export const CANONICAL_USDC = "0x3600000000000000000000000000000000000000" as const;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** 앱이 기대하는 컨트랙트 VERSION() 문자열 (mainnet 에서는 변경 불가) */
export const EXPECTED_CONTRACT_VERSION = "MoaArc-3.0";

/** 현재 testnet 배포 (v3) */
export const TESTNET_CONTRACT = "0xf7a733fb2084b31591a0fbacded683efbe5b6728" as const;

/**
 * 알려진 모든 테스트넷 MoaArc 계열 배포 주소 (AGENTS.md 기록 기준).
 * mainnet 모드에서 이 중 어떤 것도 컨트랙트 주소로 허용하지 않습니다.
 * server/src/lib/networkEnv.ts 의 목록과 동일해야 합니다 (테스트가 일치를 검증).
 */
export const KNOWN_TESTNET_CONTRACTS: readonly string[] = [
  "0x0e540064015628b03ec62b44d94721b1b50e5d92", // TripSharedTreasury V1
  "0x3bc08cdabcf702e01b458923a946cd664e438c3e", // TripSharedTreasuryV2
  "0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3", // MoaArcTreasury v2
  "0xf7a733fb2084b31591a0fbacded683efbe5b6728", // MoaArcTreasury v3
];

export type NetworkName = "testnet" | "mainnet";

export interface RawFrontendEnv {
  VITE_NETWORK?: string;
  VITE_CONTRACT_ADDRESS?: string;
  VITE_USDC_ADDRESS?: string;
  VITE_CHAIN_ID?: string;
  VITE_CONTRACT_VERSION?: string;
}

export interface FrontendNetworkResolution {
  /** 유효한 네트워크 이름. 알 수 없는 값이면 null */
  network: NetworkName | null;
  isMainnet: boolean;
  /** 선택된 네트워크의 공식 체인 ID (network=null 이면 testnet 값 — valid=false 로 write 차단) */
  chainId: number;
  /** 검증을 통과한 주소 (소문자). 설정에 오류가 있으면 null */
  contractAddress: `0x${string}` | null;
  usdcAddress: `0x${string}` | null;
  contractVersion: string;
  errors: string[];
  valid: boolean;
}

const unset = (v: string | undefined): boolean => v === undefined || v.trim() === "";

export function evaluateFrontendNetwork(env: RawFrontendEnv): FrontendNetworkResolution {
  const errors: string[] = [];

  // ── 네트워크 이름 (미설정 = testnet 기본값. 그 외에는 정확히 "testnet" | "mainnet") ──
  let network: NetworkName | null;
  const rawNetwork = env.VITE_NETWORK;
  if (unset(rawNetwork) || rawNetwork === "testnet") {
    network = "testnet";
  } else if (rawNetwork === "mainnet") {
    network = "mainnet";
  } else {
    network = null;
    errors.push(`VITE_NETWORK="${rawNetwork}" is invalid — must be "testnet" or "mainnet".`);
  }
  const isMainnet = network === "mainnet";
  const officialChainId = isMainnet ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID;
  const label = isMainnet ? "mainnet" : "testnet";

  // ── 체인 ID: 10진 정수 문자열만 (parseInt 식 접미사 허용 없음). mainnet 은 필수 ──
  const rawChainId = env.VITE_CHAIN_ID;
  if (unset(rawChainId)) {
    if (isMainnet) errors.push("VITE_CHAIN_ID is required for mainnet but not set.");
  } else {
    const trimmed = (rawChainId as string).trim();
    if (!/^[1-9][0-9]*$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
      errors.push(`VITE_CHAIN_ID="${trimmed}" is not a valid integer.`);
    } else if (network !== null && Number(trimmed) !== officialChainId) {
      errors.push(
        `VITE_CHAIN_ID=${trimmed} does not match the official chain id for ${label} (${officialChainId}).`,
      );
    }
  }

  // ── 주소 검증 ──
  const checkAddr = (v: string | undefined, name: string, required: boolean): `0x${string}` | null => {
    if (unset(v)) {
      if (required) errors.push(`${name} is required for ${label} but not set.`);
      return null;
    }
    const t = (v as string).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
      errors.push(`${name}="${t}" is not a valid 0x address (40 hex chars required).`);
      return null;
    }
    const lower = t.toLowerCase() as `0x${string}`;
    if (lower === ZERO_ADDRESS) {
      errors.push(`${name} is the zero address — not a valid address.`);
      return null;
    }
    return lower;
  };

  let contractAddress: `0x${string}` | null = null;
  let usdcAddress: `0x${string}` | null = null;

  if (network === "mainnet") {
    contractAddress = checkAddr(env.VITE_CONTRACT_ADDRESS, "VITE_CONTRACT_ADDRESS", true);
    usdcAddress = checkAddr(env.VITE_USDC_ADDRESS, "VITE_USDC_ADDRESS", true);
    if (contractAddress && KNOWN_TESTNET_CONTRACTS.includes(contractAddress)) {
      errors.push("VITE_CONTRACT_ADDRESS is a known Arc Testnet deployment — not allowed on mainnet.");
      contractAddress = null;
    }
    if (usdcAddress && usdcAddress !== CANONICAL_USDC) {
      errors.push(`VITE_USDC_ADDRESS must be exactly ${CANONICAL_USDC} on mainnet.`);
      usdcAddress = null;
    }
  } else if (network === "testnet") {
    // 설정이 있으면 검증하고, 형식 오류를 기본값으로 덮지 않음. 없을 때만 고정 기본값.
    contractAddress = unset(env.VITE_CONTRACT_ADDRESS)
      ? TESTNET_CONTRACT
      : checkAddr(env.VITE_CONTRACT_ADDRESS, "VITE_CONTRACT_ADDRESS", false);
    usdcAddress = unset(env.VITE_USDC_ADDRESS)
      ? CANONICAL_USDC
      : checkAddr(env.VITE_USDC_ADDRESS, "VITE_USDC_ADDRESS", false);
  }
  // network === null: 주소는 null 유지 — 테스트넷 값으로 대체하지 않음

  // ── 컨트랙트 버전: mainnet 은 정확히 MoaArc-3.0 ──
  let contractVersion = unset(env.VITE_CONTRACT_VERSION)
    ? EXPECTED_CONTRACT_VERSION
    : (env.VITE_CONTRACT_VERSION as string).trim();
  if (isMainnet && contractVersion !== EXPECTED_CONTRACT_VERSION) {
    errors.push(`VITE_CONTRACT_VERSION must be "${EXPECTED_CONTRACT_VERSION}" on mainnet.`);
    contractVersion = EXPECTED_CONTRACT_VERSION;
  }

  const valid = errors.length === 0 && network !== null && contractAddress !== null && usdcAddress !== null;
  return {
    network,
    isMainnet,
    chainId: officialChainId,
    contractAddress: valid ? contractAddress : null,
    usdcAddress: valid ? usdcAddress : null,
    contractVersion,
    errors,
    valid,
  };
}

// ─── 서버 /api/network 응답 ↔ 프런트 설정 비교 (지갑 서명 직전 / 화면 표시 공통) ────────────

export interface BackendNetworkStatusLike {
  status?: string;
  network?: string;
  chainId?: number;
  contractAddress?: string;
  usdcAddress?: string;
  version?: string;
}

export interface FrontendNetworkLike {
  network: NetworkName | null;
  chainId: number;
  contractAddress: string;
  usdcAddress: string;
  contractVersion: string;
}

/** 일치하면 null, 아니면 불일치 사유 코드. network 이름까지 비교합니다. */
export function backendNetworkMismatch(
  ns: BackendNetworkStatusLike | null | undefined,
  cfg: FrontendNetworkLike,
): string | null {
  if (!ns) return "backend_unavailable";
  if (ns.status !== "ok") return "backend_not_ok";
  if (ns.chainId === undefined || !ns.contractAddress || !ns.usdcAddress || !ns.version || !ns.network) {
    return "backend_fields_missing";
  }
  if (cfg.network === null || ns.network !== cfg.network) return "network_name";
  if (ns.chainId !== cfg.chainId) return "chain_id";
  if (ns.contractAddress.toLowerCase() !== cfg.contractAddress.toLowerCase()) return "contract_address";
  if (ns.usdcAddress.toLowerCase() !== cfg.usdcAddress.toLowerCase()) return "usdc_address";
  if (ns.version !== cfg.contractVersion) return "contract_version";
  return null;
}
