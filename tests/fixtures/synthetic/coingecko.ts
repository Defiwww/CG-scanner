/**
 * SYNTHETIC CoinGecko payloads for offline tests (see README.md in this folder).
 * Shapes follow the official docs; all values are invented.
 */
export const POOL = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8';
export const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca';
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const SYN_TX = '0x' + 'ab'.repeat(32);

export function poolMetadata(opts: { trackedTokenSide?: 'base' | 'quote'; poolAddress?: string; base?: string; quote?: string; linkPrice?: string; wethPrice?: string } = {}) {
  const trackedTokenSide = opts.trackedTokenSide ?? 'base';
  const base = opts.base ?? (trackedTokenSide === 'base' ? LINK : WETH);
  const quote = opts.quote ?? (trackedTokenSide === 'base' ? WETH : LINK);
  const linkPrice = opts.linkPrice ?? '15.00';
  const wethPrice = opts.wethPrice ?? '3000.00';
  const pool = opts.poolAddress ?? POOL;
  return {
    data: {
      id: `eth_${pool}`,
      type: 'pool',
      attributes: {
        address: pool,
        name: 'LINK / WETH 0.3%',
        base_token_price_usd: base === LINK ? linkPrice : wethPrice,
        quote_token_price_usd: quote === LINK ? linkPrice : wethPrice,
        reserve_in_usd: '12345678.90',
      },
      relationships: {
        base_token: { data: { id: `eth_${base}`, type: 'token' } },
        quote_token: { data: { id: `eth_${quote}`, type: 'token' } },
        dex: { data: { id: 'uniswap_v3', type: 'dex' } },
      },
    },
    included: [
      { id: `eth_${base}`, type: 'token', attributes: { address: base, symbol: base === LINK ? 'LINK' : 'WETH' } },
      { id: `eth_${quote}`, type: 'token', attributes: { address: quote, symbol: quote === LINK ? 'LINK' : 'WETH' } },
    ],
  };
}

export function restTrade(opts: { side: 'buy' | 'sell'; kind?: string; id?: string; tx?: string; sender?: string | null }) {
  const buy = opts.side === 'buy';
  return {
    id: opts.id ?? `eth_1_${SYN_TX}_7_1790000000`,
    type: 'trade',
    attributes: {
      block_number: 1,
      tx_hash: opts.tx ?? SYN_TX,
      tx_from_address: opts.sender === undefined ? '0x' + '11'.repeat(20) : opts.sender,
      from_token_amount: buy ? '0.5' : '100.0',
      to_token_amount: buy ? '100.0' : '0.5',
      price_from_in_currency_token: '1.0',
      price_to_in_currency_token: '1.0',
      price_from_in_usd: buy ? '3000.0' : '15.0',
      price_to_in_usd: buy ? '15.0' : '3000.0',
      block_timestamp: '2026-09-30T12:00:00Z',
      kind: opts.kind ?? opts.side,
      volume_in_usd: '1500.0',
      from_token_address: buy ? WETH : LINK,
      to_token_address: buy ? LINK : WETH,
    },
  };
}

export function tradesResponse(trades = [restTrade({ side: 'buy' }), restTrade({ side: 'sell', id: `eth_1_${SYN_TX}_8_1790000000` })], nextCursor: string | null = null) {
  return { data: trades, meta: { next_cursor: nextCursor } };
}

export function ohlcvResponse(rows: [number, number, number, number, number, number][] = [[1790000040, 15, 15.1, 14.9, 15.05, 1000], [1790000000, 14.9, 15, 14.8, 15, 2000]]) {
  return {
    data: { id: 'synthetic', type: 'ohlcv_request_response', attributes: { ohlcv_list: rows } },
    meta: { base: { address: LINK, symbol: 'LINK' }, quote: { address: WETH, symbol: 'WETH' } },
  };
}

/** G2 frame: `to` = base amount, `toq` = quote amount, `ty` relative to base. */
export function g2Frame(overrides: Record<string, unknown> = {}) {
  return { c: 'G2', n: 'eth', pa: POOL, tx: SYN_TX, ty: 'b', to: 100, toq: 0.5, vo: 1500, pc: 0.005, pu: 15, t: 1790000012345, ...overrides };
}

/** G3 frame: `ch` = channel code, `c` = close, `t` = candle open in seconds. */
export function g3Frame(overrides: Record<string, unknown> = {}) {
  return { ch: 'G3', n: 'eth', pa: POOL, to: 'base', i: '1m', o: 15, h: 15.1, l: 14.9, c: 15.05, v: 1234.5, t: 1790000040, ...overrides };
}
