import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadAppConfig } from './config';
import { createLogger } from './logger';

const configPath = fileURLToPath(new URL('../../../config/legacy-v0.json', import.meta.url));
// Dummy values only; no real credential is used in tests.
const SERVER_KEY = 'TEST-DUMMY-server-key-0123456789';
const OTHER = 'TEST-DUMMY-ONLY-credential-abcdef';

function capture() {
  const lines: string[] = [];
  return { lines, destination: { write: (l: string) => void lines.push(l) } };
}

describe('log redaction', () => {
  it('censors credentials in nested request metadata, URLs, error messages and causes', () => {
    const { lines, destination } = capture();
    const log = createLogger({ level: 'info', secrets: [SERVER_KEY], destination });

    // (a) nested request options header, (b) URL query value, (c) Error message, (d) err.cause.apiKey
    log.info({ request: { options: { headers: { 'x-cg-pro-api-key': OTHER } } }, operation: 'probe.rest' }, 'nested header');
    log.info({ url: `https://pro-api.coingecko.com/api/v3/x?x_cg_pro_api_key=${OTHER}`, status: 200 }, 'url query');
    log.error(new Error(`fetch failed for key ${SERVER_KEY}`), 'error message');
    log.error({ err: new Error('wrapped', { cause: Object.assign(new Error('inner'), { apiKey: OTHER }) }), correlationId: 'c-1' }, 'cause');
    // Known key under an unexpected field name and inside the message text.
    log.warn({ unexpectedField: SERVER_KEY }, `message containing ${SERVER_KEY}`);
    log.warn({ encoded: encodeURIComponent(SERVER_KEY) }, 'encoded');

    const out = lines.join('');
    expect(lines).toHaveLength(6);
    expect(out).not.toContain(OTHER);
    expect(out).not.toContain(SERVER_KEY);
    // Useful operational context survives.
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].operation).toBe('probe.rest');
    expect(parsed[1].status).toBe(200);
    expect(parsed[1].url).toContain('https://pro-api.coingecko.com/api/v3/x?');
    expect(parsed[2].err.message).toBe('fetch failed for key [REDACTED]');
    expect(parsed[2].msg).toBe('error message');
    expect(parsed[3].correlationId).toBe('c-1');
    expect(parsed[3].err.cause.apiKey).toBe('[REDACTED]');
    expect(parsed[0].time).toMatch(/Z$/);
  });

  it('censors a credential sent in the request URL through the real app request log', async () => {
    const { lines, destination } = capture();
    const app = await buildApp({ loaded: loadAppConfig(configPath), apiKey: SERVER_KEY, logLevel: 'info', logDestination: destination });
    try {
      const res = await app.inject({ method: 'GET', url: `/api/health?x_cg_pro_api_key=${OTHER}&k=${SERVER_KEY}` });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SERVER_KEY);
      expect(res.body).not.toContain(OTHER);
    } finally {
      await app.close();
    }
    const out = lines.join('');
    expect(out).toContain('/api/health?');
    expect(out).toContain('"statusCode":200');
    expect(out).not.toContain(OTHER);
    expect(out).not.toContain(SERVER_KEY);
  });
});
