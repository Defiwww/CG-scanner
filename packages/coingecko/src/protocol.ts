import { FIXED_POOL, type TrackedTokenSide, type PoolConfig } from '@volumechecker/shared';
import { WS_CHANNELS, type WsChannelName } from './constants';

/**
 * CoinGecko WebSocket protocol envelope (docs, 2026-09-30). `identifier` and
 * `data` are JSON STRINGS inside the JSON envelope; both are produced with
 * JSON.stringify, never by string concatenation.
 */

export const POOL_LOOKUP = `${FIXED_POOL.networkId}:${FIXED_POOL.poolAddress}`;

export function getPoolLookup(pool: PoolConfig): string {
  return `${pool.networkId}:${pool.poolAddress}`;
}

export function channelIdentifier(channel: WsChannelName): string {
  return JSON.stringify({ channel });
}

export function subscribeCommand(channel: WsChannelName): string {
  return JSON.stringify({ command: 'subscribe', identifier: channelIdentifier(channel) });
}

export function setPoolsCommand(channel: WsChannelName, opts: { pool?: PoolConfig; trackedTokenSide?: TrackedTokenSide } = {}): string {
  const poolLookup = opts.pool ? getPoolLookup(opts.pool) : POOL_LOOKUP;
  const data =
    channel === WS_CHANNELS.ohlcv
      ? (() => {
          if (!opts.trackedTokenSide) throw new Error('OnchainOHLCV set_pools requires the verified tracked token side');
          return { 'network_id:pool_addresses': [poolLookup], interval: '1m', token: opts.trackedTokenSide, action: 'set_pools' };
        })()
      : { 'network_id:pool_addresses': [poolLookup], action: 'set_pools' };
  return JSON.stringify({ command: 'message', identifier: channelIdentifier(channel), data: JSON.stringify(data) });
}

export type ClassifiedFrame =
  | { kind: 'connection_established'; code: number; message: string | null }
  | { kind: 'welcome' }
  | { kind: 'confirm_subscription'; channel: string | null }
  | { kind: 'reject_subscription'; channel: string | null }
  | { kind: 'pools_result'; code: number; ok: boolean; message: string | null }
  | { kind: 'heartbeat'; source: 'json-ping' }
  | { kind: 'disconnect'; reason: string | null; reconnect: boolean | null }
  | { kind: 'provider_error'; code: number | null; message: string | null }
  | { kind: 'trade'; payload: Record<string, unknown> }
  | { kind: 'candle'; payload: Record<string, unknown> }
  | { kind: 'unknown'; payload: unknown }
  | { kind: 'unparseable' };

function channelOf(identifier: unknown): string | null {
  if (typeof identifier !== 'string') return null;
  try {
    const parsed = JSON.parse(identifier) as { channel?: unknown };
    return typeof parsed.channel === 'string' ? parsed.channel : null;
  } catch {
    return null;
  }
}

/** Classifies one decoded frame object. Market data is separated from control/heartbeat frames. */
export function classifyObject(obj: unknown): ClassifiedFrame {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { kind: 'unknown', payload: obj };
  const o = obj as Record<string, unknown>;
  if (o.c === 'G2') return { kind: 'trade', payload: o };
  if (o.ch === 'G3') return { kind: 'candle', payload: o };
  const message = typeof o.message === 'string' ? o.message : null;
  switch (o.type) {
    case 'welcome':
      return { kind: 'welcome' };
    case 'confirm_subscription':
      return { kind: 'confirm_subscription', channel: channelOf(o.identifier) };
    case 'reject_subscription':
      return { kind: 'reject_subscription', channel: channelOf(o.identifier) };
    case 'ping':
      return { kind: 'heartbeat', source: 'json-ping' };
    case 'disconnect':
      return { kind: 'disconnect', reason: typeof o.reason === 'string' ? o.reason : null, reconnect: typeof o.reconnect === 'boolean' ? o.reconnect : null };
    default:
      break;
  }
  if (typeof o.code === 'number') {
    if (o.code === 3000) return { kind: 'connection_established', code: o.code, message };
    if (o.code >= 2000 && o.code < 3000) return { kind: 'pools_result', code: o.code, ok: o.code === 2000, message };
    return { kind: 'provider_error', code: o.code, message };
  }
  if (o.type === 'error' || typeof o.error === 'string') {
    return { kind: 'provider_error', code: null, message: typeof o.error === 'string' ? o.error : message };
  }
  return { kind: 'unknown', payload: o };
}

/** Decodes a text frame. A JSON array is treated as a batch of frames. */
export function classifyText(text: string): ClassifiedFrame[] {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return [{ kind: 'unparseable' }];
  }
  return Array.isArray(obj) ? obj.map(classifyObject) : [classifyObject(obj)];
}
