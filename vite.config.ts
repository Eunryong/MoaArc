import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    // Listing every eagerly-needed package here prevents Vite from
    // discovering them at runtime and invalidating the pre-bundle hash,
    // which would cause 404s on cached chunk URLs in the browser.
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'jose',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
    // Ensure arc + arcTestnet are pre-bundled together with viem/chains
    // so a new VITE_NETWORK=mainnet build does not produce a stale chunk URL.
    force: false,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    cors: true,
    proxy: {
      // /api 요청을 백엔드 포트 3001로 전달
      // 브라우저는 프리뷰 호스트의 /api 경로만 사용하므로 CORS 없이 통신
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path,
      },
    },
  },
})
