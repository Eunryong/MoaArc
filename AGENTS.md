# MoaArc

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app.

---

## What This App Does

MoaArc: 여행 일정을 관리하고 공동경비를 Arc Testnet에서 정산하는 웹앱.
- 일정 입력 → 비용 예측 → 공동예산 → 실제 지출 기록 → 예상/실제 비교 → 분담 승인 → 지갑 서명 → Arc 공동경비 정산

## Deployed Contracts

| Contract | Network | Address | Status |
|---|---|---|---|
| TripSharedTreasury (V1) | Arc Testnet | 0x0e540064015628b03ec62b44d94721b1b50e5d92 | Superseded |
| TripSharedTreasuryV2 | Arc Testnet | 0x3bc08cdabcf702e01b458923a946cd664e438c3e | Superseded |
| MoaArcTreasury v2 | Arc Testnet | 0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3 | Superseded (existing trips remain here) |
| **MoaArcTreasury v3** | **Arc Testnet** | **0xf7a733fb2084b31591a0fbacded683efbe5b6728** | **Active** |

MoaArcTreasury v3 Explorer: https://explorer.testnet.arc.io/address/0xf7a733fb2084b31591a0fbacded683efbe5b6728
MoaArcTreasury v3 Deploy Tx: 0xaa69a1a89b775873ba20bd60f81b6e99df1ebf55f1119b7fae180d4f304dc0ac

MoaArcTreasury v2 Explorer (legacy): https://explorer.testnet.arc.io/address/0x964a772ea94f2a4f03ec3e2ad3df7f3e92a935e3
MoaArcTreasury v2 Deploy Tx (legacy): 0x3a9bd689e22fdf2a6fba1ffc569535aae21000b7cb465d8c1a54d7378155dc43

Constructor args: `["0x3600000000000000000000000000000000000000"]` (Arc USDC)

### MoaArcTreasury v3 changes (vs v2)
- VERSION = "MoaArc-3.0"
- New function: `addParticipant(uint256 tripId, address newParticipant)` — admin-only, allowed only when settlementStatus==None and not locked
- New error: `ContractAddress(address addr)` — rejects smart-contract wallets (extcodesize check); known limitation documented in NatSpec
- New event: `ParticipantAdded(uint256 indexed tripId, address indexed newParticipant)`
- All other functions and storage layout unchanged

## App Modes

### DEMO MODE
- Uses DEMO_TRIP (A/B/C/D 시연 데이터, 도쿄 여행 2026)
- Always shows "시연 데이터 · 실제 지갑/온체인 상태 아님" banner
- Role switching (A/B/C/D) enabled
- Demo reset button available
- Includes: itinerary with 3 confirmed + 1 draft items, agent chat with preset responses

### TESTNET MODE
- Starts empty (빈 상태)
- Requires wallet connection (Arc Testnet, Chain ID 5042002)
- Role switching DISABLED — wallet address auto-identifies participant
- Non-participants: read-only
- Real transactions: deposit, releaseBudget, returnUnusedBudget, payDeficit, approveFinalSettlement, claimRefund

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002)
- Token: USDC (6 decimals, address: 0x3600000000000000000000000000000000000000)
- Toasts: Sonner
- All amounts: bigint microUSDC (1 USDC = 1_000_000n)

## Key Files

- `src/App.tsx` - Main app (DEMO/TESTNET mode, 5 tabs)
- `src/types.ts` - Domain types (all amounts bigint, ItineraryItem, AgentMessage, AppMode)
- `src/contractAbi.ts` - MOAARK_ADDRESS + MOAARK_ABI + ERC20_ABI
- `src/useContractWrite.ts` - Onchain write hooks (deposit, releaseBudget, returnUnusedBudget, payDeficit, approveFinalSettlement, claimRefund, createTrip)
- `src/useContractState.ts` - Onchain read hooks (tripBalance, depositedAmount, allocatedBudget, isParticipant, settlementStatus, usdcBalance, etc.)
- `src/calculations.ts` - All bigint math (fmtUsdc, parseUsdcInput, validateShares, applyProportionalRefund, etc.)
- `src/demoData.ts` - DEMO_TRIP, DEMO_ITINERARY, DEMO_AGENT_MESSAGES, createEmptyTestnetTrip
- `src/components/ItineraryTab.tsx` - Itinerary list + agent chat tab (NEW)
- `contracts/MoaArcTreasury.sol` - Active treasury contract
- `contracts/test/MoaArcTreasury.t.sol` - 42 unit tests (all pass)

## Agent Features (ItineraryTab)

- DEMO mode: preset responses for 예산/일정/지출 queries
- TESTNET mode: shows "GEMINI_API_KEY not configured" message
- Real Gemini API requires: server GEMINI_API_KEY + /api/agent endpoint + Google Search grounding
- Agent can: draft itinerary, estimate costs, compare actuals, propose budget changes
- Agent CANNOT: sign wallet transactions, auto-approve shares, change confirmed data

## To Run

```bash
bun install
bun run dev
```

## Contract Commands

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test (42 tests pass)
```
