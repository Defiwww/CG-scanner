/**
 * Allowlisted provider error shape. Transports never surface raw
 * fetch/WS error objects, request options or headers; only these fields.
 */

export type ProviderErrorKind =
  | 'auth' // 401/403: stop retries until the key is fixed
  | 'not_found' // 404: capability unavailable for this pool; no fallback
  | 'rate_limited' // 429: honour Retry-After
  | 'http' // other non-2xx
  | 'timeout'
  | 'network'
  | 'redirect_refused'
  | 'invalid_payload'
  | 'protocol' // WS protocol error / rejection
  | 'missing_key';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly operation: string;
  readonly httpStatus: number | null;
  readonly retryAfterSec: number | null;

  constructor(kind: ProviderErrorKind, operation: string, detail: string, opts: { httpStatus?: number | null; retryAfterSec?: number | null } = {}) {
    super(`${operation}: ${kind}${opts.httpStatus ? ` (HTTP ${opts.httpStatus})` : ''} - ${detail}`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.operation = operation;
    this.httpStatus = opts.httpStatus ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }

  /** Auth failures are not retried automatically. */
  get retryable(): boolean {
    return this.kind !== 'auth' && this.kind !== 'not_found' && this.kind !== 'missing_key' && this.kind !== 'invalid_payload';
  }

  toJSON() {
    return { kind: this.kind, operation: this.operation, httpStatus: this.httpStatus, retryAfterSec: this.retryAfterSec, message: this.message };
  }
}

/** Parses Retry-After (delta-seconds or HTTP-date) relative to `nowMs`. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}
