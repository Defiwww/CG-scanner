import { sameSwap } from '@volumechecker/engine';
import type { M2Collector } from '@volumechecker/storage';
import {
  getPoolConfig,
  redactText,
  type AppConfig,
  type CandleObservation,
  type CapabilityState,
  type Indicator,
  type InspectionSnapshot,
  type OperationalError,
  type OrientationResult,
  type PoolConfig,
  type PriceObservation,
  type RawSample,
  type TradeObservation,
  type TransportState,
} from '@volumechecker/shared';
import {
  CoinGeckoStream,
  ProviderError,
  UsageCounters,
  WS_CHANNELS,
  createRestClient,
  g2TradeSchema,
  g3CandleSchema,
  isFixedPoolFrame,
  trackedPriceFromMetadata,
  mapRestOhlcvRow,
  mapRestTrade,
  mapWsCandle,
  mapWsTrade,
  ohlcvMinuteRoute,
  ohlcvResponseSchema,
  poolMetadataRoute,
  poolMetadataSchema,
  tradesResponseSchema,
  tradesRoute,
  verifyOrientation,
  type ClassifiedFrame,
  type FetchLike,
  type RestClient,
  type SocketFactory,
} from '@volumechecker/coingecko';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Inspection monitor: capability checks and live stream for the selected pool,
 * with in-memory observations and optional durable storage. One instance per server process;
 * start/stop are idempotent, so multiple tabs never multiply connections.
 *
 * Sequence: pool metadata → verify identity/orientation → REST trades + OHLCV
 * → WebSocket (G2 then G3) → periodic pool metadata (price + USD reserve).
 * Nothing is fabricated: indicators report unknown/stale/inactive honestly.
 */

/** Display-only notice threshold for "No recent trades" (not an alert input). */
export const TRADE_INACTIVITY_NOTICE_SEC = 120;
const MAX_TRADES = 200;
const MAX_CANDLES = 90;
const MAX_PRICES = 100;
const MAX_ERRORS = 50;
const MAX_CONTROL = 20;
const PU_CONSISTENCY_TOLERANCE = 0.02;
/** REST trades this much older than now and absent from the stream mark the stream as behind. */
export const STREAM_LAG_GRACE_SEC = 60;


export interface MonitorDeps {
  config: AppConfig;
  apiKey: string | undefined;
  log: FastifyBaseLogger;
  fetchImpl?: FetchLike;
  socketFactory?: SocketFactory;
  now?: () => number;
  poolId?: string;
  collector?: M2Collector;
}

type CapabilityId =
  | 'rest.pool_metadata'
  | 'rest.orientation'
  | 'rest.trades'
  | 'rest.trades.sender'
  | 'rest.trades.crosscheck'
  | 'rest.ohlcv_minute'
  | 'ws.connect'
  | 'ws.heartbeat'
  | 'ws.onchain_trade.subscribe'
  | 'ws.onchain_trade.data'
  | 'ws.onchain_ohlcv.subscribe'
  | 'ws.onchain_ohlcv.data';

const CAPABILITY_LABELS: Record<CapabilityId, [string, 'rest' | 'ws']> = {
  'rest.pool_metadata': ['GET /onchain/networks/{network}/pools/P?include=base_token,quote_token', 'rest'],
  'rest.orientation': ['Pool identity and tracked/quote token orientation (from metadata)', 'rest'],
  'rest.trades': ['GET /onchain/networks/{network}/pools/P/trades?token={tracked token address}&trading_period=1d&per_page=N', 'rest'],
  'rest.trades.sender': ['REST trade sender (tx_from_address) coverage', 'rest'],
  'rest.trades.crosscheck': ['GET …/trades?bounded pagination every 60 s: stream delivery cross-check', 'rest'],
  'rest.ohlcv_minute': ['GET /onchain/networks/{network}/pools/P/ohlcv/minute?aggregate=1&currency=usd&token={tracked token address}', 'rest'],
  'ws.connect': ['wss://stream.coingecko.com/v1 (key in header)', 'ws'],
  'ws.heartbeat': ['WebSocket heartbeat (ping)', 'ws'],
  'ws.onchain_trade.subscribe': ['OnchainTrade (G2) subscribe + set_pools {network}:P', 'ws'],
  'ws.onchain_trade.data': ['OnchainTrade (G2) market data for the pool', 'ws'],
  'ws.onchain_ohlcv.subscribe': ['OnchainOHLCV (G3) subscribe + set_pools {network}:P, 1m, tracked token side', 'ws'],
  'ws.onchain_ohlcv.data': ['OnchainOHLCV (G3) market data for the pool', 'ws'],
};

export class InspectionMonitor {
  private monitor: InspectionSnapshot['monitor'] = 'idle';
  private monitorDetail = 'Not started. Press Connect to run the capability probe and open the stream.';
  private orientation: OrientationResult = {
    status: 'unverified',
    trackedTokenSide: null,
    baseTokenAddress: null,
    quoteTokenAddress: null,
    poolAddress: null,
    verifiedAt: null,
    detail: 'Not yet verified against CoinGecko pool metadata.',
  };
  private readonly caps = new Map<CapabilityId, CapabilityState>();
  private readonly checks = new Map<string, { id: string; status: 'pass' | 'fail' | 'pending'; detail: string }>();
  private trades: TradeObservation[] = [];
  private candles = new Map<number, CandleObservation>();
  private prices: PriceObservation[] = [];
  private reserve: InspectionSnapshot['reserve'] = null;
  private errors: OperationalError[] = [];
  private rawSamples = new Map<RawSample['kind'], RawSample>();
  private controlFrames: RawSample[] = [];
  private transport: InspectionSnapshot['transport'] = {
    state: 'disconnected',
    connectedAt: null,
    lastFrameAt: null,
    lastHeartbeatAt: null,
    heartbeatKind: null,
    reconnects: 0,
    subscriptions: [
      { channel: WS_CHANNELS.trade, confirmed: false, poolsSet: false, detail: 'not subscribed' },
      { channel: WS_CHANNELS.ohlcv, confirmed: false, poolsSet: false, detail: 'not subscribed' },
    ],
  };
  private lastWsTradeAt: number | null = null;
  private tradeSubscribedAt: number | null = null;
  private lastRestOk: boolean | null = null;
  private labelAgreement = { agree: 0, disagree: 0 };
  private stream: CoinGeckoStream | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private crossCheckTimer: NodeJS.Timeout | null = null;
  /** REST-known trades during the subscription that the stream has not delivered (null = none / not checked). */
  private lastDeliveryRecoveryAt = 0;
  private streamLag: { recentMissing: number; missing: number; oldestMissingBlockTime: string; checkedAt: string } | null = null;
  private restWindow: number[] = [];
  private pollBlockedUntil = 0;
  private generation = 0;
  private readonly usage: UsageCounters;
  private readonly rest: RestClient;
  private readonly now: () => number;
  private abort = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private stopTask: Promise<void> | null = null;
  private startedAt: number | null = null;
  private newTrades = 0;
  private lastNewTradeAt: string | null = null;
  private storageError: string | null = null;
  private coverageDetail = 'Not checked';
  private coverageComplete = false;
  private recovering = false;
  private selectedPool: PoolConfig | null = null;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.usage = new UsageCounters(deps.config.budget.wsCreditsPerResponse);
    this.rest = createRestClient({
      apiKey: deps.apiKey,
      timeoutMs: deps.config.provider.requestTimeoutMs,
      usage: this.usage,
      now: this.now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const poolId = deps.poolId ?? deps.config.pool.selectedPoolId;
    this.selectedPool = getPoolConfig(poolId,deps.config.pool.catalog) ?? null;
    for (const [id, [label, kind]] of Object.entries(CAPABILITY_LABELS) as [CapabilityId, [string, 'rest' | 'ws']][]) {
      this.caps.set(id, { id, label, kind, status: 'pending', lastAttemptAt: null, lastSuccessAt: null, httpStatus: null, detail: 'not attempted' });
    }
    if (!deps.apiKey) {
      this.monitor = 'blocked';
      this.monitorDetail = 'COINGECKO_API_KEY is not configured on the server. Add it to the local .env and restart the server.';
    }
  }

  // ---------------------------------------------------------------- control

  /** Idempotent: a second call while starting/running is a no-op. */
  async start(): Promise<void> {
    if (!this.deps.apiKey) return;
    if (this.monitor === 'starting' || this.monitor === 'running') return;
    if (this.stopTask) await this.stopTask;
    this.abort = new AbortController();
    const gen = ++this.generation;
    this.startedAt = this.now();
    this.monitor = 'starting';
    this.monitorDetail = 'Running capability probe: pool metadata, orientation, trades, OHLCV.';
    try {
      this.save(()=>this.deps.collector?.start());
      const ok = await this.fetchMetadata(gen);
      if (gen !== this.generation) return;
      if (!ok || this.orientation.status !== 'verified' || !this.orientation.trackedTokenSide) {
        this.monitor = 'blocked';
        this.monitorDetail =
          this.caps.get('rest.pool_metadata')!.status === 'failed'
            ? `Pool metadata unavailable: ${this.caps.get('rest.pool_metadata')!.detail}`
            : `Orientation not verified: ${this.orientation.detail}. Direction-dependent capabilities are blocked; no fallback pool or provider is used.`;
        this.markUnavailable(['rest.trades', 'rest.trades.sender', 'rest.ohlcv_minute', 'ws.connect', 'ws.heartbeat', 'ws.onchain_trade.subscribe', 'ws.onchain_trade.data', 'ws.onchain_ohlcv.subscribe', 'ws.onchain_ohlcv.data'], 'blocked: orientation not verified');
        return;
      }
      await this.fetchTrades(gen);
      if (gen !== this.generation || this.isAuthFailed()) return;
      await this.fetchOhlcv(gen);
      if (gen !== this.generation || this.isAuthFailed()) return;
      this.openStream(this.orientation.trackedTokenSide);
      this.schedulePoll(gen);
      this.scheduleCrossCheck(gen);
      this.monitor = 'running';
      this.monitorDetail = 'Collecting to SQLite. REST trades are canonical; fresh non-replay WS delivery is required for new live alerts.';
    } catch (err) {
      if (gen !== this.generation) return;
      this.recordError(err);
      await this.stop();
      this.monitor = 'blocked';
      this.monitorDetail = this.storageError ?? 'Start failed; see errors.';
    }
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.generation++;
    this.abort.abort();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.crossCheckTimer) clearTimeout(this.crossCheckTimer);
    this.pollTimer = this.crossCheckTimer = null;
    const stream = this.stream;
    this.stream = null;
    this.streamLag = null;
    this.tradeSubscribedAt = null;
    this.transport.state = 'disconnected';
    for (const sub of this.transport.subscriptions) Object.assign(sub, { confirmed: false, poolsSet: false, detail: 'not subscribed' });
    if (this.deps.apiKey && !this.isAuthFailed()) {
      this.monitor = this.storageError ? 'blocked' : 'idle';
      this.monitorDetail = this.storageError ?? 'Disconnected. Saved records remain in SQLite.';
    }
    this.stopTask = (async () => {
      await stream?.stop();
      await Promise.allSettled([...this.pending]);
      try { this.deps.collector?.stop(this.storageError ? 'error' : 'stopped'); }
      catch (err) { this.storageError = 'Could not finalize SQLite session'; this.recordError(err); }
    })().finally(() => { this.stopTask = null; });
    return this.stopTask;
  }

  private request(route: Parameters<RestClient['get']>[0]) {
    const task = this.rest.get(route, this.abort.signal);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  private save<T>(write: () => T): T {
    try { return write(); }
    catch (err) {
      this.storageError = 'SQLite write failed. Collection stopped; inspect server log and disk.';
      this.recordError(err);
      void this.stop();
      throw err;
    }
  }

  // ------------------------------------------------------------------ REST

  private allowRestCall(): boolean {
    if (this.abort.signal.aborted) return false;
    const usage = this.usage.snapshot();
    if (usage.rest.attempts >= this.deps.config.budget.maxRestRequestsPerSession || usage.estimatedCredits >= this.deps.config.budget.maxEstimatedCreditsPerSession) {
      void this.stop();
      this.monitor = 'blocked';
      this.monitorDetail = 'Session budget reached. Collection paused; Disconnect before restarting.';
      return false;
    }
    const now = this.now();
    this.restWindow = this.restWindow.filter((t) => now - t < 60_000);
    if (now < this.pollBlockedUntil) return false;
    if (this.restWindow.length >= this.deps.config.budget.maxRestRequestsPerMinute) {
      this.pushError({ operation: 'budget', kind: 'rate_limited', httpStatus: null, message: `local REST budget of ${this.deps.config.budget.maxRestRequestsPerMinute}/min reached; call skipped` });
      return false;
    }
    this.restWindow.push(now);
    return true;
  }

  private async fetchMetadata(gen: number): Promise<boolean> {
    if (gen !== this.generation || !this.allowRestCall()) return false;
    if (!this.selectedPool) {
      this.fail(this.touch('rest.pool_metadata'), null, 'Pool not configured');
      return false;
    }
    const cap = this.touch('rest.pool_metadata');
    try {
      const res = await this.request(poolMetadataRoute(this.selectedPool));
      if (gen !== this.generation) return false;
      this.lastRestOk = true;
      const parsed = poolMetadataSchema.safeParse(res.body);
      this.sample('rest_pool_metadata', res.endpoint, res.receivedAt, res.bodyText, null);
      if (!parsed.success) {
        this.fail(cap, res.httpStatus, `payload did not match schema at ${parsed.error.issues[0]?.path.join('.')}`);
        return false;
      }
      this.ok(cap, res.httpStatus, `HTTP ${res.httpStatus} in ${res.durationMs} ms`);

      const orientation = verifyOrientation(res.body, res.receivedAt, this.selectedPool);
      if (this.orientation.status === 'verified' && (orientation.status !== 'verified' || orientation.trackedTokenSide !== this.orientation.trackedTokenSide)) {
        // Orientation must never change silently under a running stream.
        this.pushError({ operation: 'orientation', kind: 'invalid_payload', httpStatus: null, message: 'pool orientation changed between metadata responses; stopping' });
        void this.stop();
        this.monitor = 'blocked';
        this.monitorDetail = 'Orientation changed between responses; stopped for investigation.';
        return false;
      }
      this.orientation = orientation;
      const oc = this.touch('rest.orientation');
      if (orientation.status === 'verified') this.ok(oc, null, orientation.detail);
      else this.fail(oc, null, orientation.detail);

      const attrs = parsed.data.data.attributes;
      if (attrs.reserve_in_usd) this.reserve = { reserveUsd: attrs.reserve_in_usd, receivedAt: res.receivedAt };
      if (orientation.trackedTokenSide) {
        const price = trackedPriceFromMetadata(attrs, orientation.trackedTokenSide, res.receivedAt);
        if (price) this.pushPrice(price);
        this.save(()=>this.deps.collector?.poolObservation(Date.parse(res.receivedAt),price?.priceUsd ?? null,attrs.reserve_in_usd ?? null));
      }
      this.rawSamples.get('rest_pool_metadata')!.mapped = {
        poolAddress: attrs.address,
        baseTokenId: parsed.data.data.relationships.base_token.data?.id ?? null,
        quoteTokenId: parsed.data.data.relationships.quote_token.data?.id ?? null,
        trackedTokenSide: orientation.trackedTokenSide,
        trackedPriceUsd: orientation.trackedTokenSide ? (orientation.trackedTokenSide === 'base' ? attrs.base_token_price_usd : attrs.quote_token_price_usd) : null,
        reserveInUsd: attrs.reserve_in_usd,
      };
      return true;
    } catch (err) {
      if (gen === this.generation) this.onRestError(cap, err);
      return false;
    }
  }

  private async fetchTrades(gen: number, initial = true): Promise<void> {
    if (gen !== this.generation || !this.selectedPool) return;
    const cap = this.touch(initial ? 'rest.trades' : 'rest.trades.crosscheck');
    const previous = this.deps.collector?.recovery();
    const now = this.now();
    const savedTarget = (previous?.last_success_ms
      ? previous.last_success_ms - this.deps.config.polling.reconciliationOverlapSec * 1000
      : now - this.deps.config.backfill.targetMinutes * 60_000);
    const target = initial ? Math.min(savedTarget,now-this.deps.config.backfill.targetMinutes*60000) : savedTarget;
    let coveredFrom = Infinity;
    let cursor: string | null = null;
    const visited = new Set<string>();
    this.coverageComplete = false;
    this.coverageDetail = 'Recovering REST history';
    this.recovering = true;
    try {
      for (let page = 0; page < this.deps.config.backfill.maxPagesPerRun; page++) {
        if (gen !== this.generation || !this.allowRestCall()) break;
        const res = await this.request(tradesRoute({ perPage: this.deps.config.backfill.tradesPerPage, tradingPeriod: '1d', cursor }, this.selectedPool));
        if (gen !== this.generation) return;
        const parsed = tradesResponseSchema.parse(res.body);
        const mapped = parsed.data.map(t => mapRestTrade(t, res.receivedAt, this.selectedPool!));
        const observations = mapped.map(m=>m.trade);
        const sample: RawSample = {kind:'rest_trade',endpointOrChannel:res.endpoint,receivedAt:res.receivedAt,rawText:redactText(res.bodyText,[this.deps.apiKey]),mapped:null};
        const known = new Set(this.trades.map(t=>t.providerTradeId).filter(Boolean));
        const inserted = this.save(()=>this.deps.collector?.restBatch(sample,observations)) ?? observations.filter(t=>!known.has(t.providerTradeId));
        for (const m of mapped) {
          if (m.labelAgrees === true) this.labelAgreement.agree++;
          if (m.labelAgrees === false) this.labelAgreement.disagree++;
        }
        if (!initial) for (const t of inserted) {
          const time = Date.parse(t.blockTimestamp ?? '');
          if (this.startedAt !== null && time > this.startedAt && time <= now) {
            this.newTrades++;
            if (!this.lastNewTradeAt || time > Date.parse(this.lastNewTradeAt)) this.lastNewTradeAt = t.blockTimestamp;
          }
        }
        this.trades = [...observations,...this.trades.filter(t=>!observations.some(n=>n.providerTradeId && n.providerTradeId===t.providerTradeId))].sort((a,b)=>(Date.parse(b.blockTimestamp ?? b.receivedAt)-Date.parse(a.blockTimestamp ?? a.receivedAt))).slice(0,MAX_TRADES);
        this.rawSamples.set('rest_trade',{...sample,rawText:JSON.stringify(parsed.data[0] ?? {}),mapped:observations[0] ?? null});
        const times = observations.map(t=>Date.parse(t.blockTimestamp ?? '')).filter(Number.isFinite);
        const oldest = times.length ? Math.min(...times) : Infinity;
        // Only successfully persisted, traversed pages establish a recent interval.
        if (!this.storageError) coveredFrom = Math.min(coveredFrom, oldest);
        cursor = parsed.meta?.next_cursor ?? null;
        if (oldest <= target || (!cursor && target >= now - 86400_000)) {
          this.coverageComplete = true;
          this.coverageDetail = `REST recovery complete to ${new Date(target).toISOString()} (${page+1} page(s))`;
          break;
        }
        if (!cursor || visited.has(cursor)) break;
        visited.add(cursor);
      }
      if (gen !== this.generation) return;
      if (!this.coverageComplete) this.coverageDetail = `Incomplete REST recovery from ${new Date(target).toISOString()}: page cap, provider depth or budget reached`;
      this.save(()=>this.deps.collector?.coverage(target,now,this.coverageComplete,this.coverageDetail,Number.isFinite(coveredFrom)?coveredFrom:undefined));
      const historicalGap = this.deps.collector?.recovery()?.incomplete_from_ms;
      if (historicalGap != null) {
        this.coverageComplete = false;
        this.coverageDetail += `; historical gap retained from ${new Date(historicalGap).toISOString()}. Current window coverage is evaluated separately.`;
      }
      this.ok(cap,200,this.coverageDetail);
      const withSender = this.trades.filter(t=>t.source==='rest' && t.senderAddress).length;
      this.ok(this.touch('rest.trades.sender'),null,`${withSender} REST trades with sender in displayed history`);
      this.setCheck('rest.kind_vs_addresses',this.labelAgreement.disagree?'fail':this.labelAgreement.agree?'pass':'pending',`${this.labelAgreement.agree} labels agree; ${this.labelAgreement.disagree} disagree with token addresses`);
    } catch(err) {
      if (gen === this.generation) {
        this.coverageDetail = 'Incomplete REST recovery: request or storage failed';
        if (!this.storageError) this.save(()=>this.deps.collector?.coverage(target,now,false,this.coverageDetail));
        this.onRestError(cap,err);
      }
    } finally { if(gen===this.generation) this.recovering=false; }
  }

  private async fetchOhlcv(gen: number): Promise<void> {
    if (gen !== this.generation || !this.allowRestCall()) return;
    if (!this.selectedPool) return;
    const cap = this.touch('rest.ohlcv_minute');
    try {
      const res = await this.request(ohlcvMinuteRoute({ limit: this.deps.config.backfill.ohlcvLimit }, this.selectedPool));
      if (gen !== this.generation) return;
      const parsed = ohlcvResponseSchema.safeParse(res.body);
      if (!parsed.success) {
        this.fail(cap, res.httpStatus, `payload did not match schema at ${parsed.error.issues[0]?.path.join('.')}`);
        return;
      }
      const rows = parsed.data.data.attributes.ohlcv_list;
      const metaBase = parsed.data.meta?.base?.address?.toLowerCase() ?? null;
      // With token=<base address> the response's `meta.base` should be the tracked asset (inverted chart when base is quote).
      const rowsTrackSelectedToken = metaBase === this.selectedPool?.baseAddress;
      for (const row of rows.slice(0, MAX_CANDLES)) {
        const c = mapRestOhlcvRow(row, this.orientation.trackedTokenSide, res.receivedAt);
        this.save(()=>this.deps.collector?.candle({kind:'rest_ohlcv',endpointOrChannel:res.endpoint,receivedAt:res.receivedAt,rawText:JSON.stringify(row),mapped:null},c));
        if (!this.candles.has(c.openTimeSec)) this.candles.set(c.openTimeSec, c);
      }
      this.trimCandles();
      this.sample('rest_ohlcv', res.endpoint, res.receivedAt, JSON.stringify({ first_rows: rows.slice(0, 3), meta: parsed.data.meta ?? null }), { rows: rows.length, metaBase, rowsTrackSelectedToken });
      const newest = rows[0]?.[0];
      this.ok(cap, res.httpStatus, `${rows.length} candles; newest open ${newest ? new Date(newest * 1000).toISOString() : 'n/a'} (seconds); meta.base ${rowsTrackSelectedToken ? 'is the tracked token' : `is ${metaBase ?? 'missing'}`}`);
      this.setCheck('rest.ohlcv_token', rowsTrackSelectedToken ? 'pass' : 'fail', `OHLCV with token={tracked token address} address reports meta.base=${metaBase ?? 'missing'}`);
    } catch (err) {
      if (gen === this.generation) this.onRestError(cap, err);
    }
  }

  private schedulePoll(gen: number): void {
    const interval = this.deps.config.polling.poolSnapshotIntervalSec * 1000;
    this.pollTimer = setTimeout(() => {
      void (async () => {
        if (gen !== this.generation) return;
        await this.fetchMetadata(gen);
        if (gen === this.generation && !this.isAuthFailed()) this.schedulePoll(gen);
      })();
    }, interval);
  }

  private scheduleCrossCheck(gen: number): void {
    this.crossCheckTimer = setTimeout(() => {
      void (async () => {
        if (gen !== this.generation) return;
        await this.crossCheckTrades(gen);
        if (gen === this.generation && !this.isAuthFailed()) this.scheduleCrossCheck(gen);
      })();
    }, this.deps.config.polling.reconciliationIntervalSec * 1000);
  }

  /**
   * Independent check of stream delivery (the WS subscription can
   * stay silent for minutes while REST already lists new trades). New REST trades
   * are added as `rest` observations; trades that happened during the subscription
   * but were not delivered via WS within the grace period mark the stream as behind.
   */
  async crossCheckTrades(gen: number = this.generation): Promise<void> {
    await this.fetchTrades(gen, false);
    if (gen !== this.generation) return;
    const rest = this.trades.filter(t=>t.source==='rest');
    const ws = this.trades.filter(t=>t.source==='ws');
    const missing = rest.filter(t=>t.blockTimestamp && Date.parse(t.blockTimestamp) >= (this.startedAt ?? Infinity)
      && this.now()-Date.parse(t.blockTimestamp)>STREAM_LAG_GRACE_SEC*1000
      && ws.filter(w=>sameSwap(w,t,this.deps.config.reconciliation)).length!==1);
    if (missing.length) {
      const oldest = missing.map(t=>t.blockTimestamp!).sort()[0]!;
      if (!this.streamLag) this.pushError({operation:'ws.onchain_trade',kind:'stream_lag',httpStatus:null,message:`stream behind REST at ${oldest}`});
      this.streamLag = {recentMissing:missing.filter(t=>this.now()-Date.parse(t.blockTimestamp!)<=this.deps.config.freshness.maxPriceAgeSec*1000).length,missing:missing.length,oldestMissingBlockTime:oldest,checkedAt:new Date(this.now()).toISOString()};
      this.setCheck('ws.delivery_vs_rest','fail',`${missing.length} REST trades lack a unique matching WS observation; canonical REST collection continues`);
      if(this.deps.config.scoring.algorithm==='distribution-v1'&&this.now()-Math.max(this.lastDeliveryRecoveryAt,this.startedAt??this.now())>=300000&&this.now()-(this.lastWsTradeAt??0)>90000){
        this.lastDeliveryRecoveryAt=this.now();
        this.stream?.recoverDelivery();
      }
    } else {
      this.streamLag = null;
      this.setCheck('ws.delivery_vs_rest','pass','No unmatched recent REST trade beyond the delivery grace in the displayed sample');
    }
  }

  private onRestError(cap: CapabilityState, err: unknown): void {
    this.lastRestOk = false;
    if (err instanceof ProviderError) {
      if (err.kind === 'not_found') this.unavailable(cap, err.httpStatus, 'HTTP 404: not available for this pool/account; no fallback');
      else this.fail(cap, err.httpStatus, err.message);
      if (err.kind === 'rate_limited' && err.retryAfterSec) this.pollBlockedUntil = this.now() + err.retryAfterSec * 1000;
      if (err.kind === 'auth') this.onAuthFailure('REST returned HTTP ' + err.httpStatus);
    } else {
      this.fail(cap, null, 'unexpected error');
    }
    this.recordError(err);
  }

  private isAuthFailed(): boolean {
    return this.transport.state === 'auth_failed' || this.monitorDetail.startsWith('Authentication failed');
  }

  private onAuthFailure(detail: string): void {
    void this.stop();
    this.transport.state = 'auth_failed';
    this.monitor = 'blocked';
    this.monitorDetail = `Authentication failed (${detail}). Retries stopped. Check COINGECKO_API_KEY in the local .env and restart the server.`;
  }

  // -------------------------------------------------------------------- WS

  private openStream(trackedTokenSide: 'base' | 'quote'): void {
    if (!this.selectedPool) return;
    const f = this.deps.config.freshness;
    const stream = new CoinGeckoStream({
      apiKey: this.deps.apiKey!,
      pool: this.selectedPool,
      trackedTokenSide,
      backoffSec: this.deps.config.retry.backoffSec,
      jitterFraction: this.deps.config.retry.jitterFraction,
      silenceTimeoutMs: (f.wsPingIntervalSec + f.wsPongTimeoutSec) * 1000,
      stepTimeoutMs: 15_000,
      usage: this.usage,
      now: this.now,
      ...(this.deps.socketFactory ? { socketFactory: this.deps.socketFactory } : {}),
    });
    this.stream = stream;
    const gen = this.generation;
    stream.on('state', (state, detail) => { if (gen === this.generation) this.onTransportState(state, detail); });
    stream.on('heartbeat', (kind, at) => {
      if (gen !== this.generation) return;
      this.transport.lastHeartbeatAt = at;
      this.transport.heartbeatKind = kind;
      this.ok(this.touch('ws.heartbeat'), null, `last ${kind} at ${at}`);
    });
    stream.on('subscription', (channel, step, detail) => {
      if (gen !== this.generation) return;
      const sub = this.transport.subscriptions.find((s) => s.channel === channel);
      const capId: CapabilityId = channel === WS_CHANNELS.trade ? 'ws.onchain_trade.subscribe' : 'ws.onchain_ohlcv.subscribe';
      if (step === 'pools_set' && channel === WS_CHANNELS.trade) this.tradeSubscribedAt = this.now();
      if (sub) {
        if (step === 'confirmed') sub.confirmed = true;
        if (step === 'pools_set') sub.poolsSet = true;
        sub.detail = detail;
      }
      if (step === 'rejected') this.fail(this.touch(capId), null, detail);
      else if (step === 'pools_set') this.ok(this.touch(capId), null, `confirmed; set_pools: ${detail}`);
    });
    stream.on('frame', (frame, raw, at) => { if (gen === this.generation) { try { this.onFrame(frame, raw, at); } catch { /* save() has stopped collection and exposed the error */ } } });
    stream.on('error', (err) => {
      if (gen !== this.generation) return;
      this.recordError(err);
      if (err.kind === 'auth') {
        this.fail(this.touch('ws.connect'), err.httpStatus, err.message);
        this.onAuthFailure('WebSocket handshake HTTP ' + err.httpStatus);
      }
    });
    this.touch('ws.connect');
    stream.start();
  }

  private onTransportState(state: TransportState, detail: string): void {
    this.transport.state = state;
    this.transport.reconnects = this.stream?.reconnectCount ?? this.transport.reconnects;
    if (state === 'open') {
      this.transport.connectedAt = new Date(this.now()).toISOString();
      this.ok(this.touch('ws.connect'), 101, 'socket open (HTTP 101 upgrade)');
    }
    if (state === 'reconnecting' || state === 'connecting') {
      this.tradeSubscribedAt = null;
      for (const s of this.transport.subscriptions) Object.assign(s, { confirmed: false, poolsSet: false, detail: 'pending (re)subscription' });
    }
    this.deps.log.info({ operation: 'ws.state', state, detail }, 'websocket state');
  }

  private onFrame(frame: ClassifiedFrame, raw: string, receivedAt: string): void {
    this.transport.lastFrameAt = receivedAt;
    if (frame.kind === 'trade') return this.onTradeFrame(frame.payload, raw, receivedAt);
    if (frame.kind === 'candle') return this.onCandleFrame(frame.payload, raw, receivedAt);
    if (frame.kind === 'heartbeat') return;
    const sample: RawSample = { kind: 'ws_control', endpointOrChannel: 'wss://stream.coingecko.com/v1', receivedAt, rawText: redactText(raw, [this.deps.apiKey]), mapped: { classifiedAs: frame.kind } };
    this.controlFrames = [sample, ...this.controlFrames].slice(0, MAX_CONTROL);
  }

  private onTradeFrame(payload: Record<string, unknown>, raw: string, receivedAt: string): void {
    const cap = this.touch('ws.onchain_trade.data');
    const parsed = g2TradeSchema.safeParse(payload);
    if (!parsed.success) {
      this.fail(cap, null, `G2 frame did not match schema at ${parsed.error.issues[0]?.path.join('.')}`);
      this.sample('ws_trade', 'OnchainTrade', receivedAt, raw, null);
      return;
    }
    if (!this.selectedPool || !isFixedPoolFrame(parsed.data, this.selectedPool)) {
      this.pushError({ operation: 'ws.onchain_trade', kind: 'invalid_payload', httpStatus: null, message: `ignored G2 frame for ${parsed.data.n}:${parsed.data.pa}` });
      return;
    }
    const trackedTokenSide = this.orientation.trackedTokenSide!;
    // Before the G2 set_pools result arrives, the socket open time is the conservative reference.
    const subscribedRef = this.tradeSubscribedAt ?? (this.transport.connectedAt ? Date.parse(this.transport.connectedAt) : null);
    const trade = mapWsTrade(parsed.data, trackedTokenSide, receivedAt, subscribedRef);
    if (trade.providerTimeMs === null || trade.providerTimeMs <= (subscribedRef ?? this.now())) trade.delivery = 'subscription-replay';
    const unique = this.save(()=>this.deps.collector?.ws({kind:'ws_trade',endpointOrChannel:'OnchainTrade',receivedAt,rawText:redactText(raw,[this.deps.apiKey]),mapped:trade},trade)) ?? !this.trades.some(t=>t.source==='ws' && t.txHash===trade.txHash && t.providerTimeMs===trade.providerTimeMs && t.trackedAmount===trade.trackedAmount && t.counterAmount===trade.counterAmount);
    if (!unique) return;
    this.trades = [trade, ...this.trades].slice(0, MAX_TRADES);
    const inRest = this.trades.filter(t=>t.source==='rest' && sameSwap(trade,t,this.deps.config.reconciliation)).length === 1;
    this.sample('ws_trade', 'OnchainTrade (G2)', receivedAt, raw, { ...trade, alsoInRestHistory: inRest });
    if (trade.delivery === 'live' && trade.deliveryLagMs !== null) {
      const lagSec = Math.round(trade.deliveryLagMs / 1000);
      const late = trade.deliveryLagMs > STREAM_LAG_GRACE_SEC * 1000;
      if (late || !this.checks.has('ws.delivery_latency') || this.checks.get('ws.delivery_latency')!.status !== 'fail') {
        this.setCheck('ws.delivery_latency', late ? 'fail' : 'pass', `last live G2 trade received ${lagSec}s after provider time t (${trade.txHash?.slice(0, 12)}…); grace ${STREAM_LAG_GRACE_SEC}s`);
      }
    }
    if (trade.delivery === 'live') {
      if(trade.providerTimeMs!==null&&trade.providerTimeMs<=this.now())this.lastWsTradeAt=Math.max(this.lastWsTradeAt??0,trade.providerTimeMs);
      this.ok(cap, null, `last LIVE trade frame received ${receivedAt}; provider t=${parsed.data.t ?? 'null'} ms (${parsed.data.t ? new Date(parsed.data.t).toISOString() : 'n/a'})`);
    } else if (cap.status !== 'ok') {
      cap.detail = `only a subscription replay so far (provider t=${parsed.data.t} ms = ${new Date(parsed.data.t!).toISOString()}, received ${receivedAt}${inRest ? '; same tx as REST history' : ''}); waiting for a new live trade`;
    }
    if (trade.trackedPriceUsd && parsed.data.t) {
      const providerTime = new Date(parsed.data.t).toISOString();
      this.pushPrice({ source: 'ws-trade', priceUsd: trade.trackedPriceUsd, providerTime, providerTimeKind: 'trade-update', receivedAt, asOf: providerTime });
    }
    this.checkPuConsistency(parsed.data.pu, trackedTokenSide);
    this.checkWsVolume(parsed.data.vo, trade);
  }

  private onCandleFrame(payload: Record<string, unknown>, raw: string, receivedAt: string): void {
    const cap = this.touch('ws.onchain_ohlcv.data');
    const parsed = g3CandleSchema.safeParse(payload);
    if (!parsed.success) {
      this.fail(cap, null, `G3 frame did not match schema at ${parsed.error.issues[0]?.path.join('.')}`);
      this.sample('ws_candle', 'OnchainOHLCV (G3)', receivedAt, raw, null);
      return;
    }
    if (!this.selectedPool || !isFixedPoolFrame(parsed.data, this.selectedPool)) {
      this.pushError({ operation: 'ws.onchain_ohlcv', kind: 'invalid_payload', httpStatus: null, message: `ignored G3 frame for ${parsed.data.n}:${parsed.data.pa}` });
      return;
    }
    const candle = mapWsCandle(parsed.data, receivedAt);
    if (!candle) return;
    const existing = this.candles.get(candle.openTimeSec);
    // Same pool/token/interval/open time replaces the candle rather than adding one.
    candle.updates = existing && existing.source === 'ws' ? existing.updates + 1 : 1;
    this.candles.set(candle.openTimeSec, candle);
    this.trimCandles();
    this.save(()=>this.deps.collector?.candle({kind:'ws_candle',endpointOrChannel:'OnchainOHLCV',receivedAt,rawText:redactText(raw,[this.deps.apiKey]),mapped:null},candle));
    this.sample('ws_candle', 'OnchainOHLCV (G3)', receivedAt, raw, candle);
    this.ok(cap, null, `last candle frame at ${receivedAt}; open t=${parsed.data.t} s (${new Date(parsed.data.t! * 1000).toISOString()}); token=${parsed.data.to}`);
    this.setCheck('ws.ohlcv_token_side', parsed.data.to === this.orientation.trackedTokenSide ? 'pass' : 'fail', `G3 token side ${parsed.data.to ?? 'null'} vs verified tracked token side ${this.orientation.trackedTokenSide}`);
    if (candle.close && parsed.data.to === this.orientation.trackedTokenSide && parsed.data.i === '1m') {
      // A candle close is current at most until the candle's end; a replayed old candle is therefore not fresh.
      const asOfMs = Math.min(this.now(), (candle.openTimeSec + 60) * 1000);
      this.pushPrice({ source: 'ws-ohlcv-close', priceUsd: candle.close, providerTime: new Date(candle.openTimeSec * 1000).toISOString(), providerTimeKind: 'candle-open', receivedAt, asOf: new Date(asOfMs).toISOString() });
    }
  }

  private checkPuConsistency(pu: number | null, trackedTokenSide: 'base' | 'quote'): void {
    const meta = this.prices.find((p) => p.source === 'rest-pool-metadata');
    if (pu === null || !meta) return;
    const ref = Number(meta.priceUsd);
    // Documented as "token price in USD"; if it is the base token price, it matches the tracked token only when it is base.
    const rel = Math.abs(pu / ref - 1);
    const matchesLink = rel <= PU_CONSISTENCY_TOLERANCE;
    this.setCheck(
      'ws.pu_meaning',
      trackedTokenSide === 'base' ? (matchesLink ? 'pass' : 'fail') : matchesLink ? 'fail' : 'pass',
      `G2 pu=${pu} vs metadata tracked token/USD=${meta.priceUsd} (rel. diff ${(rel * 100).toFixed(2)}%); Tracked token is ${trackedTokenSide}. Expectation: pu is the base token price.`,
    );
  }

  private checkWsVolume(vo: number | null, trade: TradeObservation): void {
    if (vo === null || !trade.trackedAmount || !this.latestPrice()) return;
    const implied = Number(trade.trackedAmount) * Number(this.latestPrice()!.priceUsd);
    const rel = implied > 0 ? Math.abs(vo / implied - 1) : Infinity;
    this.setCheck('ws.tracked_amount_mapping', rel <= 0.05 ? 'pass' : 'fail', `G2 vo=${vo} vs tracked token amount × tracked token/USD=${implied.toFixed(4)} (rel. diff ${(rel * 100).toFixed(2)}%): confirms which of to/toq is the tracked token amount`);
  }

  // --------------------------------------------------------------- helpers

  private trimCandles(): void {
    const keys = [...this.candles.keys()].sort((a, b) => b - a);
    for (const k of keys.slice(MAX_CANDLES)) this.candles.delete(k);
  }

  private pushPrice(p: PriceObservation): void {
    this.prices = [p, ...this.prices].slice(0, MAX_PRICES);
  }

  /** Most current observation by `asOf` (provider-time based where available), not by receipt time. */
  private latestPrice(): PriceObservation | null {
    return this.prices.reduce<PriceObservation | null>((best, p) => (!best || p.asOf > best.asOf ? p : best), null);
  }

  private sample(kind: RawSample['kind'], endpointOrChannel: string, receivedAt: string, rawText: string, mapped: unknown): void {
    const sample = { kind, endpointOrChannel, receivedAt, rawText: redactText(rawText, [this.deps.apiKey]), mapped };
    this.rawSamples.set(kind, sample);
    if (kind === 'rest_pool_metadata' || kind === 'rest_ohlcv') this.save(()=>this.deps.collector?.raw(sample));
  }

  private setCheck(id: string, status: 'pass' | 'fail' | 'pending', detail: string): void {
    this.checks.set(id, { id, status, detail });
  }

  private touch(id: CapabilityId): CapabilityState {
    const c = this.caps.get(id)!;
    c.lastAttemptAt = new Date(this.now()).toISOString();
    return c;
  }

  private ok(c: CapabilityState, httpStatus: number | null, detail: string): void {
    Object.assign(c, { status: 'ok', httpStatus, detail, lastSuccessAt: new Date(this.now()).toISOString() });
  }

  private fail(c: CapabilityState, httpStatus: number | null, detail: string): void {
    Object.assign(c, { status: 'failed', httpStatus, detail });
  }

  private unavailable(c: CapabilityState, httpStatus: number | null, detail: string): void {
    Object.assign(c, { status: 'unavailable', httpStatus, detail });
  }

  private markUnavailable(ids: CapabilityId[], detail: string): void {
    for (const id of ids) {
      const c = this.caps.get(id)!;
      if (c.status === 'pending') this.unavailable(c, null, detail);
    }
  }

  private recordError(err: unknown): void {
    if (err instanceof ProviderError) {
      this.pushError({ operation: err.operation, kind: err.kind, httpStatus: err.httpStatus, message: err.message });
      this.deps.log.warn({ err: err.toJSON(), operation: err.operation }, 'provider error');
    } else {
      this.pushError({ operation: 'monitor', kind: 'internal', httpStatus: null, message: 'unexpected internal error' });
      this.deps.log.error({ err }, 'monitor error');
    }
  }

  private pushError(e: Omit<OperationalError, 'at'>): void {
    const entry = { at: new Date(this.now()).toISOString(), ...e, message: redactText(e.message, [this.deps.apiKey]) };
    this.errors = [entry, ...this.errors].slice(0, MAX_ERRORS);
  }

  private indicator(lastAtMs: number | null, maxAgeSec: number, whenMissing: Indicator, detailOk: string, staleState: Indicator['state'] = 'stale', staleDetail = 'stale'): Indicator {
    if (lastAtMs === null) return whenMissing;
    const ageSec = Math.max(0, Math.round((this.now() - lastAtMs) / 1000));
    const lastAt = new Date(lastAtMs).toISOString();
    return ageSec <= maxAgeSec ? { state: 'ok', ageSec, lastAt, detail: detailOk } : { state: staleState, ageSec, lastAt, detail: staleDetail };
  }

  // -------------------------------------------------------------- snapshot

  status(): { restStatus: 'not_connected' | 'ok' | 'error'; wsStatus: TransportState } {
    return { restStatus: this.lastRestOk === null ? 'not_connected' : this.lastRestOk ? 'ok' : 'error', wsStatus: this.transport.state };
  }

  snapshot(): InspectionSnapshot {
    const f = this.deps.config.freshness;
    const now = this.now();
    const parse = (iso: string | null) => (iso ? Date.parse(iso) : null);
    const lastTransportEvent = Math.max(parse(this.transport.lastFrameAt) ?? 0, parse(this.transport.lastHeartbeatAt) ?? 0) || null;
    const silenceSec = f.wsPingIntervalSec + f.wsPongTimeoutSec;
    const t = this.transport.state;
    const transportIndicator: Indicator =
      t === 'streaming'
        ? this.indicator(lastTransportEvent, silenceSec, { state: 'unknown', ageSec: null, lastAt: null, detail: 'subscribed; no frame or heartbeat yet' }, 'alive (frames/heartbeats within timeout)', 'stale', `no frame or heartbeat for more than ${silenceSec}s`)
        : { state: t === 'disconnected' || t === 'auth_failed' || t === 'error' ? 'down' : 'unknown', ageSec: null, lastAt: this.transport.lastFrameAt, detail: `transport ${t}` };
    const latest = this.latestPrice();
    const priceIndicator = this.indicator(parse(latest?.asOf ?? null), f.maxPriceAgeSec, { state: 'unknown', ageSec: null, lastAt: null, detail: 'no tracked token/USD observation yet' }, `latest ${latest?.source ?? ''} observation current within ${f.maxPriceAgeSec}s`, 'stale', `no tracked token/USD observation current within ${f.maxPriceAgeSec}s (age by provider time where available)`);
    if (latest?.providerTimeKind === 'none' && priceIndicator.state === 'ok') {
      priceIndicator.state = 'unknown';
      priceIndicator.detail = 'Recent metadata receipt; provider price update time and actual price age unknown';
    }
    const tradeIndicator: Indicator =
      t !== 'streaming'
        ? { state: 'unknown', ageSec: null, lastAt: this.lastWsTradeAt ? new Date(this.lastWsTradeAt).toISOString() : null, detail: 'live trade stream not subscribed' }
        : this.indicator(this.lastWsTradeAt ?? this.tradeSubscribedAt ?? now, TRADE_INACTIVITY_NOTICE_SEC, { state: 'unknown', ageSec: null, lastAt: null, detail: '' }, this.lastWsTradeAt ? 'recent live trade' : 'subscribed; waiting for the first live trade (subscription replays do not count)', 'inactive', `No recent trades (no live trade for more than ${TRADE_INACTIVITY_NOTICE_SEC}s) while the transport is alive`);
    if (t === 'streaming' && this.streamLag && (this.streamLag.recentMissing>0||this.lastWsTradeAt===null||now-this.lastWsTradeAt>f.maxPriceAgeSec*1000)) {
      tradeIndicator.state = 'stale';
      tradeIndicator.detail = `Stream behind REST: ${this.streamLag.missing} trade(s) since the subscription (oldest block ${this.streamLag.oldestMissingBlockTime}) not delivered via WebSocket after ${STREAM_LAG_GRACE_SEC}s`;
    } else if (t === 'streaming' && this.lastWsTradeAt === null) {
      tradeIndicator.lastAt = null;
      // Waiting for the first live trade is not evidence of activity.
      if (tradeIndicator.state === 'ok') tradeIndicator.state = 'unknown';
    }
    const reserveIndicator = this.indicator(parse(this.reserve?.receivedAt ?? null), f.maxReserveAgeSec, { state: 'unknown', ageSec: null, lastAt: null, detail: 'no USD reserve observation yet' }, `pool metadata within ${f.maxReserveAgeSec}s`, 'stale', `no pool metadata within ${f.maxReserveAgeSec}s`);
    const usage = this.usage.snapshot();

    return {
      mode: 'live',
      activePoolId: this.monitor === 'running' || this.monitor === 'starting' ? `${this.selectedPool?.networkId}:${this.selectedPool?.poolAddress}` : null,
      connectionState: this.monitor === 'blocked' ? 'error' : this.monitor === 'idle' ? 'disconnected' : this.monitor === 'starting' ? 'connecting' : t === 'reconnecting' ? 'reconnecting' : t !== 'streaming' ? 'connecting' : this.lastNewTradeAt && now-Date.parse(this.lastNewTradeAt)<TRADE_INACTIVITY_NOTICE_SEC*1000 ? 'receiving' : 'waiting',
      connectedSince: this.startedAt !== null ? new Date(this.startedAt).toISOString() : null,
      newTrades: this.newTrades,
      lastNewTradeAt: this.lastNewTradeAt,
      persistence: { state: this.storageError ? 'error' : this.deps.collector ? 'ok' : 'unavailable', error: this.storageError, ...(this.deps.collector && !this.storageError ? this.deps.collector.summary() : {sessionId:null,canonicalTrades:0,pendingWs:0,ambiguousWs:0}) },
      recovery: {complete:this.coverageComplete, recovering:this.recovering, detail:this.coverageDetail},
      serverTimeUtc: new Date(now).toISOString(),
      monitor: this.monitor,
      monitorDetail: this.monitorDetail,
      apiKeyConfigured: this.deps.apiKey !== undefined,
      pool: {
        networkId: this.selectedPool?.networkId ?? '',
        poolAddress: this.selectedPool?.poolAddress ?? '',
        trackedTokenAddress: this.selectedPool?.baseAddress ?? '',
        counterTokenAddress: this.selectedPool?.quoteAddress ?? '',
      },
      orientation: { ...this.orientation },
      transport: structuredClone(this.transport),
      indicators: { transport: transportIndicator, priceFreshness: priceIndicator, tradeInactivity: tradeIndicator, reserveFreshness: reserveIndicator },
      latestPrice: latest,
      priceObservations: this.prices.slice(0, 30),
      reserve: this.reserve,
      trades: this.trades.slice(0, 100),
      candles: [...this.candles.values()].sort((a, b) => b.openTimeSec - a.openTimeSec).slice(0, 30),
      capabilities: [...this.caps.values()].map((c) => ({ ...c })),
      checks: [...this.checks.values()],
      rawSamples: [...this.rawSamples.values()],
      controlFrames: this.controlFrames,
      errors: this.errors.slice(0, 20),
      usage: {
        restAttempts: usage.rest.attempts,
        restSuccesses: usage.rest.successes,
        restErrors: usage.rest.errors,
        wsDataMessages: usage.ws.dataMessages,
        wsControlMessages: usage.ws.controlMessages,
        wsHeartbeats: usage.ws.heartbeats,
        estimatedCredits: usage.estimatedCredits,
        note: usage.note,
      },
    };
  }
}
