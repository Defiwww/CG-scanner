import { calculateMetrics,calculateRisk,evaluateOutcome,emptyEpisode } from '@volumechecker/engine';
import type { AnalysisInput,AnalysisTrade } from '@volumechecker/shared';
import type { SqliteDatabase } from '@volumechecker/storage';
import { SignalRepository } from '@volumechecker/storage';
import type { LoadedConfig } from './config';
import { SignalService } from './signals';
/** Invented scenario, isolated by mode. Every calculation uses the advancing virtual knowledge clock. */
export function syntheticInput(t:number):AnalysisInput {
 const trades:AnalysisTrade[]=[];
 const add=(id:string,eventMs:number,side:'buy'|'sell',usd:string)=>trades.push({id:`synthetic:${id}`,eventMs,knownMs:eventMs,side,usd,price:'100',sender:'synthetic-sender'});
 for(let i=0;i<100;i++)add(`baseline-buy-${i}`,t-600000+i*1000,'buy','1000');
 for(let i=0;i<20;i++)add(`baseline-sell-${i}`,t-590000+i*1000,'sell','1000');
 for(let i=0;i<20;i++)add(`sell-${i}`,t-200000+i*1000,'sell','20000');
 for(let i=0;i<10;i++)add(`buy-${i}`,t-190000+i*1000,'buy','500');
 add('confirmation-sell-a',t+10000,'sell','20000');add('confirmation-sell-b',t+25000,'sell','20000');add('confirmation-buy',t+40000,'buy','500');
 const observations=[];for(let at=t-20*60000;at<=t+60000;at+=30000)observations.push({at,knownMs:at,price:'100',reserve:at<t-300000?'1000000':'970000',source:'synthetic'});
 return {trades,observations,candles:[],coverage:Array.from({length:14},(_,i)=>({from:t-120*60000,to:t+i*5000,knownMs:t+i*5000}))};
}
export function runSyntheticDemo(db:SqliteDatabase,loaded:LoadedConfig,poolId:string){
 const repo=new SignalRepository(db);const existing=db.prepare("SELECT id FROM signals WHERE pool_id=? AND mode='synthetic' AND config_hash=?").get(poolId,loaded.hash);if(existing)return repo.list(poolId,'synthetic');
 // Each config's fixed virtual scenario starts independently; historical examples stay immutable.
 repo.saveState(poolId,'synthetic',loaded.hash,emptyEpisode());
 const service=new SignalService(db,loaded),t=Date.UTC(2026,9,5,12),input=syntheticInput(t);let fired:string|null=null;
 for(let now=t;now<=t+65000;now+=5000){const m=calculateMetrics(input,loaded.config,poolId,now,now),r=calculateRisk(m,loaded.config,true);fired=service.process(m,r,input,'synthetic',now)??fired;}
 if(!fired)throw Error('Synthetic scenario did not satisfy confirmation');
 for(const job of repo.pending('synthetic',t+5*3600000)){
  const end=Math.floor(job.due_ms/60000)*60000;
  const price=String(100-2*job.horizon/240);
  const candle={openMs:end-60000,knownMs:end+1000,close:price,volume:'1000',source:'synthetic completed candle'};
  const result=evaluateOutcome(job.reference_price,job.due_ms,Math.max(job.due_ms,end+1000),[candle],loaded.config.outcomes.maxObservationOffsetSec);
  repo.finish(job.id,result,result.status,`SYNTHETIC virtual clock. ${result.reason}`,job.due_ms,false);
 }
 return repo.list(poolId,'synthetic');
}
