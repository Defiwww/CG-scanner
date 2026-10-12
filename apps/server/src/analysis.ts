import { liveQuality } from './live-quality';
import { SignalService } from './signals';
import { AnalysisRepository, type SqliteDatabase } from '@volumechecker/storage';
import { calculateMetrics, calculateRisk, summarizeSellers } from '@volumechecker/engine';
import { v1Rules, ALLOWED_POOLS, getPoolConfig, type AnalysisResponse, type AnalysisTrade, type InspectionSnapshot } from '@volumechecker/shared';
import type { LoadedConfig } from './config';
export class AnalysisService {
  private readonly repo:AnalysisRepository;
  readonly signals:SignalService;
  private readonly cache=new Map<string,AnalysisResponse>();
  constructor(private db:SqliteDatabase,private loaded:LoadedConfig,private inspection:()=>InspectionSnapshot) {this.repo=new AnalysisRepository(db);this.signals=new SignalService(db,loaded);this.signals.repo.resetConfirmations();}
  refresh(poolId:string,now=Date.now()):AnalysisResponse {
    const pool=getPoolConfig(poolId,this.loaded.config.pool.catalog);if(!pool) throw Error('Unknown pool');
    const s=this.inspection();
    const observed = this.db.prepare('SELECT price,at_ms,source FROM pool_observations WHERE network_id=? AND pool_address=? AND price IS NOT NULL ORDER BY at_ms DESC LIMIT 1').get(pool.networkId,pool.poolAddress) as {price:string;at_ms:number;source:string}|undefined;
    const trade = this.db.prepare("SELECT base_price_usd price,received_at_sec,block_timestamp_sec FROM trades WHERE network_id=? AND pool_address=? AND source='rest' AND base_price_usd IS NOT NULL ORDER BY block_timestamp_sec DESC LIMIT 1").get(pool.networkId,pool.poolAddress) as {price:string;received_at_sec:number;block_timestamp_sec:number}|undefined;
    const stream=s.activePoolId===poolId?liveQuality(s,now,this.loaded.config.freshness.maxPriceAgeSec*1000):{state:'DISCONNECTED' as const,reason:'This pool is not currently being monitored'};
    const sessionTrades=s.activePoolId===poolId&&s.connectedSince?(this.db.prepare('SELECT provider_trade_id id,block_timestamp_sec*1000 eventMs,received_at_sec*1000 knownMs,side,volume_usd usd,base_price_usd price,sender_address sender FROM trades WHERE network_id=? AND pool_address=? AND block_timestamp_sec>=? AND received_at_sec<=?').all(pool.networkId,pool.poolAddress,Date.parse(s.connectedSince)/1000,now/1000) as AnalysisTrade[]):[];
    const prices = {
      stream,liveAlertsEnabled:this.loaded.config.alerts.liveAlertsEnabled, wallets:summarizeSellers(sessionTrades,String(this.loaded.config.scoring.largeTrade.minimumUsd),v1Rules(this.loaded.config).sellers),
      latestObservedPrice: observed ? {value:observed.price,source:observed.source,observedAt:observed.at_ms,eventAt:null} : null,
      latestConfirmedTradePrice: trade ? {value:trade.price,source:'rest-trade',observedAt:trade.received_at_sec*1000,eventAt:trade.block_timestamp_sec*1000} : null,
    };
    const checkpoint=this.db.prepare('SELECT max(to_ms) t FROM coverage_ranges WHERE network_id=? AND pool_address=?').get(pool.networkId,pool.poolAddress) as {t:number|null};
    const asOf=checkpoint.t;
    const result:AnalysisResponse={...prices,poolId,metrics:null,risk:null,collectedThrough:asOf,status:'Warming up',error:null,signals:this.signals.repo.list(poolId)};
    if(asOf!==null) {
      const input=this.repo.input(pool,asOf-125*60000,now);
      const metrics=calculateMetrics(input,this.loaded.config,poolId,asOf,now,this.repo.threshold(poolId,Math.floor(asOf/60000)*60000,now,this.loaded.hash));
      const active=s.activePoolId===poolId&&s.monitor==='running';
      const stale=now-asOf>this.loaded.config.freshness.maxPriceAgeSec*1000||!active||s.persistence.state!=='ok';
      const canonicalPrice=input.trades.filter(t=>t.price!==null&&t.eventMs<=asOf).sort((a,b)=>b.eventMs-a.eventMs)[0];
      const finalQuality=!stale&&stream.state==='LIVE'&&!!canonicalPrice&&now-canonicalPrice.eventMs<=this.loaded.config.freshness.maxPriceAgeSec*1000;
      result.risk=calculateRisk(metrics,this.loaded.config,this.loaded.config.scoring.algorithm==='distribution-v1'?finalQuality:!stale);
      result.metrics=metrics;result.status=stale?'Stale / collection paused':metrics.status==='ready'?'Ready':metrics.status==='no_trades'?'No trades in covered window':metrics.status==='gap'?'Data gap':'Warming up / insufficient data';
      if(active){this.repo.save(metrics,this.loaded.hash);this.db.prepare('INSERT INTO score_snapshots(pool_id,computed_ms,config_hash,payload) VALUES (?,?,?,?)').run(poolId,now,this.loaded.hash,JSON.stringify(result.risk));}
    }
    this.cache.set(poolId,result);return result;
  }
  /** HTTP reads only a defensive copy: no SQL, computation, writes or signal transitions. */
  read(poolId:string):AnalysisResponse {
    const snapshot=this.cache.get(poolId);
    if(!snapshot)throw Error('Analysis snapshot not initialized');
    return structuredClone(snapshot);
  }
  refreshAll(now=Date.now()):void {
    for(const pool of this.loaded.config.pool.catalog??ALLOWED_POOLS)this.refresh(`${pool.networkId}:${pool.poolAddress}`,now);
  }
  tick(now=Date.now()):void {
    this.refreshAll(now);
    const s=this.inspection();if(!s.activePoolId)return;
    const result=this.cache.get(s.activePoolId)!;if(!result.metrics||!result.risk)return;
    const input=this.repo.input(getPoolConfig(s.activePoolId,this.loaded.config.pool.catalog)!,result.metrics.asOf-125*60000,now);
    this.signals.process(result.metrics,result.risk,input,'live',now);
    this.cache.set(s.activePoolId,{...result,signals:this.signals.repo.list(s.activePoolId)});
  }
}
