import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Effective environment = repository `.env` overlaid by the process
 * environment (process wins, including explicitly empty values).
 *
 * Used by both the server and the Vite dev proxy so they resolve the
 * same HOST/PORT. The file is parsed into a local object; `.env` values are
 * not copied into `process.env`.
 */
export function effectiveEnv(envFile: string, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const fromFile = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...fromFile, ...processEnv };
}
