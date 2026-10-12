import { ALLOWED_POOLS, COINGECKO_ENDPOINTS, FIXED_POOL } from '@volumechecker/shared';
import type { PoolConfig } from '@volumechecker/shared';

/**
 * Allowlisted CoinGecko REST routes for the fixed pool. Only these three route kinds can be built; the resulting URL is
 * asserted to be HTTPS on the Pro API origin before any credentialed request.
 *
 * Routes now accept a PoolConfig parameter for multi-pool support.
 */

export type RestRouteId = 'pool_metadata' | 'trades' | 'ohlcv_minute';

export interface RestRoute {
  id: RestRouteId;
  pool?: PoolConfig;
  /** Path + query relative to the Pro API base, never containing credentials. */
  pathAndQuery: string;
}

const REST_ORIGIN = new URL(COINGECKO_ENDPOINTS.restBaseUrl).origin;
const REST_BASE_PATH = new URL(COINGECKO_ENDPOINTS.restBaseUrl).pathname;

function getPoolPath(pool: PoolConfig): string {
  if(!/^[a-z0-9][a-z0-9-]{0,39}$/.test(pool.networkId)||![pool.poolAddress,pool.baseAddress,pool.quoteAddress].every(a=>/^0x[0-9a-f]{40}$/.test(a)))throw Error('Invalid EVM pool identity');
  return `/onchain/networks/${pool.networkId}/pools/${pool.poolAddress}`;
}

export function poolMetadataRoute(pool: PoolConfig = FIXED_POOL): RestRoute {
  const poolPath = getPoolPath(pool);
  return { id: 'pool_metadata', pool, pathAndQuery: `${poolPath}?include=base_token,quote_token` };
}

export interface TradesRouteOptions {
  perPage: number;
  tradingPeriod: '1d';
  /** `meta.next_cursor` passed back unchanged. */
  cursor?: string | null;
}

export function tradesRoute(opts: TradesRouteOptions, pool: PoolConfig = FIXED_POOL): RestRoute {
  if (!Number.isInteger(opts.perPage) || opts.perPage < 1 || opts.perPage > 300) throw new Error('per_page must be 1..300');
  const poolPath = getPoolPath(pool);
  // Use the base token address (tracked asset) as the token parameter.
  const q = new URLSearchParams({ token: pool.baseAddress, trading_period: opts.tradingPeriod, per_page: String(opts.perPage) });
  if (opts.cursor) q.set('cursor', opts.cursor);
  return { id: 'trades', pool, pathAndQuery: `${poolPath}/trades?${q.toString()}` };
}

export interface OhlcvRouteOptions {
  limit: number;
  /** Documented history paging: integer epoch seconds. */
  beforeTimestampSec?: number;
}

export function ohlcvMinuteRoute(opts: OhlcvRouteOptions, pool: PoolConfig = FIXED_POOL): RestRoute {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) throw new Error('limit must be 1..1000');
  const poolPath = getPoolPath(pool);
  // Use the base token address (tracked asset) as the token parameter.
  const q = new URLSearchParams({ aggregate: '1', limit: String(opts.limit), currency: 'usd', token: pool.baseAddress });
  if (opts.beforeTimestampSec !== undefined) q.set('before_timestamp', String(Math.floor(opts.beforeTimestampSec)));
  return { id: 'ohlcv_minute', pool, pathAndQuery: `${poolPath}/ohlcv/minute?${q.toString()}` };
}

/** Builds the absolute URL and refuses anything outside the allowlisted pools. */
export function buildRestUrl(route: RestRoute): URL {
  const url = new URL(`${COINGECKO_ENDPOINTS.restBaseUrl}${route.pathAndQuery}`);
  if (url.origin !== REST_ORIGIN || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('refusing REST URL outside the CoinGecko Pro API origin');
  }
  // Routes are built from allowlisted functions; check pathname refers to an allowed pool.
  const pathWithoutBase = url.pathname.slice(REST_BASE_PATH.length);
  const allowedPoolMatches = (route.pool ? [route.pool] : ALLOWED_POOLS).some((pool) => {
    const poolPath = getPoolPath(pool);
    return [poolPath, `${poolPath}/trades`, `${poolPath}/ohlcv/minute`].includes(pathWithoutBase);
  });
  if (!allowedPoolMatches) {
    throw new Error('refusing REST path outside the fixed pools');
  }
  for (const name of url.searchParams.keys()) {
    if (/key|secret|auth/i.test(name)) throw new Error('refusing credential-like query parameter');
  }
  return url;
}

/** Path used in logs and usage records (no origin, no credentials). */
export function routeLabel(route: RestRoute, pool: PoolConfig = FIXED_POOL): string {
  const poolPath = getPoolPath(pool);
  const placeholder = `/onchain/networks/${pool.networkId}/pools/P`;
  return route.pathAndQuery.split('?')[0]!.replace(poolPath, placeholder);
}
