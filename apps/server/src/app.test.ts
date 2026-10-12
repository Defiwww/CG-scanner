import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse, PoolIdentityResponse } from '@volumechecker/shared';
import { buildApp } from './app';
import { loadAppConfig, parseEnv } from './config';

const configPath = fileURLToPath(new URL('../../../config/legacy-v0.json', import.meta.url));
const FAKE_KEY = 'TEST-ONLY-not-a-real-key-0123456789';

describe('server app (offline)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('starts and serves health without a CoinGecko key', async () => {
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: undefined, logLevel: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<HealthResponse>();
    expect(body.status).toBe('ok');
    expect(body.provider).toEqual({ apiKeyConfigured: false, restStatus: 'not_connected', wsStatus: 'disconnected' });
    expect(body.config.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.config.liveAlertsEnabled).toBe(false);
  });

  it('serves the fixed pool identity with orientation unverified (never from config)', async () => {
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: undefined, logLevel: 'silent' });
    const body = (await app.inject({ method: 'GET', url: '/api/pool' })).json<PoolIdentityResponse>();
    expect(body.poolAddress).toBe('0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8');
    expect(body.orientationStatus).toBe('unverified');
    expect(body.source).toBe('fixed-contract');
  });

  it('never exposes the key value through the API', async () => {
    const env = parseEnv({ COINGECKO_API_KEY: FAKE_KEY });
    app = await buildApp({
      loaded: loadAppConfig(configPath),
      apiKey: env.COINGECKO_API_KEY,
      logLevel: 'silent',
    });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    const pool = await app.inject({ method: 'GET', url: '/api/pool' });
    expect(health.json<HealthResponse>().provider.apiKeyConfigured).toBe(true);
    expect(health.body).not.toContain(FAKE_KEY);
    expect(pool.body).not.toContain(FAKE_KEY);
  });

  it('config hash is stable across loads', () => {
    expect(loadAppConfig(configPath).hash).toBe(loadAppConfig(configPath).hash);
  });

  it('returns 404, not the dashboard, for bare /api and unknown /api paths', async () => {
    const webDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url));
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: undefined, logLevel: 'silent', webDistDir });
    for (const url of ['/api', '/api?x=1', '/api/unknown']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});

it('rejects hostile local read hosts/origins while preserving same-origin API and development access',async()=>{
 const app=await buildApp({loaded:loadAppConfig(configPath),apiKey:FAKE_KEY,logLevel:'silent'});
 try {
  for(const headers of [{host:'evil.test'},{host:'localhost:8787',origin:'https://evil.test'},{host:'localhost:8787','sec-fetch-site':'cross-site'}])expect((await app.inject({url:'/api/inspection',headers})).statusCode).toBe(403);
  for(const host of ['localhost:8787','127.0.0.1:8787','[::1]:8787'])expect((await app.inject({url:'/api/health',headers:{host,origin:`http://${host}`}})).statusCode).toBe(200);
  const r=await app.inject({url:'/api/health',headers:{host:'localhost:5173',origin:'http://localhost:5173'}});expect(r.statusCode).toBe(200);expect(r.headers['content-security-policy']).toContain("connect-src 'self'");expect(r.body).not.toContain(FAKE_KEY);
 } finally {await app.close();}
});

it('limits local commands without requiring ngrok and keeps read APIs available',async()=>{
 const app=await buildApp({loaded:loadAppConfig(configPath),apiKey:undefined,logLevel:'silent'});
 try {
  const request={method:'POST' as const,url:'/api/inspection/stop',headers:{host:'localhost:8787','x-volumechecker-action':'1'},payload:{}};
  for(let i=0;i<10;i++)expect((await app.inject(request)).statusCode).toBe(200);
  expect((await app.inject(request)).statusCode).toBe(429);
  expect((await app.inject('/api/health')).statusCode).toBe(200);
 } finally {await app.close();}
});
