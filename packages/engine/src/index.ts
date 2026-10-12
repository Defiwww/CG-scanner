import Decimal from 'decimal.js';
import type { AppConfig, TradeObservation } from '@volumechecker/shared';

/** Candidate predicate only. The caller must enforce mutual uniqueness, never greedy tx matching. */
export function sameSwap(a: TradeObservation, b: TradeObservation, tolerance: AppConfig['reconciliation']): boolean {
  if (!a.txHash || a.txHash !== b.txHash || !a.side || a.side !== b.side) return false;
  const close = (x: string | null, y: string | null, r: number) => {
    if (x === null || y === null) return false;
    const u = new Decimal(x), v = new Decimal(y);
    return u.minus(v).abs().lte(Decimal.max(u.abs(), v.abs()).mul(r));
  };
  const at = a.providerTimeMs ?? (a.blockTimestamp ? Date.parse(a.blockTimestamp) : NaN);
  const bt = b.providerTimeMs ?? (b.blockTimestamp ? Date.parse(b.blockTimestamp) : NaN);
  return Number.isFinite(at) && Number.isFinite(bt) && Math.abs(at - bt) <= tolerance.timeToleranceSec * 1000
    && close(a.trackedAmount, b.trackedAmount, tolerance.amountRelativeTolerance)
    && close(a.counterAmount, b.counterAmount, tolerance.amountRelativeTolerance)
    && close(a.volumeUsd, b.volumeUsd, tolerance.volumeUsdRelativeTolerance);
}
export * from './metrics';
export * from './scoring';
export * from './signals';
export * from './wallets';
