// ─── 온체인 읽기 훅 (TESTNET MODE 전용) ────────────────────────────────────
//
// MoaArkTreasury 컨트랙트에서 실제 상태를 읽어옵니다.
// DEMO 모드에서는 호출하지 마세요.

import { useReadContract, useReadContracts } from "wagmi";
import { arcTestnet } from "viem/chains";
import {
  MOAARK_ADDRESS,
  MOAARK_ABI,
  ERC20_ABI,
  USDC_ADDRESS,
  settlementStatusFromUint,
} from "./contractAbi";
import type { SettlementStatus } from "./types";

// ─── tripBalance 읽기 ────────────────────────────────────────────────────

export function useTripBalance(tripId: bigint, enabled = true) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "tripBalance",
    args: [tripId],
    chainId: arcTestnet.id,
    query: { enabled, refetchInterval: 15_000 },
  });
}

// ─── depositedAmount 읽기 ────────────────────────────────────────────────

export function useDepositedAmount(
  tripId: bigint,
  participantAddress: `0x${string}` | undefined,
  enabled = true
) {
  return useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "depositedAmount",
    args: [tripId, participantAddress ?? "0x0000000000000000000000000000000000000000"],
    chainId: arcTestnet.id,
    query: { enabled: enabled && !!participantAddress, refetchInterval: 15_000 },
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
    chainId: arcTestnet.id,
    query: { enabled: enabled && !!participantAddress, refetchInterval: 15_000 },
  });
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
    chainId: arcTestnet.id,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}

// ─── settlementStatus 읽기 ───────────────────────────────────────────────

export function useSettlementStatus(tripId: bigint, enabled = true) {
  const result = useReadContract({
    address: MOAARK_ADDRESS,
    abi: MOAARK_ABI,
    functionName: "getSettlementStatus",
    args: [tripId],
    chainId: arcTestnet.id,
    query: { enabled, refetchInterval: 15_000 },
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
    chainId: arcTestnet.id,
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
    chainId: arcTestnet.id,
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
    chainId: arcTestnet.id,
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
    chainId: arcTestnet.id,
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
        chainId: arcTestnet.id,
      },
      {
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "isAllDeficitPaid",
        args: [tripId],
        chainId: arcTestnet.id,
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
    chainId: arcTestnet.id,
    query: { enabled: enabled && !!address, refetchInterval: 15_000 },
  });
}
