import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  appConfigSchema,
  approvalContent,
  canonicalJson,
  deepFreeze,
  serverAddressSchema,
  type AppConfig,
} from '@volumechecker/shared';

export interface LoadedConfig {
  readonly config: AppConfig;
  /** sha256 of the canonical JSON of the validated, deep-frozen config. */
  readonly hash: string;
  readonly path: string;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Hash identifying the complete configuration snapshot (session/evidence identity). */
export function configHash(config: AppConfig): string {
  return sha256Canonical(config);
}

/** Hash of the settings an approval covers: everything except the approval block. */
export function approvalContentHash(config: AppConfig): string {
  return sha256Canonical(approvalContent(config));
}

/**
 * Validates, deep-freezes and hashes a configuration. The returned
 * snapshot cannot be mutated, so the hash always identifies its behavior.
 * An approved config must carry the content hash of exactly these settings.
 */
export function validateAppConfig(input: unknown, source: string): LoadedConfig {
  const parsed = appConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid configuration ${source}:\n${z.prettifyError(parsed.error)}`);
  }
  const config = deepFreeze(parsed.data);
  if (config.approval.status === 'approved') {
    const actual = approvalContentHash(config);
    if (config.approval.approvedContentHash !== actual) {
      throw new Error(
        `Invalid configuration ${source}: approval.approvedContentHash does not match the approved settings (expected ${actual}). ` +
          'Any change to approved settings requires a new approval.',
      );
    }
  }
  return Object.freeze({ config, hash: configHash(config), path: source });
}

export function loadAppConfig(path: string): LoadedConfig {
  return validateAppConfig(JSON.parse(readFileSync(path, 'utf8')), path);
}

const envSchema = serverAddressSchema.extend({
  // Optional until the capability probe: offline startup must not require a key.
  COINGECKO_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  CONFIG_PATH: z.string().default('config/default.json'),
  DATA_DIR: z.string().default('data'),
});

export type ServerEnv = z.infer<typeof envSchema>;

export function parseEnv(env: Record<string, string | undefined>): ServerEnv {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // prettifyError reports paths and messages only; received values (possibly secrets) are not echoed.
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function resolveFromRoot(root: string, p: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}
