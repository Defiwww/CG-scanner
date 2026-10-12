import type { ScoreComponent } from '@volumechecker/shared';
export function componentBar(c: ScoreComponent, stale: boolean) {
  const ratio = c.weight > 0 ? Math.max(0, Math.min(1, Number(c.contribution) / c.weight)) : 0;
  const unavailable = c.input === null || c.severity === null;
  return { percent: ratio * 100, tone: unavailable || stale ? 'neutral' : ratio >= 0.75 ? 'high' : ratio >= 0.4 ? 'medium' : 'low', label: unavailable ? 'Unavailable' : stale ? 'Historical / stale' : ratio >= 0.75 ? 'High risk contribution' : ratio >= 0.4 ? 'Moderate risk contribution' : 'Low risk contribution' };
}
export const ageSeconds = (at: number, now: number) => Math.max(0, Math.floor((now-at)/1000));
