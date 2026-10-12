import { mkdtempSync, rmSync } from 'node:fs';
import {connect} from 'node:net';
import { tmpdir } from 'node:os';
// Offline startup smoke check for the production build.
// Starts apps/server/dist/server.js on a loopback port without a CoinGecko key,
// checks the API and the served dashboard, scans the web bundle for provider
// credentials plumbing, then sends SIGTERM and expects a clean exit.
// Usage: pnpm build && pnpm smoke
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const isolatedData = mkdtempSync(`${tmpdir()}/vc-smoke-`);
process.on('exit', () => rmSync(isolatedData, {recursive:true, force:true}));
const root = new URL('..', import.meta.url).pathname;
const port = process.env.SMOKE_PORT ?? '8799';
const base = `http://127.0.0.1:${port}`;
const serverEntry = join(root, 'apps/server/dist/server.js');
const webDist = join(root, 'apps/web/dist');

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
}

if (!existsSync(serverEntry) || !existsSync(webDist)) {
  console.error('SMOKE FAIL: build output missing; run `pnpm build` first');
  process.exit(1);
}

// Explicit empty key: the process environment overrides any repository .env,
// so the smoke run is key-free even when a local .env exists.
const env = { ...process.env, DATA_DIR: isolatedData, PORT: port, HOST: '127.0.0.1', LOG_LEVEL: 'warn', COINGECKO_API_KEY: '' };
const child = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'inherit', 'inherit'] });
const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy within 5s');
}

try {
  const health = await waitForHealth();
  console.log(`health: status=${health.status} apiKeyConfigured=${health.provider.apiKeyConfigured} config=${health.config.configVersion} hash=${health.config.configHash.slice(0, 12)} sqlite=${health.storage.sqliteVersion}`);
  if (health.provider.apiKeyConfigured !== false) fail('expected no API key in smoke environment');
  if (health.provider.restStatus !== 'not_connected' || health.provider.wsStatus !== 'disconnected') fail('a key-free server must not report a CoinGecko connection');

  const pool = await (await fetch(`${base}/api/pool`)).json();
  console.log(`pool: ${pool.networkId}:${pool.poolAddress} orientation=${pool.orientationStatus}`);

  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (!page.ok || !html.includes('<div id="root">')) fail('dashboard index.html not served');
  else console.log('dashboard: index.html served');

  const missingApi = await fetch(`${base}/api/does-not-exist`);
  if (missingApi.status !== 404) fail(`unknown /api route should be 404, got ${missingApi.status}`);

  const assets = readdirSync(join(webDist, 'assets')).filter((f) => f.endsWith('.js') || f.endsWith('.js.map'));
  for (const f of assets) {
    const text = readFileSync(join(webDist, 'assets', f), 'utf8');
    for (const needle of ['COINGECKO_API_KEY', 'x-cg-pro-api-key', 'pro-api.coingecko.com', 'stream.coingecko.com']) {
      if (text.includes(needle)) fail(`web bundle ${f} contains provider plumbing: ${needle}`);
    }
  }
  console.log(`bundle scan: ${assets.length} JS/source-map asset(s) free of provider credentials/endpoints`);
} catch (err) {
  fail(err.message);
} finally {
  // A browser may preconnect without sending HTTP headers; shutdown must not wait for its timeout.
  const idle=connect({host:'127.0.0.1',port:Number(port)});
  await new Promise(resolve=>{idle.once('connect',resolve);idle.once('error',resolve);});
  const deadline=setTimeout(()=>{fail('shutdown exceeded 5s with an idle browser socket');child.kill('SIGKILL');},5000);
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  clearTimeout(deadline);idle.destroy();
  if (code !== 0) fail(`server exit code ${code} signal ${signal}`);
  else console.log('shutdown: clean exit on SIGTERM');
}

// Production build with a DUMMY key and info logging.
// A credential in the request URL and the configured key must not appear in
// stdout/stderr or in API responses. The dummy is never a real credential.
{
  const DUMMY = 'SMOKE-DUMMY-not-a-real-key-7f3a9c21';
  const OTHER = 'SMOKE-DUMMY-url-credential-5b8e';
  const logs = [];
  const keyed = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, DATA_DIR: isolatedData, PORT: port, HOST: '127.0.0.1', LOG_LEVEL: 'info', COINGECKO_API_KEY: DUMMY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  keyed.stdout.on('data', (d) => logs.push(String(d)));
  keyed.stderr.on('data', (d) => logs.push(String(d)));
  const keyedExit = new Promise((res) => keyed.on('exit', (code) => res(code)));
  try {
    const health = await waitForHealth();
    if (health.provider.apiKeyConfigured !== true) fail('dummy key not detected as configured');
    const res = await fetch(`${base}/api/health?x_cg_pro_api_key=${OTHER}&apikey=${DUMMY}`);
    const body = await res.text();
    if (body.includes(DUMMY) || body.includes(OTHER)) fail('API response contains a credential');
  } catch (err) {
    fail(err.message);
  } finally {
    keyed.kill('SIGTERM');
    const code = await keyedExit;
    if (code !== 0) fail(`keyed server exit code ${code}`);
  }
  const out = logs.join('');
  if (!out.includes('/api/health?')) fail('request log line missing (redaction check would be vacuous)');
  if (out.includes(DUMMY) || out.includes(OTHER)) fail('server logs contain a credential');
  else console.log(`redaction: dummy key and URL credential absent from ${out.split('\n').filter(Boolean).length} log line(s) and responses`);
}

console.log(process.exitCode ? 'SMOKE: FAILED' : 'SMOKE: PASSED');
