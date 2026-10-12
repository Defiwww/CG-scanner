import { loadDemoAccess } from './demo-access';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadAppConfig, parseEnv, resolveFromRoot } from './config';
import { effectiveEnv } from './env-file';
import { loadLifetime } from './lifetime';

/** Repository root: this file lives at apps/server/src (dev) or apps/server/dist (build). */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Same resolution as the Vite dev proxy: .env overlaid by the process environment.
const processEnv = process.env.VC_ISOLATED_LOCAL==='1' ? process.env : effectiveEnv(resolve(repoRoot, '.env'));
const env = parseEnv(processEnv);
const demoAccess = loadDemoAccess(processEnv.DEMO_PUBLIC_ORIGIN, env.PORT);
const lifetime = loadLifetime(processEnv.LIFETIME_FILE);
const loaded = loadAppConfig(resolveFromRoot(repoRoot, env.CONFIG_PATH));

const app = await buildApp({
  loaded,
  ...(demoAccess ? {demoAccess} : {}),
  ...(lifetime ? {lifetime} : {}),
  databasePath: resolve(resolveFromRoot(repoRoot,env.DATA_DIR),'volumechecker.sqlite'),
  apiKey: env.COINGECKO_API_KEY,
  logLevel: env.LOG_LEVEL,
  webDistDir: resolve(repoRoot, 'apps/web/dist'),
});

app.log.info(
  {
    configVersion: loaded.config.configVersion,
    configHash: loaded.hash,
    approvalStatus: loaded.config.approval.status,
    apiKeyConfigured: env.COINGECKO_API_KEY !== undefined,
  },
  'configuration loaded',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
