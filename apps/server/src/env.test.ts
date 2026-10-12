import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveServerAddress, serverOrigin } from '@volumechecker/shared';
import { effectiveEnv } from './env-file';
import { parseEnv } from './config';

const FAKE_KEY = 'TEST-ONLY-not-a-real-key-0123456789';

describe('environment validation', () => {
  it('defaults to loopback and treats an empty key as absent', () => {
    const env = parseEnv({ COINGECKO_API_KEY: '  ' });
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(8787);
    expect(env.COINGECKO_API_KEY).toBeUndefined();
  });

  it('rejects a non-loopback bind address', () => {
    expect(() => parseEnv({ HOST: '0.0.0.0' })).toThrow(/loopback/);
  });

  it('does not echo the key in validation errors', () => {
    let message = '';
    try {
      parseEnv({ COINGECKO_API_KEY: FAKE_KEY, PORT: 'not-a-port' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain(FAKE_KEY);
  });
});

describe('shared backend address for server and dev proxy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function envFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'volumechecker-env-'));
    dirs.push(dir);
    const file = join(dir, '.env');
    writeFileSync(file, content);
    return file;
  }

  it('process environment overrides .env, including an explicitly empty key', () => {
    const file = envFile(`PORT=18887\nHOST=::1\nCOINGECKO_API_KEY=${FAKE_KEY}\n`);
    expect(effectiveEnv(file, {}).PORT).toBe('18887');
    const merged = effectiveEnv(file, { PORT: '19000', COINGECKO_API_KEY: '' });
    expect(merged.PORT).toBe('19000');
    expect(merged.HOST).toBe('::1');
    expect(parseEnv(merged).COINGECKO_API_KEY).toBeUndefined();
  });

  it('does not copy .env values into process.env', () => {
    const file = envFile('VOLUMECHECKER_TEST_ONLY_VAR=1\n');
    effectiveEnv(file, {});
    expect(process.env.VOLUMECHECKER_TEST_ONLY_VAR).toBeUndefined();
  });

  it('server and proxy derive the same origin, bracketing IPv6', () => {
    expect(serverOrigin(resolveServerAddress({}))).toBe('http://127.0.0.1:8787');
    expect(serverOrigin(resolveServerAddress({ PORT: '18887' }))).toBe('http://127.0.0.1:18887');
    expect(serverOrigin(resolveServerAddress({ HOST: '::1', PORT: '18888' }))).toBe('http://[::1]:18888');
    expect(serverOrigin(resolveServerAddress({ HOST: 'localhost' }))).toBe('http://localhost:8787');
    const server = parseEnv({ HOST: '::1', PORT: '18888' });
    expect(serverOrigin({ host: server.HOST, port: server.PORT })).toBe('http://[::1]:18888');
  });

  it('proxy startup validation rejects the same invalid values as the server', () => {
    expect(() => resolveServerAddress({ HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => resolveServerAddress({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('the Vite config proxies /api to the configured PORT', async () => {
    vi.stubEnv('PORT', '18887');
    vi.stubEnv('HOST', '127.0.0.1');
    const cfg = (await import('../../web/vite.config')).default as { server: { proxy: Record<string, { target: string }> } };
    expect(cfg.server.proxy['/api']!.target).toBe('http://127.0.0.1:18887');
  });

  it('the Vite config refuses a backend PORT equal to its own port', async () => {
    vi.stubEnv('PORT', '5173');
    await expect(import('../../web/vite.config')).rejects.toThrow(/collides with the Vite dev server port/);
  });

  it('the Vite config refuses a non-loopback HOST at startup', async () => {
    vi.stubEnv('HOST', '0.0.0.0');
    await expect(import('../../web/vite.config')).rejects.toThrow(/loopback/);
  });
});
