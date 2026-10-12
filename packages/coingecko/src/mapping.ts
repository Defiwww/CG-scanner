import {
  FIXED_POOL,
  type CandleObservation,
  type TrackedTokenSide,
  type TradeSide,
  type PoolConfig,
  type PriceObservation,
  type TradeObservation,
} from '@volumechecker/shared';
import type { G2Trade, G3Candle, RestTrade } from './schemas';

/**
 * Field mappings from provider payloads to observations relative to tracked token.
 * Direction is never taken from a provider label alone:
 *  - REST: derived from from/to token addresses (tracked token received = buy).
 *  - WS G2: `ty` is documented relative to the BASE token, so it is inverted
 *    when verified orientation says tracked token is the quote token.
 * Timestamp units: WS G2 `t` = ms (provider update time); WS G3 `t` = seconds
 * (candle open); REST `block_timestamp` = ISO string; OHLCV rows = seconds.
 */

/** JSON number → decimal string (JS shortest round-trip form). Non-finite/null → null. */
export function numberToDecimal(n: number | null | undefined): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : null;
}

export interface RestTradeMapping {
  trade: TradeObservation;
  /** Whether the provider `kind` label agrees with the address-derived tracked token side (null if not comparable). */
  labelAgrees: boolean | null;
}

export function mapRestTrade(t: RestTrade, receivedAt: string, pool: PoolConfig = FIXED_POOL): RestTradeMapping {
  const a = t.attributes;
  const from = a.from_token_address?.toLowerCase() ?? null;
  const to = a.to_token_address?.toLowerCase() ?? null;
  const tracked = pool.baseAddress;
  const counter = pool.quoteAddress;

  let side: TradeSide | null = null;
  let trackedAmount: string | null = null;
  let counterAmount: string | null = null;
  let trackedPriceUsd: string | null = null;
  if (to === tracked && from === counter) {
    side = 'buy';
    trackedAmount = a.to_token_amount;
    counterAmount = a.from_token_amount;
    trackedPriceUsd = a.price_to_in_usd;
  } else if (from === tracked && to === counter) {
    side = 'sell';
    trackedAmount = a.from_token_amount;
    counterAmount = a.to_token_amount;
    trackedPriceUsd = a.price_from_in_usd;
  }
  const kind = a.kind?.toLowerCase() ?? null;
  const labelAgrees = side === null || (kind !== 'buy' && kind !== 'sell') ? null : kind === side;

  return {
    labelAgrees,
    trade: {
      source: 'rest',
      delivery: 'rest',
      deliveryLagMs: null,
      providerTradeId: t.id,
      txHash: a.tx_hash,
      side,
      sideBasis: side ? 'rest-token-addresses' : 'unknown',
      providerSideLabel: a.kind,
      trackedAmount,
      counterAmount,
      volumeUsd: a.volume_in_usd,
      trackedPriceUsd,
      trackedPriceBasis: trackedPriceUsd ? 'rest-token-price' : 'unavailable',
      providerTimeMs: null,
      blockTimestamp: a.block_timestamp,
      blockNumber: a.block_number,
      senderAddress: a.tx_from_address?.toLowerCase() ?? null,
      receivedAt,
    },
  };
}

export function isFixedPoolFrame(frame: { n: string; pa: string }, pool: PoolConfig = FIXED_POOL): boolean {
  return frame.n === pool.networkId && frame.pa.toLowerCase() === pool.poolAddress;
}

/** Frames whose provider time is this much older than the subscription are treated as replays. */
export const REPLAY_TOLERANCE_MS = 5_000;

/**
 * @param subscribedAtMs when the G2 set_pools succeeded; frames for trades older than that
 *   (minus tolerance) are marked `subscription-replay`, not live activity.
 */
export function mapWsTrade(f: G2Trade, trackedTokenSide: TrackedTokenSide, receivedAt: string, subscribedAtMs: number | null = null): TradeObservation {
  const baseSide: TradeSide | null = f.ty === 'b' ? 'buy' : f.ty === 's' ? 'sell' : null;
  const side: TradeSide | null = baseSide === null ? null : trackedTokenSide === 'base' ? baseSide : baseSide === 'buy' ? 'sell' : 'buy';
  const baseAmount = numberToDecimal(f.to);
  const quoteAmount = numberToDecimal(f.toq);
  const trackedPriceUsd = trackedTokenSide === 'base' ? numberToDecimal(f.pu) : null;
  return {
    source: 'ws',
    delivery: subscribedAtMs !== null && f.t !== null && f.t < subscribedAtMs - REPLAY_TOLERANCE_MS ? 'subscription-replay' : 'live',
    deliveryLagMs: f.t !== null ? Date.parse(receivedAt) - f.t : null,
    providerTradeId: null,
    txHash: f.tx,
    side,
    sideBasis: side ? 'ws-type-relative-to-base' : 'unknown',
    providerSideLabel: f.ty,
    trackedAmount: trackedTokenSide === 'base' ? baseAmount : quoteAmount,
    counterAmount: trackedTokenSide === 'base' ? quoteAmount : baseAmount,
    volumeUsd: numberToDecimal(f.vo),
    trackedPriceUsd,
    // `pu` is documented as "token price in USD" without naming the token; treated as the
    // base token price (to be confirmed against pool metadata) and only used when tracked token is base.
    trackedPriceBasis: trackedPriceUsd ? 'ws-pu-base-token' : 'unavailable',
    providerTimeMs: f.t,
    blockTimestamp: null,
    blockNumber: null,
    senderAddress: null, // G2 has no documented sender field
    receivedAt,
  };
}

export function mapWsCandle(f: G3Candle, receivedAt: string): CandleObservation | null {
  if (f.t === null) return null;
  return {
    source: 'ws',
    interval: f.i ?? 'unknown',
    tokenSide: f.to,
    openTimeSec: f.t,
    open: numberToDecimal(f.o),
    high: numberToDecimal(f.h),
    low: numberToDecimal(f.l),
    close: numberToDecimal(f.c),
    volumeUsd: numberToDecimal(f.v),
    receivedAt,
    updates: 1,
  };
}

export function mapRestOhlcvRow(row: readonly [number, number | null, number | null, number | null, number | null, number | null], tokenSide: TrackedTokenSide | null, receivedAt: string): CandleObservation {
  return {
    source: 'rest',
    interval: '1m',
    tokenSide,
    openTimeSec: row[0],
    open: numberToDecimal(row[1]),
    high: numberToDecimal(row[2]),
    low: numberToDecimal(row[3]),
    close: numberToDecimal(row[4]),
    volumeUsd: numberToDecimal(row[5]),
    receivedAt,
    updates: 1,
  };
}

/** tracked token/USD from pool metadata according to verified orientation. */
export function trackedPriceFromMetadata(
  attrs: { base_token_price_usd: string | null; quote_token_price_usd: string | null },
  trackedTokenSide: TrackedTokenSide,
  receivedAt: string,
): PriceObservation | null {
  const price = trackedTokenSide === 'base' ? attrs.base_token_price_usd : attrs.quote_token_price_usd;
  return price ? { source: 'rest-pool-metadata', priceUsd: price, providerTime: null, providerTimeKind: 'none', receivedAt, asOf: receivedAt } : null;
}
