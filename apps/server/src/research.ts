import Decimal from 'decimal.js';
import {summarizeSellers,quantile} from '@volumechecker/engine';
import {getPoolConfig, ALLOWED_POOLS, v1Rules, type AppConfig} from '@volumechecker/shared';
import type {AnalysisResponse,AnalysisTrade,InspectionSnapshot} from '@volumechecker/shared';
import type {SqliteDatabase} from '@volumechecker/storage';
export class ResearchService {
 private last=new Map<string,string>();
 constructor(private db:SqliteDatabase,private config:AppConfig){}
 private get catalog(){return this.config.pool.catalog??ALLOWED_POOLS;}
 observe(s:InspectionSnapshot,a:AnalysisResponse,now:number):void {
  const id=s.persistence.sessionId;if(!id)return;
  const detail={stream:a.stream,rest:a.status,reconnects:s.transport.reconnects,errors:s.errors};
  const key=JSON.stringify(detail);
  if(this.last.get(id)!==key){this.db.prepare('INSERT INTO session_events(session_id,at_ms,kind,payload) VALUES (?,?,?,?)').run(id,now,'quality',key);this.last.set(id,key);}
  if(a.metrics&&a.risk?.score!==null&&(a.risk?.score??0)>=this.config.scoring.states.find(b=>b.name==='Distribution Watch')!.min&&!this.db.prepare('SELECT 1 FROM research_cases WHERE session_id=? AND as_of_ms=?').get(id,a.metrics.asOf))this.db.prepare('INSERT OR IGNORE INTO research_cases(session_id,pool_id,as_of_ms,kind,payload) VALUES (?,?,?,?,?)').run(id,a.poolId,a.metrics.asOf,'score-watch',JSON.stringify({scoreHistory:(this.db.prepare('SELECT computed_ms,payload FROM score_snapshots WHERE pool_id=? AND computed_ms>=? AND computed_ms<=? AND config_hash=(SELECT config_hash FROM sessions WHERE id=?) ORDER BY computed_ms').all(a.poolId,now-this.config.alerts.preAlertContextMinutes*60000,now,id) as {computed_ms:number;payload:string}[]).map(r=>({at:r.computed_ms,...JSON.parse(r.payload)})),metrics:a.metrics,risk:a.risk,wallets:a.wallets,stream:a.stream,source:'real canonical REST; an elevated score is not confirmation'}));
 }
 finish(id:string,endMs?:number,startMs?:number):void {
  if(this.db.prepare('SELECT 1 FROM session_reports WHERE session_id=?').get(id))return;
  const session=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as {id:string;network_id:string;pool_address:string;started_at_sec:number;stopped_at_sec:number|null;final_state:string}|undefined;
  if(!session?.stopped_at_sec)return;
  const start=startMs??session.started_at_sec*1000,end=endMs??session.stopped_at_sec*1000;
  const poolId=`${session.network_id}:${session.pool_address}`;
  const trades=this.db.prepare('SELECT provider_trade_id id,block_timestamp_sec*1000 eventMs,received_at_sec*1000 knownMs,side,volume_usd usd,base_price_usd price,sender_address sender FROM trades WHERE network_id=? AND pool_address=? AND block_timestamp_sec>=? AND block_timestamp_sec<=? AND received_at_sec<=?').all(session.network_id,session.pool_address,start/1000,end/1000,end/1000) as AnalysisTrade[];
  const sum=(side:string)=>trades.filter(t=>t.side===side&&t.usd!==null).reduce((s,t)=>s.plus(t.usd!),new Decimal(0)).toString();
  const alerts=this.db.prepare("SELECT * FROM signals WHERE pool_id=? AND mode='live' AND fired_ms>=? AND fired_ms<=? ORDER BY fired_ms").all(poolId,start,end) as {id:string;metrics_json:string;risk_json:string;evidence_json:string;fired_ms:number}[];
  const events=this.db.prepare('SELECT at_ms,kind,payload FROM session_events WHERE session_id=? ORDER BY at_ms').all(id) as {at_ms:number;kind:string;payload:string}[];
  const parsed=events.map(e=>({at:e.at_ms,kind:e.kind,...JSON.parse(e.payload)}));
  const stalePeriods=parsed.flatMap((e,i)=>e.stream?.state==='STALE'?[{from:e.at,to:parsed[i+1]?.at??end,reason:e.stream.reason}]:[]);
  const payload={id,poolId,pair:(()=>{const p=getPoolConfig(poolId,this.catalog);return p?`${p.baseName}/${p.quoteName}`:poolId;})(),chain:session.network_id,pool:session.pool_address,start,end,durationSeconds:(end-start)/1000,trades:trades.length,buyUsd:sum('buy'),sellUsd:sum('sell'),alertCount:alerts.length,alerts:alerts.map(a=>({id:a.id,at:a.fired_ms,metrics:JSON.parse(a.metrics_json),risk:JSON.parse(a.risk_json),evidence:JSON.parse(a.evidence_json),outcomes:this.db.prepare('SELECT horizon,status,result_json,reason FROM outcome_jobs WHERE alert_id=?').all(a.id)})),wallets:summarizeSellers(trades,String(this.config.scoring.largeTrade.minimumUsd),v1Rules(this.config).sellers),qualityEvents:parsed,stalePeriods,finalState:session.final_state,note:'Frozen at session end. Counts exclude initial history and unconfirmed WS observations. Live outcomes continue independently; retrieve updated outcomes from the alert evidence endpoint. Missing telemetry from older sessions is unknown.'};
  this.db.prepare('INSERT OR IGNORE INTO session_reports VALUES (?,?)').run(id,JSON.stringify(payload));this.last.delete(id);
 }
 list(){return (this.db.prepare('SELECT s.id,s.network_id,s.started_at_sec,s.stopped_at_sec FROM session_reports r JOIN sessions s ON s.id=r.session_id ORDER BY s.started_at_sec DESC LIMIT 30').all());}
 report(id:string):Record<string,unknown>|null {const row=this.db.prepare('SELECT payload FROM session_reports WHERE session_id=?').get(id) as {payload:string}|undefined;return row?JSON.parse(row.payload):null;}
 signal(id:string):unknown {const row=this.db.prepare('SELECT id,pool_id,mode,fired_ms,metrics_json,risk_json,evidence_json,reference_price,reference_ms,reference_source FROM signals WHERE id=?').get(id) as Record<string,unknown>|undefined;if(!row)return null;return {...row,metrics:JSON.parse(String(row.metrics_json)),risk:JSON.parse(String(row.risk_json)),evidence:JSON.parse(String(row.evidence_json)),outcomes:this.db.prepare('SELECT horizon,status,result_json,reason FROM outcome_jobs WHERE alert_id=?').all(id)};}
 case(id:number):unknown {
  const row=this.db.prepare('SELECT pool_id,as_of_ms,payload FROM research_cases WHERE id=?').get(id) as {pool_id:string;as_of_ms:number;payload:string}|undefined;
  if(!row)return null;const pool=getPoolConfig(row.pool_id,this.catalog);if(!pool)return null;
  const after=this.db.prepare('SELECT open_ms,close,volume,known_ms,source FROM candle_versions WHERE network_id=? AND pool_address=? AND open_ms>=? AND open_ms<? AND known_ms>=open_ms+60000 ORDER BY open_ms,known_ms').all(pool.networkId,pool.poolAddress,row.as_of_ms,row.as_of_ms+14400000);
  return {id,...JSON.parse(row.payload),subsequentObservedCandles:after,note:'Frozen watch context; subsequent saved candles are observational follow-up, not a confirmed alert or guaranteed complete history.'};
 }
 summary(poolId:string){
  const signals=this.db.prepare("SELECT id,fired_ms,risk_json FROM signals WHERE pool_id=? AND mode='live' ORDER BY fired_ms DESC").all(poolId) as {id:string;fired_ms:number;risk_json:string}[];
  const jobs=this.db.prepare("SELECT j.alert_id,j.horizon,j.status,j.result_json FROM outcome_jobs j JOIN signals s ON s.id=j.alert_id WHERE s.pool_id=? AND s.mode='live'").all(poolId) as {alert_id:string;horizon:number;status:string;result_json:string|null}[];
  const completed=jobs.filter(j=>['complete','recovered'].includes(j.status)).map(j=>({...j,result:JSON.parse(j.result_json??'null') as {returnPct:string}|null})).filter(j=>j.result?.returnPct!=null);
  const oneHour=completed.filter(j=>j.horizon===60);
  const drawdown=oneHour.filter(j=>Number(j.result!.returnPct)<=-1),rally=oneHour.filter(j=>Number(j.result!.returnPct)>0);
  const cases=this.db.prepare('SELECT id,as_of_ms FROM research_cases WHERE pool_id=? ORDER BY as_of_ms DESC LIMIT 20').all(poolId) as {id:number;as_of_ms:number;payload:string}[];
  return {realAlerts:signals.length,completedOneHour:oneHour.length,drawdown:drawdown.length,continuedRally:rally.length,inconclusive:signals.length-drawdown.length-rally.length,falsePositiveRate:oneHour.length>=20?rally.length/oneHour.length:null,definition:'Exploratory definition: 1h return ≤ −1% = drawdown; > 0% = continued rally / false positive; otherwise or missing outcome = inconclusive. Not profitability. Rates/medians withheld below 20 completed observations.',horizons:[5,15,60,240].map(h=>{const rows=completed.filter(j=>j.horizon===h);return {minutes:h,n:rows.length,medianReturn:rows.length>=20?quantile(rows.map(j=>j.result!.returnPct),.5):null};}),examples:{confirmed:signals[0]?.id??null,falsePositive:rally[0]?.alert_id??null,unconfirmed:cases.filter(c=>!signals.some(s=>s.fired_ms>=c.as_of_ms&&s.fired_ms<=c.as_of_ms+120000)).map(c=>({id:c.id,asOf:c.as_of_ms,label:Date.now()-c.as_of_ms<120000?'Watch still pending':'Elevated score without confirmation within two minutes'}))}};
 }
}
export function reportCsv(report:Record<string,unknown>):string {
 const keys=['id','pair','chain','pool','start','end','durationSeconds','trades','buyUsd','sellUsd','alertCount'];
 const quote=(v:unknown)=>'"'+String(v??'').replace(/"/g,'""')+'"';
 return keys.map(quote).join(',')+'\r\n'+keys.map(k=>quote(report[k])).join(',')+'\r\n';
}
