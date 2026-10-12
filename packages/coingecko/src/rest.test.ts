import { describe, expect, it } from 'vitest';
import { ProviderError, parseRetryAfter } from './errors';
import { createRestClient, type FetchLike } from './rest';
import { poolMetadataRoute } from './routes';
import { UsageCounters } from './usage';

const KEY = 'TEST-DUMMY-rest-key-0123456789';

function fakeFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

async function caught(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected rejection');
}

describe('REST transport', () => {
  it('sends the key only in the header, refuses redirects and uses a timeout', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{"data":1}', { status: 200 }));
    const usage = new UsageCounters(0.1);
    const res = await createRestClient({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fn, usage }).get(poolMetadataRoute());
    expect(res.body).toEqual({ data: 1 });
    expect(res.bodyText).toBe('{"data":1}');
    const { url, init } = calls[0]!;
    expect(url.origin).toBe('https://pro-api.coingecko.com');
    expect(url.href).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-cg-pro-api-key']).toBe(KEY);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(usage.snapshot().rest).toMatchObject({ attempts: 1, successes: 1, errors: 0 });
    expect(usage.snapshot().estimatedCredits).toBe(1);
  });

  it('does not call the provider without a key', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{}'));
    const err = await caught(createRestClient({ apiKey: undefined, timeoutMs: 5000, fetchImpl: fn }).get(poolMetadataRoute()));
    expect(err.kind).toBe('missing_key');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [500, 'http'],
  ])('maps HTTP %i to %s without leaking the key', async (status, kind) => {
    const { fn } = fakeFetch(() => new Response(`{"error":"bad key ${KEY}"}`, { status }));
    const err = await caught(createRestClient({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fn }).get(poolMetadataRoute()));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.httpStatus).toBe(status);
    expect(JSON.stringify(err.toJSON()) + err.message + String(err.stack)).not.toContain(KEY);
    if (kind === 'auth') expect(err.retryable).toBe(false);
  });

  it('honours Retry-After on 429', async () => {
    const { fn } = fakeFetch(() => new Response('', { status: 429, headers: { 'retry-after': '17' } }));
    const err = await caught(createRestClient({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fn }).get(poolMetadataRoute()));
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterSec).toBe(17);
    expect(err.retryable).toBe(true);
    expect(parseRetryAfter('Wed, 30 Sep 2026 12:00:30 GMT', Date.parse('2026-09-30T12:00:00Z'))).toBe(30);
    expect(parseRetryAfter('garbage', 0)).toBeNull();
  });

  it('maps timeouts, refused redirects and network failures to allowlisted errors', async () => {
    const timeout = fakeFetch(() => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    expect((await caught(createRestClient({ apiKey: KEY, timeoutMs: 5, fetchImpl: timeout.fn }).get(poolMetadataRoute()))).kind).toBe('timeout');

    const redirect = fakeFetch(() => Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })));
    expect((await caught(createRestClient({ apiKey: KEY, timeoutMs: 5, fetchImpl: redirect.fn }).get(poolMetadataRoute()))).kind).toBe('redirect_refused');

    const network = fakeFetch(() => Promise.reject(new TypeError('fetch failed', { cause: { headers: { 'x-cg-pro-api-key': KEY } } })));
    const err = await caught(createRestClient({ apiKey: KEY, timeoutMs: 5, fetchImpl: network.fn }).get(poolMetadataRoute()));
    expect(err.kind).toBe('network');
    expect(JSON.stringify(err.toJSON()) + String(err.stack)).not.toContain(KEY);
    expect(err.cause).toBeUndefined();
  });

  it('rejects non-JSON bodies', async () => {
    const { fn } = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await caught(createRestClient({ apiKey: KEY, timeoutMs: 5000, fetchImpl: fn }).get(poolMetadataRoute()))).kind).toBe('invalid_payload');
  });
});
