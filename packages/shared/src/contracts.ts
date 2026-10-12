/**
 * Browser-safe DTOs shared by the server and the dashboard.
 * No secrets and no provider client code belong in this package.
 */

/** Session lifecycle. Data quality is a separate axis. */
export const SESSION_STATES = [
  'idle',
  'starting',
  'warming_up',
  'monitoring',
  'stopped_with_followup',
  'complete',
  'error',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type SessionMode = 'live' | 'replay';

/** Status of a capability that has not yet been exercised against the real provider. */
export type VerificationStatus = 'unverified' | 'verified' | 'failed';

export interface HealthResponse {
  status: 'ok';
  milestone: string;
  serverTimeUtc: string;
  uptimeSec: number;
  config: {
    configVersion: string;
    configHash: string;
    approvalStatus: 'proposed' | 'approved';
    liveAlertsEnabled: boolean;
  };
  provider: {
    /** Only whether a key is present in the server environment; the key itself is never exposed. */
    apiKeyConfigured: boolean;
    /** Summary of the inspection monitor; details at GET /api/inspection. */
    restStatus: 'not_connected' | 'ok' | 'error';
    wsStatus: TransportState;
  };
  storage: {
    driver: 'better-sqlite3';
    sqliteVersion: string;
  };
  /** Present only for a time-limited deployment. After `expired`, no provider request or background job runs. */
  lifetime?: {
    startedAt: string;
    expiresAt: string;
    expired: boolean;
    collectorActive: boolean;
  };
}

export interface PoolIdentityResponse {
  networkId: string;
  poolAddress: string;
  trackedTokenAddress: string;
  counterTokenAddress: string;
  /** Derived only from actual CoinGecko metadata, never from configuration. */
  orientationStatus: VerificationStatus;
  /** Identity comes from the fixed product contract (packages/shared/src/fixed.ts). */
  source: 'fixed-contract';
  displayTimeZone: string;
  riskDisclaimer: string;
}

// ---------------------------------------------------------------------------
// Inspection contracts. Decimal values are strings; times are explicit:
// `providerTimeMs` = WS G2 `t` (provider update time, ms, NOT block time);
// `blockTimestamp` = REST block time (ISO UTC); `receivedAt` = local receipt (ISO UTC).
// ---------------------------------------------------------------------------

export type TrackedTokenSide = 'base' | 'quote';

export interface OrientationResult {
  status: VerificationStatus;
  trackedTokenSide: TrackedTokenSide | null;
  baseTokenAddress: string | null;
  quoteTokenAddress: string | null;
  poolAddress: string | null;
  verifiedAt: string | null;
  detail: string;
}

/** Direction of the trade relative to tracked token. */
export type TradeSide = 'buy' | 'sell';

export interface TradeObservation {
  source: 'ws' | 'rest';
  /**
   * `live` = WS frame whose provider time is not older than the subscription;
   * `subscription-replay` = WS frame delivered on subscribe for an earlier trade
   * (the latest existing trade may be replayed); `rest` = REST history.
   */
  delivery: 'live' | 'subscription-replay' | 'rest';
  /** WS only: local receipt minus provider time `t` (ms). Large values mean late delivery. */
  deliveryLagMs: number | null;
  /** REST `data.id` (stable per swap); null for WS (provisional). */
  providerTradeId: string | null;
  txHash: string | null;
  side: TradeSide | null;
  /** How `side` was derived, for auditability. */
  sideBasis: 'rest-token-addresses' | 'ws-type-relative-to-base' | 'unknown';
  /** Provider's own label as received (`b`/`s` or `buy`/`sell`). */
  providerSideLabel: string | null;
  trackedAmount: string | null;
  counterAmount: string | null;
  volumeUsd: string | null;
  /** tracked token/USD for this trade as reported/derived; see `trackedPriceBasis`. */
  trackedPriceUsd: string | null;
  trackedPriceBasis: 'ws-pu-base-token' | 'rest-token-price' | 'unavailable';
  providerTimeMs: number | null;
  blockTimestamp: string | null;
  blockNumber: number | null;
  senderAddress: string | null;
  receivedAt: string;
}

export interface CandleObservation {
  source: 'ws' | 'rest';
  interval: string;
  tokenSide: TrackedTokenSide | null;
  /** Candle open time, epoch SECONDS. */
  openTimeSec: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volumeUsd: string | null;
  receivedAt: string;
  /** Number of provider updates that replaced this candle (WS). */
  updates: number;
}

export interface PriceObservation {
  source: 'rest-pool-metadata' | 'ws-ohlcv-close' | 'ws-trade';
  priceUsd: string;
  /** Provider time (ISO UTC) when the provider supplies one; see `providerTimeKind`. */
  providerTime: string | null;
  /** `trade-update` = G2 `t` (ms); `candle-open` = G3 candle open time (s), not the price time; `none` = no provider time. */
  providerTimeKind: 'trade-update' | 'candle-open' | 'none';
  receivedAt: string;
  /**
   * Time the price is known to be current as of, used for freshness:
   * trade update time (G2), candle open + interval (G3, upper bound), or receipt (pool metadata, no provider time).
   */
  asOf: string;
}

export interface RawSample {
  kind: 'rest_pool_metadata' | 'rest_trade' | 'rest_ohlcv' | 'ws_trade' | 'ws_candle' | 'ws_control';
  endpointOrChannel: string;
  receivedAt: string;
  /** Unchanged provider text after credential scrubbing (payloads carry no credentials). */
  rawText: string;
  /** Extracted fields for display next to the raw payload. */
  mapped: unknown;
}

export type CapabilityStatus = 'pending' | 'ok' | 'failed' | 'unavailable';

export interface CapabilityState {
  id: string;
  label: string;
  kind: 'rest' | 'ws';
  status: CapabilityStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  httpStatus: number | null;
  detail: string;
}

export type IndicatorState = 'ok' | 'stale' | 'down' | 'inactive' | 'unknown';

export interface Indicator {
  state: IndicatorState;
  /** Seconds since the relevant last event, if any. */
  ageSec: number | null;
  lastAt: string | null;
  detail: string;
}

export type TransportState = 'disconnected' | 'connecting' | 'open' | 'subscribing' | 'streaming' | 'reconnecting' | 'auth_failed' | 'error';

export interface OperationalError {
  at: string;
  operation: string;
  kind: string;
  httpStatus: number | null;
  message: string;
}

export interface InspectionSnapshot {
  activePoolId: string | null;
  connectionState: 'disconnected' | 'connecting' | 'waiting' | 'receiving' | 'reconnecting' | 'error';
  connectedSince: string | null;
  newTrades: number;
  lastNewTradeAt: string | null;
  persistence: {state:'ok'|'error'|'unavailable';error:string|null;sessionId:string|null;canonicalTrades:number;pendingWs:number;ambiguousWs:number};
  recovery: {complete:boolean;recovering:boolean;detail:string};
  mode: 'live';
  serverTimeUtc: string;
  monitor: 'idle' | 'starting' | 'running' | 'blocked';
  monitorDetail: string;
  apiKeyConfigured: boolean;
  pool: { networkId: string; poolAddress: string; trackedTokenAddress: string; counterTokenAddress: string };
  orientation: OrientationResult;
  transport: {
    state: TransportState;
    connectedAt: string | null;
    lastFrameAt: string | null;
    lastHeartbeatAt: string | null;
    heartbeatKind: string | null;
    reconnects: number;
    subscriptions: { channel: string; confirmed: boolean; poolsSet: boolean; detail: string }[];
  };
  indicators: {
    transport: Indicator;
    priceFreshness: Indicator;
    tradeInactivity: Indicator;
    reserveFreshness: Indicator;
  };
  latestPrice: PriceObservation | null;
  priceObservations: PriceObservation[];
  reserve: { reserveUsd: string; receivedAt: string } | null;
  trades: TradeObservation[];
  candles: CandleObservation[];
  capabilities: CapabilityState[];
  /** Runtime consistency checks on mappings (e.g. provider label vs address-derived side). */
  checks: { id: string; status: 'pass' | 'fail' | 'pending'; detail: string }[];
  rawSamples: RawSample[];
  controlFrames: RawSample[];
  errors: OperationalError[];
  usage: {
    restAttempts: number;
    restSuccesses: number;
    restErrors: number;
    wsDataMessages: number;
    wsControlMessages: number;
    wsHeartbeats: number;
    estimatedCredits: number;
    note: string;
  };
}
