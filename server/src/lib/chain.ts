/**
 * server/src/lib/chain.ts — 온체인 검증 유틸리티
 *
 * 환경변수:
 *   MOARC_CONTRACT_ADDRESS   배포된 MoaArcTreasury 주소 (0x...)  [필수]
 *   MOARC_CHAIN_ID           체인 ID 정수 문자열 (기본: 5042002 Arc Testnet)
 *   MOARC_USDC_ADDRESS       USDC ERC-20 주소 (기본: 테스트넷 주소)
 *   MOARC_NETWORK            "testnet" | "mainnet" (기본: "testnet")
 *   ARC_TESTNET_RPC_FALLBACK 공개 RPC URL
 *   ARC_RPC_URL              추가 RPC URL (우선순위 높음)
 *   RPC_PROXY_BASE_URL, RPC_PROXY_TOKEN, RPC_PROXY_CHAINS  Arc Studio RPC 프록시
 *
 * 규칙:
 *  - MOARC_NETWORK=mainnet 이면 mainnet chain 객체 사용.
 *  - mainnet 이면 Arc RPC 5042번 응답을 검증 (mismatch → write 차단).
 *  - 테스트넷 주소를 mainnet fallback 으로 절대 사용 금지.
 */

import {
  createPublicClient,
  http,
  fallback,
  parseAbiItem,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
} from "viem";
import { arc, arcTestnet } from "viem/chains";

// ─── 환경변수 파싱 ────────────────────────────────────────────────────────────

const NETWORK = (process.env.MOARC_NETWORK ?? "testnet").toLowerCase();
const IS_MAINNET = NETWORK === "mainnet";

/** 지원 체인 ID */
export const ARC_TESTNET_CHAIN_ID = arcTestnet.id;  // 5042002
export const ARC_MAINNET_CHAIN_ID = arc.id;          // 5042

export const ACTIVE_CHAIN_ID: number = IS_MAINNET
  ? (process.env.MOARC_CHAIN_ID ? parseInt(process.env.MOARC_CHAIN_ID, 10) : ARC_MAINNET_CHAIN_ID)
  : (process.env.MOARC_CHAIN_ID ? parseInt(process.env.MOARC_CHAIN_ID, 10) : ARC_TESTNET_CHAIN_ID);

const ACTIVE_CHAIN = IS_MAINNET ? arc : arcTestnet;

// 테스트넷 기본값 — mainnet이면 환경변수 필수
const TESTNET_USDC = "0x3600000000000000000000000000000000000000" as const;

function getMoarcContract(): `0x${string}` {
  const addr = process.env.MOARC_CONTRACT_ADDRESS;
  if (!addr) throw new Error("MOARC_CONTRACT_ADDRESS 환경변수가 설정되지 않았습니다.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`MOARC_CONTRACT_ADDRESS "${addr}" 은 유효한 주소가 아닙니다.`);
  }
  return addr.toLowerCase() as `0x${string}`;
}

function getMoarcUsdc(): `0x${string}` {
  const addr = process.env.MOARC_USDC_ADDRESS;
  if (IS_MAINNET && !addr) {
    throw new Error("MOARC_USDC_ADDRESS 환경변수가 mainnet에서 필수입니다.");
  }
  if (addr) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      throw new Error(`MOARC_USDC_ADDRESS "${addr}" 은 유효한 주소가 아닙니다.`);
    }
    return addr.toLowerCase() as `0x${string}`;
  }
  return TESTNET_USDC;
}

function getRpcUrls(): string[] {
  const urls: string[] = [];
  if (process.env.ARC_RPC_URL)              urls.push(process.env.ARC_RPC_URL);
  if (process.env.ARC_RPC_URL_2)            urls.push(process.env.ARC_RPC_URL_2);
  if (process.env.ARC_RPC_URL_3)            urls.push(process.env.ARC_RPC_URL_3);
  if (process.env.ARC_TESTNET_RPC_FALLBACK) urls.push(process.env.ARC_TESTNET_RPC_FALLBACK);
  const base  = process.env.RPC_PROXY_BASE_URL;
  const token = process.env.RPC_PROXY_TOKEN;
  const chains = process.env.RPC_PROXY_CHAINS ?? "";
  const proxyKey = IS_MAINNET ? "ARC-MAINNET" : "ARC-TESTNET";
  if (base && token && chains.includes(proxyKey)) {
    urls.push(`${base}/api/rpc/${proxyKey.toLowerCase()}?_rpc_token=${token}`);
  }
  if (urls.length === 0) {
    // viem chain defaults
    ACTIVE_CHAIN.rpcUrls.default.http.forEach((u) => urls.push(u));
  }
  return urls;
}

function makeClient() {
  const urls = getRpcUrls();
  const transports = urls.map((u) => http(u, { timeout: 30_000 }));
  return createPublicClient({
    chain: ACTIVE_CHAIN,
    transport: transports.length > 1 ? fallback(transports) : transports[0],
  });
}

// ─── 서버 시작 시 RPC 검증 ────────────────────────────────────────────────────

export interface ServerNetworkVerification {
  ok: boolean;
  chainId?: number;
  bytecodePresent?: boolean;
  version?: string;
  usdcDecimals?: number;
  errors: string[];
}

/**
 * 서버 시작 시 또는 write 라우트 첫 요청 시 호출합니다.
 * RPC eth_chainId, 컨트랙트 bytecode 존재, VERSION() 상수, USDC decimals()를 확인합니다.
 * 불일치가 있으면 ok=false를 반환하고 write 라우트가 차단합니다.
 * 이 함수는 민감값을 로그에 출력하지 않습니다.
 */
export async function verifyServerNetworkConfig(): Promise<ServerNetworkVerification> {
  const errors: string[] = [];
  let chainId: number | undefined;
  let bytecodePresent: boolean | undefined;
  let version: string | undefined;
  let usdcDecimals: number | undefined;

  try {
    const contract = getMoarcContract();
    const usdc     = getMoarcUsdc();
    const client   = makeClient();

    // 1. eth_chainId
    try {
      const rpcChainId = await client.getChainId();
      chainId = rpcChainId;
      if (rpcChainId !== ACTIVE_CHAIN_ID) {
        errors.push(`RPC chainId=${rpcChainId} ≠ expected ${ACTIVE_CHAIN_ID}`);
      }
    } catch (e) {
      errors.push(`eth_chainId 실패: ${String(e)}`);
    }

    // 2. 컨트랙트 bytecode 존재 여부
    try {
      const code = await client.getCode({ address: contract });
      bytecodePresent = !!(code && code.length > 2);
      if (!bytecodePresent) {
        errors.push(`컨트랙트 ${contract}에 코드가 없습니다.`);
      }
    } catch (e) {
      errors.push(`getCode 실패: ${String(e)}`);
    }

    // 3. VERSION() 상수
    try {
      const versionAbi = parseAbi(["function VERSION() view returns (string)"]);
      const v = await client.readContract({
        address: contract,
        abi: versionAbi,
        functionName: "VERSION",
      }) as string;
      version = v;
      if (!v.startsWith("MoaArc")) {
        errors.push(`VERSION "${v}" 이 "MoaArc"로 시작하지 않습니다.`);
      }
    } catch (e) {
      errors.push(`VERSION() 읽기 실패: ${String(e)}`);
    }

    // 4. USDC decimals
    try {
      const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
      const d = await client.readContract({
        address: usdc,
        abi: decimalsAbi,
        functionName: "decimals",
      }) as number;
      usdcDecimals = d;
      if (d !== 6) {
        errors.push(`USDC decimals=${d} ≠ 6`);
      }
    } catch (e) {
      errors.push(`USDC decimals() 읽기 실패: ${String(e)}`);
    }

  } catch (setup) {
    errors.push(`설정 오류: ${String(setup)}`);
  }

  return { ok: errors.length === 0, chainId, bytecodePresent, version, usdcDecimals, errors };
}

// ─── createTrip ABI ──────────────────────────────────────────────────────────

const CREATE_TRIP_ABI = parseAbi([
  "function createTrip(string name, address[] participants, uint256 targetBudget) returns (uint256 tripId)",
]);

export function encodeCreateTripCalldata(
  name: string,
  participants: `0x${string}`[],
  targetBudget: bigint
): `0x${string}` {
  return encodeFunctionData({
    abi: CREATE_TRIP_ABI,
    functionName: "createTrip",
    args: [name, participants, targetBudget],
  });
}

// ─── 트랜잭션 상태 조회 ───────────────────────────────────────────────────────

export async function getTransactionStatus(txHash: `0x${string}`): Promise<
  | { found: false }
  | { found: true; confirmed: false }
  | { found: true; confirmed: true; success: boolean; blockNumber: bigint }
> {
  const client = makeClient();
  let tx: Awaited<ReturnType<typeof client.getTransaction>> | null = null;
  try {
    tx = await client.getTransaction({ hash: txHash });
  } catch {
    return { found: false };
  }
  if (!tx) return { found: false };
  if (tx.blockNumber === null) return { found: true, confirmed: false };
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    return { found: true, confirmed: true, success: receipt.status === "success", blockNumber: receipt.blockNumber };
  } catch {
    return { found: true, confirmed: false };
  }
}

// ─── TripCreated 이벤트 검증 ─────────────────────────────────────────────────

const TRIP_CREATED_ABI = parseAbiItem(
  "event TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget)"
);
const TRIP_CREATED_TOPIC =
  "0xb97d60f4efa6efead896cfc0db2bfdfe57133218c9c3df8855db7c98301b3038";

export interface VerifiedTripOnchain {
  tripId: bigint;
  admin: string;
  name: string;
  participants: string[];
}

export async function verifyCreateTripTx(
  txHash: `0x${string}`,
  expectedChainId: number,
  expectedContract: string
): Promise<VerifiedTripOnchain> {
  if (expectedChainId !== ACTIVE_CHAIN_ID) {
    throw new Error(`지원하지 않는 체인 ID: ${expectedChainId}. 서버 체인 ID: ${ACTIVE_CHAIN_ID}`);
  }
  const contract = getMoarcContract();
  if (expectedContract.toLowerCase() !== contract) {
    throw new Error(`알 수 없는 컨트랙트 주소: ${expectedContract}`);
  }
  const client = makeClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error("트랜잭션이 revert되었습니다.");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0]?.toLowerCase() !== TRIP_CREATED_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRIP_CREATED_ABI],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      return {
        tripId: decoded.args.tripId as bigint,
        admin: (decoded.args.admin as string).toLowerCase(),
        name: decoded.args.name as string,
        participants: [],
      };
    } catch { continue; }
  }
  throw new Error("TripCreated 이벤트를 찾을 수 없습니다.");
}

// ─── ParticipantAdded 이벤트 검증 ────────────────────────────────────────────

const PARTICIPANT_ADDED_ABI = parseAbiItem(
  "event ParticipantAdded(uint256 indexed tripId, address indexed newParticipant)"
);
const PARTICIPANT_ADDED_TOPIC =
  "0x4a0dfc65adbcd5d5010eb4cbde7a35087f1961d5f69023cfabe53970adc22096";

export interface VerifiedAddParticipant {
  tripId: bigint;
  newParticipant: string;
}

export async function verifyAddParticipantTx(
  txHash: `0x${string}`,
  expectedChainId: number,
  expectedContract: string,
  expectedTripId: bigint
): Promise<VerifiedAddParticipant> {
  if (expectedChainId !== ACTIVE_CHAIN_ID) {
    throw new Error(`지원하지 않는 체인 ID: ${expectedChainId}. 서버 체인 ID: ${ACTIVE_CHAIN_ID}`);
  }
  const contract = getMoarcContract();
  if (expectedContract.toLowerCase() !== contract) {
    throw new Error(`알 수 없는 컨트랙트 주소: ${expectedContract}`);
  }
  const client = makeClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error("트랜잭션이 revert되었습니다.");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0]?.toLowerCase() !== PARTICIPANT_ADDED_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: [PARTICIPANT_ADDED_ABI],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const tripId = decoded.args.tripId as bigint;
      if (tripId !== expectedTripId) {
        throw new Error(`tripId 불일치: 이벤트=${tripId}, 기대값=${expectedTripId}`);
      }
      return { tripId, newParticipant: (decoded.args.newParticipant as string).toLowerCase() };
    } catch (inner) { throw inner; }
  }
  throw new Error("ParticipantAdded 이벤트를 찾을 수 없습니다.");
}

// ─── 온체인 참여자 목록 조회 ──────────────────────────────────────────────────

const TRIP_PARTICIPANTS_ABI = parseAbi([
  "function getTripParticipants(uint256 tripId) view returns (address[])",
]);

export async function fetchOnchainParticipants(
  contractAddress: string,
  tripId: bigint
): Promise<string[]> {
  const client = makeClient();
  const addrs = await client.readContract({
    address: contractAddress as `0x${string}`,
    abi: TRIP_PARTICIPANTS_ABI,
    functionName: "getTripParticipants",
    args: [tripId],
  });
  return (addrs as string[]).map((a) => a.toLowerCase());
}
