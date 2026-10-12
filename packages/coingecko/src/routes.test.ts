import { describe, expect, it } from 'vitest';
import { buildRestUrl, ohlcvMinuteRoute, poolMetadataRoute, routeLabel, tradesRoute } from './routes';

const P = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8';
const L = '0x514910771af9ca656af840dff83e8264ecf986ca';

describe('allowlisted REST routes', () => {
  it('builds the planned routes for the fixed pool on the Pro API origin', () => {
    expect(buildRestUrl(poolMetadataRoute()).href).toBe(`https://pro-api.coingecko.com/api/v3/onchain/networks/eth/pools/${P}?include=base_token,quote_token`);
    expect(buildRestUrl(tradesRoute({ perPage: 300, tradingPeriod: '1d' })).href).toBe(
      `https://pro-api.coingecko.com/api/v3/onchain/networks/eth/pools/${P}/trades?token=${L}&trading_period=1d&per_page=300`,
    );
    expect(buildRestUrl(ohlcvMinuteRoute({ limit: 180 })).href).toBe(
      `https://pro-api.coingecko.com/api/v3/onchain/networks/eth/pools/${P}/ohlcv/minute?aggregate=1&limit=180&currency=usd&token=${L}`,
    );
  });

  it('passes the cursor back as an unchanged value and before_timestamp as integer seconds', () => {
    const cursor = 'opaque+cursor/=value';
    expect(buildRestUrl(tradesRoute({ perPage: 10, tradingPeriod: '1d', cursor })).searchParams.get('cursor')).toBe(cursor);
    expect(buildRestUrl(ohlcvMinuteRoute({ limit: 5, beforeTimestampSec: 1790000000.9 })).searchParams.get('before_timestamp')).toBe('1790000000');
  });

  it('rejects out-of-range pagination values', () => {
    expect(() => tradesRoute({ perPage: 301, tradingPeriod: '1d' })).toThrow();
    expect(() => tradesRoute({ perPage: 0, tradingPeriod: '1d' })).toThrow();
    expect(() => ohlcvMinuteRoute({ limit: 1001 })).toThrow();
  });

  it('refuses URLs outside the fixed pool path or with credential parameters', () => {
    expect(() => buildRestUrl({ id: 'trades', pathAndQuery: '/onchain/networks/eth/pools/0x1111111111111111111111111111111111111111/trades' })).toThrow(/fixed pool/);
    expect(() => buildRestUrl({ id: 'trades', pathAndQuery: `/onchain/networks/eth/pools/${P}?x_cg_pro_api_key=1` })).toThrow(/credential/);
    expect(() => buildRestUrl({ id: 'trades', pathAndQuery: '@evil.example/x' })).toThrow();
  });

  it('labels routes without the origin or query', () => {
    expect(routeLabel(tradesRoute({ perPage: 1, tradingPeriod: '1d' }))).toBe('/onchain/networks/eth/pools/P/trades');
  });
});
