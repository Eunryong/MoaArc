/**
 * 온체인 여행방 등록 검증
 *
 * POST /api/trips 시 createTrip 트랜잭션을 검증합니다.
 * - 올바른 chainId (Arc Testnet = 5042002)
 * - 올바른 컨트랙트 주소 (process.env.MOARC_CONTRACT_ADDRESS)
 * - 트랜잭션 해시에서 TripCreated 이벤트 파싱 → 실제 tripId 추출
 *
 * 서버는 새 트랜잭션을 전송하거나 서명하지 않습니다.
 *
 * 환경변수:
 *   MOARC_CONTRACT_ADDRESS   배포된 컨트랙트 주소 (0x...)
 *   RPC_PROXY_BASE_URL       Arc Studio RPC 프록시 base URL
 *   RPC_PROXY_TOKEN          Arc Studio RPC 프록시 토큰
 *   RPC_PROXY_CHAINS         쉼표 구분 체인 목록 (예: "ARC-TESTNET,ETH-SEPOLIA")
 *   ARC_TESTNET_RPC_FALLBACK 프록시 미사용 시 fallback RPC (공개 엔드포인트)
 */

import { createPublicClient, http, parseAbiItem, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";

// Arc Testnet chainId (viem/chains arcTestnet.id = 5042002)
export const ARC_TESTNET_CHAIN_ID = 5042002;

function getMoarcContract(): `0x${string}` {
  const addr = process.env.MOARC_CONTRACT_ADDRESS;
  if (!addr) throw new Error("MOARC_CONTRACT_ADDRESS 환경변수가 설정되지 않았습니다.");
  return addr.toLowerCase() as `0x${string}`;
}

function getRpcUrl(): string {
  const base = process.env.RPC_PROXY_BASE_URL;
  const token = process.env.RPC_PROXY_TOKEN;
  const chains = process.env.RPC_PROXY_CHAINS ?? "";
  if (base && token && chains.includes("ARC-TESTNET")) {
    return `${base}/api/rpc/arc-testnet?_rpc_token=${token}`;
  }
  const fallback = process.env.ARC_TESTNET_RPC_FALLBACK;
  if (!fallback) {
    throw new Error(
      "RPC URL을 결정할 수 없습니다. RPC_PROXY_BASE_URL/TOKEN/CHAINS 또는 ARC_TESTNET_RPC_FALLBACK 환경변수를 설정하세요."
    );
  }
  return fallback;
}

const TRIP_CREATED_ABI = parseAbiItem(
  "event TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget)"
);

// keccak256("TripCreated(uint256,address,string,uint256)")
const TRIP_CREATED_TOPIC =
  "0xb97d60f4efa6efead896cfc0db2bfdfe57133218c9c3df8855db7c98301b3038";

export interface VerifiedTripOnchain {
  tripId: bigint;
  admin: string;        // lowercase 0x
  name: string;
  participants: string[]; // lowercase 0x[] — 컨트랙트 getTripParticipants()로 조회
}

/**
 * 주어진 txHash에서 TripCreated 이벤트를 파싱해 tripId를 반환합니다.
 * 잘못된 체인/컨트랙트/이벤트이면 예외를 던집니다.
 */
export async function verifyCreateTripTx(
  txHash: `0x${string}`,
  expectedChainId: number,
  expectedContract: string
): Promise<VerifiedTripOnchain> {
  if (expectedChainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `지원하지 않는 체인 ID: ${expectedChainId}. Arc Testnet(${ARC_TESTNET_CHAIN_ID})만 지원합니다.`
    );
  }

  const contract = getMoarcContract();
  if (expectedContract.toLowerCase() !== contract) {
    throw new Error(
      `알 수 없는 컨트랙트 주소: ${expectedContract}`
    );
  }

  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(getRpcUrl()),
  });

  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error("트랜잭션이 revert되었습니다.");
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract) continue;
    if (log.topics[0]?.toLowerCase() !== TRIP_CREATED_TOPIC) continue;
    try {
      const decoded = client.decodeEventLog({
        abi: [TRIP_CREATED_ABI],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      return {
        tripId: decoded.args.tripId as bigint,
        admin: (decoded.args.admin as string).toLowerCase(),
        name: decoded.args.name as string,
      };
    } catch {
      continue;
    }
  }

  throw new Error(
    "TripCreated 이벤트를 찾을 수 없습니다. 올바른 컨트랙트에서 생성된 트랜잭션이 아닐 수 있습니다."
  );
}

// ─── 온체인 참여자 목록 조회 ──────────────────────────────────────────────────

const TRIP_PARTICIPANTS_ABI = parseAbi([
  "function getTripParticipants(uint256 tripId) view returns (address[])",
]);

/**
 * 컨트랙트의 getTripParticipants()를 호출해 참여자 주소 목록을 반환합니다.
 */
export async function fetchOnchainParticipants(
  contractAddress: string,
  tripId: bigint
): Promise<string[]> {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(getRpcUrl()),
  });

  const addrs = await client.readContract({
    address: contractAddress as `0x${string}`,
    abi: TRIP_PARTICIPANTS_ABI,
    functionName: "getTripParticipants",
    args: [tripId],
  });

  return (addrs as string[]).map((a) => a.toLowerCase());
}
