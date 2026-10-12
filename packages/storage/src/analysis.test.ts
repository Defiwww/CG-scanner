import {it,expect} from 'vitest';
import {openDatabase,runMigrations,M2Collector,AnalysisRepository} from './index';
import {ALLOWED_POOLS} from '@volumechecker/shared';
import {mapRestTrade} from '../../coingecko/src/mapping';
import {restTrade} from '../../../tests/fixtures/synthetic/coingecko';
it('updates canonical corrections without another swap; replay sees only revisions known at its clock',()=>{
 const db=openDatabase(':memory:');try{runMigrations(db);const p=ALLOWED_POOLS[0]!,id=`${p.networkId}:${p.poolAddress}`;
 const c=new M2Collector({db,sessionId:'test',selectedPoolId:id,configHash:'test'});c.start();
 const t=mapRestTrade(restTrade({side:'buy',id:'opaque'}),'2026-10-05T10:00:00Z').trade;
 const sample={kind:'rest_trade' as const,endpointOrChannel:'synthetic',receivedAt:t.receivedAt,rawText:'{}',mapped:null};
 c.restBatch(sample,[t,t]);c.restBatch(sample,[{...t,volumeUsd:'99',receivedAt:'2026-10-05T10:01:00Z'}]);
 expect(c.summary().canonicalTrades).toBe(1);
 const repo=new AnalysisRepository(db);expect(repo.input(p,0,Date.parse('2026-10-05T10:00:30Z')).trades[0]?.usd).toBe('1500.0');expect(repo.input(p,0,Date.parse('2026-10-05T10:02:00Z')).trades[0]?.usd).toBe('99');expect(repo.input(ALLOWED_POOLS[1]!,0,Date.now()).trades).toEqual([]);
 }finally{db.close();}
});
