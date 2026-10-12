/** Frozen reference implementation for behavioral parity tests only. Not used at runtime. */
import Decimal from 'decimal.js';
import type { AnalysisCandle, AnalysisTrade, AppConfig, MetricsSnapshot, RiskSnapshot } from '@volumechecker/shared';
export interface EpisodeState {
 candidate: {since:number;lastTick:number;eventStart:number;newIds:string[];sellIds:string[]}|null;
 lastFired:number|null; rearmed:boolean; recoverySince:number|null; highRiskSeen:boolean; lastObserved?:number; v1Candidate?:{asOf:number;tradeIds:string[]}|null; lastV1Checkpoint?:number;
}
export const emptyEpisode=():EpisodeState=>({candidate:null,lastFired:null,rearmed:true,recoverySince:null,highRiskSeen:false});
export function advanceEpisode(previous:EpisodeState,m:MetricsSnapshot,r:RiskSnapshot,trades:AnalysisTrade[],c:AppConfig,now:number,allowed:boolean):{state:EpisodeState;action:'fire'|'escalate'|null} {
 if(c.scoring.algorithm==='distribution-v1')return advanceV1(previous,m,r,c,now,allowed);
 const s=structuredClone(previous),a=c.alerts;
 if(s.lastObserved!==undefined&&now-s.lastObserved>c.polling.metricsRecomputeIntervalSec*2000)s.recoverySince=null;
 s.lastObserved=now;
 const healthy=r.gates.find(g=>g.name==='Collection quality')?.pass&&r.gates.find(g=>g.name==='Coverage')?.pass;
 if(!allowed){s.candidate=null;s.recoverySince=null;return {state:s,action:null};}
 if(s.lastFired!==null&&!s.rearmed&&healthy&&r.score!==null&&r.score<a.recoveryScoreBelow){s.recoverySince??=now;if(now-s.recoverySince>=a.recoveryMinutes*60000)s.rearmed=true;}else if(!healthy||r.score===null||r.score>=a.recoveryScoreBelow)s.recoverySince=null;
 const escalation=s.lastFired!==null&&!s.rearmed&&!s.highRiskSeen&&healthy&&r.score!==null&&r.score>=c.scoring.states[4]!.min;
 if(escalation){s.highRiskSeen=true;return {state:s,action:'escalate'};}
 if(!r.gates.every(g=>g.pass)||!s.rearmed||(s.lastFired!==null&&now-s.lastFired<a.cooldownMinutes*60000)){s.candidate=null;return {state:s,action:null};}
 if(s.candidate&&now-s.candidate.lastTick>c.polling.metricsRecomputeIntervalSec*2000)s.candidate=null;
 s.candidate??={since:now,lastTick:now,eventStart:m.asOf,newIds:[],sellIds:[]};
 const candidate=s.candidate;candidate.lastTick=now;
 for(const t of trades){if(t.knownMs>candidate.since&&t.knownMs<=now&&t.eventMs>candidate.eventStart&&t.eventMs<=m.asOf){if(!candidate.newIds.includes(t.id))candidate.newIds.push(t.id);if(t.side==='sell'&&!candidate.sellIds.includes(t.id))candidate.sellIds.push(t.id);}}
 if(now-candidate.since<a.confirmationSec*1000||candidate.newIds.length<a.confirmationMinNewTrades||candidate.sellIds.length<a.confirmationMinNewSells)return {state:s,action:null};
 s.lastFired=now;s.rearmed=false;s.recoverySince=null;s.highRiskSeen=(r.score??0)>=c.scoring.states[4]!.min;s.candidate=null;
 return {state:s,action:'fire'};
}
export interface OutcomeResult {status:'pending'|'complete'|'recovered'|'unavailable';price:string|null;returnPct:string|null;observedAt:number|null;receivedAt:number|null;delayMs:number|null;reason:string}
export function evaluateOutcome(reference:string,due:number,now:number,candles:AnalysisCandle[],offsetSec:number):OutcomeResult {
 const empty={price:null,returnPct:null,observedAt:null,receivedAt:null,delayMs:null};
 if(now<due)return {...empty,status:'pending',reason:'Horizon is not due'};
 const candidates=candles.filter(c=>c.knownMs<=now&&c.knownMs>=c.openMs+60000&&c.openMs+60000<=due&&due-(c.openMs+60000)<=offsetSec*1000&&new Decimal(c.close).gt(0)&&c.volume!==null&&new Decimal(c.volume).gt(0));
 const chosen=candidates.sort((a,b)=>b.openMs-a.openMs||b.knownMs-a.knownMs)[0];
 if(!chosen)return {...empty,status:'unavailable',reason:'No completed nonempty observed candle ending within the allowed boundary; no later-price substitution'};
 return {status:chosen.knownMs>due+offsetSec*1000?'recovered':'complete',price:chosen.close,returnPct:new Decimal(chosen.close).div(reference).minus(1).mul(100).toString(),observedAt:chosen.openMs+60000,receivedAt:chosen.knownMs,delayMs:Math.max(0,chosen.knownMs-due),reason:`${chosen.source}; completed minute close; boundary offset ${due-(chosen.openMs+60000)} ms`};
}

/** Two observations mean distinct canonical checkpoints with new trades, never repeated UI/timer reads. */
function advanceV1(previous:EpisodeState,m:MetricsSnapshot,r:RiskSnapshot,c:AppConfig,now:number,allowed:boolean):{state:EpisodeState;action:'fire'|null} {
 const s=structuredClone(previous),w=m.windows.find(x=>x.minutes===5)!;
 if(!allowed||!r.gates.every(g=>g.pass)||now-m.asOf>c.freshness.maxPriceAgeSec*1000){s.v1Candidate=null;return {state:s,action:null};}
 if(s.lastFired!==null&&now-s.lastFired<c.alerts.cooldownMinutes*60000){s.v1Candidate=null;return {state:s,action:null};}
 if(s.lastV1Checkpoint!=null&&s.lastV1Checkpoint>=m.asOf)return {state:s,action:null};
 s.lastV1Checkpoint=m.asOf;
 const prior=s.v1Candidate;
 const consecutive=prior!==null&&prior!==undefined&&m.asOf-prior.asOf<=c.polling.reconciliationIntervalSec*2000&&w.tradeIds.some(id=>!prior.tradeIds.includes(id));
 const high=(r.score??0)>=85&&r.components.some(x=>['Sell dominance','Seller concentration'].includes(x.name)&&Number(x.contribution)>0);
 s.v1Candidate={asOf:m.asOf,tradeIds:[...w.tradeIds]};
 if(!high&&!consecutive)return {state:s,action:null};
 s.lastFired=now;s.v1Candidate=null;s.candidate=null;s.highRiskSeen=high;return {state:s,action:'fire'};
}

/** Observed minute-close excursions only: gaps are explicit, no tick-high/low claim. */
export function observedExcursions(reference:string,from:number,to:number,now:number,candles:AnalysisCandle[]) {
 const minutes=new Map<number,AnalysisCandle>();
 for(const c of candles)if(c.openMs+60000>from&&c.openMs+60000<=to&&c.knownMs<=now&&c.knownMs>=c.openMs+60000&&c.volume!==null&&new Decimal(c.volume).gt(0)&&new Decimal(c.close).gt(0)){const old=minutes.get(c.openMs);if(!old||old.knownMs<c.knownMs)minutes.set(c.openMs,c);}
 const returns=[...minutes.values()].map(c=>new Decimal(c.close).div(reference).minus(1).mul(100));
 return {maxAdverseObservedClosePct:returns.length?Decimal.min(0,...returns).toString():null,maxFavorableObservedClosePct:returns.length?Decimal.max(0,...returns).toString():null,observedMinutes:minutes.size,expectedMinutes:Math.floor(to/60000)-Math.floor(from/60000),basis:'Observed nonempty minute closes only; missing minutes not interpolated. Not intraminute extrema or profitability.'};
}
