import { describe, expect, it } from 'vitest';
import { LINK, WETH, poolMetadata } from '../../../tests/fixtures/synthetic/coingecko';
import { verifyOrientation } from './orientation';

const at = '2026-09-30T12:00:00.000Z';

describe('orientation verification from pool metadata', () => {
  it('verifies LINK as base', () => {
    const r = verifyOrientation(poolMetadata({ trackedTokenSide: 'base' }), at);
    expect(r).toMatchObject({ status: 'verified', trackedTokenSide: 'base', baseTokenAddress: LINK, quoteTokenAddress: WETH, verifiedAt: at });
  });

  it('verifies LINK as quote (pair name order is not assumed)', () => {
    expect(verifyOrientation(poolMetadata({ trackedTokenSide: 'quote' }), at)).toMatchObject({ status: 'verified', trackedTokenSide: 'quote', baseTokenAddress: WETH });
  });

  it('fails for another pool, other tokens, inconsistent included tokens or a bad schema', () => {
    expect(verifyOrientation(poolMetadata({ poolAddress: '0x' + '1'.repeat(40) }), at).status).toBe('failed');
    expect(verifyOrientation(poolMetadata({ base: LINK, quote: '0x' + '2'.repeat(40) }), at).status).toBe('failed');
    expect(verifyOrientation(poolMetadata({ base: LINK, quote: LINK }), at).status).toBe('failed');
    const inconsistent = poolMetadata();
    inconsistent.included[0]!.attributes.address = '0x' + '3'.repeat(40);
    expect(verifyOrientation(inconsistent, at).status).toBe('failed');
    expect(verifyOrientation({ data: {} }, at)).toMatchObject({ status: 'failed', trackedTokenSide: null, verifiedAt: null });
  });
});
