/**
 * server/src/lib/chain.ts — 온체인 검증 유틸리티
 *
 * 환경변수 (검증 규칙은 networkEnv.ts — 잘못된 값은 모두 fail-closed):
 *   MOARC_NETWORK            정확히 "testnet" | "mainnet" (대소문자·공백 불허). 미설정/공백뿐 = testnet, 그 외 값은 오류
 *   MOARC_CHAIN_ID           10진 정수 문자열. mainnet 필수(5042), testnet 선택(5042002). 공식 id 와 정확히 일치해야 함
 *   MOARC_CONTRACT_ADDRESS   배포된 MoaArcTreasury 주소 [필수]. mainnet 에서는 테스트넷 배포 주소 거부
 *   MOARC_USDC_ADDRESS       USDC 주소. mainnet 필수 + 정확히 0x3600…0000. testnet 기본값 동일
 *   MOARC_CONTRACT_VERSION   기대 VERSION() (mainnet 에서는 "MoaArc-3.0" 고정)
 *   ARC_MAINNET_RPC_URL(_2,_3)  mainnet 전용 RPC (https). mainnet 에서는 이것만 사용 + viem 공식 mainnet 기본값
 *   ARC_TESTNET_RPC_URL(_2,_3), ARC_RPC_URL(_2,_3), ARC_TESTNET_RPC_FALLBACK, RPC_PROXY_*  testnet 전용
 *
 * 규칙:
 *  - mainnet 에서는 테스트넷 RPC fallback / 범용 ARC_RPC_URL* / Arc Studio 프록시를 사용하지 않음.
 *  - 설정 오류가 있으면 verifyServerNetworkConfig() 가 RPC 호출 없이 실패하고 write API 는 503.
 *  - 시작 시 eth_chainId(설정값·공식값 모두 일치), bytecode, VERSION(), treasury.usdc(), USDC decimals 검증.
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
import { resolveServerNetwork, buildRpcUrls } from "./networkEnv.js";

// ─── 환경변수 파싱 (fail-closed) ──────────────────────────────────────────────

/** 모듈 로드 시점의 네트워크 해석. 이후 getMoarcContract/Usdc 는 env 를 다시 읽되 네트워크가 바뀌면 거부합니다. */
const BOOT = resolveServerNetwork(process.env);

/** 표시용 네트워크 이름 (알 수 없는 값이면 입력값 그대로 — 검증은 BOOT.errors 로 실패) */
const NETWORK: string = BOOT.network ?? (process.env.MOARC_NETWORK ?? "");

/** 지원 체인 ID */
export const ARC_TESTNET_CHAIN_ID = arcTestnet.id;  // 5042002
export const ARC_MAINNET_CHAIN_ID = arc.id;          // 5042

/**
 * 검증된 체인 ID. 네트워크 이름이나 MOARC_CHAIN_ID 가 잘못되면 0 (어떤 체인 ID 와도 일치하지 않음 →
 * chainId 비교 라우트가 모두 거부).
 */
export const ACTIVE_CHAIN_ID: number = BOOT.chainId ?? 0;

const ACTIVE_CHAIN = BOOT.network === "mainnet" ? arc : BOOT.network === "testnet" ? arcTestnet : null;

function currentConfig() {
  const r = resolveServerNetwork(process.env);
  if (r.network !== BOOT.network) {
    throw new Error("MOARC_NETWORK 가 서버 시작 후 변경되었습니다 — 재시작이 필요합니다.");
  }
  if (r.errors.length > 0) {
    throw new Error(`네트워크 설정 오류: ${r.errors.join("; ")}`);
  }
  return r;
}

/** 검증된 MoaArcTreasury 주소 (소문자). mainnet 에서는 테스트넷 배포 주소·0 주소·형식 오류를 거부합니다. */
export function getMoarcContract(): `0x${string}` {
  return currentConfig().contractAddress as `0x${string}`;
}

function getRpcUrls(): string[] {
  if (!ACTIVE_CHAIN) throw new Error("알 수 없는 MOARC_NETWORK — RPC 를 구성할 수 없습니다.");
  const { urls, errors } = buildRpcUrls(
    BOOT.network as "testnet" | "mainnet",
    process.env,
    ACTIVE_CHAIN.rpcUrls.default.http as readonly string[],
  );
  if (errors.length > 0) throw new Error(`RPC 설정 오류: ${errors.join("; ")}`);
  return urls;
}

function makeClient() {
  if (!ACTIVE_CHAIN) throw new Error("알 수 없는 MOARC_NETWORK — RPC 클라이언트를 만들 수 없습니다.");
  const urls = getRpcUrls();
  const transports = urls.map((u) => http(u, { timeout: 30_000 }));
  return createPublicClient({
    chain: ACTIVE_CHAIN,
    transport: transports.length > 1 ? fallback(transports) : transports[0],
  });
}

// ─── 서버 시작 시 RPC 검증 ────────────────────────────────────────────────────

/** 컨트랙트 VERSION() 함수가 반환해야 하는 정확한 문자열 */
const EXPECTED_VERSION = BOOT.contractVersion;

/** 공식 체인 ID — ACTIVE_CHAIN_ID와 일치해야 함 */
const OFFICIAL_CHAIN_ID = ACTIVE_CHAIN?.id ?? 0;

export interface ServerNetworkVerification {
  ok: boolean;
  chainId?: number;
  bytecodePresent?: boolean;
  version?: string;
  usdcAddress?: string;
  usdcDecimals?: number;
  network: string;
  contractAddress: string;
  errors: string[];
}

/**
 * 검증 결과 — 서버 시작 시 한 번 실행되어 이 모듈 상태에 캐시됩니다.
 * undefined = 아직 실행 전 (서버 기동 중)
 */
let _verificationResult: ServerNetworkVerification | undefined;

/** 현재 캐시된 검증 결과를 반환합니다. undefined이면 아직 검증 전입니다. */
export function getNetworkVerification(): ServerNetworkVerification | undefined {
  return _verificationResult;
}

/**
 * 테스트 전용: 검증 결과를 직접 주입합니다.
 * production 코드에서는 절대 호출하지 마세요 — 테스트 픽스처 setup에서만 사용합니다.
 * 이 함수를 통해 동일한 미들웨어 경로(isNetworkReady → 503/통과)를 검증합니다.
 */
export function _setVerificationResultForTest(
  result: ServerNetworkVerification | undefined
): void {
  _verificationResult = result;
}

/**
 * write API 미들웨어에서 호출합니다.
 * 검증이 완료되지 않았거나 ok=false이면 503을 반환합니다.
 * 호출자는 false이면 즉시 응답을 반환해야 합니다.
 */
export function isNetworkReady(): { ready: true } | { ready: false; reason: string } {
  if (_verificationResult === undefined) {
    return { ready: false, reason: "서버 네트워크 검증이 아직 완료되지 않았습니다. 잠시 후 다시 시도하세요." };
  }
  if (!_verificationResult.ok) {
    return { ready: false, reason: `네트워크 불일치: ${_verificationResult.errors.join("; ")}` };
  }
  return { ready: true };
}

/**
 * 에러 메시지에서 민감 토큰 값을 제거합니다.
 * RPC URL의 토큰 파라미터(_rpc_token=...)를 마스킹합니다.
 */
function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/_rpc_token=[^&\s"]+/g, "_rpc_token=***");
}

/**
 * 서버 시작 시 호출합니다.
 * RPC eth_chainId, 공식 체인 ID 일치, 컨트랙트 bytecode 존재,
 * VERSION() 정확 비교("MoaArc-3.0"), treasury.usdc() 주소 비교, USDC decimals()를 확인합니다.
 * 결과는 모듈 내부에 캐시되어 write 라우트 미들웨어가 isNetworkReady()로 503 차단합니다.
 * 이 함수는 민감값(토큰, 키)을 로그에 출력하지 않습니다.
 */
export async function verifyServerNetworkConfig(): Promise<ServerNetworkVerification> {
  const errors: string[] = [];
  let chainId: number | undefined;
  let bytecodePresent: boolean | undefined;
  let version: string | undefined;
  let usdcAddress: string | undefined;
  let usdcDecimals: number | undefined;

  let contract: `0x${string}`;
  let usdc: `0x${string}`;

  try {
    // 설정이 하나라도 잘못되면 RPC 를 호출하지 않고 실패 (write API 는 503 유지)
    const cfg = currentConfig();
    if (!ACTIVE_CHAIN) throw new Error("알 수 없는 MOARC_NETWORK");
    contract = cfg.contractAddress as `0x${string}`;
    usdc     = cfg.usdcAddress as `0x${string}`;
    // RPC 목록도 사전 검증 (잘못된/교차 네트워크 URL 이면 여기서 실패)
    getRpcUrls();
  } catch (e) {
    const msg = sanitizeError(e);
    errors.push(`설정 오류: ${msg}`);
    const result: ServerNetworkVerification = {
      ok: false,
      network: NETWORK,
      contractAddress: process.env.MOARC_CONTRACT_ADDRESS ?? "(미설정)",
      errors,
    };
    _verificationResult = result;
    return result;
  }

  const client = makeClient();

  // 1. eth_chainId — 설정값 AND 선택 network 공식 id와 모두 일치해야 함
  try {
    const rpcChainId = await client.getChainId();
    chainId = rpcChainId;
    if (rpcChainId !== ACTIVE_CHAIN_ID) {
      errors.push(`RPC chainId=${rpcChainId} ≠ 설정값 ${ACTIVE_CHAIN_ID}`);
    }
    if (rpcChainId !== OFFICIAL_CHAIN_ID) {
      errors.push(`RPC chainId=${rpcChainId} ≠ ${NETWORK} 공식 chain id ${OFFICIAL_CHAIN_ID}`);
    }
  } catch (e) {
    errors.push(`eth_chainId 실패: ${sanitizeError(e)}`);
  }

  // 2. 컨트랙트 bytecode 존재 여부
  try {
    const code = await client.getCode({ address: contract });
    bytecodePresent = !!(code && code.length > 2);
    if (!bytecodePresent) {
      errors.push(`컨트랙트 ${contract}에 코드가 없습니다 — 주소가 올바른지 확인하세요.`);
    }
  } catch (e) {
    errors.push(`getCode 실패: ${sanitizeError(e)}`);
  }

  // 3. VERSION() 정확 비교
  try {
    const versionAbi = parseAbi(["function VERSION() view returns (string)"]);
    const v = await client.readContract({
      address: contract,
      abi: versionAbi,
      functionName: "VERSION",
    }) as string;
    version = v;
    if (v !== EXPECTED_VERSION) {
      errors.push(`VERSION "${v}" ≠ 기대값 "${EXPECTED_VERSION}"`);
    }
  } catch (e) {
    errors.push(`VERSION() 읽기 실패: ${sanitizeError(e)}`);
  }

  // 4. treasury.usdc() 주소 비교
  try {
    const usdcFnAbi = parseAbi(["function usdc() view returns (address)"]);
    const onchainUsdc = await client.readContract({
      address: contract,
      abi: usdcFnAbi,
      functionName: "usdc",
    }) as string;
    usdcAddress = onchainUsdc.toLowerCase();
    if (usdcAddress !== usdc.toLowerCase()) {
      errors.push(`treasury.usdc()=${usdcAddress} ≠ 설정 MOARC_USDC_ADDRESS=${usdc}`);
    }
  } catch (e) {
    errors.push(`treasury.usdc() 읽기 실패: ${sanitizeError(e)}`);
  }

  // 5. USDC decimals()
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
    errors.push(`USDC decimals() 읽기 실패: ${sanitizeError(e)}`);
  }

  const result: ServerNetworkVerification = {
    ok: errors.length === 0,
    chainId,
    bytecodePresent,
    version,
    usdcAddress,
    usdcDecimals,
    network: NETWORK,
    contractAddress: contract,
    errors,
  };
  _verificationResult = result;
  return result;
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
