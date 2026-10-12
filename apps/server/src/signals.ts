import { AnalysisRepository, SignalRepository, type SqliteDatabase } from '@volumechecker/storage';
import { advanceEpisode, emptyEpisode, evaluateOutcome, observedExcursions, type EpisodeState } from '@volumechecker/engine';
import { getPoolConfig, type AnalysisInput, type AppConfig, type MetricsSnapshot, type RiskSnapshot, type SignalRecord, redactText } from '@volumechecker/shared';
import { createRestClient, ohlcvMinuteRoute, ohlcvResponseSchema, ProviderError, type FetchLike } from '@volumechecker/coingecko';
import type { LoadedConfig } from './config';
export class SignalService {
 readonly repo:SignalRepository;
 constructor(private db:SqliteDatabase,private loaded:LoadedConfig){this.repo=new SignalRepository(db);}
 process(m:MetricsSnapshot,r:RiskSnapshot,input:AnalysisInput,mode:SignalRecord['mode'],now:number):string|null {
  const c=this.loaded.config;
  const allowed=mode!=='live'||(c.approval.status==='approved'&&c.alerts.liveAlertsEnabled);
  return this.db.transaction(()=>{
   const previous=this.repo.state<EpisodeState>(m.poolId,mode,this.loaded.hash)??emptyEpisode();
   const result=advanceEpisode(previous,m,r,input.trades,c,now,allowed);
   let id:string|null=null;
   const price=input.trades.filter(t=>t.price!==null&&t.eventMs<=m.asOf&&t.knownMs<=now).sort((a,b)=>b.eventMs-a.eventMs)[0];
   if(result.action==='fire'&&c.scoring.algorithm==='distribution-v1'&&(!price||now-price.eventMs>c.freshness.maxPriceAgeSec*1000))return null;
   if(result.action==='fire')id=this.repo.fire(m,r,c,this.loaded.hash,mode,now,{scoreHistory:(this.db.prepare('SELECT computed_ms,payload FROM score_snapshots WHERE pool_id=? AND config_hash=? AND computed_ms>=? AND computed_ms<=? ORDER BY computed_ms').all(m.poolId,this.loaded.hash,now-c.alerts.preAlertContextMinutes*60000,now) as {computed_ms:number;payload:string}[]).map(row=>({at:row.computed_ms,...JSON.parse(row.payload)})),algorithm:m.algorithm,knownAt:now,trades:input.trades.filter(t=>t.eventMs>m.asOf-c.alerts.preAlertContextMinutes*60000&&t.eventMs<=m.asOf&&t.knownMs<=now),observations:input.observations.filter(o=>o.at>m.asOf-c.alerts.preAlertContextMinutes*60000&&o.at<=m.asOf&&o.knownMs<=now),candles:input.candles.filter(o=>o.openMs>=m.asOf-c.alerts.preAlertContextMinutes*60000&&o.openMs+60000<=m.asOf&&o.knownMs<=now),coverage:input.coverage.filter(r=>r.knownMs<=now)},c.scoring.algorithm==='distribution-v1'&&price?{value:price.price!,at:price.eventMs,source:'rest-trade block time'}:undefined);
   if(result.action==='escalate')this.repo.escalate(m.poolId,mode,now);
   this.repo.saveState(m.poolId,mode,this.loaded.hash,result.state);return id;
  })();
 }
}
/** Independent price-only worker. Disconnect and selected pool do not own its lifecycle. */
export class OutcomeWorker {
 private readonly repo:SignalRepository;
 private running:Promise<void>|null=null;
 private readonly abort=new AbortController();
 constructor(private db:SqliteDatabase,private opts:{apiKey:string|undefined;fetchImpl?:FetchLike;now?:()=>number}){this.repo=new SignalRepository(db);}
 tick(now=Date.now()):Promise<void>{if(this.running)return this.running;this.running=this.run(now).finally(()=>{this.running=null;});return this.running;}
 async stop():Promise<void>{this.abort.abort();await this.running;}
 private async run(now:number):Promise<void>{
  // At most one provider request per tick; the scheduler interval is 30 seconds.
  const job=this.repo.pending('live',now)[0];if(!job||this.abort.signal.aborted)return;
  const c=JSON.parse(job.config_json) as AppConfig,pool=getPoolConfig(job.pool_id,c.pool.catalog);
  if(!pool){this.repo.finish(job.id,null,'unavailable','Original pool is not allowlisted',now,false);return;}
  const input=new AnalysisRepository(this.db).input(pool,job.fired_ms-60000,now);
  let result=evaluateOutcome(job.reference_price,job.due_ms,now,input.candles,c.outcomes.maxObservationOffsetSec);
  if(result.price!==null){this.repo.finish(job.id,{...result,excursions:observedExcursions(job.reference_price,job.fired_ms,job.due_ms,now,input.candles)},result.status,result.reason,now,false);return;}
  const used=(this.db.prepare('SELECT sum(attempts) n FROM outcome_jobs WHERE alert_id=?').get(job.alert_id) as {n:number|null}).n??0;
  if(used>=c.budget.followupReserveRestRequests||job.attempts>=5){this.repo.finish(job.id,result,'unavailable','Follow-up recovery budget exhausted; no suitable candle',now,false);return;}
  if(!this.opts.apiKey){this.repo.finish(job.id,result,'delayed','Server key unavailable; original job retained',now+60000,false);return;}
  // Reserve an attempt before I/O so a crash cannot reset its budget.
  this.repo.finish(job.id,result,'delayed','Requesting historical candle for original pool and horizon',now+60000,true);
  try {
   const client=createRestClient({apiKey:this.opts.apiKey,timeoutMs:c.provider.requestTimeoutMs,...(this.opts.now?{now:this.opts.now}:{}),...(this.opts.fetchImpl?{fetchImpl:this.opts.fetchImpl}:{})});
   const response=await client.get(ohlcvMinuteRoute({limit:3,beforeTimestampSec:Math.floor(job.due_ms/1000)},pool),this.abort.signal);
   if(this.abort.signal.aborted)return;
   const parsed=ohlcvResponseSchema.parse(response.body);
   if(parsed.meta?.base?.address?.toLowerCase()!==pool.baseAddress.toLowerCase())throw Error('Outcome token orientation mismatch');
   const received=Date.parse(response.receivedAt);
   this.db.prepare('INSERT INTO outcome_raw(job_id,received_ms,payload) VALUES (?,?,?)').run(job.id,received,redactText(response.bodyText,[this.opts.apiKey]));
   const candles=parsed.data.attributes.ohlcv_list.flatMap(row=>row[4]===null?[]:[{openMs:row[0]*1000,knownMs:received,close:String(row[4]),volume:row[5]===null?null:String(row[5]),source:'rest-outcome-history'}]);
   result=evaluateOutcome(job.reference_price,job.due_ms,received,candles,c.outcomes.maxObservationOffsetSec);
   this.repo.finish(job.id,{...result,excursions:observedExcursions(job.reference_price,job.fired_ms,job.due_ms,received,[...input.candles,...candles])},result.price===null?'delayed':result.status,result.reason,received+60000,false);
  }catch(err){if(this.abort.signal.aborted)return;const auth=err instanceof ProviderError&&err.kind==='auth';const retry=err instanceof ProviderError?err.retryAfterSec??60:60;this.repo.finish(job.id,null,auth?'unavailable':'delayed',auth?'Provider authorization failed':'Historical observation request failed; no current-price substitution',now+Math.max(60,retry)*1000,false);}
 }
}
