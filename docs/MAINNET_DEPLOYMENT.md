# MoaArc: Arc Mainnet preparation guide

**Status: no mainnet deployment exists.** This guide only documents how to configure and verify the app
*after you deploy the contract yourself*. The Arc Studio preview and the sandbox stay on **Arc Testnet**. Do
not put mainnet values in the Studio preview environment.

> Transactions on mainnet involve real funds and are irreversible. Arc Studio did not and will not deploy,
> sign for, or fund anything on mainnet. Review every address and setting yourself, obtain an independent
> audit, and test on testnet first. You are solely responsible for what you deploy and operate.

Never put a private key in this repository, in a Studio chat, or in any `.env` file that is committed.
Use a hardware wallet or a keystore on your own machine.

## 1. Values you must fill in

| Setting (frontend, build time) | Setting (server) | Mainnet value |
|---|---|---|
| `VITE_NETWORK` | `MOARC_NETWORK` | `mainnet` (exactly: lowercase, no surrounding spaces. `Mainnet`, `MAINNET`, ` mainnet ` and any other word are rejected on both sides. Unset, empty or whitespace-only means the testnet default) |
| `VITE_CHAIN_ID` | `MOARC_CHAIN_ID` | `5042` (required, plain decimal integer) |
| `VITE_USDC_ADDRESS` | `MOARC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` (exactly) |
| `VITE_CONTRACT_ADDRESS` | `MOARC_CONTRACT_ADDRESS` | `<MAINNET_DEPLOYED_CONTRACT_ADDRESS>` (you fill this in after deploying) |
| `VITE_CONTRACT_VERSION` (optional) | `MOARC_CONTRACT_VERSION` (optional) | `MoaArc-3.0` (the only accepted value on mainnet) |
| (not applicable) | `ARC_MAINNET_RPC_URL`, `_2`, `_3` | `<YOUR_MAINNET_RPC_HTTPS_URL>` (https only; optional, falls back to the official viem Arc mainnet RPC) |
| `VITE_API_BASE_URL` | `ALLOWED_ORIGINS` | `<YOUR_PRODUCTION_API_URL>` / `<YOUR_PRODUCTION_WEB_ORIGIN>` |
| (not applicable) | `JWT_SECRET`, `DATABASE_PATH` | a new random secret and a new production database path (never reuse testnet data or secrets) |

The frontend and the server must agree. The frontend refuses to send any transaction unless the server's
`/api/network` reports the same network name, chain id, contract, USDC and `VERSION`.

### What fails closed (nothing is silently replaced by a testnet value)

- Unknown network names (`Mainnet`, `prod`, a trailing space, etc.).
- A chain id that is not a plain decimal integer (`5042abc`, `5042.0`, `0x13b2`, `05042`) or is not exactly the
  official id for the selected network (`5042` mainnet, `5042002` testnet).
- A missing, malformed or zero contract or USDC address, a USDC address other than the canonical one, or any
  known Arc Testnet MoaArc deployment used as the mainnet contract.
- A `VERSION` other than `MoaArc-3.0` on mainnet.
- On the server, RPC settings that are cross-network: on mainnet the server ignores `ARC_TESTNET_RPC_FALLBACK`
  and the Arc Studio RPC proxy, rejects the network-agnostic `ARC_RPC_URL*` variables and any RPC URL that is
  not https or points to a testnet host. The official viem Arc mainnet RPC is used only as the final fallback.
- An RPC that does not answer `eth_chainId` with `5042` at startup. Until verification passes, all trip and
  intent write APIs return 503 and the frontend blocks wallet writes.

## 2. Manual deployment outline (Foundry, run by you)

Run these on your own machine. Do not run them in Studio and do not paste keys anywhere.

1. Build the contract with the project settings (`foundry.toml`: solc 0.8.28, optimizer 200 runs, via IR):

   ```bash
   forge build
   ```

   The artifact is `contracts/out/MoaArcTreasury.sol/MoaArcTreasury.json`.

2. Confirm the chain before sending anything:

   ```bash
   cast chain-id --rpc-url "$ARC_MAINNET_RPC_URL"        # must print 5042
   cast call 0x3600000000000000000000000000000000000000 "decimals()(uint8)" --rpc-url "$ARC_MAINNET_RPC_URL"  # 6
   ```

3. Deploy with the canonical USDC as the only constructor argument. Use a hardware wallet or an encrypted
   keystore you manage yourself (for example `--ledger` or `--account <keystore-name>`), never a pasted key:

   ```bash
   forge create contracts/MoaArcTreasury.sol:MoaArcTreasury \
     --rpc-url "$ARC_MAINNET_RPC_URL" \
     --constructor-args 0x3600000000000000000000000000000000000000 \
     --account <your-keystore-name> \
     --broadcast
   ```

   Record the deployed address. This is the `<MAINNET_DEPLOYED_CONTRACT_ADDRESS>` value above.

## 3. Verify before enabling users

Replace `$C` with your deployed address.

| Check | Command or action | Expected |
|---|---|---|
| Chain id | `cast chain-id --rpc-url "$ARC_MAINNET_RPC_URL"` | `5042` |
| Contract has code | `cast code $C --rpc-url "$ARC_MAINNET_RPC_URL"` | non-empty bytecode |
| Constructor USDC | `cast call $C "usdc()(address)" --rpc-url "$ARC_MAINNET_RPC_URL"` | `0x3600000000000000000000000000000000000000` |
| Version | `cast call $C "VERSION()(string)" --rpc-url "$ARC_MAINNET_RPC_URL"` | `"MoaArc-3.0"` |
| Bytecode matches your build | compare `cast code $C` with `deployedBytecode.object` from the compiled artifact (ignore the metadata hash suffix) | match |
| Source verification | verify the source on the Arc explorer | verified |
| Server startup | start the server with the mainnet variables and check `/api/network` | `status: "ok"`, `network: "mainnet"`, `chainId: 5042` |
| Test deposit and return | with a small amount from your own wallet: create a trip, deposit, then return/withdraw | both succeed, balances match the Details view |

Only after every row passes should you build the frontend with the mainnet `VITE_*` values and publish it.

## 4. Values to provide after you deploy

1. `<MAINNET_DEPLOYED_CONTRACT_ADDRESS>`: set as `VITE_CONTRACT_ADDRESS` and `MOARC_CONTRACT_ADDRESS`.
2. `<YOUR_MAINNET_RPC_HTTPS_URL>` (optional): set as `ARC_MAINNET_RPC_URL` on the server.
3. `<YOUR_PRODUCTION_API_URL>`: set as `VITE_API_BASE_URL` before building the frontend.
4. `<YOUR_PRODUCTION_WEB_ORIGIN>`: set as `ALLOWED_ORIGINS` on the server (comma separated).
5. A new `JWT_SECRET` and a production `DATABASE_PATH`.
