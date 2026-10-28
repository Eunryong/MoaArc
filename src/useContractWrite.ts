/**
 * useContractWrite.ts — 온체인 쓰기 훅
 *
 * 공통 실행 경로:
 *  1. 레거시 방 차단 (contractAddress가 현재 배포와 다르면 거부)
 *  2. simulateContract — revert 사전 감지 (선택적)
 *  3. writeContractAsync — 지갑 서명
 *  4. waitForTransactionReceipt — receipt.status 검증 (reverted이면 오류)
 *  5. approve tx와 money-moving tx는 상태·해시 구분
 */

import { useCallback, useState } from "react";
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  usePublicClient,
  useAccount,
  useSimulateContract,
} from "wagmi";
import { MOAARK_ADDRESS, MOAARK_ABI, ERC20_ABI, USDC_ADDRESS } from "./contractAbi";
import { NETWORK_CONFIG, CONFIG_VALID, txExplorerUrl as explorerUrl } from "./networkConfig";

export type TxStatus = "idle" | "approving" | "waiting_approval" | "pending" | "success" | "error";

export interface TxState {
  status: TxStatus;
  /** approve tx 해시 (approve+deposit 시퀀스에서 첫 번째 tx) */
  approveTxHash?: `0x${string}`;
  /** money-moving tx 해시 */
  txHash?: `0x${string}`;
  errorMessage?: string;
}

// ─── 공통 유틸 ────────────────────────────────────────────────────────────────

function extractRevertReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // viem ContractFunctionRevertedError carries shortMessage
  const short = (e as { shortMessage?: string }).shortMessage;
  return short ?? msg.slice(0, 200);
}

/** receipt.status === "reverted"이면 throw */
async function waitAndVerify(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  hash: `0x${string}`,
  label: string
) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
    confirmations: 1,
  });
  if (receipt.status === "reverted") {
    throw new Error(`트랜잭션 실패 (reverted): ${label}`);
  }
  return receipt;
}

/**
 * 현재 방이 현재 배포 컨트랙트와 일치하는지 확인.
 * tripContractAddress가 없으면(레거시) 차단.
 */
export function isLegacyTrip(tripContractAddress: string | undefined): boolean {
  if (!tripContractAddress) return true;
  return tripContractAddress.toLowerCase() !== NETWORK_CONFIG.contractAddress.toLowerCase();
}

const LEGACY_BLOCKED_MSG =
  "이 여행방은 이전 컨트랙트를 사용합니다. 새 여행방을 만들어 v3 기능을 사용하세요.";
const CONFIG_INVALID_MSG =
  "컨트랙트 설정이 완료되지 않았습니다. 환경변수를 확인하세요.";

// ─── useDeposit ───────────────────────────────────────────────────────────────

export function useDeposit(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) { setState({ status: "error", errorMessage: "지갑이 연결되지 않았습니다." }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "approving" });
      try {
        // Step 1: approve USDC
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "approving", approveTxHash: approveTx });
        await waitAndVerify(publicClient, approveTx, "USDC approve");

        // Step 2: deposit
        setState({ status: "waiting_approval", approveTxHash: approveTx });
        const depositTx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "deposit",
          args: [tripId, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", approveTxHash: approveTx, txHash: depositTx });
        await waitAndVerify(publicClient, depositTx, "deposit");
        setState({ status: "success", approveTxHash: approveTx, txHash: depositTx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [address, publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useReleaseBudget ─────────────────────────────────────────────────────────

export function useReleaseBudget(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(
    async (spender: `0x${string}`, amount: bigint, memo: string) => {
      if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "releaseBudget",
          args: [tripId, spender, amount, memo],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", txHash: tx });
        await waitAndVerify(publicClient, tx, "releaseBudget");
        setState({ status: "success", txHash: tx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useReturnUnusedBudget ────────────────────────────────────────────────────

export function useReturnUnusedBudget(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) { setState({ status: "error", errorMessage: "지갑이 연결되지 않았습니다." }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "approving" });
      try {
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "approving", approveTxHash: approveTx });
        await waitAndVerify(publicClient, approveTx, "USDC approve");

        setState({ status: "waiting_approval", approveTxHash: approveTx });
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "returnUnusedBudget",
          args: [tripId, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", approveTxHash: approveTx, txHash: tx });
        await waitAndVerify(publicClient, tx, "returnUnusedBudget");
        setState({ status: "success", approveTxHash: approveTx, txHash: tx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [address, publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── usePayDeficit ────────────────────────────────────────────────────────────

export function usePayDeficit(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });
  const { address } = useAccount();

  const execute = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient) { setState({ status: "error", errorMessage: "지갑이 연결되지 않았습니다." }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "approving" });
      try {
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [MOAARK_ADDRESS, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "approving", approveTxHash: approveTx });
        await waitAndVerify(publicClient, approveTx, "USDC approve");

        setState({ status: "waiting_approval", approveTxHash: approveTx });
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "payDeficit",
          args: [tripId, amount],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", approveTxHash: approveTx, txHash: tx });
        await waitAndVerify(publicClient, tx, "payDeficit");
        setState({ status: "success", approveTxHash: approveTx, txHash: tx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [address, publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useApproveFinalSettlement ────────────────────────────────────────────────

export function useApproveFinalSettlement(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(
    async (ledgerHash: `0x${string}`) => {
      if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "approveFinalSettlement",
          args: [tripId, ledgerHash],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", txHash: tx });
        await waitAndVerify(publicClient, tx, "approveFinalSettlement");
        setState({ status: "success", txHash: tx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useClaimRefund ───────────────────────────────────────────────────────────

export function useClaimRefund(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(async () => {
    if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
    if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
    if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

    setState({ status: "waiting_approval" });
    try {
      const tx = await writeContractAsync({
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "claimRefund",
        args: [tripId],
        chainId: NETWORK_CONFIG.chainId,
      });
      setState({ status: "pending", txHash: tx });
      await waitAndVerify(publicClient, tx, "claimRefund");
      setState({ status: "success", txHash: tx });
    } catch (e) {
      setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
    }
  }, [publicClient, writeContractAsync, tripId, tripContractAddress]);

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useRecordActualSpend ─────────────────────────────────────────────────────

export function useRecordActualSpend(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(
    async (amount: bigint, memo: string) => {
      if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "recordActualSpend",
          args: [tripId, amount, memo],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", txHash: tx });
        await waitAndVerify(publicClient, tx, "recordActualSpend");
        setState({ status: "success", txHash: tx });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [publicClient, writeContractAsync, tripId, tripContractAddress]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useCreateTrip ────────────────────────────────────────────────────────────

export function useCreateTrip() {
  const [state, setState] = useState<TxState & { tripId?: bigint }>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(
    async (name: string, participants: `0x${string}`[], targetBudget: bigint) => {
      if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }

      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "createTrip",
          args: [name, participants, targetBudget],
        });
        setState({ status: "pending", txHash: tx });
        const receipt = await waitAndVerify(publicClient, tx, "createTrip");
        const TRIP_CREATED_TOPIC =
          "0xb97d60f4efa6efead896cfc0db2bfdfe57133218c9c3df8855db7c98301b3038" as const;
        let tripId: bigint | undefined;
        for (const log of receipt.logs) {
          if (log.topics[0] === TRIP_CREATED_TOPIC && log.topics[1]) {
            try { tripId = BigInt(log.topics[1]); break; } catch { /* skip */ }
          }
        }
        setState({ status: "success", txHash: tx, tripId });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
      }
    },
    [publicClient, writeContractAsync]
  );

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useCancelSettlement ──────────────────────────────────────────────────────

export function useCancelSettlement(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<TxState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(async () => {
    if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return; }
    if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return; }
    if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return; }

    setState({ status: "waiting_approval" });
    try {
      const tx = await writeContractAsync({
        address: MOAARK_ADDRESS,
        abi: MOAARK_ABI,
        functionName: "cancelSettlement",
        args: [tripId],
        chainId: NETWORK_CONFIG.chainId,
      });
      setState({ status: "pending", txHash: tx });
      await waitAndVerify(publicClient, tx, "cancelSettlement");
      setState({ status: "success", txHash: tx });
    } catch (e) {
      setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
    }
  }, [publicClient, writeContractAsync, tripId, tripContractAddress]);

  return { state, execute, reset: () => setState({ status: "idle" }) };
}

// ─── useAddParticipant (v3) ───────────────────────────────────────────────────
// txHash 보존: DB sync 실패 후 재시도 시 같은 txHash를 재사용

export interface AddParticipantState extends TxState {
  /** onchain 성공 후 확정된 txHash — DB sync 재시도에 사용 */
  confirmedTxHash?: `0x${string}`;
  /** onchain 성공 후 확정된 참여자 주소 */
  confirmedAddress?: string;
}

export function useAddParticipant(tripId: bigint, tripContractAddress?: string) {
  const [state, setState] = useState<AddParticipantState>({ status: "idle" });
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: NETWORK_CONFIG.chainId });

  const execute = useCallback(
    async (newParticipant: `0x${string}`): Promise<`0x${string}` | null> => {
      // 이미 onchain 성공했으면 같은 txHash 반환 (DB sync 재시도)
      if (state.confirmedTxHash && state.confirmedAddress === newParticipant.toLowerCase()) {
        return state.confirmedTxHash;
      }
      if (!publicClient) { setState({ status: "error", errorMessage: "RPC 연결 없음" }); return null; }
      if (!CONFIG_VALID) { setState({ status: "error", errorMessage: CONFIG_INVALID_MSG }); return null; }
      if (isLegacyTrip(tripContractAddress)) { setState({ status: "error", errorMessage: LEGACY_BLOCKED_MSG }); return null; }

      setState({ status: "waiting_approval" });
      try {
        const tx = await writeContractAsync({
          address: MOAARK_ADDRESS,
          abi: MOAARK_ABI,
          functionName: "addParticipant",
          args: [tripId, newParticipant],
          chainId: NETWORK_CONFIG.chainId,
        });
        setState({ status: "pending", txHash: tx });
        await waitAndVerify(publicClient, tx, "addParticipant");
        setState({
          status: "success",
          txHash: tx,
          confirmedTxHash: tx,
          confirmedAddress: newParticipant.toLowerCase(),
        });
        return tx;
      } catch (e) {
        setState((s) => ({ ...s, status: "error", errorMessage: extractRevertReason(e) }));
        return null;
      }
    },
    [tripId, tripContractAddress, writeContractAsync, publicClient, state.confirmedTxHash, state.confirmedAddress]
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, execute, reset };
}

// ─── 상태 표시 헬퍼 ──────────────────────────────────────────────────────────

export function txStatusLabel(state: TxState): string {
  switch (state.status) {
    case "idle": return "";
    case "approving": return "USDC 승인 중...";
    case "waiting_approval": return "지갑에서 서명 대기 중...";
    case "pending": return "트랜잭션 처리 중...";
    case "success": return "완료";
    case "error": return `오류: ${state.errorMessage ?? "알 수 없는 오류"}`;
  }
}

export function txStatusColor(state: TxState): string {
  switch (state.status) {
    case "idle": return "text-stone-500";
    case "approving": return "text-amber-500";
    case "waiting_approval": return "text-amber-600";
    case "pending": return "text-indigo-600";
    case "success": return "text-emerald-600";
    case "error": return "text-rose-600";
  }
}

/** 트랜잭션 해시 → 탐색기 링크 */
export function txExplorerUrl(hash: string): string {
  return explorerUrl(hash);
}

// re-export for components that use it
export { useSimulateContract, useWaitForTransactionReceipt };
