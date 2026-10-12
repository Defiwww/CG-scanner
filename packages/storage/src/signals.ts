import {randomUUID} from 'node:crypto';
import type {AppConfig,MetricsSnapshot,RiskSnapshot,SignalRecord} from '@volumechecker/shared';
import type {SqliteDatabase} from './index';
export interface StoredJob {id:number;alert_id:string;pool_id:string;mode:SignalRecord['mode'];horizon:number;due_ms:number;attempts:number;reference_price:string;config_json:string;fired_ms:number;status:string}
export class SignalRepository {
 constructor(readonly db:SqliteDatabase){}
 state<T>(poolId:string,mode:string,hash:string):T|undefined{
  const r=this.db.prepare('SELECT payload,config_hash FROM signal_state WHERE pool_id=? AND mode=? ORDER BY rowid DESC LIMIT 1').get(poolId,mode) as {payload:string;config_hash:string}|undefined;
  if(!r)return undefined;const state=JSON.parse(r.payload);if(r.config_hash!==hash){state.candidate=null;state.recoverySince=null;state.v1Candidate=null;state.lastV1Checkpoint=null;}return state as T;
 }
 saveState(poolId:string,mode:string,hash:string,state:unknown):void{
  this.db.prepare('DELETE FROM signal_state WHERE pool_id=? AND mode=? AND config_hash!=?').run(poolId,mode,hash);
  this.db.prepare('INSERT INTO signal_state VALUES (?,?,?,?) ON CONFLICT(pool_id,mode,config_hash) DO UPDATE SET payload=excluded.payload').run(poolId,mode,hash,JSON.stringify(state));
 }
 resetConfirmations():void{this.db.exec("UPDATE signal_state SET payload=json_set(payload,'$.candidate',NULL,'$.recoverySince',NULL,'$.v1Candidate',NULL,'$.lastV1Checkpoint',NULL) WHERE mode='live'");}
 fire(m:MetricsSnapshot,r:RiskSnapshot,c:AppConfig,hash:string,mode:SignalRecord['mode'],at:number,evidence:unknown,reference?:{value:string;at:number;source:string}):string{
  return this.db.transaction(()=>{
   const p=reference?{value:reference.value,from:reference.at,reason:reference.source}:m.windows.find(w=>w.minutes===5)!.metrics.currentPrice!;
   if(p.value===null||at-p.from>c.freshness.maxPriceAgeSec*1000)throw Error('Signal reference price is not fresh');
   const id=randomUUID();
   this.db.prepare('INSERT INTO signals(id,pool_id,mode,fired_ms,metrics_json,risk_json,config_json,config_hash,reference_price,reference_ms,reference_source,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.poolId,mode,at,JSON.stringify(m),JSON.stringify(r),JSON.stringify(c),hash,p.value,p.from,p.reason,JSON.stringify(evidence));
   for(const horizon of c.outcomes.horizonsMinutes)this.db.prepare("INSERT INTO outcome_jobs(alert_id,pool_id,mode,horizon,due_ms,status,next_ms) VALUES (?,?,?,?,?,'pending',?)").run(id,m.poolId,mode,horizon,at+horizon*60000,at+horizon*60000);
   this.db.prepare('INSERT INTO signal_timeline(alert_id,at_ms,event) VALUES (?,?,?)').run(id,at,'Signal confirmed');return id;
  })();
 }
 escalate(poolId:string,mode:string,at:number):void{const r=this.db.prepare('SELECT id FROM signals WHERE pool_id=? AND mode=? ORDER BY fired_ms DESC LIMIT 1').get(poolId,mode) as {id:string}|undefined;if(r)this.db.prepare('INSERT INTO signal_timeline(alert_id,at_ms,event) VALUES (?,?,?)').run(r.id,at,'Escalated to High Risk; same episode');}
 pending(mode:string,now:number):StoredJob[]{return this.db.prepare("SELECT j.*,s.reference_price,s.config_json,s.fired_ms FROM outcome_jobs j JOIN signals s ON s.id=j.alert_id WHERE j.mode=? AND j.status IN ('pending','delayed') AND j.next_ms<=? ORDER BY j.due_ms LIMIT 20").all(mode,now) as StoredJob[];}
 finish(id:number,result:unknown,status:string,reason:string,nextMs:number,attempt:boolean):void{this.db.prepare('UPDATE outcome_jobs SET result_json=?,status=?,reason=?,next_ms=?,attempts=attempts+? WHERE id=?').run(JSON.stringify(result),status,reason,nextMs,Number(attempt),id);}
 list(poolId:string,mode?:string):SignalRecord[]{
  const rows=this.db.prepare('SELECT * FROM signals WHERE pool_id=? '+(mode?'AND mode=? ':'')+'ORDER BY fired_ms DESC LIMIT 30').all(...(mode?[poolId,mode]:[poolId])) as {id:string;pool_id:string;mode:SignalRecord['mode'];fired_ms:number;risk_json:string}[];
  return rows.map(r=>{const risk=JSON.parse(r.risk_json) as RiskSnapshot;const jobs=this.db.prepare('SELECT * FROM outcome_jobs WHERE alert_id=? ORDER BY horizon').all(r.id) as {horizon:number;due_ms:number;status:string;result_json:string|null;reason:string}[];return {id:r.id,poolId:r.pool_id,mode:r.mode,firedAt:r.fired_ms,score:risk.score!,state:risk.state,explanation:risk.explanation,outcomes:jobs.map(j=>{const result=j.result_json?JSON.parse(j.result_json) as {price:string|null;returnPct:string|null;observedAt:number|null;receivedAt:number|null;delayMs:number|null}:null;return {horizon:j.horizon,dueAt:j.due_ms,status:j.status,price:result?.price??null,returnPct:result?.returnPct??null,observedAt:result?.observedAt??null,receivedAt:result?.receivedAt??null,delayMs:result?.delayMs??null,reason:j.reason};})};});
 }
}
