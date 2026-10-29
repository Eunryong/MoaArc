/**
 * networkConfig.ts — 프런트엔드 공통 네트워크/컨트랙트 설정
 *
 * 환경변수 (VITE_* = 빌드타임 노출 OK, 공개값만):
 *   VITE_NETWORK           "testnet" | "mainnet"  (기본: "testnet"; 다른 값은 오류)
 *   VITE_CONTRACT_ADDRESS  배포된 MoaArcTreasury 주소. mainnet이면 필수.
 *   VITE_USDC_ADDRESS      USDC ERC-20 주소. mainnet이면 필수.
 *   VITE_CHAIN_ID          체인 ID 정수 문자열. 설정 시 공식 체인 id와 일치해야 함.
 *   VITE_CONTRACT_VERSION  기대하는 VERSION() 반환값 (기본: "MoaArc-3.0")
 *
 * 검증 규칙:
 *  - VITE_NETWORK가 "testnet" | "mainnet" 이외이면 CONFIG_VALID=false (silent fallback 금지).
 *  - VITE_CHAIN_ID가 설정됐다면 완전한 정수여야 하고 해당 네트워크의 공식 체인 id와 정확히 일치해야 함.
 *  - 주소는 형식 + 0x0…0(zero sentinel) 차단 + 소문자 정규화.
 *  - mainnet: VITE_CONTRACT_ADDRESS, VITE_USDC_ADDRESS 필수. 미설정/0주소/형식오류 → CONFIG_VALID=false.
 *  - testnet override: 주소 설정 시 검증 적용. 형식 오류 → CONFIG_VALID=false (조용히 default로 바꾸지 않음).
 *  - mainnet contractAddress/usdcAddress에는 테스트넷 주소를 절대 넣지 않음.
 *    null인 경우 NETWORK_CONFIG 내 sentinel("0x0") 대신 null을 직접 사용하고 write 호출 시 차단.
 */

import { arc, arcTestnet } from "viem/chains";

// ─── 퍼블릭 상수 ─────────────────────────────────────────────────────────────
export const ARC_TESTNET_CHAIN_ID = arcTestnet.id; // 5042002
export const ARC_MAINNET_CHAIN_ID = arc.id;         // 5042

// 테스트넷 배포 상수 (코드에 고정 — testnet 전용)
const TESTNET_CONTRACT = "0xf7a733fb2084b31591a0fbacded683efbe5b6728" as const;
const TESTNET_USDC     = "0x3600000000000000000000000000000000000000" as const;

// 영(zero) 주소 sentinel — 유효하지 않은 주소 표시용 (실제 컨트랙트 호출 차단)
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

// ─── 수집된 설정 오류 목록 (CONFIG_VALID=false 사유 디버깅용) ───────────────
const _configErrors: string[] = [];

// ─── 빌드타임 환경변수 ────────────────────────────────────────────────────────
const rawNetwork  = import.meta.env.VITE_NETWORK as string | undefined;
const rawContract = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
const rawUsdc     = import.meta.env.VITE_USDC_ADDRESS     as string | undefined;
const rawChainId  = import.meta.env.VITE_CHAIN_ID         as string | undefined;

// ─── VITE_NETWORK 검증 ───────────────────────────────────────────────────────
// "testnet" | "mainnet" 이외의 값은 명시적 차단 (오타/잘못된 환경 감지)
let IS_MAINNET: boolean;
if (!rawNetwork || rawNetwork === "testnet") {
  IS_MAINNET = false;
} else if (rawNetwork === "mainnet") {
  IS_MAINNET = true;
} else {
  _configErrors.push(
    `VITE_NETWORK="${rawNetwork}" is invalid — must be "testnet" or "mainnet".`
  );
  IS_MAINNET = false; // 오류 상태에서의 기술적 기본값 (CONFIG_VALID=false로 차단됨)
}

const officialChainId: number = IS_MAINNET ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID;

// ─── VITE_CHAIN_ID 검증 ──────────────────────────────────────────────────────
// mainnet: VITE_CHAIN_ID 필수 — 누락이면 CONFIG_VALID=false.
// testnet: 선택 — 설정된 경우에만 검증.
// 공통: 설정 시 완전한 정수여야 하고 해당 네트워크의 공식 체인 id와 정확히 일치해야 함.
if (IS_MAINNET && (rawChainId === undefined || rawChainId.trim() === "")) {
  _configErrors.push(
    `VITE_CHAIN_ID is required for mainnet but not set.`
  );
} else if (rawChainId !== undefined && rawChainId.trim() !== "") {
  const parsed = Number(rawChainId.trim());
  if (!Number.isInteger(parsed) || String(parsed) !== rawChainId.trim()) {
    _configErrors.push(
      `VITE_CHAIN_ID="${rawChainId}" is not a valid integer.`
    );
  } else if (parsed !== officialChainId) {
    _configErrors.push(
      `VITE_CHAIN_ID=${parsed} does not match the official chain id ` +
      `for ${IS_MAINNET ? "mainnet" : "testnet"} (${officialChainId}).`
    );
  }
}

// ─── 주소 검증 헬퍼 ──────────────────────────────────────────────────────────
function validateAddr(
  v: string | undefined,
  name: string,
  required: boolean,
): `0x${string}` | null {
  if (!v || v.trim() === "") {
    if (required) {
      _configErrors.push(`${name} is required for ${IS_MAINNET ? "mainnet" : "testnet"} but not set.`);
    }
    return null;
  }
  const trimmed = v.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    _configErrors.push(`${name}="${trimmed}" is not a valid 0x address (40 hex chars required).`);
    return null;
  }
  const lower = trimmed.toLowerCase() as `0x${string}`;
  if (lower === ZERO_ADDR) {
    _configErrors.push(`${name}="${trimmed}" is the zero address — not a valid contract address.`);
    return null;
  }
  return lower;
}

// ─── 주소 결정 ───────────────────────────────────────────────────────────────
// mainnet: 필수 — 미설정/형식오류/0주소 모두 CONFIG_VALID=false
// testnet override: 설정 시 검증 적용 — 형식오류이면 CONFIG_VALID=false (default로 조용히 바꾸지 않음)
let contractAddr: `0x${string}` | null;
let usdcAddr:     `0x${string}` | null;

if (IS_MAINNET) {
  contractAddr = validateAddr(rawContract, "VITE_CONTRACT_ADDRESS", true);
  usdcAddr     = validateAddr(rawUsdc,     "VITE_USDC_ADDRESS",     true);
} else {
  // testnet: 설정 없으면 고정 기본값, 설정 있으면 검증 후 사용 (오류 시 null)
  if (rawContract && rawContract.trim() !== "") {
    contractAddr = validateAddr(rawContract, "VITE_CONTRACT_ADDRESS", false);
    // validateAddr이 null을 반환했으면 이미 _configErrors에 추가됨 — testnet default로 대체 금지
  } else {
    contractAddr = TESTNET_CONTRACT;
  }
  if (rawUsdc && rawUsdc.trim() !== "") {
    usdcAddr = validateAddr(rawUsdc, "VITE_USDC_ADDRESS", false);
  } else {
    usdcAddr = TESTNET_USDC;
  }
}

// ─── CONFIG_VALID ─────────────────────────────────────────────────────────────
// 단 하나의 오류라도 있으면 모든 write를 차단
export const CONFIG_VALID: boolean = _configErrors.length === 0
  && contractAddr !== null
  && usdcAddr !== null;

// 개발 환경에서 오류 로깅
if (_configErrors.length > 0) {
  for (const e of _configErrors) {
    console.error(`[networkConfig] ${e}`);
  }
}

// ─── contractVersion ─────────────────────────────────────────────────────────
const EXPECTED_VERSION =
  (import.meta.env.VITE_CONTRACT_VERSION as string | undefined) ?? "MoaArc-3.0";

/** 현재 활성 네트워크 설정 */
export const NETWORK_CONFIG = {
  isMainnet: IS_MAINNET,
  chainId: officialChainId,
  /**
   * 배포된 MoaArcTreasury 컨트랙트 주소 (소문자).
   * mainnet이고 미설정이면 ZERO_ADDR sentinel — CONFIG_VALID=false가 write를 차단.
   */
  contractAddress: (contractAddr ?? ZERO_ADDR),
  /**
   * USDC ERC-20 주소 (소문자).
   * 미설정이면 ZERO_ADDR sentinel — CONFIG_VALID=false가 write를 차단.
   */
  usdcAddress: (usdcAddr ?? ZERO_ADDR),
  contractVersion: EXPECTED_VERSION,
  explorerBase: IS_MAINNET
    ? arc.blockExplorers.default.url
    : arcTestnet.blockExplorers.default.url,
  viemChain: IS_MAINNET ? arc : arcTestnet,
  rpcUrls: IS_MAINNET
    ? arc.rpcUrls.default.http    as readonly string[]
    : arcTestnet.rpcUrls.default.http as readonly string[],
  /** 설정 오류 목록 (빈 배열이면 정상) */
  configErrors: _configErrors as readonly string[],
} as const;

export type NetworkConfig = typeof NETWORK_CONFIG;

/** 트랜잭션 탐색기 URL */
export function txExplorerUrl(hash: string): string {
  return `${NETWORK_CONFIG.explorerBase}/tx/${hash}`;
}

/** 주소 탐색기 URL */
export function addressExplorerUrl(addr: string): string {
  return `${NETWORK_CONFIG.explorerBase}/address/${addr}`;
}
