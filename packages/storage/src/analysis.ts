import type { AnalysisInput, AnalysisTrade, MetricsSnapshot, PoolConfig } from '@volumechecker/shared';
import type { SqliteDatabase } from './index';
export class AnalysisRepository {
  constructor(readonly db:SqliteDatabase) {}
  input(pool:PoolConfig,from:number,knownAt:number):AnalysisInput {
    const args=[pool.networkId,pool.poolAddress,knownAt];
    const versions=this.db.prepare(`SELECT payload FROM (SELECT payload,event_ms, row_number() OVER(PARTITION BY trade_id ORDER BY known_ms DESC,id DESC) rank FROM trade_versions WHERE network_id=? AND pool_address=? AND known_ms<=?) WHERE rank=1 AND event_ms>?`).all(...args,from) as {payload:string}[];
    const obs=this.db.prepare('SELECT at_ms at,known_ms knownMs,price,reserve,source FROM pool_observations WHERE network_id=? AND pool_address=? AND known_ms<=? AND at_ms>=?').all(...args,from-90000) as AnalysisInput['observations'];
    const candles=this.db.prepare(`SELECT open_ms openMs,known_ms knownMs,close,volume,source FROM (SELECT *,row_number() OVER(PARTITION BY open_ms ORDER BY known_ms DESC,id DESC) rank FROM candle_versions WHERE network_id=? AND pool_address=? AND known_ms<=?) WHERE rank=1 AND open_ms>=?`).all(...args,from-60000) as AnalysisInput['candles'];
    const coverage=this.db.prepare('SELECT from_ms "from",to_ms "to",known_ms knownMs FROM coverage_ranges WHERE network_id=? AND pool_address=? AND known_ms<=? AND to_ms>=?').all(...args,from) as AnalysisInput['coverage'];
    return {trades:versions.map(v=>JSON.parse(v.payload) as AnalysisTrade),observations:obs,candles,coverage};
  }
  save(metrics:MetricsSnapshot,configHash:string):void {
    this.db.prepare('INSERT INTO metric_snapshots(pool_id,as_of_ms,computed_ms,config_hash,payload) VALUES (?,?,?,?,?)').run(metrics.poolId,metrics.asOf,metrics.computedAt,configHash,JSON.stringify(metrics));
  }
  threshold(poolId:string,minute:number,knownAt:number,configHash:string):MetricsSnapshot['threshold']|undefined {
    const r=this.db.prepare('SELECT payload FROM metric_snapshots WHERE pool_id=? AND config_hash=? AND computed_ms<=? AND as_of_ms>=? AND as_of_ms<? ORDER BY id LIMIT 1').get(poolId,configHash,knownAt,minute,minute+60000) as {payload:string}|undefined;
    return r?(JSON.parse(r.payload) as MetricsSnapshot).threshold:undefined;
  }
}
