import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Runtime check: `pnpm dev` with the default PORT and with a non-default
// PORT must serve identical API responses directly and through the Vite proxy,
// and the proxy must not contact a stale default port.
// Usage: node scripts/dev-proxy-check.mjs [[host@]port ...]   (default: 8787 18887 ::1@18888)
import { spawn } from 'node:child_process';

const isolatedData = mkdtempSync(`${tmpdir()}/vc-smoke-`);
process.on('exit', () => rmSync(isolatedData, {recursive:true, force:true}));
const root = new URL('..', import.meta.url).pathname;
const targets = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['8787', '18887', '::1@18888']).map((t) => {
  const [host, port] = t.includes('@') ? t.split('@') : ['127.0.0.1', t];
  return { host, port };
});
const VITE = 'http://127.0.0.1:5173';
let failed = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function waitFor(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getJson(url);
      if (r.status === 200) return r;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error(`${url} not ready`);
}

async function isListening(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

for (const { host, port } of targets) {
  const backend = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const env = { ...process.env, DATA_DIR: isolatedData, PORT: port, HOST: host, COINGECKO_API_KEY: '', LOG_LEVEL: 'warn' };
  const child = spawn('pnpm', ['dev'], { cwd: root, env, detached: true, stdio: 'ignore' });
  try {
    const direct = await waitFor(`${backend}/api/health`);
    const proxied = await waitFor(`${VITE}/api/health`);
    const poolDirect = await getJson(`${backend}/api/pool`);
    const poolProxied = await getJson(`${VITE}/api/pool`);
    const same =
      proxied.body.config.configHash === direct.body.config.configHash &&
      JSON.stringify(poolDirect.body) === JSON.stringify(poolProxied.body);
    const staleDefault = port !== '8787' && (await isListening('http://127.0.0.1:8787/api/health'));
    console.log(
      `HOST=${host} PORT=${port}: direct ${direct.status}, proxy /api/health ${proxied.status}, /api/pool ${poolProxied.status}, identical=${same}, default port 8787 listening=${port !== '8787' ? staleDefault : 'n/a'}`,
    );
    if (!same || proxied.status !== 200 || poolProxied.status !== 200 || staleDefault) failed = true;
  } catch (err) {
    console.log(`HOST=${host} PORT=${port}: FAIL ${err.message}`);
    failed = true;
  } finally {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(1500);
  }
}

console.log(failed ? 'DEV PROXY CHECK: FAILED' : 'DEV PROXY CHECK: PASSED');
process.exitCode = failed ? 1 : 0;
