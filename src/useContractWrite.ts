// ─── 온체인 쓰기 훅 ────────────────────────────────────────────────────────
//
// 실제 Arc Testnet 트랜잭션을 전송합니다.
// 각 훅은 wagmi useWriteContract + useWaitForTransactionReceipt 를 사용합니다.

import { useCallback, useState } from "react";
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  usePublicClient,
  useAccount,
} from "wagmi";
import { arcTestnet } from "viem/chains";
import { MOAARK_ADDRESS, MOAARK_ABI, ERC20_ABI, USDC_ADDRESS } from "./contractAbi";

export type TxStatus = "idle" | "waiting_approval" | "pending" | "success" | "error";

export interface TxState {
  status: TxStatus;
  txHash?: `0x${string}`;
  errorMessage?: string;
}

// ─── 공통: approve + deposit ─────────────────────────────────────────────

export function useDeposit(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) return;
      setState({ status: "waiting_approval" });
      try {
        // Step 1: approve USDC
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: approveTx });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        // Step 2: deposit
        const depositTx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "deposit",
          args: [tripId, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: depositTx });
        await publicClient.waitForTransactionReceipt({ hash: depositTx });
        setState({ status: "success", txHash: depositTx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [address, publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── releaseBudget ──────────────────────────────────────────────────────

export function useReleaseBudget(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(
    async (spender: `0x${string}`, amount: bigint, memo: string) => {
      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "releaseBudget",
          args: [tripId, spender, amount, memo],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        await publicClient?.waitForTransactionReceipt({ hash: tx });
        setState({ status: "success", txHash: tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── returnUnusedBudget ─────────────────────────────────────────────────

export function useReturnUnusedBudget(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) return;
      setState({ status: "waiting_approval" });
      try {
        // Approve first
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: approveTx });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "returnUnusedBudget",
          args: [tripId, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        setState({ status: "success", txHash: tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [address, publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── payDeficit ─────────────────────────────────────────────────────────

export function usePayDeficit(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) return;
      setState({ status: "waiting_approval" });
      try {
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: approveTx });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });

        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "payDeficit",
          args: [tripId, amount],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        setState({ status: "success", txHash: tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [address, publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── approveFinalSettlement ──────────────────────────────────────────────

export function useApproveFinalSettlement(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(
    async (ledgerHash: `0x${string}`) => {
      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "approveFinalSettlement",
          args: [tripId, ledgerHash],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        await publicClient?.waitForTransactionReceipt({ hash: tx });
        setState({ status: "success", txHash: tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── claimRefund ────────────────────────────────────────────────────────

export function useClaimRefund(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(async () => {
    setState({ status: "waiting_approval" });
    try {
      const tx = await writeContractAsync({
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "claimRefund",
        args: [tripId],
        chainId: arcTestnet.id,
      });
      setState({ status: "pending", txHash: tx });
      await publicClient?.waitForTransactionReceipt({ hash: tx });
      setState({ status: "success", txHash: tx });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ status: "error", errorMessage: msg });
    }
  }, [publicClient, writeContractAsync, tripId]);

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── recordActualSpend ──────────────────────────────────────────────────

export function useRecordActualSpend(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(
    async (amount: bigint, memo: string) => {
      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "recordActualSpend",
          args: [tripId, amount, memo],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        await publicClient?.waitForTransactionReceipt({ hash: tx });
        setState({ status: "success", txHash: tx });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [publicClient, writeContractAsync, tripId]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── createTrip ─────────────────────────────────────────────────────────

export function useCreateTrip() {
  const [state, setState] = useState<TxState & { tripId?: bigint }>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(
    async (
      name: string,
      participants: `0x${string}`[],
      targetBudget: bigint
    ) => {
      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "createTrip",
          args: [name, participants, targetBudget],
          chainId: arcTestnet.id,
        });
        setState({ status: "pending", txHash: tx });
        const receipt = await publicClient?.waitForTransactionReceipt({ hash: tx });
        // TripCreated(uint256 indexed tripId, address indexed admin, string name, uint256 targetBudget)
        // topic0 = keccak256("TripCreated(uint256,address,string,uint256)")
        const TRIP_CREATED_TOPIC =
          "0xb97d60f4efa6efead896cfc0db2bfdfe57133218c9c3df8855db7c98301b3038" as const;
        let tripId: bigint | undefined;
        if (receipt) {
          for (const log of receipt.logs) {
            if (log.topics[0] === TRIP_CREATED_TOPIC && log.topics[1]) {
              // tripId is the first indexed param → topics[1]
              try { tripId = BigInt(log.topics[1]); } catch { /* ignore */ }
            }
          }
        }
        setState({ status: "success", txHash: tx, tripId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setState({ status: "error", errorMessage: msg });
      }
    },
    [publicClient, writeContractAsync]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── cancelSettlement ───────────────────────────────────────────────────

export function useCancelSettlement(tripId: bigint) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const execute = useCallback(async () => {
    setState({ status: "waiting_approval" });
    try {
      const tx = await writeContractAsync({
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "cancelSettlement",
        args: [tripId],
        chainId: arcTestnet.id,
      });
      setState({ status: "pending", txHash: tx });
      await publicClient?.waitForTransactionReceipt({ hash: tx });
      setState({ status: "success", txHash: tx });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ status: "error", errorMessage: msg });
    }
  }, [publicClient, writeContractAsync, tripId]);

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── 트랜잭션 상태 표시 헬퍼 ────────────────────────────────────────────

export function txStatusLabel(state: TxState): string {
  switch (state.status) {
    case "idle": return "";
    case "waiting_approval": return "지갑에서 승인 대기 중...";
    case "pending": return "트랜잭션 처리 중...";
    case "success": return "완료";
    case "error": return `오류: ${state.errorMessage ?? "알 수 없는 오류"}`;
  }
}

export function txStatusColor(state: TxState): string {
  switch (state.status) {
    case "idle": return "text-stone-500";
    case "waiting_approval": return "text-amber-600";
    case "pending": return "text-indigo-600";
    case "success": return "text-emerald-600";
    case "error": return "text-rose-600";
  }
}

/** 트랜잭션 해시 → Arc Testnet 탐색기 링크 */
export function txExplorerUrl(hash: string): string {
  return `https://explorer.testnet.arc.io/tx/${hash}`;
}

// useWaitForTransactionReceipt re-export for convenience
export { useWaitForTransactionReceipt };
