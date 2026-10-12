import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { REDACTED, isSensitiveName, redactText, redactValue } from '@volumechecker/shared';

/**
 * Logging with credential redaction.
 *
 * Every serialized line passes through `redactText` before it reaches the
 * destination, so known secret values (raw, URL-encoded, JSON-escaped),
 * credential query parameters, sensitive keys at any depth, header-style
 * pairs and URL userinfo are removed regardless of where they appear
 * (message, nested object, error message/stack/cause, request URL).
 * Error and object arguments are additionally deep-copied through
 * `redactValue` before serialization. Timestamps are ISO-8601 UTC.
 */

export interface RedactingLoggerOptions {
  level: string;
  /** Known secret values (e.g. the CoinGecko key). Values, not names. */
  secrets: readonly (string | undefined)[];
  /** Defaults to stdout; tests pass a capturing stream. */
  destination?: DestinationStream;
}

export function redactingDestination(inner: DestinationStream, secrets: readonly (string | undefined)[]): DestinationStream {
  return {
    write(line: string) {
      inner.write(redactText(line, secrets));
    },
  };
}

export function loggerOptions(level: string, secrets: readonly (string | undefined)[]): LoggerOptions {
  return {
    level,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    hooks: {
      logMethod(args, method) {
        // A bare Error as the merging object keeps pino's `err` convention.
        const cleaned = args.map((a, i) => (i === 0 && a instanceof Error ? { err: redactValue(a, secrets) } : sanitizeArg(a, secrets)));
        return method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    serializers: {
      // Error objects are already converted by redactValue; keep the key name `err` stable.
      err: (e: unknown) => redactValue(e, secrets),
      req: (req: { method?: string; url?: string; id?: string }) => ({
        method: req.method,
        url: req.url === undefined ? undefined : redactText(req.url, secrets),
        id: req.id,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

/**
 * Deep-sanitizes Errors and plain data in a log argument. Non-plain values
 * (Fastify request/reply, sockets) are left for their serializers; the
 * line-level scrub in `redactingDestination` still applies to their output.
 */
function sanitizeArg(arg: unknown, secrets: readonly (string | undefined)[]): unknown {
  if (arg === null || typeof arg !== 'object') return arg;
  if (arg instanceof Error || Array.isArray(arg)) return redactValue(arg, secrets);
  if (!isPlainOrError(arg)) return arg;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(arg)) {
    if (isSensitiveName(k)) out[k] = REDACTED;
    else if (v !== null && typeof v === 'object' && !isPlainOrError(v) && !Array.isArray(v)) out[k] = v;
    else out[k] = redactValue(v, secrets);
  }
  return out;
}

function isPlainOrError(v: object): boolean {
  if (v instanceof Error) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function createLogger(opts: RedactingLoggerOptions): Logger {
  const destination = opts.destination ?? pino.destination({ fd: 1, sync: false });
  return pino(loggerOptions(opts.level, opts.secrets), redactingDestination(destination, opts.secrets));
}
