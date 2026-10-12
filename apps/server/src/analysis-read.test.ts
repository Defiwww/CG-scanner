import {it,expect,vi} from 'vitest';
import {openDatabase,runMigrations,M2Collector} from '@volumechecker/storage';
import {mapRestTrade} from '@volumechecker/coingecko';
import {ALLOWED_POOLS,type InspectionSnapshot} from '@volumechecker/shared';
import {AnalysisService} from './analysis';
import {loadAppConfig} from './config';
import {buildApp} from './app';
import {syntheticInput} from './synthetic';
import {restTrade} from '../../../tests/fixtures/synthetic/coingecko';
const loaded=loadAppConfig(new URL('../../../config/default.json',import.meta.url).pathname);
it('background ticks advance snapshots/signals without readers; reads perform zero SQL and never alter confirmation',async()=>{
 const app=await buildApp({loaded,apiKey:undefined,logLevel:'silent'});
 const s=(await app.inject('/api/inspection')).json<InspectionSnapshot>();await app.close();
 const pool=ALLOWED_POOLS[0]!,id=`${pool.networkId}:${pool.poolAddress}`,now=Date.UTC(2026,9,6,12)+10000;
 const db=openDatabase(':memory:');runMigrations(db);
 try{
  const collector=new M2Collector({db,sessionId:'read-test',configHash:loaded.hash,selectedPoolId:id,now:()=>now});collector.start();
  const input=syntheticInput(now-10000);
  collector.restBatch({kind:'rest_trade',endpointOrChannel:'test',receivedAt:new Date(now).toISOString(),rawText:'{}',mapped:null},input.trades.map(t=>({...mapRestTrade(restTrade({side:t.side??'buy'}),new Date(t.knownMs).toISOString()).trade,providerTradeId:t.id,side:t.side,volumeUsd:t.usd,trackedPriceUsd:t.price,senderAddress:t.sender,blockTimestamp:new Date(t.eventMs).toISOString()})));
  for(const coverage of input.coverage)collector.coverage(coverage.from,now,true,'synthetic covered window');
  for(const o of input.observations)collector.poolObservation(o.at,o.price,o.reserve);
  Object.assign(s,{activePoolId:id,monitor:'running',connectedSince:new Date(now-900000).toISOString()});s.orientation.status='verified';s.persistence.state='ok';s.indicators.transport.state='ok';s.indicators.tradeInactivity={state:'ok',ageSec:0,lastAt:new Date(now).toISOString(),detail:'test live trade'};
  const service=new AnalysisService(db,loaded,()=>s);service.tick(now);
  const first=service.read(id);expect(first.metrics?.asOf).toBe(now);expect(first.signals).toHaveLength(1);
  const before=db.prepare('SELECT total_changes() n').get();const sql=vi.spyOn(db,'prepare');
  for(let i=0;i<100;i++){const read=service.read(id);expect(read).toEqual(first);read.status='client mutation';}
  expect(sql).not.toHaveBeenCalled();sql.mockRestore();expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
  service.tick(now+5000);expect(service.read(id).metrics!.computedAt).toBe(now+5000);expect(service.read(id).signals).toHaveLength(1);
  service.tick(now+100000);expect(service.read(id).status).toContain('Stale');expect(service.read(id).risk!.provisional).toBe(true);
  s.activePoolId=null;s.monitor='idle';service.refreshAll(now+105000);expect(service.read(id).stream!.state).toBe('DISCONNECTED');
  const restarted=new AnalysisService(db,loaded,()=>s);restarted.refreshAll(now+110000);expect(restarted.read(id).metrics!.asOf).toBe(now);expect(restarted.read(id).signals).toHaveLength(1);
 }finally{db.close();}
});
it('analysis HTTP GET uses the snapshot reader, never the calculation path',async()=>{
 const app=await buildApp({loaded,apiKey:undefined,logLevel:'silent'});
 const refresh=vi.spyOn(AnalysisService.prototype,'refresh');
 try{for(let i=0;i<20;i++)expect((await app.inject('/api/analysis')).statusCode).toBe(200);expect(refresh).not.toHaveBeenCalled();}finally{refresh.mockRestore();await app.close();}
});
