import { readFileSync } from 'node:fs';

/** Fixed deployment window. Created once at first launch; restarts and redeploys read it and never extend it. */
export interface Lifetime {
  startedAtMs: number;
  expiresAtMs: number;
}

/** A configured but missing or invalid file throws, so the server refuses to run without a known end time. */
export function loadLifetime(path: string | undefined): Lifetime | undefined {
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { started_at?: unknown; expires_at?: unknown };
  const startedAtMs = Date.parse(String(raw.started_at));
  const expiresAtMs = Date.parse(String(raw.expires_at));
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= startedAtMs) {
    throw new Error('Invalid deployment lifetime file: started_at and expires_at must be ISO times with expires_at later');
  }
  return { startedAtMs, expiresAtMs };
}
