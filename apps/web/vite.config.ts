import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { effectiveEnv } from '../server/src/env-file';
import { resolveServerAddress, serverOrigin } from '../../packages/shared/src/server-address';

// Dev server is loopback-only and proxies /api to the Fastify server.
// The browser never talks to CoinGecko directly.
//
// The proxy target is resolved exactly like the server's bind address:
// repository .env overlaid by the process environment, validated by the same
// loopback-only schema. Only HOST/PORT are read here; nothing is exposed to the client.
const VITE_PORT = 5173;
const repoEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
const backendAddress = resolveServerAddress(effectiveEnv(repoEnvFile));
if (backendAddress.port === VITE_PORT) {
  // A shared PORT=5173 (e.g. injected by tooling) would make the proxy target itself.
  throw new Error(`Backend PORT ${VITE_PORT} collides with the Vite dev server port; set PORT to another value (default 8787).`);
}
const backend = serverOrigin(backendAddress);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: VITE_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
