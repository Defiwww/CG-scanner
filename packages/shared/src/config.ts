import {distributionRulesSchema,historicalV1Rules} from './distribution-rules';
import { z } from 'zod';
import { ALLOWED_POOLS, COINGECKO_ENDPOINTS, RISK_STATE_NAMES } from './fixed';

/**
 * Versioned application configuration (config/default.json).
 *
 * Browser-safe: contains no credentials. Numeric scoring/alert values are
 * PROPOSED defaults carried forward from docs/TECHNICAL_SPEC.md; they are not
 * approved until `approval.status` is "approved" with an approver, a UTC
 * timestamp and the content hash of the approved settings.
 *
 * schemaVersion 2 : fixed pool/provider literals, no configurable
 * orientation, structured approval record, ordered state names, horizon checks.
 */

const positiveInt = z.number().int().positive();
const nonNegative = z.number().nonnegative();
const fraction = z.number().min(0).max(1);

/** Severity ramp u(x;a,b) = clamp((x-a)/(b-a),0,1); requires a < b. */
const ramp = z
  .object({ a: z.number(), b: z.number() })
  .strict()
  .refine((r) => r.a < r.b, { message: 'ramp requires a < b' });

const component = z
  .object({
    weight: nonNegative,
    ramp,
  })
  .strict();

const stateBand = z
  .object({
    name: z.enum([...RISK_STATE_NAMES, 'High-Risk Distribution']),
    min: z.number().int().min(0).max(100),
    max: z.number().int().min(0).max(100),
  })
  .strict();

/** Non-empty after trimming, with no surrounding whitespace. */
const meaningfulText = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0 && v.trim() === v, { message: 'must be non-empty without surrounding whitespace' });

/**
 * Approval record. A proposed config carries no approval metadata.
 * An approved config names the approver, an ISO-8601 UTC timestamp and the
 * sha256 of the approved settings (canonical JSON of the config without the
 * `approval` block), which the server verifies at load time. The schema cannot
 * authenticate intent; local approval remains a separate user decision.
 */
const approvalSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('proposed'),
      approvedBy: z.null(),
      approvedAt: z.null(),
      approvedContentHash: z.null(),
      note: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal('approved'),
      approvedBy: meaningfulText,
      approvedAt: z.iso.datetime({ offset: false }),
      approvedContentHash: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest'),
      note: z.string(),
    })
    .strict(),
]);

export const appConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    configVersion: z.string().min(1),
    approval: approvalSchema,
    // Per-user catalog; provider origins stay fixed at the transport boundary.
    // selectedPoolId identifies the active pool; monitor runs one pool at a time.
    // Stop required before switching pools.
    pool: z.object({
      selectedPoolId: z.string().max(110),
      catalog: z.array(z.object({
        networkId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
        poolAddress:z.string().regex(/^0x[0-9a-f]{40}$/),
        baseAddress:z.string().regex(/^0x[0-9a-f]{40}$/),
        quoteAddress:z.string().regex(/^0x[0-9a-f]{40}$/),
        baseName:z.string().min(1).max(40),quoteName:z.string().min(1).max(40),
        trackedAsset:z.literal('base'),
        // Read-only compatibility for previously approved pool catalogs; omitted from runtime DTOs.
        linkAddress:z.string().regex(/^0x[0-9a-f]{40}$/).optional(),
        wethAddress:z.string().regex(/^0x[0-9a-f]{40}$/).optional(),
      }).strict().refine(p=>p.baseAddress!==p.quoteAddress,{message:'Pool tokens must differ'})).min(1).max(20).optional(),
    }).strict().superRefine((p,ctx)=>{
      const ids=(p.catalog??ALLOWED_POOLS).map(x=>`${x.networkId}:${x.poolAddress}`);
      if(!ids.includes(p.selectedPoolId))ctx.addIssue({code:'custom',path:['selectedPoolId'],message:'Selected pool must belong to the local catalog'});
      if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',path:['catalog'],message:'Duplicate pools'});
    }),
    provider: z
      .object({
        restBaseUrl: z.literal(COINGECKO_ENDPOINTS.restBaseUrl),
        wsUrl: z.literal(COINGECKO_ENDPOINTS.wsUrl),
        requestTimeoutMs: positiveInt,
      })
      .strict(),
    polling: z
      .object({
        poolSnapshotIntervalSec: positiveInt,
        reconciliationIntervalSec: positiveInt,
        reconciliationOverlapSec: positiveInt,
        reconnectGapOverlapSec: positiveInt,
        metricsRecomputeIntervalSec: positiveInt,
      })
      .strict(),
    backfill: z
      .object({
        targetMinutes: positiveInt,
        readinessMinutes: positiveInt,
        tradesPerPage: z.number().int().min(1).max(300),
        tradingPeriod: z.literal('1d'),
        maxPagesPerRun: positiveInt,
        ohlcvLimit: positiveInt,
      })
      .strict(),
    freshness: z
      .object({
        maxPriceAgeSec: positiveInt,
        maxReserveAgeSec: positiveInt,
        wsPingIntervalSec: positiveInt,
        wsPongTimeoutSec: positiveInt,
      })
      .strict(),
    retry: z
      .object({
        backoffSec: z.array(positiveInt).min(1),
        jitterFraction: fraction,
      })
      .strict(),
    budget: z
      .object({
        maxRestRequestsPerMinute: positiveInt,
        maxRestRequestsPerSession: positiveInt,
        maxEstimatedCreditsPerSession: positiveInt,
        wsCreditsPerResponse: nonNegative,
        warningFraction: fraction,
        followupReserveRestRequests: z.number().int().nonnegative(),
      })
      .strict(),
    reconciliation: z
      .object({
        amountRelativeTolerance: nonNegative,
        volumeUsdRelativeTolerance: nonNegative,
        timeToleranceSec: positiveInt,
      })
      .strict(),
    metrics: z
      .object({
        windowsMinutes: z.array(positiveInt).min(1),
        volatilityMinClosedCandles: positiveInt,
      })
      .strict(),
    scoring: z
      .object({
        algorithm: z.enum(['legacy-v0','distribution-v1']).optional(),
        v1: distributionRulesSchema.optional(),
        currentWindowMinutes: positiveInt,
        baselineWindowMinutes: positiveInt,
        largeTrade: z
          .object({
            minimumUsd: nonNegative,
            quantile: fraction,
            lookbackMinutes: positiveInt,
            minBaselineTrades: positiveInt,
          })
          .strict(),
        components: z
          .object({
            sellDominance: component,
            flowDeterioration: component,
            largeSellConcentration: component,
            buyerSizeDecline: component,
            usdReserveDecline: component,
            priceFlowDivergence: component.optional(),
          })
          .strict(),
        states: z.array(stateBand).min(1),
      })
      .strict(),
    alerts: z
      .object({
        /** Hard switch. Live alerts stay disabled until explicit configuration approval. */
        liveAlertsEnabled: z.boolean(),
        minScore: z.number().int().min(0).max(100),
        minTradesCurrent: positiveInt,
        minTradesBaseline: positiveInt,
        minBuysEachWindow: positiveInt,
        minSellsCurrent: positiveInt,
        minPriceChangePct: z.number(),
        maxImbalance: z.number().min(-1).max(1),
        minDeterioration: z.number(),
        minSellRateRatio: nonNegative,
        minSellRateUsdPerMinWhenBaselineZero: nonNegative,
        minQualifyingFlowComponents: z.number().int().min(1).max(4),
        qualifyingSeverity: fraction,
        confirmationSec: positiveInt,
        confirmationMinNewTrades: positiveInt,
        confirmationMinNewSells: positiveInt,
        cooldownMinutes: positiveInt,
        recoveryScoreBelow: z.number().int().min(0).max(100),
        recoveryMinutes: positiveInt,
        preAlertContextMinutes: positiveInt,
      })
      .strict(),
    outcomes: z
      .object({
        horizonsMinutes: z.array(positiveInt).min(1),
        candleIntervalMinutes: z.literal(1),
        maxObservationOffsetSec: positiveInt,
        evaluation: z
          .object({
            status: z.enum(['proposed', 'approved']),
            horizonMinutes: positiveInt,
            declineThresholdPct: z.number(),
          })
          .strict(),
      })
      .strict(),
    ui: z
      .object({
        displayTimeZone: z.string().min(1),
        riskDisclaimer: z.literal('This is a risk signal, not a price prediction.'),
      })
      .strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.alerts.liveAlertsEnabled && cfg.approval.status !== 'approved') {
      ctx.addIssue({
        code: 'custom',
        path: ['alerts', 'liveAlertsEnabled'],
        message: 'live alerts cannot be enabled while the configuration is not approved',
      });
    }
    const w = cfg.scoring.components;
    const total =
      w.sellDominance.weight +
      w.flowDeterioration.weight +
      w.largeSellConcentration.weight +
      w.buyerSizeDecline.weight +
      w.usdReserveDecline.weight + (w.priceFlowDivergence?.weight ?? 0);
    if (total !== 100) {
      ctx.addIssue({ code: 'custom', path: ['scoring', 'components'], message: `weights must sum to 100 (got ${total})` });
    }
    if(cfg.scoring.algorithm==='distribution-v1') {
      const r=cfg.scoring.v1??historicalV1Rules;
      const maxima=[r.sellDominance.abovePoints,r.flowDeterioration.at(-1)!.points,r.divergence.extremePoints,r.sellerConcentration.at(-1)!.points,r.buyerDeterioration.at(-1)!.points];
      const weights=[w.sellDominance.weight,w.flowDeterioration.weight,w.priceFlowDivergence?.weight,w.largeSellConcentration.weight,w.buyerSizeDecline.weight];
      if(w.usdReserveDecline.weight!==0||maxima.some((m,i)=>m!==weights[i]||m<=0))ctx.addIssue({code:'custom',path:['scoring'],message:'V1 points must match positive component weights; reserve has no points'});
      if(!cfg.metrics.windowsMinutes.includes(cfg.scoring.currentWindowMinutes))ctx.addIssue({code:'custom',path:['metrics'],message:'Current scoring window must be computed'});
      if(r.confirmation.fastScore<cfg.alerts.minScore)ctx.addIssue({code:'custom',path:['scoring','v1'],message:'Fast confirmation score cannot be below the alert score'});
    }
    // State bands: exactly the five ordered spec states, ascending and tiling 0..100.
    const bands = cfg.scoring.states;
    const names = bands.map((b) => b.name);
    const expectedNames=RISK_STATE_NAMES.map(n=>cfg.scoring.algorithm==='distribution-v1'&&n==='High Risk'?'High-Risk Distribution':n);
    if (names.length !== RISK_STATE_NAMES.length || names.some((n, i) => n !== expectedNames[i])) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoring', 'states'],
        message: `states must be exactly [${RISK_STATE_NAMES.join(', ')}] in ascending order`,
      });
    } else {
      let expectedMin = 0;
      for (const [i, band] of bands.entries()) {
        if (band.min !== expectedMin || band.max < band.min) {
          ctx.addIssue({ code: 'custom', path: ['scoring', 'states', i], message: 'state bands must cover 0..100 contiguously' });
          break;
        }
        expectedMin = band.max + 1;
      }
      if (expectedMin !== 101) {
        ctx.addIssue({ code: 'custom', path: ['scoring', 'states'], message: 'state bands must end at 100' });
      }
    }
    // Outcome horizons: unique, strictly ascending, and the evaluation horizon must be scheduled.
    const horizons = cfg.outcomes.horizonsMinutes;
    if (horizons.some((h, i) => i > 0 && h <= horizons[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['outcomes', 'horizonsMinutes'], message: 'horizons must be unique and strictly ascending' });
    }
    if (!horizons.includes(cfg.outcomes.evaluation.horizonMinutes)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcomes', 'evaluation', 'horizonMinutes'],
        message: 'evaluation horizon must be one of outcomes.horizonsMinutes',
      });
    }
  });

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** A validated configuration snapshot. Recursively readonly; runtime values are deep-frozen. */
export type AppConfig = DeepReadonly<z.infer<typeof appConfigSchema>>;

/** Recursively freezes a plain JSON value in place and returns it. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Validates and deep-freezes. The returned object cannot change after its hash is computed. */
export function parseAppConfig(input: unknown): AppConfig {
  return deepFreeze(appConfigSchema.parse(input));
}

/** The settings covered by an approval: the whole config except the approval block itself. */
export function approvalContent(config: AppConfig): Omit<AppConfig, 'approval'> {
  const { approval: _approval, ...rest } = config;
  return rest;
}

/**
 * Canonical JSON serialization: object keys sorted recursively, no whitespace.
 * The config hash is sha256 over this string, so formatting/key order in the
 * JSON file does not change the hash but any value change does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Old frozen configs retain their hashes and their original versioned behavior. */
export const v1Rules=(config:AppConfig)=>config.scoring.v1??historicalV1Rules;
