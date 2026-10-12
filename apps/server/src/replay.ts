import {AnalysisRepository,type SqliteDatabase} from '@volumechecker/storage';
import {getPoolConfig} from '@volumechecker/shared';
import {calculateMetrics,calculateRisk,advanceEpisode,emptyEpisode} from '@volumechecker/engine';
import type {LoadedConfig} from './config';
/** Read-only historical replay. No provider calls, no live signal writes, no future knowledge. */
export function replaySaved(db:SqliteDatabase,loaded:LoadedConfig,poolId:string,end=Date.now()) {
 const pool=getPoolConfig(poolId,loaded.config.pool.catalog);if(!pool)throw Error('Pool not allowed');
 const repo=new AnalysisRepository(db),start=end-15*60000,step=loaded.config.polling.metricsRecomputeIntervalSec*1000;
 let state=emptyEpisode(),threshold:ReturnType<typeof calculateMetrics>['threshold']|undefined;
 const samples:{at:number;asOf:number;score:number|null;status:string;tradeCount:number;maxKnownAt:number|null}[]=[];const wouldFire:number[]=[];
 for(let at=start;at<=end;at+=step){
  const checkpoint=db.prepare('SELECT max(to_ms) t FROM coverage_ranges WHERE network_id=? AND pool_address=? AND known_ms<=? AND to_ms<=?').get(pool.networkId,pool.poolAddress,at,at) as {t:number|null};
  if(checkpoint.t===null)continue;
  const input=repo.input(pool,checkpoint.t-125*60000,at),m=calculateMetrics(input,loaded.config,poolId,checkpoint.t,at,threshold);threshold=m.threshold;
  const healthy=at-m.asOf<=90000; // Transport cannot be reconstructed: this is an explicitly labelled simulation.
  const r=calculateRisk(m,loaded.config,healthy),result=advanceEpisode(state,m,r,input.trades,loaded.config,at,true);state=result.state;if(result.action==='fire')wouldFire.push(at);
  const known=input.trades.map(t=>t.knownMs);samples.push({at,asOf:m.asOf,score:r.score,status:r.state,tradeCount:m.windows.find(w=>w.minutes===5)!.tradeIds.length,maxKnownAt:known.length?Math.max(...known):null});
 }
 return {mode:'replay',poolId,start,end,steps:samples.length,wouldFire,samples,note:'Read-only REPLAY simulation. Uses only revisions, observations and coverage known at each virtual clock. Historical transport quality is not reconstructed; no live alerts emitted.'};
}
