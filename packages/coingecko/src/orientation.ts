import type { PoolConfig } from '@volumechecker/shared';
import { FIXED_POOL, type TrackedTokenSide, type OrientationResult } from '@volumechecker/shared';
import { poolMetadataSchema } from './schemas';

/**
 * Verifies pool identity and base/quote ordering from an ACTUAL pool
 * metadata response. Nothing is assumed from the pair name. Any mismatch is a
 * failure that blocks direction-dependent capabilities (no fallback pool).
 *
 * Relationship ids are expected as `<network>_<address>` (documented format);
 * the token address is taken from `included[].attributes.address` when present
 * and from the id otherwise, and both must agree.
 */
export function verifyOrientation(body: unknown, verifiedAt: string, pool: PoolConfig = FIXED_POOL): OrientationResult {
  const failed = (detail: string): OrientationResult => ({
    status: 'failed',
    trackedTokenSide: null,
    baseTokenAddress: null,
    quoteTokenAddress: null,
    poolAddress: null,
    verifiedAt: null,
    detail,
  });

  const parsed = poolMetadataSchema.safeParse(body);
  if (!parsed.success) return failed(`pool metadata did not match the expected schema: ${parsed.error.issues[0]?.path.join('.') ?? ''}`);
  const d = parsed.data.data;

  const poolAddress = d.attributes.address.toLowerCase();
  if (poolAddress !== pool.poolAddress) return failed(`metadata pool address ${poolAddress} is not the configured pool`);
  if (d.id.toLowerCase() !== `${pool.networkId}_${pool.poolAddress}`) return failed(`metadata pool id ${d.id} does not match expected format`);

  const tokenAddress = (rel: { data: { id: string } | null }): string | null => {
    if (!rel.data) return null;
    const id = rel.data.id.toLowerCase();
    const prefix = `${pool.networkId}_`;
    if (!id.startsWith(prefix)) return null;
    const fromId = id.slice(prefix.length);
    const inc = parsed.data.included?.find((x) => x.id.toLowerCase() === id);
    const fromIncluded = inc?.attributes.address?.toLowerCase() ?? null;
    if (fromIncluded !== null && fromIncluded !== fromId) return null;
    return fromId;
  };
  const base = tokenAddress(d.relationships.base_token);
  const quote = tokenAddress(d.relationships.quote_token);
  if (!base || !quote) return failed('base/quote token relationships missing or inconsistent with included tokens');

  const expectedBase = pool.baseAddress.toLowerCase();
  const expectedQuote = pool.quoteAddress.toLowerCase();
  const pair = new Set([base, quote]);
  if (pair.size !== 2 || !pair.has(expectedBase) || !pair.has(expectedQuote)) {
    return failed(`pool tokens ${base}/${quote} do not match configured base/quote tokens`);
  }
  const trackedSide: TrackedTokenSide = base === expectedBase ? 'base' : 'quote';
  return {
    status: 'verified',
    trackedTokenSide: trackedSide,
    baseTokenAddress: base,
    quoteTokenAddress: quote,
    poolAddress,
    verifiedAt,
    detail: `${pool.baseName} is the ${trackedSide} token; ${pool.quoteName} is the ${trackedSide === 'base' ? 'quote' : 'base'} token (from CoinGecko pool metadata)`,
  };
}
