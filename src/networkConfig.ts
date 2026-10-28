/**
 * networkConfig.ts — 프런트엔드 공통 네트워크/컨트랙트 설정
 *
 * 환경변수 (VITE_* = 빌드타임 노출 OK, 공개값만):
 *   VITE_NETWORK           "testnet" | "mainnet"  (기본: "testnet")
 *   VITE_CONTRACT_ADDRESS  배포된 MoaArcTreasury 주소. mainnet이면 필수.
 *   VITE_USDC_ADDRESS      USDC ERC-20 주소. mainnet이면 필수.
 *   VITE_CHAIN_ID          체인 ID 정수 문자열. mainnet이면 필수.
 *
 * 규칙:
 *  - mainnet이고 VITE_CONTRACT_ADDRESS 가 없으면 CONFIG_VALID=false → 모든 write 차단.
 *  - 테스트넷 주소는 mainnet 주소로 절대 fallback 금지.
 *  - viemChain: testnet=arcTestnet, mainnet=arc (viem/chains에서 둘 다 export됨).
 */

import { arc, arcTestnet } from "viem/chains";

// ─── 퍼블릭 상수 ─────────────────────────────────────────────────────────────
export const ARC_TESTNET_CHAIN_ID = arcTestnet.id;  // 5042002
export const ARC_MAINNET_CHAIN_ID = arc.id;          // 5042

// 테스트넷 배포 상수 (코드에 고정, 환경변수로 override 가능)
const TESTNET_CONTRACT  = "0xf7a733fb2084b31591a0fbacded683efbe5b6728" as const;
const TESTNET_USDC      = "0x3600000000000000000000000000000000000000" as const;

// Arc mainnet USDC — 사용자가 VITE_USDC_ADDRESS로 설정해야 함
// (주소 없이 mainnet 배포 불가 — CONFIG_VALID=false가 write를 차단)

// ─── 빌드타임 환경변수 ────────────────────────────────────────────────────────
const VITE_NETWORK   = (import.meta.env.VITE_NETWORK as string | undefined) ?? "testnet";
const IS_MAINNET     = VITE_NETWORK === "mainnet";

const rawContract = import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined;
const rawUsdc     = import.meta.env.VITE_USDC_ADDRESS    as string | undefined;
const rawChainId  = import.meta.env.VITE_CHAIN_ID        as string | undefined;

function validateAddr(
  v: string | undefined,
  name: string,
  required: boolean,
): `0x${string}` | null {
  if (!v) {
    if (required) console.error(`[networkConfig] ${name} is required for mainnet but not set.`);
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.error(`[networkConfig] ${name}="${v}" is not a valid 0x address.`);
    return null;
  }
  return v.toLowerCase() as `0x${string}`;
}

const contractAddr: `0x${string}` | null = IS_MAINNET
  ? validateAddr(rawContract, "VITE_CONTRACT_ADDRESS", true)
  : (validateAddr(rawContract, "VITE_CONTRACT_ADDRESS", false) ?? TESTNET_CONTRACT);

const usdcAddr: `0x${string}` | null = IS_MAINNET
  ? validateAddr(rawUsdc, "VITE_USDC_ADDRESS", true)
  : (validateAddr(rawUsdc, "VITE_USDC_ADDRESS", false) ?? TESTNET_USDC);

const chainId: number = IS_MAINNET
  ? rawChainId
    ? parseInt(rawChainId, 10)
    : ((): number => {
        console.error("[networkConfig] VITE_CHAIN_ID is required for mainnet.");
        return ARC_MAINNET_CHAIN_ID;
      })()
  : ARC_TESTNET_CHAIN_ID;

/** mainnet 설정이 불완전하면 모든 write를 차단 */
export const CONFIG_VALID: boolean = IS_MAINNET
  ? contractAddr !== null && usdcAddr !== null
  : true;

/** 현재 활성 네트워크 설정 */
export const NETWORK_CONFIG = {
  isMainnet: IS_MAINNET,
  chainId,
  /** 배포된 MoaArcTreasury 컨트랙트 주소 (소문자) */
  contractAddress: (contractAddr ?? TESTNET_CONTRACT) as `0x${string}`,
  /** USDC ERC-20 주소 (소문자) */
  usdcAddress: (usdcAddr ?? TESTNET_USDC) as `0x${string}`,
  explorerBase: IS_MAINNET
    ? arc.blockExplorers.default.url          // "https://explorer.arc.io"
    : arcTestnet.blockExplorers.default.url,  // "https://explorer.testnet.arc.io"
  /** wagmi/viem chain 객체 */
  viemChain: IS_MAINNET ? arc : arcTestnet,
  /** RPC URL 목록 (첫 번째가 primary) */
  rpcUrls: IS_MAINNET
    ? arc.rpcUrls.default.http as readonly string[]
    : arcTestnet.rpcUrls.default.http as readonly string[],
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
