/**
 * networkConfig.ts — 프런트엔드 공통 네트워크/컨트랙트 설정
 *
 * 환경변수 (VITE_* = 빌드타임 노출, 공개값만):
 *   VITE_NETWORK           "testnet" | "mainnet"  (미설정: testnet; 다른 값은 오류)
 *   VITE_CHAIN_ID          mainnet 필수 (5042). testnet 은 선택 (5042002). 10진 정수만 허용.
 *   VITE_CONTRACT_ADDRESS  배포된 MoaArcTreasury 주소. mainnet 필수 (테스트넷 배포 주소 거부).
 *   VITE_USDC_ADDRESS      mainnet 필수, 정확히 0x3600…0000.
 *   VITE_CONTRACT_VERSION  기대 VERSION() (기본·mainnet 고정: "MoaArc-3.0")
 *
 * 모든 검증은 networkConfigCore.ts 의 순수 함수(evaluateFrontendNetwork)가 수행합니다.
 * 오류가 하나라도 있으면 CONFIG_VALID=false 이고 contractAddress/usdcAddress 는 ZERO sentinel 이 되어
 * 모든 write 훅이 차단됩니다. 테스트넷 값으로 조용히 대체하지 않습니다.
 */

import { arc, arcTestnet } from "viem/chains";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID,
  ZERO_ADDRESS,
  evaluateFrontendNetwork,
} from "./networkConfigCore";

export { ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID };

const resolved = evaluateFrontendNetwork({
  VITE_NETWORK: import.meta.env.VITE_NETWORK as string | undefined,
  VITE_CONTRACT_ADDRESS: import.meta.env.VITE_CONTRACT_ADDRESS as string | undefined,
  VITE_USDC_ADDRESS: import.meta.env.VITE_USDC_ADDRESS as string | undefined,
  VITE_CHAIN_ID: import.meta.env.VITE_CHAIN_ID as string | undefined,
  VITE_CONTRACT_VERSION: import.meta.env.VITE_CONTRACT_VERSION as string | undefined,
});

// 개발 환경에서 오류 로깅 (값 자체는 출력하지 않아도 되는 공개 설정이지만 최소화)
for (const e of resolved.errors) {
  console.error(`[networkConfig] ${e}`);
}

/** 단 하나의 오류라도 있으면 false — 모든 write 가 차단됩니다. */
export const CONFIG_VALID: boolean = resolved.valid;

const IS_MAINNET = resolved.isMainnet;

/** 현재 활성 네트워크 설정 */
export const NETWORK_CONFIG = {
  /** "mainnet" | "testnet" | null (알 수 없는 VITE_NETWORK) */
  network: resolved.network,
  isMainnet: IS_MAINNET,
  chainId: resolved.chainId,
  /** 소문자 주소. 설정이 유효하지 않으면 ZERO sentinel (CONFIG_VALID=false 가 write 차단) */
  contractAddress: (resolved.contractAddress ?? ZERO_ADDRESS) as `0x${string}`,
  usdcAddress: (resolved.usdcAddress ?? ZERO_ADDRESS) as `0x${string}`,
  contractVersion: resolved.contractVersion,
  explorerBase: IS_MAINNET
    ? arc.blockExplorers.default.url
    : arcTestnet.blockExplorers.default.url,
  viemChain: IS_MAINNET ? arc : arcTestnet,
  rpcUrls: IS_MAINNET
    ? (arc.rpcUrls.default.http as readonly string[])
    : (arcTestnet.rpcUrls.default.http as readonly string[]),
  /** 설정 오류 목록 (빈 배열이면 정상) */
  configErrors: resolved.errors as readonly string[],
} as const;

export type NetworkConfig = typeof NETWORK_CONFIG;

/** 사람이 읽는 네트워크 표시 이름 */
export const NETWORK_LABEL: string = IS_MAINNET
  ? `Arc Mainnet (${ARC_MAINNET_CHAIN_ID})`
  : `Arc Testnet (${ARC_TESTNET_CHAIN_ID})`;

/** 트랜잭션 탐색기 URL */
export function txExplorerUrl(hash: string): string {
  return `${NETWORK_CONFIG.explorerBase}/tx/${hash}`;
}

/** 주소 탐색기 URL */
export function addressExplorerUrl(addr: string): string {
  return `${NETWORK_CONFIG.explorerBase}/address/${addr}`;
}
