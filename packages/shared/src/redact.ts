/**
 * Credential redaction.
 *
 * Note: a bare `token` is NOT sensitive here; CoinGecko uses `token=<address>`
 * (REST) and `"token":"base"` (G3) as ordinary parameters.
 *
 * Two layers, both value-based rather than a list of field paths:
 *  1. `redactText` scrubs any serialized text (a whole log line, an error
 *     message, a URL): known secret values in raw / URL-encoded / JSON-escaped
 *     form, credential-like query parameters, sensitive JSON keys at any depth,
 *     header-style `name: value` pairs and URL userinfo.
 *  2. `redactValue` deep-copies a plain value/Error for places that store or
 *     export structured data (fixtures, operational events), applying the
 *     same rules to keys and strings.
 *
 * Callers pass the secrets they know (e.g. the configured API key) so that a
 * key is removed even when it appears under an unexpected name.
 */

export const REDACTED = '[REDACTED]';

/** Field / parameter / header names whose values are always credentials. */
const SENSITIVE_NAME =
  '(?:x[-_]cg[-_](?:pro|demo)[-_]api[-_]key|coingecko[-_]api[-_]key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|secret|client[-_]?secret|password|passwd|authorization|proxy[-_]authorization|cookie|set[-_]cookie|credentials?|signature)';

const SENSITIVE_NAME_EXACT = new RegExp(`^${SENSITIVE_NAME}$`, 'i');

/** Minimum length for value-based replacement, to avoid scrubbing trivial substrings. */
const MIN_SECRET_LENGTH = 8;

/** "name":"value" in JSON, any depth. Also covers non-string scalar values. */
const JSON_PAIR = new RegExp(`("${SENSITIVE_NAME}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d[\\d.eE+-]*|true|false)`, 'gi');

/** ?name=value / &name=value / ;name=value, including percent-encoded separators. */
const QUERY_PAIR = new RegExp(`((?:[?&;]|%3[fF]|%26)${SENSITIVE_NAME}(?:=|%3[dD]))([^&#\\s"'\\\\<>]*)`, 'gi');

/** Header-style `x-cg-pro-api-key: value` or `api_key=value` inside free text. */
const HEADER_PAIR = new RegExp(`(\\b${SENSITIVE_NAME}\\b['"]?\\s*[:=]\\s*['"]?)(?!\\[REDACTED\\])([^\\s"',;&}\\]\\\\]+)`, 'gi');

/** scheme://user:pass@host */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"'<>]+:[^/\s@"'<>]*@/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function secretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  variants.add(encodeURIComponent(secret));
  variants.add(JSON.stringify(secret).slice(1, -1));
  variants.add(JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1));
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

function usableSecrets(secrets: readonly (string | undefined | null)[]): string[] {
  return secrets.filter((s): s is string => typeof s === 'string' && s.trim().length >= MIN_SECRET_LENGTH).map((s) => s.trim());
}

/** Scrubs credentials from arbitrary text. Idempotent. */
export function redactText(text: string, secrets: readonly (string | undefined | null)[] = []): string {
  let out = text;
  for (const secret of usableSecrets(secrets)) {
    for (const v of secretVariants(secret)) {
      out = out.replace(new RegExp(escapeRegExp(v), 'g'), REDACTED);
    }
  }
  out = out.replace(JSON_PAIR, `$1"${REDACTED}"`);
  out = out.replace(QUERY_PAIR, `$1${REDACTED}`);
  out = out.replace(HEADER_PAIR, `$1${REDACTED}`);
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
  return out;
}

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_EXACT.test(name);
}

const MAX_DEPTH = 12;

/**
 * Deep copy with credentials removed. Errors become plain objects with
 * name/message/stack/code/status/cause. Non-plain objects (sockets, requests)
 * are summarized by constructor name instead of being traversed.
 */
export function redactValue(value: unknown, secrets: readonly (string | undefined | null)[] = [], depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
    const out: Record<string, unknown> = { name: e.name, message: redactText(e.message, secrets) };
    if (e.stack) out.stack = redactText(e.stack, secrets);
    if (e.code !== undefined) out.code = redactValue(e.code, secrets, depth + 1);
    if (e.status !== undefined) out.status = redactValue(e.status, secrets, depth + 1);
    if (e.cause !== undefined) out.cause = redactValue(e.cause, secrets, depth + 1);
    for (const [k, v] of Object.entries(e)) {
      if (!(k in out)) out[k] = isSensitiveName(k) ? REDACTED : redactValue(v, secrets, depth + 1);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets, depth + 1));

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `[${(value as { constructor?: { name?: string } }).constructor?.name ?? 'Object'}]`;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveName(k) ? REDACTED : redactValue(v, secrets, depth + 1);
  }
  return out;
}
