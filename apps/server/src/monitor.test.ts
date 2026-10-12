import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FetchLike } from '@volumechecker/coingecko';
import type { HealthResponse, InspectionSnapshot } from '@volumechecker/shared';
import { FakeSocket, handshake } from '../../../tests/helpers/fake-socket';
import { g2Frame, g3Frame, ohlcvResponse, poolMetadata, restTrade, tradesResponse, LINK } from '../../../tests/fixtures/synthetic/coingecko';
import { ACTION_HEADER, buildApp } from './app';
import { loadAppConfig } from './config';
import { InspectionMonitor } from './monitor';

// Offline integration: synthetic REST responses + in-memory WebSocket. No network, no real key.
const configPath = fileURLToPath(new URL('../../../config/legacy-v0.json', import.meta.url));
const KEY = 'TEST-DUMMY-monitor-key-0123456789';

type Routes = { metadata?: () => Response; trades?: () => Response; ohlcv?: () => Response };

function fakeProvider(routes: Routes = {}) {
  const calls: string[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/trades')) return (routes.trades ?? (() => json(tradesResponse())))();
    if (url.pathname.endsWith('/ohlcv/minute')) return (routes.ohlcv ?? (() => json(ohlcvResponse())))();
    return (routes.metadata ?? (() => json(poolMetadata())))();
  };
  const sockets: FakeSocket[] = [];
  const socketFactory = (url: string, headers: Record<string, string>) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    return s;
  };
  return { fetchImpl, socketFactory, calls, sockets };
}

const logs: string[] = [];
const logDestination = { write: (l: string) => void logs.push(l) };

async function until(app: FastifyInstance, pred: (s: InspectionSnapshot) => boolean): Promise<InspectionSnapshot> {
  for (let i = 0; i < 100; i++) {
    const s = (await app.inject({ method: 'GET', url: '/api/inspection' })).json<InspectionSnapshot>();
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not reached');
}

const start = (app: FastifyInstance, headers: Record<string, string> = { [ACTION_HEADER]: '1' }) =>
  app.inject({ method: 'POST', url: '/api/inspection/start', headers, payload:{poolId:'eth:0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8'} });

describe('inspection monitor (offline integration)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    logs.length = 0;
  });

  it('is blocked without a key and makes no provider calls', async () => {
    const p = fakeProvider();
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: undefined, logLevel: 'silent', ...p });
    expect((await start(app)).statusCode).toBe(409);
    const s = (await app.inject({ method: 'GET', url: '/api/inspection' })).json<InspectionSnapshot>();
    expect(s.monitor).toBe('blocked');
    expect(s.monitorDetail).toMatch(/COINGECKO_API_KEY is not configured/);
    expect(p.calls).toHaveLength(0);
    expect(p.sockets).toHaveLength(0);
  });

  it('guards mutation routes against cross-site and rebinding requests', async () => {
    const p = fakeProvider();
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'silent', ...p });
    expect((await start(app, {})).statusCode).toBe(403);
    expect((await start(app, { [ACTION_HEADER]: '1', host: 'evil.example:8787' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/inspection/stop', headers: {} })).statusCode).toBe(403);
    expect(p.calls).toHaveLength(0);
  });

  it('runs the probe sequence, verifies orientation, then streams G2/G3 with honest indicators', async () => {
    const p = fakeProvider();
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'info', logDestination, ...p });
    await start(app);
    await start(app); // idempotent
    let s = await until(app, (x) => x.monitor === 'running');
    expect(p.calls.map((c) => c.split('/').at(-1))).toEqual([expect.stringMatching(/^0x/), 'trades', 'minute']);
    expect(p.sockets).toHaveLength(1);
    expect(s.orientation).toMatchObject({ status: 'verified', trackedTokenSide: 'base', baseTokenAddress: LINK });
    expect(s.trades.filter((t) => t.source === 'rest').map((t) => t.side)).toEqual(['buy', 'sell']);
    expect(s.latestPrice).toMatchObject({ source: 'rest-pool-metadata', priceUsd: '15.00' });
    expect(s.reserve?.reserveUsd).toBe('12345678.90');
    expect(s.indicators.transport.state).not.toBe('ok'); // not subscribed yet
    expect(s.indicators.tradeInactivity.state).toBe('unknown');
    expect(s.checks.find((c) => c.id === 'rest.kind_vs_addresses')?.status).toBe('pass');

    const sock = p.sockets[0]!;
    expect(sock.headers).toEqual({ 'x-cg-pro-api-key': KEY });
    handshake(sock);
    s = await until(app, (x) => x.transport.state === 'streaming');
    // Handshake alone is not a working market stream.
    expect(s.capabilities.find((c) => c.id === 'ws.onchain_trade.data')?.status).toBe('pending');
    expect(s.indicators.tradeInactivity.detail).toMatch(/waiting for the first live trade/);

    // Observed live behaviour: the latest existing trade/candle is replayed on subscribe.
    sock.msg(g2Frame({ pu: 15.01, t: Date.now() - 600_000 }));
    s = await until(app, (x) => x.trades.some((t) => t.delivery === 'subscription-replay'));
    expect(s.capabilities.find((c) => c.id === 'ws.onchain_trade.data')?.status).toBe('pending');
    expect(s.indicators.tradeInactivity.state).not.toBe('ok');
    const oldCandleOpen = Math.floor(Date.now() / 60_000) * 60 - 600;
    sock.msg(g3Frame({ to: 'base', t: oldCandleOpen, c: 99 }));
    s = await until(app, (x) => x.candles.some((c) => c.openTimeSec === oldCandleOpen));
    expect(s.latestPrice?.priceUsd).not.toBe('99'); // replayed old candle close is not the current price

    const nowMs = Date.now();
    const candleOpen = Math.floor(nowMs / 60_000) * 60;
    sock.msg(g2Frame({ pu: 15.01, t: nowMs }));
    sock.msg(g3Frame({ to: 'base', t: candleOpen }));
    sock.msg(g3Frame({ to: 'base', t: candleOpen, c: 15.2 })); // same open time replaces the candle
    sock.emit('ping');
    s = await until(app, (x) => x.trades.some((t) => t.delivery === 'live'));
    const ws = s.trades.find((t) => t.delivery === 'live')!;
    expect(ws).toMatchObject({ source: 'ws', side: 'buy', trackedAmount: '100', providerTimeMs: nowMs, blockTimestamp: null });
    expect(s.capabilities.find((c) => c.id === 'ws.onchain_trade.data')?.status).toBe('ok');
    expect(s.capabilities.find((c) => c.id === 'ws.onchain_ohlcv.data')?.status).toBe('ok');
    const wsCandles = s.candles.filter((c) => c.source === 'ws' && c.openTimeSec === candleOpen);
    expect(wsCandles).toHaveLength(1);
    expect(wsCandles[0]).toMatchObject({ close: '15.2', updates: 2 });
    expect(s.checks.find((c) => c.id === 'ws.pu_meaning')?.status).toBe('pass');
    expect(s.checks.find((c) => c.id === 'ws.ohlcv_token_side')?.status).toBe('pass');
    expect(s.indicators.transport.state).toBe('ok');
    expect(s.indicators.priceFreshness.state).toBe('ok');
    expect(s.indicators.tradeInactivity.state).toBe('ok');
    expect(s.rawSamples.find((r) => r.kind === 'ws_trade')?.rawText).toContain('"c":"G2"');

    const health = (await app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
    expect(health.provider).toMatchObject({ apiKeyConfigured: true, restStatus: 'ok', wsStatus: 'streaming' });

    // Frames for another pool are ignored, not mixed in.
    sock.msg(g2Frame({ pa: '0x' + '9'.repeat(40) }));
    s = await until(app, (x) => x.errors.some((e) => e.message.includes('ignored G2 frame')));
    expect(s.trades.filter((t) => t.source === 'ws')).toHaveLength(2);

    await app.inject({ method: 'POST', url: '/api/inspection/stop', headers: { [ACTION_HEADER]: '1' } });
    s = await until(app, (x) => x.monitor === 'idle');
    expect(s.transport.state).toBe('disconnected');
    expect(logs.join('')).not.toContain(KEY);
  });

  it('with LINK as quote, inverts G2 direction and subscribes G3 to the quote side', async () => {
    const p = fakeProvider({ metadata: () => new Response(JSON.stringify(poolMetadata({ trackedTokenSide: 'quote' }))) });
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'silent', ...p });
    await start(app);
    await until(app, (x) => x.monitor === 'running');
    const sock = p.sockets[0]!;
    handshake(sock);
    const g3SetPools = sock.sent.map((m) => JSON.parse(m)).find((m) => m.command === 'message' && m.identifier.includes('OHLCV'));
    expect(JSON.parse(g3SetPools.data).token).toBe('quote');
    sock.msg(g2Frame({ ty: 'b', to: 0.5, toq: 100, pu: 3000, t: Date.now() }));
    const s = await until(app, (x) => x.trades.some((t) => t.source === 'ws'));
    expect(s.trades.find((t) => t.source === 'ws')).toMatchObject({ side: 'sell', trackedAmount: '100', trackedPriceUsd: null });
  });

  it('blocks without opening a socket when orientation cannot be verified (no fallback pool)', async () => {
    const other = '0x' + '2'.repeat(40);
    const p = fakeProvider({ metadata: () => new Response(JSON.stringify(poolMetadata({ base: LINK, quote: other }))) });
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'silent', ...p });
    await start(app);
    const s = await until(app, (x) => x.monitor === 'blocked');
    expect(s.orientation.status).toBe('failed');
    expect(p.sockets).toHaveLength(0);
    expect(p.calls).toHaveLength(1);
    expect(s.capabilities.find((c) => c.id === 'ws.connect')?.status).toBe('unavailable');
  });

  it('stops on authentication failure without retries and without leaking the key', async () => {
    const p = fakeProvider({ metadata: () => new Response(`{"status":{"error_code":401,"error_message":"invalid key ${KEY}"}}`, { status: 401 }) });
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'info', logDestination, ...p });
    await start(app);
    const s = await until(app, (x) => x.monitor === 'blocked');
    expect(s.monitorDetail).toMatch(/Authentication failed/);
    expect(s.capabilities.find((c) => c.id === 'rest.pool_metadata')).toMatchObject({ status: 'failed', httpStatus: 401 });
    expect(p.sockets).toHaveLength(0);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(logs.join('')).not.toContain(KEY);
  });

  it('marks a 404 capability unavailable and keeps other capabilities running', async () => {
    const p = fakeProvider({ trades: () => new Response('{"errors":[{"status":"404"}]}', { status: 404 }) });
    app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: KEY, logLevel: 'silent', ...p });
    await start(app);
    const s = await until(app, (x) => x.monitor === 'running');
    expect(s.capabilities.find((c) => c.id === 'rest.trades')).toMatchObject({ status: 'unavailable', httpStatus: 404 });
    expect(s.capabilities.find((c) => c.id === 'rest.ohlcv_minute')?.status).toBe('ok');
  });
});

describe('stream delivery cross-check', () => {
  const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; }, level: 'silent', silent() {} } as never;

  it('reports "stream behind REST" instead of "no recent trades", and clears once the WebSocket delivers', async () => {
    let clock = Date.parse('2026-10-02T11:07:00Z');
    const tx = '0x' + 'cd'.repeat(32);
    let trades = tradesResponse([restTrade({ side: 'buy', id: 'eth_1_old_1_1' })]);
    const p = fakeProvider({ trades: () => new Response(JSON.stringify(trades)) });
    const monitor = new InspectionMonitor({ config: loadAppConfig(configPath).config, apiKey: KEY, log: silentLog, now: () => clock, fetchImpl: p.fetchImpl, socketFactory: p.socketFactory });
    await monitor.start();
    handshake(p.sockets[0]!); // subscribed at 11:07:00Z

    // A sell happens at 11:26:35Z; REST lists it, the socket stays silent.
    trades = tradesResponse([{ ...restTrade({ side: 'sell', id: `eth_2_${tx}_1_1`, tx }), attributes: { ...restTrade({ side: 'sell', tx }).attributes, block_timestamp: '2026-10-02T11:26:35Z' } }]);
    clock = Date.parse('2026-10-02T11:27:00Z'); // only 25 s later: within grace
    await monitor.crossCheckTrades();
    expect(monitor.snapshot().indicators.tradeInactivity.state).not.toBe('stale');

    clock = Date.parse('2026-10-02T11:28:47Z');
    await monitor.crossCheckTrades();
    let s = monitor.snapshot();
    expect(s.indicators.tradeInactivity.state).toBe('stale');
    expect(s.indicators.tradeInactivity.detail).toMatch(/Stream behind REST/);
    expect(s.checks.find((c) => c.id === 'ws.delivery_vs_rest')?.status).toBe('fail');
    expect(s.trades.some((t) => t.source === 'rest' && t.txHash === tx)).toBe(true);
    expect(s.errors.some((e) => e.kind === 'stream_lag')).toBe(true);

    // The WebSocket finally delivers it 2 min 48 s late.
    clock = Date.parse('2026-10-02T11:29:23.599Z');
    p.sockets[0]!.msg(g2Frame({ tx, ty: 's', t: Date.parse('2026-10-02T11:26:35Z') }));
    await monitor.crossCheckTrades();
    s = monitor.snapshot();
    expect(s.checks.find((c) => c.id === 'ws.delivery_vs_rest')?.status).toBe('pass');
    const ws = s.trades.find((t) => t.source === 'ws' && t.txHash === tx)!;
    expect(ws.delivery).toBe('live');
    expect(ws.deliveryLagMs).toBe(168_599);
    expect(s.indicators.tradeInactivity.state).not.toBe('ok');
    expect(s.indicators.tradeInactivity.lastAt).toBe('2026-10-02T11:26:35.000Z');
    expect(s.checks.find((c) => c.id === 'ws.delivery_latency')?.status).toBe('fail');
    monitor.stop();
  });
});

