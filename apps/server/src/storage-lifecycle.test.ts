import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ALLOWED_POOLS, type InspectionSnapshot, type PoolConfig } from '@volumechecker/shared';
import { M2Collector, openDatabase, runMigrations, type SqliteDatabase } from '@volumechecker/storage';
import { mapRestTrade, verifyOrientation, type FetchLike } from '@volumechecker/coingecko';
import { sameSwap } from '@volumechecker/engine';
import { buildApp, ACTION_HEADER } from './app';
import { loadAppConfig } from './config';
import { FakeSocket, handshake } from '../../../tests/helpers/fake-socket';
import { poolMetadata, restTrade, tradesResponse, ohlcvResponse, g2Frame } from '../../../tests/fixtures/synthetic/coingecko';
const loaded = loadAppConfig(new URL('../../../config/legacy-v0.json',import.meta.url).pathname);
const eth=ALLOWED_POOLS[0]!, base=ALLOWED_POOLS[1]!;
const id=(p:PoolConfig)=>`${p.networkId}:${p.poolAddress}`;
const headers = {[ACTION_HEADER]:'1'};
const apps:FastifyInstance[]=[];const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(apps.splice(0).map(a=>a.close()));for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const snapshot=async(a:FastifyInstance)=>(await a.inject('/api/inspection')).json<InspectionSnapshot>();
async function waitFor(a:FastifyInstance,pred:(s:InspectionSnapshot)=>boolean){for(let n=0;n<100;n++){const s=await snapshot(a);if(pred(s))return s;await new Promise(r=>setTimeout(r,5));}throw Error('state timeout');}
function provider(){
 const calls:string[]=[]; const sockets:FakeSocket[]=[];
 let tradeBody = tradesResponse();
 let gate:Promise<void>|null=null;let release=()=>{};
 const fetchImpl:FetchLike=async(url,init)=>{
   calls.push(url.toString());
   if(gate) await Promise.race([gate,new Promise((_,reject)=>init.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))]);
   const p=url.pathname.includes('/base/')?base:eth;
   const convert=(v:unknown)=>JSON.parse(JSON.stringify(v).replaceAll(eth.poolAddress,p.poolAddress).replaceAll(eth.baseAddress,p.baseAddress).replaceAll(eth.quoteAddress,p.quoteAddress).replaceAll('eth_',`${p.networkId}_`));
   return new Response(JSON.stringify(convert(url.pathname.endsWith('/trades')?tradeBody:url.pathname.endsWith('/minute')?ohlcvResponse():poolMetadata())));
 };
 return {setTrades:(value:ReturnType<typeof tradesResponse>)=>{tradeBody=value;},calls,sockets,fetchImpl,socketFactory:(url:string,h:Record<string,string>)=>{const s=new FakeSocket(url,h);sockets.push(s);return s;},block:()=>{gate=new Promise<void>(r=>{release=r;});},release:()=>{release();gate=null;}};
}
async function app(p=provider(),databasePath?:string, appLoaded=loaded){const a=await buildApp({loaded:appLoaded,apiKey:'DUMMY-ONLY-STORAGE',logLevel:'silent',...p,...(databasePath?{databasePath}:{})});apps.push(a);return a;}
const start=(a:FastifyInstance,p:PoolConfig)=>(a.inject({method:'POST',url:'/api/inspection/start',headers,payload:{poolId:id(p)}}));
const stop=(a:FastifyInstance)=>a.inject({method:'POST',url:'/api/inspection/stop',headers:{...headers,'content-type':'application/json'},payload:{}});

describe('explicit selection and lifecycle',()=>{
 it('verifies Base token orientation against a labelled synthetic metadata fixture',()=>{
   const payload=JSON.parse(JSON.stringify(poolMetadata({poolAddress:base.poolAddress,base:base.baseAddress,quote:base.quoteAddress})).replaceAll('eth_', 'base_'));
   expect(verifyOrientation(payload,'2026-10-05T10:24:54Z',base)).toMatchObject({status:'verified',trackedTokenSide:'base',baseTokenAddress:'0x4200000000000000000000000000000000000006',quoteTokenAddress:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'});
 });
 it('requires an allowlisted pool and serializes tabs; Base reaches REST, both WS channels and storage',async()=>{
   const p=provider(),a=await app(p);
   expect((await a.inject({method:'POST',url:'/api/inspection/start',headers,payload:{poolId:'bad'}})).statusCode).toBe(400);
   expect((await a.inject({method:'POST',url:'/api/inspection/start',headers})).statusCode).toBe(400);
   const replies=await Promise.all([start(a,base),start(a,base)]);
   expect(replies.map(r=>r.statusCode)).toEqual([202,202]);
   let s=await waitFor(a,s=>s.monitor==='running');
   expect(p.sockets).toHaveLength(1);expect(p.calls.every(c=>c.includes('/base/'))).toBe(true);
   expect(s.pool.poolAddress).toBe(base.poolAddress);expect(s.orientation.status).toBe('verified');
   expect(s.trades[0]?.side).toBe('buy');expect(s.persistence.canonicalTrades).toBe(2);expect(s.newTrades).toBe(0);
   handshake(p.sockets[0]!);
   const commands=p.sockets[0]!.sent.map(x=>JSON.parse(x)).filter(x=>x.command==='message');
   expect(commands).toHaveLength(2);expect(commands.every(c=>c.data.includes(id(base)))).toBe(true);
   expect((await start(a,eth)).statusCode).toBe(409);
   await stop(a);expect(p.sockets[0]!.closed).toBe(true);
   const before=p.calls.length;
   p.sockets[0]!.emit('close',1006,Buffer.from(''));p.sockets[0]!.msg(g2Frame());
   expect(p.calls).toHaveLength(before);
   await start(a,eth);s=await waitFor(a,s=>s.monitor==='running');
   expect(s.pool.poolAddress).toBe(eth.poolAddress);expect(s.persistence.canonicalTrades).toBe(2);
   expect(s.priceObservations.every(x=>x.source==='rest-pool-metadata')).toBe(true);expect(p.sockets).toHaveLength(2);
 });
 it('awaits cancellation during startup; late old response cannot open a socket or change next pool',async()=>{
   const p=provider(),a=await app(p);p.block();await start(a,eth);await stop(a);p.release();
   expect((await snapshot(a)).monitor).toBe('idle');expect(p.sockets).toHaveLength(0);
   await start(a,base);expect((await waitFor(a,s=>s.monitor==='running')).pool.networkId).toBe('base');expect(p.sockets).toHaveLength(1);
 });
 it('counts only new REST-confirmed swaps after Connect, excluding history, WS replay and repeated REST pages',async()=>{
   let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
   const cfg={...loaded,config:{...loaded.config,polling:{...loaded.config.polling,reconciliationIntervalSec:0.02}}};
   const p=provider(),a=await app(p,undefined,cfg);await start(a,base);await waitFor(a,s=>s.monitor==='running');
   handshake(p.sockets[0]!);p.sockets[0]!.msg(g2Frame({n:'base',pa:base.poolAddress,t:now-10000}));
   expect((await snapshot(a)).newTrades).toBe(0);
   now+=3000;const t=restTrade({side:'buy',id:'new/opaque'});t.attributes.block_timestamp=new Date(now-1000).toISOString();
   p.setTrades(tradesResponse([t]));await waitFor(a,s=>s.newTrades===1);
   await new Promise(r=>setTimeout(r,70));const s=await snapshot(a);
   expect(s.newTrades).toBe(1);expect(s.lastNewTradeAt).toBe(t.attributes.block_timestamp);expect(s.persistence.canonicalTrades).toBe(3);
 });
 it('exposes an incomplete capped recovery and stops with a visible SQLite write failure',async()=>{
   const d=mkdtempSync(join(tmpdir(),'vc-failure-'));dirs.push(d);const path=join(d,'test.sqlite');
   const cfg={...loaded,config:{...loaded.config,backfill:{...loaded.config.backfill,maxPagesPerRun:1},polling:{...loaded.config.polling,reconciliationIntervalSec:0.02}}};
   const p=provider();const t=restTrade({side:'buy',id:'recent'});t.attributes.block_timestamp=new Date().toISOString();p.setTrades(tradesResponse([t],'more'));
   const a=await app(p,path,cfg);await start(a,base);const s=await waitFor(a,s=>s.monitor==='running');expect(s.recovery.complete).toBe(false);
   const db=openDatabase(path);db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON raw_events BEGIN SELECT RAISE(FAIL,'synthetic disk failure'); END;");
   try {const failed=await waitFor(a,s=>s.persistence.state==='error');expect(failed.connectionState).toBe('error');expect(failed.persistence.error).toContain('SQLite write failed');expect(p.sockets[0]!.closed).toBe(true);}
   finally {db.exec('DROP TRIGGER fail_write');db.close();}
 });
 it('preserves desired collection through server restart, but explicit Disconnect prevents restart',async()=>{
   const d=mkdtempSync(join(tmpdir(),'vc-m2-'));dirs.push(d);const path=join(d,'test.sqlite');
   const p=provider(),a=await app(p,path);await start(a,base);await waitFor(a,s=>s.monitor==='running');
   await a.close();apps.splice(apps.indexOf(a),1);
   const p2=provider(),b=await app(p2,path);const s=await waitFor(b,s=>s.monitor==='running');
   expect(s.activePoolId).toBe(id(base));expect(s.persistence.canonicalTrades).toBe(2);expect(s.newTrades).toBe(0);
   await stop(b);await b.close();apps.splice(apps.indexOf(b),1);
   const c=await app(provider(),path);expect((await snapshot(c)).activePoolId).toBeNull();
 });
});

describe('durable identity and upgrades',()=>{
 const memory=()=>{const db=openDatabase(':memory:');expect(runMigrations(db).failed).toEqual([]);return db;};
 function collector(db:SqliteDatabase,p:PoolConfig,session:string){const c=new M2Collector({db,sessionId:session,selectedPoolId:id(p),configHash:loaded.hash,matches:(w,r)=>sameSwap(w,r,loaded.config.reconciliation)});c.start();return c;}
 const sample={kind:'rest_trade' as const,endpointOrChannel:'synthetic',receivedAt:'2026-10-05T10:00:00Z',rawText:'{}',mapped:null};
 it('keeps opaque REST IDs and multiple identical swaps in one tx; never merges ambiguity or double counts WS',()=>{
   const db=memory();try{
    const c=collector(db,eth,'one');const t=mapRestTrade(restTrade({side:'buy',id:'opaque/id?one'}),sample.receivedAt).trade;
    expect(c.restBatch(sample,[t,t])).toHaveLength(1);
    const ws={...t,source:'ws' as const,providerTradeId:null,providerTimeMs:Date.parse(t.blockTimestamp!),blockTimestamp:null};
    c.ws({...sample,kind:'ws_trade'},ws);expect(c.summary()).toMatchObject({canonicalTrades:1,pendingWs:0,ambiguousWs:0});
    expect(c.ws({...sample,kind:'ws_trade'},ws)).toBe(false);
    c.restBatch(sample,[{...t,providerTradeId:'opaque/id?two'}]);
    expect(c.summary()).toMatchObject({canonicalTrades:2,ambiguousWs:1});
    expect((db.prepare('SELECT rest_trade_id FROM ws_observations').get() as {rest_trade_id:unknown}).rest_trade_id).toBeNull();
    const b=collector(db,base,'two');b.restBatch(sample,[t]);expect(b.summary().canonicalTrades).toBe(1);expect(c.summary().canonicalTrades).toBe(2);
   }finally{db.close();}
 });
 it('upgrades a populated original 001 even when placeholder 002 is already applied; preserves IDs, values and FKs',async()=>{
   const d=mkdtempSync(join(tmpdir(),'vc-upgrade-'));dirs.push(d);const path=join(d,'old.sqlite');const db=openDatabase(path);
   try{
    db.exec(readFileSync(new URL('../../../packages/storage/src/migrations/001-m2-durable-ingestion.sql',import.meta.url),'utf8'));
    db.exec("CREATE TABLE _migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at_sec INTEGER); INSERT INTO _migrations VALUES(1,'old',1),(2,'placeholder',2);");
    db.prepare('INSERT INTO sessions(id,started_at_sec,config_hash) VALUES (?,?,?)').run('old',1,'oldhash');
    db.prepare("INSERT INTO raw_events(id,session_id,kind,endpoint_or_channel,received_at_sec,raw_text) VALUES (7,'old','rest_trade','synthetic',1,'{}')").run();
    db.prepare("INSERT INTO trades(id,session_id,provider_trade_id,tx_hash,source,received_at_sec,link_amount,rest_raw_event_id) VALUES (9,'old','opaque','tx','rest',1,'123.456',7)").run();
    await db.backup(join(d,'before.bak'));
    expect(runMigrations(db)).toEqual({applied:7,failed:[]});
    expect(db.prepare('SELECT id,network_id,base_amount,rest_raw_event_id FROM trades').get()).toEqual({id:9,network_id:'eth',base_amount:'123.456',rest_raw_event_id:7});
    expect(db.pragma('foreign_key_check')).toEqual([]);expect(runMigrations(db).applied).toBe(0);
   }finally{db.close();}
 });
});

it('advances current REST coverage and analytics past a capped old gap without erasing that gap',async()=>{
 let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
 const dir=mkdtempSync(join(tmpdir(),'vc-gap-'));dirs.push(dir);const path=join(dir,'db.sqlite');
 const db=openDatabase(path);runMigrations(db);const old=now-86400000;
 db.prepare('INSERT INTO collection_state VALUES (?,?,?,?,?)').run(base.networkId,base.poolAddress,old,old-120000,'old gap');
 const cfg={...loaded,config:{...loaded.config,backfill:{...loaded.config.backfill,maxPagesPerRun:1},polling:{...loaded.config.polling,reconciliationIntervalSec:0.05,metricsRecomputeIntervalSec:0.01}}};
 const p=provider();const t=restTrade({side:'buy',id:'recent-history'});t.attributes.block_timestamp=new Date(now-1200000).toISOString();p.setTrades(tradesResponse([t],'more'));
 const a=await app(p,path,cfg);await start(a,base);await waitFor(a,s=>s.monitor==='running');
 const first=(await a.inject(`/api/analysis?poolId=${id(base)}`)).json();expect(first.metrics.asOf).toBe(now);expect(first.status).not.toContain('Stale');
 expect(first.latestObservedPrice.eventAt).toBeNull();
 expect((await snapshot(a)).indicators.priceFreshness.state).toBe('unknown');
 expect(db.prepare('SELECT incomplete_from_ms t FROM collection_state').get()).toMatchObject({t:old-120000});
 now+=60000;const fresh=restTrade({side:'sell',id:'new-confirmed'});fresh.attributes.block_timestamp=new Date(now-1000).toISOString();p.setTrades(tradesResponse([fresh,t],'more'));
 await waitFor(a,s=>s.newTrades===1);
 for(let i=0;i<100&&(await a.inject(`/api/analysis?poolId=${id(base)}`)).json().metrics?.asOf!==now;i++)await new Promise(r=>setTimeout(r,5));
 const second=(await a.inject(`/api/analysis?poolId=${id(base)}`)).json();expect(second.metrics.asOf).toBe(now);expect(second.metrics.windows.find((w:{minutes:number})=>w.minutes===5).metrics.sellCount.value).toBe('1');
 expect(second.latestConfirmedTradePrice.eventAt).toBe(now-1000);
 expect(db.prepare('SELECT incomplete_from_ms t FROM collection_state').get()).toMatchObject({t:old-120000});
 expect(db.prepare('SELECT count(*) n FROM trades').get()).toMatchObject({n:2});
 await stop(a);now+=200000;
 const stopped=(await a.inject(`/api/analysis?poolId=${id(base)}`)).json();
 expect(stopped.metrics.asOf).toBe(second.metrics.asOf);expect(stopped.status).toContain('Stale');
 expect(stopped.latestObservedPrice.observedAt).toBe(second.latestObservedPrice.observedAt);db.close();
});
