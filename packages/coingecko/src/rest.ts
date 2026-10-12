import { API_KEY_HEADER } from './constants';
import { ProviderError, parseRetryAfter } from './errors';
import { buildRestUrl, routeLabel, type RestRoute } from './routes';
import type { UsageCounters } from './usage';

/**
 * Credentialed REST transport for the allowlisted CoinGecko routes.
 *
 * - The key travels only in the `x-cg-pro-api-key` header.
 * - Redirects are refused (`redirect: 'error'`) so the header can never be
 *   forwarded to another origin.
 * - Every call has a timeout; failures become an allowlisted ProviderError.
 * - The raw response text is returned unchanged for raw storage/fixtures.
 */

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface RestClientOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  usage?: UsageCounters;
}

export interface RestResponse {
  routeId: RestRoute['id'];
  endpoint: string;
  httpStatus: number;
  bodyText: string;
  body: unknown;
  requestedAt: string;
  receivedAt: string;
  durationMs: number;
}

export interface RestClient {
  get(route: RestRoute, signal?: AbortSignal): Promise<RestResponse>;
}

export function createRestClient(opts: RestClientOptions): RestClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;

  return {
    async get(route, signal) {
      const endpoint = routeLabel(route);
      const operation = `rest.${route.id}`;
      if (!opts.apiKey) throw new ProviderError('missing_key', operation, 'COINGECKO_API_KEY is not configured on the server');
      const url = buildRestUrl(route);
      const started = now();
      opts.usage?.restAttempt(route.id);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json', [API_KEY_HEADER]: opts.apiKey },
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]) : AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        opts.usage?.restError(route.id);
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new ProviderError('timeout', operation, `no response within ${opts.timeoutMs} ms`);
        }
        // fetch reports a refused redirect as a TypeError; the cause is not surfaced (may carry request metadata).
        const redirect = err instanceof Error && /redirect/i.test(String((err as { cause?: unknown }).cause ?? err.message));
        throw new ProviderError(redirect ? 'redirect_refused' : 'network', operation, redirect ? 'redirect refused' : 'network request failed');
      }
      const bodyText = await res.text().catch(() => '');
      const received = now();
      if (!res.ok) {
        opts.usage?.restError(route.id);
        const status = res.status;
        if (res.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
          throw new ProviderError('redirect_refused', operation, 'redirect refused', { httpStatus: status });
        }
        const kind = status === 401 || status === 403 ? 'auth' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'http';
        throw new ProviderError(kind, operation, `${endpoint} returned an error`, {
          httpStatus: status,
          retryAfterSec: status === 429 ? parseRetryAfter(res.headers.get('retry-after'), received) : null,
        });
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        opts.usage?.restError(route.id);
        throw new ProviderError('invalid_payload', operation, 'response is not JSON', { httpStatus: res.status });
      }
      opts.usage?.restSuccess(route.id);
      return {
        routeId: route.id,
        endpoint,
        httpStatus: res.status,
        bodyText,
        body,
        requestedAt: new Date(started).toISOString(),
        receivedAt: new Date(received).toISOString(),
        durationMs: received - started,
      };
    },
  };
}
