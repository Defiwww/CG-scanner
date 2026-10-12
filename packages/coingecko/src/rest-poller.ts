/**
 * REST trade poller.
 * Continuously fetches trades via REST pagination, respects rate limits,
 * and recovers from previous polling state.
 */

import { ProviderError } from './errors';
import type { RestClient } from './rest';
import { tradesRoute } from './routes';
import type { RestTrade } from './schemas';

export interface PollingState {
  lastCursor: string | null;
  lastFetchSec: number | null;
  retryAfterUntilSec: number | null;
}

export interface PollerOptions {
  /** Page size (CoinGecko max 300). */
  perPage?: number;
  /** Minimum delay between polls (ms). */
  minPollIntervalMs?: number;
  /** Max retries on HTTP error before giving up this batch. */
  maxRetries?: number;
}

/**
 * Polls the CoinGecko REST trades endpoint for a fixed pool/token.
 * Maintains cursor position for pagination and respects rate limits.
 *
 * Usage:
 *   const poller = new RestTradePoller(restClient, options);
 *   const { trades, nextCursor, retryAfter } = await poller.poll(state);
 *   // Insert trades into DB, update state with nextCursor and retryAfter
 */
export class RestTradePoller {
  private readonly perPage: number;
  private readonly minPollIntervalMs: number;
  private readonly maxRetries: number;

  constructor(private restClient: RestClient, options: PollerOptions = {}) {
    this.perPage = options.perPage ?? 300;
    this.minPollIntervalMs = options.minPollIntervalMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Poll for the next batch of trades.
   *
   * @returns { trades, nextCursor, retryAfterSec, shouldWait }
   *   - trades: newly fetched trade records
   *   - nextCursor: cursor for next pagination (null if no more pages)
   *   - retryAfterSec: if rate-limited, until when to not retry (null if ready to retry)
   *   - shouldWait: if true, the caller should wait before polling again
   */
  async poll(state: PollingState): Promise<{
    trades: RestTrade[];
    nextCursor: string | null;
    retryAfterSec: number | null;
    shouldWait: boolean;
  }> {
    const nowSec = Math.floor(Date.now() / 1000);

    // Check rate-limit backoff.
    if (state.retryAfterUntilSec !== null && nowSec < state.retryAfterUntilSec) {
      return {
        trades: [],
        nextCursor: state.lastCursor,
        retryAfterSec: state.retryAfterUntilSec,
        shouldWait: true,
      };
    }

    // Check minimum poll interval.
    const elapsedMs = (nowSec - (state.lastFetchSec ?? 0)) * 1000;
    if (elapsedMs < this.minPollIntervalMs) {
      return {
        trades: [],
        nextCursor: state.lastCursor,
        retryAfterSec: null,
        shouldWait: true,
      };
    }

    // Fetch the next page of trades.
    const trades: RestTrade[] = [];
    let nextCursor: string | null = null;
    let retryAfterUntil: number | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const route = state.lastCursor
          ? tradesRoute({ perPage: this.perPage, tradingPeriod: '1d', cursor: state.lastCursor })
          : tradesRoute({ perPage: this.perPage, tradingPeriod: '1d' });

        const response = await this.restClient.get(route);

        // Parse the response.
        const body = response.body as { data?: RestTrade[]; meta?: { next_cursor?: string | null } } | undefined;
        trades.push(...(body?.data ?? []));
        nextCursor = body?.meta?.next_cursor ?? null;
        break; // Success, no retry needed.
      } catch (err) {
        const error = err instanceof ProviderError ? err : new ProviderError('http', 'rest_poller.poll', String(err));

        if (error.kind === 'rate_limited') {
          // Honor Retry-After header.
          retryAfterUntil = nowSec + (error.retryAfterSec ?? 60);
          break; // Don't retry; let the caller respect the backoff.
        }

        if (error.kind === 'auth') {
          // 401/403: don't retry.
          throw error;
        }

        if (attempt < this.maxRetries - 1) {
          // Retry with exponential backoff.
          const delayMs = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          // Max retries exceeded.
          throw error;
        }
      }
    }

    return {
      trades,
      nextCursor,
      retryAfterSec: retryAfterUntil,
      shouldWait: false,
    };
  }
}
