// ─── 온체인 읽기 훅 (TESTNET MODE 전용) ────────────────────────────────────
//
// MoaArkTreasury 컨트랙트에서 실제 상태를 읽어옵니다.
// DEMO 모드에서는 호출하지 마세요.

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import {
  MOAARK_ABI,
  ERC20_ABI,
  settlementStatusFromUint,
} from "./contractAbi";
import { NETWORK_CONFIG } from "./networkConfig";
import type { SettlementStatus } from "./types";
import {
  parseParticipantBalances,
  type BatchStatus,
  type ContractReadResult,
  type ParticipantOnchainRow,
} from "./onchainReads";

// 편의 상수 — networkConfig를 읽어 사용
const MOAARK_ADDRESS = NETWORK_CONFIG.contractAddress;
const USDC_ADDRESS   = NETWORK_CONFIG.usdcAddress;
const CHAIN_ID       = NETWORK_CONFIG.chainId;

import { isLegacyTrip } from "./useContractWrite";

// ─── tripBalance 읽기 ────────────────────────────────────────────────────

export function useTripBalance(tripId: bigint, enabled = true, tripContractAddress?: string) {
  const active = enabled && !isLegacyTrip(tripContractAddress);
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "tripBalance",
    args: [tripId],
    chainId: CHAIN_ID,
    query: { enabled: active, refetchInterval: 15_000 },
  });
}

// ─── depositedAmount 읽기 ────────────────────────────────────────────────

export function useDepositedAmount(
  tripId: bigint,
  participantAddress: `0x${string}` | undefined,
  enabled = true,
  tripContractAddress?: string
) {
  const active = enabled && !!participantAddress && !isLegacyTrip(tripContractAddress);
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "depositedAmount",
    args: [tripId, participantAddress ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: active, refetchInterval: 15_000 },
  });
}

// ─── allocatedBudget 읽기 ────────────────────────────────────────────────

export function useAllocatedBudget(
  tripId: bigint,
  participantAddress: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "allocatedBudget",
    args: [tripId, participantAddress ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!participantAddress, refetchInterval: 15_000 },
  });
}

// ─── 참여자 전원의 depositedAmount / allocatedBudget / spentFromBudget (배치) ──
//
// 참여자 i 당 3개 읽기가 [deposited, allocated, spent] 순서로 평탄화됩니다.
// (PARTICIPANT_READ_FUNCTIONS 순서와 parseParticipantBalances 가 이에 의존)
// 개별 읽기가 실패하면 그 참여자는 rows 에서 빠지고 0n 으로 채워지지 않습니다.

export function useParticipantBalances(
  tripId: bigint,
  participantAddresses: readonly string[],
  enabled = true,
  tripContractAddress?: string,
): {
  rows: Record<string, ParticipantOnchainRow>;
  status: BatchStatus;
  refetch: () => void;
} {
  const active = enabled && tripId > 0n && participantAddresses.length > 0 && !isLegacyTrip(tripContractAddress);
  const addressKey = participantAddresses.map((a) => a.toLowerCase()).join(",");

  const contracts = useMemo(
    () =>
      addressKey
        ? addressKey.split(",").flatMap((addr) => {
            const a = addr as `0x${string}`;
            return [
              { address: MOAARK_ADDRESS, abi: MOAARK_ABI, functionName: "depositedAmount", args: [tripId, a], chainId: CHAIN_ID },
              { address: MOAARK_ADDRESS, abi: MOAARK_ABI, functionName: "allocatedBudget", args: [tripId, a], chainId: CHAIN_ID },
              { address: MOAARK_ADDRESS, abi: MOAARK_ABI, functionName: "spentFromBudget", args: [tripId, a], chainId: CHAIN_ID },
            ] as const;
          })
        : [],
    [addressKey, tripId],
  );

  const result = useReadContracts({
    contracts,
    allowFailure: true,
    query: { enabled: active, refetchInterval: 15_000 },
  });

  let status: BatchStatus;
  if (!active) status = "disabled";
  else if (result.isError) status = "error";
  else if (result.data === undefined) status = "loading";
  else status = "ok";

  // 마지막 갱신이 실패(isError)했다면 react-query 가 이전 data 를 들고 있어도 최신값으로 취급하지 않습니다.
  const rows = useMemo(
    () =>
      status === "ok"
        ? parseParticipantBalances(
            addressKey ? addressKey.split(",") : [],
            result.data as readonly ContractReadResult[] | undefined,
          )
        : {},
    [addressKey, result.data, status],
  );

  return { rows, status, refetch: () => { void result.refetch(); } };
}

// ─── isParticipant 확인 ──────────────────────────────────────────────────

export function useIsParticipant(
  tripId: bigint,
  address: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "isParticipant",
    args: [tripId, address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}

// ─── settlementStatus 읽기 ───────────────────────────────────────────────

export function useSettlementStatus(tripId: bigint, enabled = true, tripContractAddress?: string) {
  const active = enabled && !isLegacyTrip(tripContractAddress);
  const result = useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "getSettlementStatus",
    args: [tripId],
    chainId: CHAIN_ID,
    query: { enabled: active, refetchInterval: 15_000 },
  });
  const status: SettlementStatus | undefined =
    result.data !== undefined ? settlementStatusFromUint(result.data) : undefined;
  return { ...result, settlementStatus: status };
}

// ─── USDC 잔액 읽기 ──────────────────────────────────────────────────────

export function useUsdcBalance(
  address: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}

// ─── USDC allowance 읽기 ─────────────────────────────────────────────────

export function useUsdcAllowance(
  owner: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [
      owner ?? "0x0000000000000000000000000000000000000000",
      MOAARK_ADDRESS,
    ],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!owner, refetchInterval: 15_000 },
  });
}

// ─── refundClaimed 읽기 ──────────────────────────────────────────────────

export function useRefundClaimed(
  tripId: bigint,
  address: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "refundClaimed",
    args: [tripId, address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}

// ─── settlementDetails 읽기 ──────────────────────────────────────────────

export function useSettlementDetails(tripId: bigint, enabled = true) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "getSettlementDetails",
    args: [tripId],
    chainId: CHAIN_ID,
    query: { enabled, refetchInterval: 15_000 },
  });
}

// ─── isAllApproved + isAllDeficitPaid (배치) ─────────────────────────────

export function useSettlementReadiness(tripId: bigint, enabled = true) {
  return useReadContracts({
    contracts: [
      {
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "isAllApproved",
        args: [tripId],
        chainId: CHAIN_ID,
      },
      {
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "isAllDeficitPaid",
        args: [tripId],
        chainId: CHAIN_ID,
      },
    ],
    query: { enabled, refetchInterval: 15_000 },
  });
}

// ─── paidDeficit 읽기 ────────────────────────────────────────────────────

export function usePaidDeficit(
  tripId: bigint,
  address: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "paidDeficit",
    args: [tripId, address ?? "0x0000000000000000000000000000000000000000"],
    chainId: CHAIN_ID,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}
