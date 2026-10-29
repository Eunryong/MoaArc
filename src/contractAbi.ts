// ─── MoaArcTreasury ABI ───────────────────────────────────────────────────
// MoaArcTreasury (v3, Active): 0xf7a733fb2084b31591a0fbacded683efbe5b6728 (Arc Testnet)
// Deploy Tx: 0xaa69a1a89b775873ba20bd60f81b6e99df1ebf55f1119b7fae180d4f304dc0ac
// VERSION: MoaArc-3.0
//
// Legacy contracts (do NOT use):
//   MoaArcTreasury (v2):       0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3
//   MoaArkTreasury (v1):       0x63aff048f159b1712e7c8d728cdc61b004eed40e
//   TripSharedTreasuryV2:      0x3bc08cdabcf702e01b458923a946cd664e438c3e
//   TripSharedTreasury (V1):   0x0e540064015628b03ec62b44d94721b1b50e5d92

// NOTE: these live addresses are driven by NETWORK_CONFIG (networkConfig.ts),
// which reads VITE_CONTRACT_ADDRESS / VITE_USDC_ADDRESS / VITE_NETWORK at build time.
// Never use these as fallback values — they are re-exported only for components
// that haven't been migrated to import from networkConfig directly.
import { NETWORK_CONFIG } from "./networkConfig";

/** Active MoaArcTreasury address for the current build target (testnet or mainnet). */
export const MOAARK_ADDRESS: `0x${string}` = NETWORK_CONFIG.contractAddress;
/** USDC ERC-20 address for the current build target. */
export const USDC_ADDRESS: `0x${string}` = NETWORK_CONFIG.usdcAddress;

/** @deprecated MoaArkTreasury v1 — superseded. Never used in new code. */
export const MOAARK_V1_ADDRESS = "0x63aff048f159b1712e7c8d728cdc61b004eed40e" as const;
/** @deprecated TripSharedTreasuryV2 — superseded. Never used in new code. */
export const TREASURY_V2_ADDRESS = "0x3bc08cdabcf702e01b458923a946cd664e438c3e" as const;

export const MOAARK_ABI = [
  // ─── createTrip ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "createTrip",
    inputs: [
      { name: "name", type: "string" },
      { name: "participants", type: "address[]" },
      { name: "targetBudget", type: "uint256" },
    ],
    outputs: [{ name: "tripId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  // ─── deposit ────────────────────────────────────────────────────────────
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── releaseBudget ──────────────────────────────────────────────────────
  {
    type: "function",
    name: "releaseBudget",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── returnUnusedBudget ─────────────────────────────────────────────────
  {
    type: "function",
    name: "returnUnusedBudget",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── recordActualSpend ──────────────────────────────────────────────────
  {
    type: "function",
    name: "recordActualSpend",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── recordPersonalPrepaid ──────────────────────────────────────────────
  {
    type: "function",
    name: "recordPersonalPrepaid",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── payDeficit ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "payDeficit",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── proposeFinalSettlement ─────────────────────────────────────────────
  {
    type: "function",
    name: "proposeFinalSettlement",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "members", type: "address[]" },
      { name: "finalRefundAmounts", type: "uint256[]" },
      { name: "requiredDeficits", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── approveFinalSettlement ─────────────────────────────────────────────
  {
    type: "function",
    name: "approveFinalSettlement",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "ledgerHash", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── claimRefund ────────────────────────────────────────────────────────
  {
    type: "function",
    name: "claimRefund",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── computeSettlementHash (pure) ───────────────────────────────────────
  {
    type: "function",
    name: "computeSettlementHash",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "version", type: "uint256" },
      { name: "members", type: "address[]" },
      { name: "finalRefundAmounts", type: "uint256[]" },
      { name: "requiredDeficits", type: "uint256[]" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  // ─── view: getSettlementDetails ─────────────────────────────────────────
  {
    type: "function",
    name: "getSettlementDetails",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [
      { name: "hash", type: "bytes32" },
      { name: "members", type: "address[]" },
      { name: "refunds", type: "uint256[]" },
      { name: "deficits", type: "uint256[]" },
      { name: "proposed", type: "bool" },
    ],
    stateMutability: "view",
  },
  // ─── view: tripBalance ──────────────────────────────────────────────────
  {
    type: "function",
    name: "tripBalance",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: depositedAmount ──────────────────────────────────────────────
  {
    type: "function",
    name: "depositedAmount",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: allocatedBudget ──────────────────────────────────────────────
  {
    type: "function",
    name: "allocatedBudget",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: spentFromBudget ──────────────────────────────────────────────
  {
    type: "function",
    name: "spentFromBudget",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: paidDeficit ──────────────────────────────────────────────────
  {
    type: "function",
    name: "paidDeficit",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: settlementApproved ───────────────────────────────────────────
  {
    type: "function",
    name: "settlementApproved",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── view: refundClaimed ────────────────────────────────────────────────
  {
    type: "function",
    name: "refundClaimed",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── view: isParticipant ────────────────────────────────────────────────
  {
    type: "function",
    name: "isParticipant",
    inputs: [
      { name: "", type: "uint256" },
      { name: "", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── view: getSettlementStatus ──────────────────────────────────────────
  {
    type: "function",
    name: "getSettlementStatus",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  // ─── view: getSettlementVersion ─────────────────────────────────────────
  {
    type: "function",
    name: "getSettlementVersion",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  // ─── view: isAllApproved ────────────────────────────────────────────────
  {
    type: "function",
    name: "isAllApproved",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── view: isAllDeficitPaid ─────────────────────────────────────────────
  {
    type: "function",
    name: "isAllDeficitPaid",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── cancelSettlement (MoaArcTreasury v2+) ─────────────────────────────
  {
    type: "function",
    name: "cancelSettlement",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── view: canCancelSettlement ──────────────────────────────────────────
  {
    type: "function",
    name: "canCancelSettlement",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  // ─── event: SettlementCancelled ─────────────────────────────────────────
  {
    type: "event",
    name: "SettlementCancelled",
    inputs: [{ name: "tripId", type: "uint256", indexed: true }],
  },
  // ─── addParticipant (MoaArcTreasury v3) ─────────────────────────────────
  // Admin only. settlementStatus must be None. newParticipant must be an EOA.
  {
    type: "function",
    name: "addParticipant",
    inputs: [
      { name: "tripId", type: "uint256" },
      { name: "newParticipant", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // ─── event: ParticipantAdded (MoaArcTreasury v3) ─────────────────────────
  {
    type: "event",
    name: "ParticipantAdded",
    inputs: [
      { name: "tripId", type: "uint256", indexed: true },
      { name: "newParticipant", type: "address", indexed: true },
    ],
  },
  // ─── view: getTripParticipants ──────────────────────────────────────────
  {
    type: "function",
    name: "getTripParticipants",
    inputs: [{ name: "tripId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/** SettlementStatus uint8 → 문자열 변환 */
export function settlementStatusFromUint(n: number | bigint): import("./types").SettlementStatus {
  const v = Number(n);
  if (v === 0) return "None";
  if (v === 1) return "Proposed";
  if (v === 2) return "DeficitPaying";
  if (v === 3) return "ClaimStarted";
  if (v === 4) return "Completed";
  return "None";
}
