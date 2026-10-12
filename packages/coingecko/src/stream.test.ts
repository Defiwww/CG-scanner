import { describe, expect, it } from 'vitest';
import { FIXED_POOL } from '@volumechecker/shared';
import { g2Frame, g3Frame } from '../../../tests/fixtures/synthetic/coingecko';
import type { ProviderError } from './errors';
import { FakeSocket, handshake } from '../../../tests/helpers/fake-socket';
import { CoinGeckoStream, type Timers } from './stream';

const KEY = 'TEST-DUMMY-ws-key-0123456789';
const P = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8';

class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private pending = new Map<number, { at: number; cb: () => void }>();
  setTimeout(cb: () => void, ms: number) {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, cb });
    return id;
  }
  clearTimeout(h: unknown) {
    this.pending.delete(h as number);
  }
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].cb();
    }
    this.now = target;
  }
}

function setup(trackedTokenSide: 'base' | 'quote' = 'base') {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const stream = new CoinGeckoStream({
    apiKey: KEY,
    pool: FIXED_POOL,
    trackedTokenSide,
    backoffSec: [1, 2, 4],
    jitterFraction: 0,
    silenceTimeoutMs: 30_000,
    stepTimeoutMs: 15_000,
    timers,
    now: () => timers.now,
    random: () => 0.5,
    socketFactory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  });
  const states: string[] = [];
  const errors: ProviderError[] = [];
  const frames: string[] = [];
  stream.on('state', (s) => states.push(s));
  stream.on('error', (e) => errors.push(e));
  stream.on('frame', (f) => frames.push(f.kind));
  return { stream, sockets, timers, states, errors, frames };
}

describe('CoinGeckoStream protocol', () => {
  it('connects to the fixed URL with the key only in the header', () => {
    const { stream, sockets } = setup();
    stream.start();
    stream.start(); // idempotent
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://stream.coingecko.com/v1');
    expect(sockets[0]!.headers).toEqual({ 'x-cg-pro-api-key': KEY });
  });

  it('serializes subscriptions: G2 subscribe → confirm → set_pools → 2000 → G3 subscribe → confirm → set_pools(1m, LINK side) → 2000', () => {
    const { stream, sockets, states } = setup('quote');
    stream.start();
    const s = sockets[0]!;
    s.emit('open');
    expect(s.sent).toHaveLength(0);
    s.msg({ type: 'welcome' });
    expect(JSON.parse(s.sent[0]!)).toEqual({ command: 'subscribe', identifier: '{"channel":"OnchainTrade"}' });
    s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainOHLCV"}' }); // wrong channel is ignored
    expect(s.sent).toHaveLength(1);
    s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainTrade"}' });
    expect(JSON.parse(JSON.parse(s.sent[1]!).data)).toMatchObject({ action: 'set_pools', 'network_id:pool_addresses': [`eth:${P}`] });
    expect(s.sent).toHaveLength(2); // G3 waits for the G2 set_pools result
    s.msg({ code: 2000, message: 'ok' });
    expect(JSON.parse(s.sent[2]!)).toEqual({ command: 'subscribe', identifier: '{"channel":"OnchainOHLCV"}' });
    s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainOHLCV"}' });
    expect(JSON.parse(JSON.parse(s.sent[3]!).data)).toEqual({ 'network_id:pool_addresses': [`eth:${P}`], interval: '1m', token: 'quote', action: 'set_pools' });
    s.msg({ code: 2000, message: 'ok' });
    expect(states.at(-1)).toBe('streaming');
    expect(s.sent.join('')).not.toContain(KEY);
  });

  it('emits market frames and heartbeats separately', () => {
    const { stream, sockets, frames } = setup();
    const beats: string[] = [];
    stream.on('heartbeat', (k) => beats.push(k));
    stream.start();
    handshake(sockets[0]!);
    sockets[0]!.msg(g2Frame());
    sockets[0]!.msg(g3Frame());
    sockets[0]!.emit('ping');
    sockets[0]!.msg({ type: 'ping', message: 1 });
    expect(frames.filter((k) => k === 'trade' || k === 'candle')).toEqual(['trade', 'candle']);
    expect(beats).toEqual(['ws-ping', 'json-ping']);
  });

  it('reconnects with backoff and re-runs the whole subscription procedure', () => {
    const { stream, sockets, timers, states } = setup();
    stream.start();
    handshake(sockets[0]!);
    sockets[0]!.terminate();
    expect(states.at(-1)).toBe('reconnecting');
    timers.advance(999);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);
    const s2 = sockets[1]!;
    s2.emit('open');
    s2.msg({ type: 'welcome' });
    expect(JSON.parse(s2.sent[0]!).command).toBe('subscribe');
    expect(stream.reconnectCount).toBe(1);
  });

  it('stops retrying after a 401/403 handshake', () => {
    const { stream, sockets, timers, states, errors } = setup();
    stream.start();
    sockets[0]!.emit('unexpected-response', {}, { statusCode: 401 });
    timers.advance(120_000);
    expect(sockets).toHaveLength(1);
    expect(states).toContain('auth_failed');
    expect(errors[0]).toMatchObject({ kind: 'auth', httpStatus: 401 });
    expect(JSON.stringify(errors.map((e) => e.toJSON()))).not.toContain(KEY);
  });

  it('declares the connection dead after silence and when a protocol step times out', () => {
    const { stream, sockets, timers, errors } = setup();
    stream.start();
    sockets[0]!.emit('open');
    timers.advance(15_000); // no welcome
    expect(errors.at(-1)).toMatchObject({ kind: 'protocol' });
    expect(sockets[0]!.closed).toBe(true);
    timers.advance(1_000);
    handshake(sockets[1]!);
    timers.advance(29_999);
    expect(sockets[1]!.closed).toBe(false);
    sockets[1]!.emit('ping');
    timers.advance(29_999);
    expect(sockets[1]!.closed).toBe(false);
    timers.advance(1);
    expect(sockets[1]!.closed).toBe(true);
    expect(errors.at(-1)).toMatchObject({ kind: 'timeout', operation: 'ws.heartbeat' });
  });

  it('reports a rejected subscription and a failed set_pools result', () => {
    const { stream, sockets, errors } = setup();
    stream.start();
    const s = sockets[0]!;
    s.emit('open');
    s.msg({ type: 'welcome' });
    s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainTrade"}' });
    s.msg({ code: 4003, message: 'Invalid pool' });
    expect(errors.at(-1)).toMatchObject({ kind: 'protocol' });
    s.msg({ type: 'reject_subscription', identifier: '{"channel":"OnchainTrade"}' });
    expect(errors.at(-1)!.message).toMatch(/rejected/);
  });

  it('stop() closes without reconnecting', () => {
    const { stream, sockets, timers } = setup();
    stream.start();
    handshake(sockets[0]!);
    stream.stop();
    timers.advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});

it('delivery recovery uses normal reconnect backoff and Stop cancels pending recovery',async()=>{const {stream,sockets,timers}=setup();stream.start();handshake(sockets[0]!);stream.recoverDelivery();expect(sockets).toHaveLength(1);timers.advance(1000);expect(sockets).toHaveLength(2);handshake(sockets[1]!);stream.recoverDelivery();await stream.stop();timers.advance(30000);expect(sockets).toHaveLength(2);});
