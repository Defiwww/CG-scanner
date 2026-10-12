import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ALLOWED_POOLS, type HealthResponse, type InspectionSnapshot } from '@volumechecker/shared';
import type { FetchLike } from '@volumechecker/coingecko';
import { buildApp, ACTION_HEADER } from './app';
import { loadAppConfig } from './config';
import { PUBLIC_READS_PER_MINUTE } from './demo-access';
import { loadLifetime } from './lifetime';
import { FakeSocket } from '../../../tests/helpers/fake-socket';
import { ohlcvResponse, poolMetadata, tradesResponse } from '../../../tests/fixtures/synthetic/coingecko';

const loaded = loadAppConfig(new URL('../../../config/legacy-v0.json', import.meta.url).pathname);
const eth = ALLOWED_POOLS[0]!;
const poolId = `${eth.networkId}:${eth.poolAddress}`;
const headers = { [ACTION_HEADER]: '1' };
const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vc-lifetime-'));
  dirs.push(d);
  return d;
};
function provider() {
  const calls: string[] = [];
  const sockets: FakeSocket[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url.toString());
    return new Response(JSON.stringify(url.pathname.endsWith('/trades') ? tradesResponse() : url.pathname.endsWith('/minute') ? ohlcvResponse() : poolMetadata()));
  };
  return { calls, sockets, fetchImpl, socketFactory: (url: string, h: Record<string, string>) => { const s = new FakeSocket(url, h); sockets.push(s); return s; } };
}
const health = async (a: FastifyInstance) => (await a.inject('/api/health')).json<HealthResponse>();
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 400; n++) { if (await check()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('condition not reached');
}

it('stops the collector, provider requests and commands when the fixed window ends, and stays stopped after a restart', async () => {
  const databasePath = join(tempDir(), 'db.sqlite');
  const p = provider();
  const lifetime = { startedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 400 };
  const a = await buildApp({ loaded, apiKey: 'DUMMY-ONLY-LIFETIME', logLevel: 'silent', databasePath, lifetime, fetchImpl: p.fetchImpl, socketFactory: p.socketFactory });
  apps.push(a);
  expect((await a.inject({ method: 'POST', url: '/api/inspection/start', headers, payload: { poolId } })).statusCode).toBe(202);
  await until(async () => p.calls.length > 0);
  expect((await health(a)).lifetime).toMatchObject({ expired: false, collectorActive: true, expiresAt: new Date(lifetime.expiresAtMs).toISOString() });

  await until(async () => { const l = (await health(a)).lifetime!; return l.expired && !l.collectorActive; });
  const callsAtExpiry = p.calls.length;
  await new Promise((r) => setTimeout(r, 150));
  expect(p.calls.length).toBe(callsAtExpiry);
  expect((await a.inject('/api/inspection')).json<InspectionSnapshot>().activePoolId).toBeNull();
  for (const url of ['/api/inspection/start', '/api/replay', '/api/synthetic-demo']) {
    expect((await a.inject({ method: 'POST', url, headers, payload: { poolId } })).statusCode).toBe(410);
  }
  expect((await a.inject(`/api/analysis?poolId=${poolId}`)).statusCode).toBe(200);
  await a.close();
  apps.length = 0;

  // The desired state is still "collecting", yet a restart inside an ended window must not resume it.
  const q = provider();
  const b = await buildApp({ loaded, apiKey: 'DUMMY-ONLY-LIFETIME', logLevel: 'silent', databasePath, lifetime, fetchImpl: q.fetchImpl, socketFactory: q.socketFactory });
  apps.push(b);
  await new Promise((r) => setTimeout(r, 100));
  expect(q.calls.length).toBe(0);
  expect(q.sockets.length).toBe(0);
  expect((await health(b)).lifetime).toMatchObject({ expired: true, collectorActive: false });
});

it('resumes the saved collection after a restart inside the window without changing its end', async () => {
  const databasePath = join(tempDir(), 'db.sqlite');
  const lifetime = { startedAtMs: Date.now(), expiresAtMs: Date.now() + 3_600_000 };
  const p = provider();
  const a = await buildApp({ loaded, apiKey: 'DUMMY-ONLY-LIFETIME', logLevel: 'silent', databasePath, lifetime, fetchImpl: p.fetchImpl, socketFactory: p.socketFactory });
  apps.push(a);
  await a.inject({ method: 'POST', url: '/api/inspection/start', headers, payload: { poolId } });
  await until(async () => p.calls.length > 0);
  await a.close();
  apps.length = 0;
  const q = provider();
  const b = await buildApp({ loaded, apiKey: 'DUMMY-ONLY-LIFETIME', logLevel: 'silent', databasePath, lifetime, fetchImpl: q.fetchImpl, socketFactory: q.socketFactory });
  apps.push(b);
  await until(async () => q.calls.length > 0);
  expect((await health(b)).lifetime).toMatchObject({ expired: false, collectorActive: true, expiresAt: new Date(lifetime.expiresAtMs).toISOString() });
});

it('reads the window from a file and refuses a missing or invalid one', () => {
  const dir = tempDir();
  const file = join(dir, 'lifetime.json');
  writeFileSync(file, JSON.stringify({ started_at: '2026-10-09T10:00:00Z', expires_at: '2026-10-23T10:00:00Z' }));
  const l = loadLifetime(file)!;
  expect(l.expiresAtMs - l.startedAtMs).toBe(14 * 24 * 3600 * 1000);
  expect(loadLifetime(undefined)).toBeUndefined();
  expect(() => loadLifetime(join(dir, 'absent.json'))).toThrow();
  writeFileSync(file, JSON.stringify({ started_at: '2026-10-23T10:00:00Z', expires_at: '2026-10-09T10:00:00Z' }));
  expect(() => loadLifetime(file)).toThrow();
});

it('limits public reads per client address', async () => {
  const demoAccess = { origin: 'https://exact-demo.example', port: 8787 };
  const h = { host: 'exact-demo.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' };
  const a = await buildApp({ loaded, apiKey: undefined, logLevel: 'silent', demoAccess });
  apps.push(a);
  for (let i = 0; i < PUBLIC_READS_PER_MINUTE; i++) expect((await a.inject({ url: '/api/pools', headers: h })).statusCode).toBe(200);
  const limited = await a.inject({ url: '/api/pools', headers: h });
  expect(limited.statusCode).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect((await a.inject({ url: '/api/pools', headers: { ...h, 'x-forwarded-for': '203.0.113.10' } })).statusCode).toBe(200);
});
