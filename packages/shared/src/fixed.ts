/** Default example catalog. User catalogs are validated independently; one active pool per server. */
export interface PoolConfig {
  readonly networkId: string;
  readonly poolAddress: string;
  readonly baseName: string;
  readonly baseAddress: string;
  readonly quoteName: string;
  readonly quoteAddress: string;
  /** Which token is the tracked asset (for buy/sell, amounts, prices). */
  readonly trackedAsset: 'base' | 'quote';

}

export const ALLOWED_POOLS: readonly PoolConfig[] = [
  {
    networkId: 'eth',
    poolAddress: '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8',
    baseName: 'LINK',
    baseAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
    quoteName: 'WETH',
    quoteAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    trackedAsset: 'base',
  },
  {
    networkId: 'base',
    poolAddress: '0x6c561b446416e1a00e8e93e221854d6ea4171372',
    baseName: 'WETH',
    baseAddress: '0x4200000000000000000000000000000000000006',
    quoteName: 'USDC',
    quoteAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    trackedAsset: 'base',
  },
] as const;

/** Eth LINK/WETH (default, legacy name for backwards compat with migrations). */
export const FIXED_POOL: PoolConfig = ALLOWED_POOLS[0]!;

/** Resolve a pool ID (network:address) to its PoolConfig. */
export function getPoolConfig(poolId: string, catalog: readonly PoolConfig[] = ALLOWED_POOLS): PoolConfig | null {
  const pool = catalog.find((p) => `${p.networkId}:${p.poolAddress}` === poolId);
  return pool || null;
}

/** The only market-data provider endpoints the server may contact. */
export const COINGECKO_ENDPOINTS = {
  restBaseUrl: 'https://pro-api.coingecko.com/api/v3',
  wsUrl: 'wss://stream.coingecko.com/v1',
} as const;

/** Ordered risk states (spec §8). Band bounds are configurable; names and order are not. */
export const RISK_STATE_NAMES = [
  'Normal',
  'Caution',
  'Distribution Watch',
  'Distribution Confirmed',
  'High Risk',
] as const;
export type RiskStateName = (typeof RISK_STATE_NAMES)[number];

/** Pick the current pool contract without historical asset aliases or unknown fields. */
export function poolIdentity(p:PoolConfig):PoolConfig {
 return {networkId:p.networkId,poolAddress:p.poolAddress,baseName:p.baseName,baseAddress:p.baseAddress,quoteName:p.quoteName,quoteAddress:p.quoteAddress,trackedAsset:p.trackedAsset};
}
