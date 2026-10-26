/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, fallback, createConfig } from 'wagmi'
import { arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])

// Arc Testnet RPC 엔드포인트 — 첫 번째가 느리거나 타임아웃 시 fallback
const arcRpc = fallback([
  http('https://rpc.testnet.arc.io',             { timeout: 30_000 }),
  http('https://rpc.blockdaemon.testnet.arc.io', { timeout: 30_000 }),
  http('https://rpc.drpc.testnet.arc.io',        { timeout: 30_000 }),
])

export const config = createConfig({
  chains: [arcTestnet],      // Arc Testnet 전용 — mainnet 제거
  connectors: [injected()],
  pollingInterval: 1_000,
  transports: {
    [arcTestnet.id]: arcRpc,
  },
})
