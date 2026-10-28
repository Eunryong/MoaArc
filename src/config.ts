/**
 * wagmi configuration
 *
 * 체인과 RPC는 networkConfig.ts의 NETWORK_CONFIG에서 읽습니다.
 * 환경변수 VITE_NETWORK=mainnet 으로 Arc mainnet으로 전환합니다.
 */

import { http, fallback, createConfig } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'
import { NETWORK_CONFIG } from './networkConfig'

// RPC URLs
const rpcUrls = NETWORK_CONFIG.rpcUrls
registerChain(NETWORK_CONFIG.chainId, rpcUrls[0])

const transport = fallback(
  [...rpcUrls].map((url) => http(url, { timeout: 30_000 }))
)

// wagmi createConfig requires a statically-known chain tuple and matching
// transports key — use a conditional so TypeScript sees each branch.
export const config = NETWORK_CONFIG.isMainnet
  ? createConfig({
      chains: [arc],
      connectors: [injected()],
      pollingInterval: 1_000,
      transports: { [arc.id]: transport },
    })
  : createConfig({
      chains: [arcTestnet],
      connectors: [injected()],
      pollingInterval: 1_000,
      transports: { [arcTestnet.id]: transport },
    })
