import { describe, expect, it } from 'vitest';
import { REDACTED, redactText, redactValue } from './redact';

const DUMMY = 'TEST-DUMMY-cg-key-0123456789abcdef';
const OTHER = 'TEST-DUMMY-ONLY-credential-abcdef';

describe('redactText', () => {
  it('removes a known secret in raw, URL-encoded and JSON-escaped forms', () => {
    const tricky = 'TEST/DUMMY+key="quoted"&x';
    const text = `raw=${tricky} enc=${encodeURIComponent(tricky)} json=${JSON.stringify(tricky)}`;
    const out = redactText(text, [tricky]);
    expect(out).not.toContain(tricky);
    expect(out).not.toContain(encodeURIComponent(tricky));
    expect(out).not.toContain(JSON.stringify(tricky).slice(1, -1));
  });

  it('removes credential query parameters even when the value is unknown', () => {
    for (const url of [
      `/api/health?x_cg_pro_api_key=${OTHER}`,
      `https://pro-api.coingecko.com/api/v3/x?x-cg-pro-api-key=${OTHER}&page=2`,
      `/p?api_key=${OTHER}`,
      `/p%3Fapikey%3D${OTHER}`,
      `/p?a=1&access_token=${OTHER}#frag`,
    ]) {
      expect(redactText(url)).not.toContain(OTHER);
    }
    expect(redactText(`/p?page=2&api_key=${OTHER}`)).toBe(`/p?page=2&api_key=${REDACTED}`);
  });

  it('keeps ordinary CoinGecko parameters such as token=<address>', () => {
    const url = '/trades?token=0x514910771af9ca656af840dff83e8264ecf986ca&trading_period=1d&per_page=300';
    expect(redactText(url)).toBe(url);
    expect(redactText('{"token":"base","interval":"1m"}')).toBe('{"token":"base","interval":"1m"}');
  });

  it('removes sensitive JSON keys at any depth', () => {
    const line = JSON.stringify({ a: { b: { c: { apiKey: OTHER, 'x-cg-pro-api-key': OTHER, Authorization: `Bearer ${OTHER}` } } } });
    const out = redactText(line);
    expect(out).not.toContain(OTHER);
    expect(JSON.parse(out).a.b.c.apiKey).toBe(REDACTED);
  });

  it('removes header-style pairs and URL userinfo in free text', () => {
    expect(redactText(`request failed with header x-cg-pro-api-key: ${OTHER}`)).not.toContain(OTHER);
    expect(redactText(`connect wss://user:${OTHER}@stream.example/v1`)).not.toContain(OTHER);
  });

  it('is idempotent', () => {
    const once = redactText(`?api_key=${OTHER} ${DUMMY}`, [DUMMY]);
    expect(redactText(once, [DUMMY])).toBe(once);
  });
});

describe('redactValue', () => {
  it('sanitizes Error message, stack, cause chain and extra fields', () => {
    const cause = Object.assign(new Error(`inner ${DUMMY}`), { apiKey: OTHER });
    const err = Object.assign(new Error(`outer ?x_cg_pro_api_key=${OTHER}`, { cause }), {
      request: { options: { headers: { 'x-cg-pro-api-key': OTHER, accept: 'application/json' } } },
      status: 401,
    });
    const out = redactValue(err, [DUMMY]) as any;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(OTHER);
    expect(serialized).not.toContain(DUMMY);
    expect(out.status).toBe(401);
    expect(out.request.options.headers.accept).toBe('application/json');
    expect(out.cause.apiKey).toBe(REDACTED);
  });

  it('summarizes non-plain objects instead of traversing them', () => {
    class Socket {
      secret = OTHER;
    }
    expect(redactValue({ sock: new Socket() })).toEqual({ sock: '[Socket]' });
  });
});
