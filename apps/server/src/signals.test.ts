import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,runMigrations,SignalRepository,M2Collector} from '@volumechecker/storage';
import {calculateMetrics,calculateRisk,advanceEpisode,emptyEpisode,evaluateOutcome} from '@volumechecker/engine';
import {ALLOWED_POOLS} from '@volumechecker/shared';
import {syntheticInput,runSyntheticDemo} from './synthetic';
import {SignalService,OutcomeWorker} from './signals';
import {replaySaved} from './replay';
import {mapRestTrade} from '../../../packages/coingecko/src/mapping';
import {restTrade} from '../../../tests/fixtures/synthetic/coingecko';
import {loadAppConfig} from './config';
const loaded=loadAppConfig(new URL('../../../config/legacy-v0.json',import.meta.url).pathname),c=loaded.config;
const t=Date.UTC(2026,9,5,12),pool=ALLOWED_POOLS[1]!,poolId=`${pool.networkId}:${pool.poolAddress}`;
const calculate=(now:number,input=syntheticInput(t))=>{const m=calculateMetrics(input,c,poolId,now,now);return {m,r:calculateRisk(m,c,true)};};
it('confirms only after 60s and new swaps incl two sells; suppresses one episode and resets failures',()=>{
 const data=syntheticInput(t);let state=emptyEpisode(),fired=0;
 for(let now=t;now<=t+120000;now+=5000){const {m,r}=calculate(now,data);const step=advanceEpisode(state,m,r,data.trades,c,now,true);state=step.state;if(step.action==='fire'){expect(now).toBe(t+60000);fired++;}}
 expect(fired).toBe(1);
 let same=emptyEpisode();for(let now=t;now<=t+60000;now+=5000){const {m,r}=calculate(t);same=advanceEpisode(same,m,r,[],c,now,true).state;}expect(same.lastFired).toBeNull();
 const {m,r}=calculate(t+60000);r.gates[0]!.pass=false;expect(advanceEpisode(same,m,r,data.trades,c,t+65000,true).state.candidate).toBeNull();
});
it('keeps cooldown across config change and resets interrupted confirmation, not the episode',()=>{const db=openDatabase(':memory:');try{runMigrations(db);const repo=new SignalRepository(db);const state={...emptyEpisode(),lastFired:t,rearmed:false,candidate:{since:t,lastTick:t,eventStart:t,newIds:[],sellIds:[]}};repo.saveState(poolId,'live','old',state);expect(repo.state<typeof state>(poolId,'live','new')).toMatchObject({lastFired:t,candidate:null,rearmed:false});repo.resetConfirmations();expect(repo.state<typeof state>(poolId,'live','old')?.candidate).toBeNull();}finally{db.close();}});
it('enforces no future candles, records recovery delay, and leaves unavailable prices unknown',()=>{const candle={openMs:t-60000,knownMs:t+120000,close:'98',volume:'1',source:'history'};expect(evaluateOutcome('100',t,t-1,[candle],60).status).toBe('pending');expect(evaluateOutcome('100',t,t+1000,[candle],60).price).toBeNull();expect(evaluateOutcome('100',t,t+120000,[candle],60)).toMatchObject({status:'recovered',returnPct:'-2',delayMs:120000});expect(evaluateOutcome('100',t,t+120000,[{...candle,openMs:t}],60).price).toBeNull();});
it('synthetic end-to-end stores one immutable signal and all four explicitly synthetic outcomes; live remains off',()=>{const db=openDatabase(':memory:');try{runMigrations(db);const result=runSyntheticDemo(db,loaded,poolId);expect(result).toHaveLength(1);expect(result[0]!.mode).toBe('synthetic');expect(result[0]!.outcomes.map(o=>o.horizon)).toEqual([5,15,60,240]);expect(result[0]!.outcomes.every(o=>o.status==='complete')).toBe(true);expect(runSyntheticDemo(db,loaded,poolId)).toHaveLength(1);expect(()=>db.prepare('UPDATE signals SET reference_price=?').run('5')).toThrow('immutable');const service=new SignalService(db,loaded),{m,r}=calculate(t+60000);expect(service.process(m,r,syntheticInput(t),'live',t+60000)).toBeNull();expect(new SignalRepository(db).list(poolId,'live')).toEqual([]);}finally{db.close();}});
it('durable pending jobs survive DB restart and use their original Base pool after collection stops or switches',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vc-outcome-')),path=join(dir,'db.sqlite');let db=openDatabase(path);
 try{runMigrations(db);const {m,r}=calculate(t+60000);const repo=new SignalRepository(db);const alert=repo.fire(m,r,c,loaded.hash,'live',t+60000,{fixture:true});const due=t+6*60000;db.close();db=openDatabase(path);
 const urls:string[]=[];const worker=new OutcomeWorker(db,{apiKey:'DUMMY',now:()=>due+120000,fetchImpl:async(url)=>{urls.push(url.toString());return new Response(JSON.stringify({data:{id:'synthetic',type:'ohlcv_request_response',attributes:{ohlcv_list:[[(due-60000)/1000,99,99,99,99,5]]}},meta:{base:{address:pool.baseAddress},quote:{address:pool.quoteAddress}}}));}});
 await worker.tick(due+120000);await worker.stop();const restored=new SignalRepository(db).list(poolId,'live').find(s=>s.id===alert)!;expect(restored.outcomes[0]!.status).toBe('recovered');expect(restored.outcomes[0]!.returnPct).toBe('-1');expect(restored.outcomes.slice(1).every(o=>o.status==='pending')).toBe(true);expect(urls[0]).toContain(`/networks/base/pools/${pool.poolAddress}/`);expect(urls[0]).toContain('before_timestamp=');expect(db.prepare('SELECT count(*) n FROM outcome_raw').get()).toEqual({n:1});
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
it('requires recovery and cooldown to rearm; High Risk escalates without a second alert',()=>{
 const {m,r}=calculate(t),data=syntheticInput(t);let state:ReturnType<typeof emptyEpisode>={...emptyEpisode(),lastFired:t,rearmed:false,highRiskSeen:false};
 const escalation=advanceEpisode(state,m,r,data.trades,c,t+5000,true);expect(escalation.action).toBe('escalate');state=escalation.state;
 expect(advanceEpisode(state,m,r,data.trades,c,t+10000,true).action).toBeNull();
 const low={...r,score:40};for(let now=t+15000;now<=t+135000;now+=5000)state=advanceEpisode(state,m,low,data.trades,c,now,true).state;
 expect(state.rearmed).toBe(true);expect(advanceEpisode(state,m,r,data.trades,c,t+140000,true).state.candidate).toBeNull();
 expect(advanceEpisode(state,m,r,data.trades,c,t+16*60000,true).state.candidate).not.toBeNull();
});

it('rejects a candle last received before its close and does not rearm across unobserved recovery',()=>{
 expect(evaluateOutcome('100',t,t+120000,[{openMs:t-60000,knownMs:t-1000,close:'98',volume:'1',source:'ws'}],60).price).toBeNull();
 const {m,r}=calculate(t),low={...r,score:40};
 const state={...emptyEpisode(),lastFired:t-600000,rearmed:false,recoverySince:t-120000,lastObserved:t-120000};
 expect(advanceEpisode(state,m,low,[],c,t,true).state.rearmed).toBe(false);
});

it('historical replay is unchanged by future corrections or metadata and never writes signals',()=>{
 const db=openDatabase(':memory:');try{runMigrations(db);
 const collector=new M2Collector({db,sessionId:'replay-test',selectedPoolId:poolId,configHash:loaded.hash});collector.start();
 const trade={...mapRestTrade(restTrade({id:'replay-opaque',side:'buy'}),new Date(t).toISOString()).trade,blockTimestamp:new Date(t-10000).toISOString()};
 const sample={kind:'rest_trade' as const,endpointOrChannel:'synthetic',receivedAt:trade.receivedAt,rawText:'{}',mapped:null};
 collector.restBatch(sample,[trade]);
 db.prepare('INSERT INTO coverage_ranges(network_id,pool_address,from_ms,to_ms,known_ms) VALUES (?,?,?,?,?)').run(pool.networkId,pool.poolAddress,t-7200000,t,t);
 const before=replaySaved(db,loaded,poolId,t+60000);
 collector.restBatch(sample,[{...trade,volumeUsd:'999999',receivedAt:new Date(t+90000).toISOString()}]);
 db.prepare('INSERT INTO pool_observations(network_id,pool_address,at_ms,known_ms,price,reserve,source) VALUES (?,?,?,?,?,?,?)').run(pool.networkId,pool.poolAddress,t-1000,t+90000,'999','999','synthetic');
 expect(replaySaved(db,loaded,poolId,t+60000)).toEqual(before);
 expect(before.steps).toBeGreaterThan(0);expect(before.samples.every(s=>s.maxKnownAt===null||s.maxKnownAt<=s.at)).toBe(true);
 expect(new SignalRepository(db).list(poolId)).toEqual([]);
 }finally{db.close();}
});
