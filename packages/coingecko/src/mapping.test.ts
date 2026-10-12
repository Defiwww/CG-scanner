import { describe, expect, it } from 'vitest';
import { g2Frame, g3Frame, restTrade } from '../../../tests/fixtures/synthetic/coingecko';
import { trackedPriceFromMetadata, mapRestOhlcvRow, mapRestTrade, mapWsCandle, mapWsTrade, numberToDecimal } from './mapping';
import { g2TradeSchema, g3CandleSchema, restTradeSchema } from './schemas';

const at = '2026-09-30T12:00:01.000Z';

describe('REST trade mapping (direction from token addresses)', () => {
  it('LINK received is a buy; LINK sent is a sell; amounts and prices follow the LINK side', () => {
    const buy = mapRestTrade(restTradeSchema.parse(restTrade({ side: 'buy' })), at);
    expect(buy.trade).toMatchObject({ side: 'buy', sideBasis: 'rest-token-addresses', trackedAmount: '100.0', counterAmount: '0.5', trackedPriceUsd: '15.0', blockTimestamp: '2026-09-30T12:00:00Z', providerTimeMs: null });
    expect(buy.labelAgrees).toBe(true);
    const sell = mapRestTrade(restTradeSchema.parse(restTrade({ side: 'sell' })), at);
    expect(sell.trade).toMatchObject({ side: 'sell', trackedAmount: '100.0', counterAmount: '0.5', trackedPriceUsd: '15.0' });
  });

  it('records disagreement between the provider kind label and the addresses instead of trusting the label', () => {
    const m = mapRestTrade(restTradeSchema.parse(restTrade({ side: 'buy', kind: 'sell' })), at);
    expect(m.trade.side).toBe('buy');
    expect(m.trade.providerSideLabel).toBe('sell');
    expect(m.labelAgrees).toBe(false);
  });

  it('keeps nullable sender and the stable per-swap id', () => {
    const m = mapRestTrade(restTradeSchema.parse(restTrade({ side: 'buy', sender: null, id: 'eth_1_0xabc_99_1' })), at);
    expect(m.trade.senderAddress).toBeNull();
    expect(m.trade.providerTradeId).toBe('eth_1_0xabc_99_1');
  });
});

describe('WS G2 mapping (ty relative to base)', () => {
  const frame = g2TradeSchema.parse(g2Frame({ ty: 'b', to: 100, toq: 0.5, pu: 15, t: 1790000012345 }));

  it('LINK as base: b = buy LINK, `to` is the LINK amount, pu is LINK/USD', () => {
    expect(mapWsTrade(frame, 'base', at)).toMatchObject({ side: 'buy', trackedAmount: '100', counterAmount: '0.5', trackedPriceUsd: '15', trackedPriceBasis: 'ws-pu-base-token', sideBasis: 'ws-type-relative-to-base' });
  });

  it('LINK as quote: b (buy of base WETH) = sell LINK, `toq` is the LINK amount, pu is not LINK/USD', () => {
    expect(mapWsTrade(frame, 'quote', at)).toMatchObject({ side: 'sell', trackedAmount: '0.5', counterAmount: '100', trackedPriceUsd: null, trackedPriceBasis: 'unavailable' });
    expect(mapWsTrade(g2TradeSchema.parse(g2Frame({ ty: 's' })), 'quote', at).side).toBe('buy');
  });

  it('keeps `t` as provider update time in milliseconds, never as block time, and has no sender', () => {
    const t = mapWsTrade(frame, 'base', at);
    expect(t.providerTimeMs).toBe(1790000012345);
    expect(new Date(t.providerTimeMs!).toISOString()).toBe('2026-09-21T14:13:32.345Z');
    expect(t.blockTimestamp).toBeNull();
    expect(t.senderAddress).toBeNull();
    expect(t.providerTradeId).toBeNull();
  });

  it('marks frames older than the subscription as subscription replays', () => {
    const sub = 1790000100000;
    expect(mapWsTrade(frame, 'base', at, sub).delivery).toBe('subscription-replay');
    expect(mapWsTrade(g2TradeSchema.parse(g2Frame({ t: sub - 1000 })), 'base', at, sub).delivery).toBe('live');
    expect(mapWsTrade(frame, 'base', at, null).delivery).toBe('live');
    expect(mapRestTrade(restTradeSchema.parse(restTrade({ side: 'buy' })), at).trade.delivery).toBe('rest');
  });

  it('preserves nulls from the provider', () => {
    const t = mapWsTrade(g2TradeSchema.parse(g2Frame({ ty: null, vo: null, pu: null, t: null })), 'base', at);
    expect(t).toMatchObject({ side: null, sideBasis: 'unknown', volumeUsd: null, trackedPriceUsd: null, providerTimeMs: null });
  });

  it('rejects a millisecond/second mix-up at the schema level only by type, so units are asserted here', () => {
    // G2 t is an integer in ms (13 digits for current dates); G3 t is seconds (10 digits).
    expect(String(g2Frame().t)).toHaveLength(13);
    expect(String(g3Frame().t)).toHaveLength(10);
  });
});

describe('WS G3 and REST OHLCV mapping', () => {
  it('candle time is the open time in seconds', () => {
    const c = mapWsCandle(g3CandleSchema.parse(g3Frame({ t: 1790000040, to: 'quote' })), at)!;
    expect(c).toMatchObject({ source: 'ws', openTimeSec: 1790000040, tokenSide: 'quote', interval: '1m', close: '15.05' });
    expect(new Date(c.openTimeSec * 1000).toISOString()).toBe('2026-09-21T14:14:00.000Z');
  });

  it('maps REST rows [t_sec, o, h, l, c, v]', () => {
    expect(mapRestOhlcvRow([1790000040, 1, 2, 0.5, 1.5, 10], 'base', at)).toMatchObject({ source: 'rest', openTimeSec: 1790000040, open: '1', high: '2', low: '0.5', close: '1.5', volumeUsd: '10' });
  });

  it('numberToDecimal keeps JS round-trip spelling and drops non-finite values', () => {
    expect(numberToDecimal(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(numberToDecimal(null)).toBeNull();
    expect(numberToDecimal(Number.NaN)).toBeNull();
  });
});

describe('metadata price', () => {
  it('reads LINK/USD from the verified side', () => {
    const attrs = { base_token_price_usd: '3000', quote_token_price_usd: '15' };
    expect(trackedPriceFromMetadata(attrs, 'quote', at)?.priceUsd).toBe('15');
    expect(trackedPriceFromMetadata(attrs, 'base', at)?.priceUsd).toBe('3000');
  });
});
