import { z } from 'zod';

/**
 * Backend bind address shared by the Fastify server and the Vite dev proxy,
 * so both always agree on HOST/PORT. Loopback only for the local MVP.
 */

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

export const serverAddressSchema = z.object({
  HOST: z.enum(LOOPBACK_HOSTS, { message: 'HOST must be a loopback address (127.0.0.1, ::1 or localhost)' }).default(DEFAULT_HOST),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
});

export interface ServerAddress {
  host: (typeof LOOPBACK_HOSTS)[number];
  port: number;
}

/** Validates HOST/PORT from an environment-like record; throws with a path-level message. */
export function resolveServerAddress(env: Record<string, string | undefined>): ServerAddress {
  const parsed = serverAddressSchema.safeParse({ HOST: env.HOST, PORT: env.PORT });
  if (!parsed.success) {
    throw new Error(`Invalid server address:\n${z.prettifyError(parsed.error)}`);
  }
  return { host: parsed.data.HOST, port: parsed.data.PORT };
}

/** HTTP origin for the backend, bracketing IPv6 literals. */
export function serverOrigin(addr: ServerAddress): string {
  const host = addr.host.includes(':') ? `[${addr.host}]` : addr.host;
  return `http://${host}:${addr.port}`;
}
