import { createHash } from 'node:crypto';
import { getPoolConfig, type CandleObservation, type PoolConfig, type RawSample, type TradeObservation } from '@volumechecker/shared';
import type { SqliteDatabase } from './index';
import type { TradeRecord } from './repositories';

export interface CollectorOptions {
  sessionId: string;
  pool?: PoolConfig;
  selectedPoolId: string;
  configHash: string;
  db: SqliteDatabase;
  now?: () => number;
  matches?: (ws: TradeObservation, rest: TradeObservation) => boolean;
}

/** REST swaps are canonical; WS observations stay separate until a mutually unique match exists. */
export class M2Collector {
  readonly pool: PoolConfig;
  readonly startedAt: number;
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  constructor(private readonly opts: CollectorOptions) {
    const pool = opts.pool ?? getPoolConfig(opts.selectedPoolId);
    if(pool && `${pool.networkId}:${pool.poolAddress}`!==opts.selectedPoolId)throw Error('Pool identity mismatch');
    if (!pool) throw new Error('Pool is not allowlisted');
    this.pool = pool;
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }
  start(): void {
    this.db.prepare('INSERT INTO sessions (id,network_id,pool_address,started_at_sec,config_hash) VALUES (?,?,?,?,?)')
      .run(this.opts.sessionId, this.pool.networkId, this.pool.poolAddress, Math.floor(this.startedAt / 1000), this.opts.configHash);
  }
  stop(state = 'stopped'): void {
    this.db.prepare('UPDATE sessions SET stopped_at_sec=?, final_state=? WHERE id=?')
      .run(Math.floor(this.now()/1000), state, this.opts.sessionId);
  }
  raw(sample: RawSample): number {
    return Number(this.db.prepare(`INSERT INTO raw_events
      (session_id,network_id,pool_address,kind,endpoint_or_channel,received_at_sec,raw_text,mapped) VALUES (?,?,?,?,?,?,?,?)`)
      .run(this.opts.sessionId,this.pool.networkId,this.pool.poolAddress,sample.kind,sample.endpointOrChannel,
        Math.floor(Date.parse(sample.receivedAt)/1000),sample.rawText,JSON.stringify(sample.mapped ?? null)).lastInsertRowid);
  }
  restBatch(sample: RawSample, trades: TradeObservation[]): TradeObservation[] {
    return this.db.transaction(() => {
      const raw = this.raw(sample);
      const inserted: TradeObservation[] = [];
      for (const t of trades) {
        if (!t.providerTradeId || !t.txHash || !t.blockTimestamp || !Number.isFinite(Date.parse(t.blockTimestamp))) throw new Error('Invalid canonical trade identity/time');
        const existing = this.db.prepare('SELECT id,side,volume_usd,base_amount,quote_amount,base_price_usd,block_timestamp_sec,sender_address FROM trades WHERE network_id=? AND pool_address=? AND provider_trade_id=?').get(this.pool.networkId,this.pool.poolAddress,t.providerTradeId) as Record<string,unknown>|undefined;
        const changed = !existing || existing.side!==t.side || existing.volume_usd!==t.volumeUsd || existing.base_amount!==t.trackedAmount || existing.quote_amount!==t.counterAmount || existing.base_price_usd!==t.trackedPriceUsd || existing.block_timestamp_sec!==Date.parse(t.blockTimestamp)/1000 || existing.sender_address!==t.senderAddress;
        this.db.prepare(`INSERT INTO trades
          (session_id,network_id,pool_address,provider_trade_id,tx_hash,source,block_timestamp_sec,received_at_sec,side,base_amount,quote_amount,volume_usd,base_price_usd,sender_address,rest_raw_event_id)
          VALUES (?,?,?,?,?,'rest',?,?,?,?,?,?,?,?,?) ON CONFLICT(network_id,pool_address,provider_trade_id) DO UPDATE SET
          side=excluded.side,block_timestamp_sec=excluded.block_timestamp_sec,base_amount=excluded.base_amount,quote_amount=excluded.quote_amount,
          volume_usd=excluded.volume_usd,base_price_usd=excluded.base_price_usd,sender_address=excluded.sender_address,rest_raw_event_id=excluded.rest_raw_event_id`)
          .run(this.opts.sessionId,this.pool.networkId,this.pool.poolAddress,t.providerTradeId,t.txHash,Date.parse(t.blockTimestamp)/1000,
            Date.parse(t.receivedAt)/1000,t.side,t.trackedAmount,t.counterAmount,t.volumeUsd,t.trackedPriceUsd,t.senderAddress,raw);
        const row = this.db.prepare('SELECT id FROM trades WHERE network_id=? AND pool_address=? AND provider_trade_id=?')
          .get(this.pool.networkId,this.pool.poolAddress,t.providerTradeId) as {id:number};
        this.db.prepare('INSERT OR IGNORE INTO session_trades VALUES (?,?)').run(this.opts.sessionId,row.id);
        if (!existing) inserted.push(t);
        if (changed) this.db.prepare('INSERT INTO trade_versions(trade_id,network_id,pool_address,event_ms,known_ms,payload) VALUES (?,?,?,?,?,?)').run(row.id,this.pool.networkId,this.pool.poolAddress,Date.parse(t.blockTimestamp),Date.parse(t.receivedAt),JSON.stringify({id:t.providerTradeId,eventMs:Date.parse(t.blockTimestamp),knownMs:Date.parse(t.receivedAt),side:t.side,usd:t.volumeUsd,price:t.trackedPriceUsd,sender:t.senderAddress}));
      }
      this.reconcile([...new Set(trades.map(t=>t.txHash).filter((x): x is string=>x!==null))]);
      return inserted;
    })();
  }
  ws(sample: RawSample, t: TradeObservation): boolean {
    return this.db.transaction(() => {
      const raw = this.raw(sample);
      const fingerprint = createHash('sha256').update(JSON.stringify([t.txHash,t.side,t.trackedAmount,t.counterAmount,t.volumeUsd,t.providerTimeMs])).digest('hex');
      const result = this.db.prepare(`INSERT INTO ws_observations
        (session_id,network_id,pool_address,fingerprint,observation,raw_event_id) VALUES (?,?,?,?,?,?)
        ON CONFLICT(network_id,pool_address,fingerprint) DO NOTHING`)
        .run(this.opts.sessionId,this.pool.networkId,this.pool.poolAddress,fingerprint,JSON.stringify(t),raw);
      if(t.txHash) this.reconcile([t.txHash]);
      return !!result.changes;
    })();
  }
  private reconcile(txHashes: string[]): void {
    if (!this.opts.matches) return;
    for(const tx of txHashes) {
      const ws = this.db.prepare("SELECT id,observation FROM ws_observations WHERE network_id=? AND pool_address=? AND json_extract(observation,'$.txHash')=?")
        .all(this.pool.networkId,this.pool.poolAddress,tx) as {id:number;observation:string}[];
      const rows = this.db.prepare('SELECT * FROM trades WHERE network_id=? AND pool_address=? AND tx_hash=? AND provider_trade_id IS NOT NULL')
        .all(this.pool.networkId,this.pool.poolAddress,tx) as TradeRecord[];
      const candidates = ws.map(w=>({...w,matches:rows.filter(r=>this.opts.matches!(readStoredObservation(w.observation),this.observation(r)))}));
      const multiplicity = new Map<number,number>();
      for(const w of candidates) for(const r of w.matches) multiplicity.set(r.id,(multiplicity.get(r.id)??0)+1);
      for(const w of candidates) this.db.prepare('UPDATE ws_observations SET rest_trade_id=NULL WHERE id=?').run(w.id);
      for(const w of candidates) {
        const only = w.matches.length===1 && multiplicity.get(w.matches[0]!.id)===1 ? w.matches[0]!.id : null;
        this.db.prepare('UPDATE ws_observations SET rest_trade_id=?,match_status=? WHERE id=?')
          .run(only,only!==null?'matched':w.matches.length?'ambiguous':'pending',w.id);
      }
    }
  }
  candle(sample: RawSample, c: CandleObservation): void {
    this.db.transaction(() => {
      const raw = this.raw(sample);
      if(c.close!==null) this.db.prepare('INSERT INTO candle_versions(network_id,pool_address,open_ms,known_ms,close,volume,source) VALUES (?,?,?,?,?,?,?)').run(this.pool.networkId,this.pool.poolAddress,c.openTimeSec*1000,Date.parse(c.receivedAt),c.close,c.volumeUsd,c.source);
      this.db.prepare(`INSERT INTO candles (session_id,network_id,pool_address,open_time_sec,source,open,high,low,close,volume_usd,received_at_sec,rest_raw_event_id,ws_raw_event_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,network_id,pool_address,open_time_sec) DO UPDATE SET
        source=excluded.source,open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume_usd=excluded.volume_usd,
        received_at_sec=excluded.received_at_sec,update_count=candles.update_count+1,
        rest_raw_event_id=COALESCE(excluded.rest_raw_event_id,candles.rest_raw_event_id),ws_raw_event_id=COALESCE(excluded.ws_raw_event_id,candles.ws_raw_event_id)`)
        .run(this.opts.sessionId,this.pool.networkId,this.pool.poolAddress,c.openTimeSec,c.source,c.open,c.high,c.low,c.close,c.volumeUsd,
          Date.parse(c.receivedAt)/1000,c.source==='rest'?raw:null,c.source==='ws'?raw:null);
    })();
  }
  recovery(): { last_success_ms: number | null; incomplete_from_ms: number | null; detail: string } | undefined {
    return this.db.prepare('SELECT * FROM collection_state WHERE network_id=? AND pool_address=?')
      .get(this.pool.networkId,this.pool.poolAddress) as ReturnType<M2Collector['recovery']>;
  }
  poolObservation(at:number,price:string|null,reserve:string|null):void {
    this.db.prepare('INSERT INTO pool_observations(network_id,pool_address,at_ms,known_ms,price,reserve,source) VALUES (?,?,?,?,?,?,?)').run(this.pool.networkId,this.pool.poolAddress,at,at,price,reserve,'rest-pool-metadata');
  }
  coverage(from: number, until: number, complete: boolean, detail: string, recentFrom?: number): void {
    this.db.transaction(() => {
      const previous = this.recovery();
      // A capped backfill may prove a recent interval without filling an older gap.
      // Exclude the oldest boundary: a page can split trades with equal block time.
      const lower = complete ? from : recentFrom;
      const covered = lower !== undefined && lower < until;
      if (covered) this.db.prepare('INSERT INTO coverage_ranges(network_id,pool_address,from_ms,to_ms,known_ms) VALUES (?,?,?,?,?)').run(this.pool.networkId,this.pool.poolAddress,lower,until,this.now());
      const oldGap = previous?.incomplete_from_ms;
      const remainingOldGap = oldGap != null && !(complete && from <= oldGap) ? oldGap : null;
      const gap = complete ? remainingOldGap : Math.min(remainingOldGap ?? from, from);
      this.db.prepare(`INSERT INTO collection_state VALUES (?,?,?,?,?) ON CONFLICT(network_id,pool_address) DO UPDATE SET
        last_success_ms=COALESCE(excluded.last_success_ms,collection_state.last_success_ms),incomplete_from_ms=excluded.incomplete_from_ms,detail=excluded.detail`)
        .run(this.pool.networkId,this.pool.poolAddress,covered?until:null,gap,detail);
    })();
  }
  private observation(r: TradeRecord): TradeObservation {
    return { source:'rest',delivery:'rest',deliveryLagMs:null,providerTradeId:r.provider_trade_id,txHash:r.tx_hash,side:r.side,
      sideBasis:'rest-token-addresses',providerSideLabel:r.side,trackedAmount:r.base_amount,counterAmount:r.quote_amount,volumeUsd:r.volume_usd,
      trackedPriceUsd:r.base_price_usd,trackedPriceBasis:'rest-token-price',providerTimeMs:null,
      blockTimestamp:r.block_timestamp_sec!==null?new Date(r.block_timestamp_sec*1000).toISOString():null,
      blockNumber:null,senderAddress:r.sender_address,receivedAt:new Date(r.received_at_sec*1000).toISOString() };
  }
  recent(): TradeObservation[] {
    return (this.db.prepare("SELECT * FROM trades WHERE network_id=? AND pool_address=? AND provider_trade_id IS NOT NULL ORDER BY block_timestamp_sec DESC LIMIT 100")
      .all(this.pool.networkId,this.pool.poolAddress) as TradeRecord[]).map(r=>this.observation(r));
  }
  summary() {
    const count = (sql:string) => (this.db.prepare(sql).get(this.pool.networkId,this.pool.poolAddress) as {n:number}).n;
    return {sessionId:this.opts.sessionId,canonicalTrades:count('SELECT count(*) n FROM trades WHERE network_id=? AND pool_address=? AND provider_trade_id IS NOT NULL'),
      pendingWs:count("SELECT count(*) n FROM ws_observations WHERE network_id=? AND pool_address=? AND match_status='pending'"),
      ambiguousWs:count("SELECT count(*) n FROM ws_observations WHERE network_id=? AND pool_address=? AND match_status='ambiguous'")};
  }
}

/** Compatibility for persisted observations from the original asset-specific DTO. */
export function readStoredObservation(json:string):TradeObservation {
 const old=JSON.parse(json);
 const {linkAmount,wethAmount,linkPriceUsd,linkPriceBasis,...rest}=old;
 return {...rest,trackedAmount:old.trackedAmount??linkAmount??null,counterAmount:old.counterAmount??wethAmount??null,trackedPriceUsd:old.trackedPriceUsd??linkPriceUsd??null,trackedPriceBasis:old.trackedPriceBasis??linkPriceBasis??'unavailable'} as TradeObservation;
}
