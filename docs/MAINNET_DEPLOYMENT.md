# MoaArc: Arc Mainnet deployment guide

**Status: deployed.**
Contract: `0x3CCC5FE6a4Cf142e0CFa6811C437b0E64f64ED16` on Arc Mainnet (chain id 5042).
Explorer: <https://explorer.arc.io/address/0x3CCC5FE6a4Cf142e0CFa6811C437b0E64f64ED16>
First deposit tx: `0xd7644707265670eaa343743df4fbffe93113a000da61cac652f48c36cbbdd9a9` (0.60 USDC)
Live app: <https://moaarc.eunryong.com>

The Arc Studio preview and sandbox remain on **Arc Testnet**. Do not put mainnet values in the Studio preview environment.

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
| `VITE_CONTRACT_ADDRESS` | `MOARC_CONTRACT_ADDRESS` | `0x3CCC5FE6a4Cf142e0CFa6811C437b0E64f64ED16` |
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

## 2. Manual deployment outline (Arc Foundry, run by you)

Use **Arc Foundry** (`arc-forge`, `arc-cast`, `arc-anvil`), Circle's Arc-specific fork of Foundry, for every
build, read-only check and deployment command below. Do not use stock `forge` or `cast` for Arc: they simulate a
generic EVM and miss Arc-specific behavior. Official references:
[Install Arc Foundry](https://docs.arc.io/arc/tutorials/install-arc-foundry.md) and
[Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc.md).

Run these on your own machine. Do not run them in Studio, and never paste a key, seed phrase or keystore
password into Studio, a chat, a file in this repository or a committed `.env`. Every command block is labeled:

- **READ-ONLY**: queries the chain, compiles locally or uploads source to the explorer. It sends no transaction
  and needs no approval.
- **SENDS A TRANSACTION**: costs real USDC (gas) and is irreversible. It only runs when you run it and approve it
  in your own signer (hardware wallet prompt or keystore password). Nothing in this guide or in Arc Studio
  deploys or signs for you.

### 2.1 Install Arc Foundry (READ-ONLY, local install)

Download the archive for your platform from the
[Arc Foundry releases page](https://github.com/circlefin/arc-foundry/releases), then extract it and rename the
binaries as the official guide describes:

```bash
tar -xzf arc-foundry-<version>-<target>.tar.gz
mkdir -p ~/.local/bin
mv forge ~/.local/bin/arc-forge
mv cast  ~/.local/bin/arc-cast
mv anvil ~/.local/bin/arc-anvil
export PATH="$HOME/.local/bin:$PATH"
arc-forge --version
```

### 2.2 Set the Arc Mainnet RPC (READ-ONLY)

The official primary Arc Mainnet RPC is `https://rpc.mainnet.arc.io` (chain id `5042`, currency USDC, explorer
`https://explorer.arc.io`). Provider endpoints (Alchemy, Blockdaemon, dRPC, QuickNode) are listed on the Connect
to Arc page. Use an https URL:

```bash
export ARC_MAINNET_RPC_URL="https://rpc.mainnet.arc.io"
```

This shell variable is only for your terminal. The server reads its own `ARC_MAINNET_RPC_URL` (section 1) and
requires https.

### 2.3 Build and test (READ-ONLY, local compile)

Build with the project settings in `foundry.toml` (solc 0.8.28, optimizer 200 runs, via IR, `evm_version =
"paris"`, which Arc's Osaka baseline runs). Do not change these settings between building, deploying and
verifying:

```bash
arc-forge build
arc-forge test --network arc
```

`--network arc` runs the tests against Arc's runtime behavior, as the official deploy guide recommends. The
artifact is `contracts/out/MoaArcTreasury.sol/MoaArcTreasury.json`. (This guide's commands have not been run by
Arc Studio; see "Not verified" at the end.)

### 2.4 Confirm the chain and USDC before sending anything (READ-ONLY)

```bash
arc-cast chain-id --rpc-url "$ARC_MAINNET_RPC_URL"        # must print 5042
arc-cast call 0x3600000000000000000000000000000000000000 "decimals()(uint8)" \
  --rpc-url "$ARC_MAINNET_RPC_URL"                         # must print 6 (the ERC-20 interface)
```

Arc's USDC is one balance exposed two ways: the ERC-20 interface at `0x3600…0000` uses **6 decimals**, while the
native gas balance (`arc-cast balance`, `msg.value`) uses **18 decimals**. Do not mix the two when you read
balances ([EVM differences](https://docs.arc.io/arc/references/evm-differences.md)). Check that your deployer
address holds enough USDC for gas:

```bash
arc-cast balance <YOUR_DEPLOYER_ADDRESS> --rpc-url "$ARC_MAINNET_RPC_URL"   # native view, 18 decimals
```

### 2.5 Prepare your signer on your own machine

Use a hardware wallet or an encrypted keystore that you create and unlock yourself.

- Keystore: import your key into an encrypted keystore with the interactive prompt, which asks for the key and a
  password in your terminal only (nothing is written to a file in this repository):

  ```bash
  arc-cast wallet import <your-keystore-name> --interactive
  ```

- Hardware wallet: use `--ledger` or `--trezor` in the deployment command instead of `--account`.

Confirm the signer flags your installed version supports with `arc-forge create --help` before deploying. Do not
use `--private-key` on the command line or `PRIVATE_KEY` in a `.env`, even though the testnet tutorial does for a
throwaway development wallet.

### 2.6 Deploy (SENDS A TRANSACTION, you approve it)

Deploy with the canonical USDC as the only constructor argument. The contract reverts on a zero USDC address,
and the app and server accept only `0x3600000000000000000000000000000000000000` on mainnet:

```bash
arc-forge create contracts/MoaArcTreasury.sol:MoaArcTreasury \
  --rpc-url "$ARC_MAINNET_RPC_URL" \
  --account <your-keystore-name> \
  --constructor-args 0x3600000000000000000000000000000000000000 \
  --broadcast
```

(For a hardware wallet, replace `--account <your-keystore-name>` with `--ledger` or `--trezor`.) Before you
approve in your signer, check the destination chain id (`5042`), the constructor argument and the fee shown.
Arc's mempool enforces a 20 Gwei `maxFeePerGas` floor; if the node rejects the fee, see
[Gas and fees](https://docs.arc.io/arc/references/gas-and-fees.md).

Save the `Deployed to:` address and the transaction hash from the output. The address is your
`<MAINNET_DEPLOYED_CONTRACT_ADDRESS>`. Set it in your shell for the next steps (run this again in any new
terminal), and do not share the keystore file or its password:

```bash
export C=<MAINNET_DEPLOYED_CONTRACT_ADDRESS>
```

### 2.7 Verify the source on the explorer (READ-ONLY, uploads source)

Verification uploads source to the explorer and does not spend gas. Run it from the project root so the same
compiler settings apply:

```bash
arc-forge verify-contract "$C" contracts/MoaArcTreasury.sol:MoaArcTreasury \
  --chain-id 5042 \
  --verifier blockscout \
  --verifier-url <ARC_MAINNET_EXPLORER_VERIFIER_URL> \
  --constructor-args "$(arc-cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000)"
```

The official guide only documents the testnet verifier URL (`https://explorer.testnet.arc.io/api/`). Take the
mainnet verifier URL from the explorer at `https://explorer.arc.io` (or use its contract verification page) and
confirm it before running; this guide does not invent one.

## 3. Verify before enabling users

All commands below are READ-ONLY queries; nothing here sends a transaction. `$C` is the deployed address you
exported in section 2.6 (set it again in a new terminal), and `$ARC_MAINNET_RPC_URL` comes from section 2.2.

| Check | Command or action | Expected |
|---|---|---|
| Chain id | `arc-cast chain-id --rpc-url "$ARC_MAINNET_RPC_URL"` | `5042` |
| Deployment receipt | `arc-cast receipt <DEPLOY_TX_HASH> --rpc-url "$ARC_MAINNET_RPC_URL"` | status success, `contractAddress` equals `$C` |
| Contract has code | `arc-cast code "$C" --rpc-url "$ARC_MAINNET_RPC_URL"` | non-empty bytecode |
| Constructor USDC | `arc-cast call "$C" "usdc()(address)" --rpc-url "$ARC_MAINNET_RPC_URL"` | `0x3600000000000000000000000000000000000000` |
| USDC decimals | `arc-cast call 0x3600000000000000000000000000000000000000 "decimals()(uint8)" --rpc-url "$ARC_MAINNET_RPC_URL"` | `6` |
| Version | `arc-cast call "$C" "VERSION()(string)" --rpc-url "$ARC_MAINNET_RPC_URL"` | `"MoaArc-3.0"` |
| Bytecode matches your build | compare `arc-cast code "$C"` with `deployedBytecode.object` from `contracts/out/MoaArcTreasury.sol/MoaArcTreasury.json`. Ignore the metadata hash at the end and the slot where the immutable `usdc` is embedded (the artifact has zeros there, the chain has the USDC address; positions are in `immutableReferences`) | match |
| Source verification | section 2.7, then open `$C` on `https://explorer.arc.io` | verified |
| Server startup | start the server with the mainnet variables (section 1) and open `/api/network` | `status: "ok"`, `network: "mainnet"`, `chainId: 5042`, `version: "MoaArc-3.0"` |

Only after every row passes should you build the frontend with the mainnet `VITE_*` values and publish it. The
test deposit and return in the next section are real-money transactions and are not part of this read-only table.

## 3a. Testing the local app against real Arc Mainnet

The contract is deployed at `0x3CCC5FE6a4Cf142e0CFa6811C437b0E64f64ED16` and passes section 3.
To run the app locally against Arc Mainnet, set the section 1 environment variables and proceed as follows:

1. Put the section 1 values in a local, uncommitted environment on your own machine and run the server and
   frontend there. Do not put them in the Arc Studio preview, which stays on Arc Testnet.
2. Add Arc Mainnet to your wallet (chain id `5042`, RPC `https://rpc.mainnet.arc.io`, symbol USDC, explorer
   `https://explorer.arc.io`) and fund it yourself with a small amount of real USDC. Arc uses USDC for gas, so
   one balance pays for both the deposit and the fees.
3. Signing in (the nonce signature) proves address ownership and costs no gas. Every **on-chain** action (USDC
   approval, deposit, budget transfer, return, trip creation) is a real, irreversible transaction that your
   wallet shows and **you must approve** each time. Arc Studio and the assistant never send, sign or approve
   anything for you.
4. Start with a very small amount, for example create one trip, deposit a small amount, return it, and compare
   the balances with the app's Details view and the explorer.

Optional rehearsal with no real funds: run the same steps on Arc Testnet (`VITE_NETWORK=testnet`, the testnet
contract and `https://rpc.testnet.arc.io`). `arc-anvil` can fork Arc Testnet state locally for contract-level
checks with `arc-forge` and `arc-cast`, but this app only accepts chain ids `5042` and `5042002`, so its UI
does not connect to a local node.

## 4. Values summary

1. `VITE_CONTRACT_ADDRESS` / `MOARC_CONTRACT_ADDRESS`: `0x3CCC5FE6a4Cf142e0CFa6811C437b0E64f64ED16` (deployed).
2. `ARC_MAINNET_RPC_URL` (optional): your https RPC endpoint; falls back to `https://rpc.mainnet.arc.io`.
3. `VITE_API_BASE_URL`: set to your production API URL before building the frontend.
4. `ALLOWED_ORIGINS`: set on the server (comma separated production web origins).
5. A production `JWT_SECRET` and `DATABASE_PATH` (never reuse testnet values).

## Not verified by Arc Studio

- The `arc-forge`, `arc-cast` and `arc-anvil` commands in this guide were not run (Arc Foundry is not installed
  in the Studio sandbox, and nothing was deployed or sent). Command names and the `--network arc` flag follow the
  official Arc Foundry install and deploy tutorials; confirm signer flags (`--account`, `--ledger`, `--trezor`)
  with `arc-forge create --help` on your machine.
- Whether this repository's contract tests pass under `arc-forge test --network arc` has not been checked.
- The Arc Mainnet explorer's source-verification URL is not documented in the pages this guide follows, so it is
  left as a placeholder.
