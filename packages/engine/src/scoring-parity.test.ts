import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {appConfigSchema,v1Rules} from '@volumechecker/shared';
import {calculateMetrics,calculateRisk,advanceEpisode,emptyEpisode,summarizeSellers} from './index';
import {distributionRisk as originalRisk} from './test-fixtures/scoring-v1-reference';
import {advanceEpisode as originalEpisode} from './test-fixtures/signals-reference';
import {syntheticInput} from '../../../apps/server/src/synthetic';
const c=appConfigSchema.parse(JSON.parse(readFileSync(new URL('../../../config/default.json',import.meta.url),'utf8')));
const now=Date.UTC(2026,9,6,12);
const fixture=()=>calculateMetrics(syntheticInput(now),c,'test',now,now);
it('matches the frozen reference v1 across exact boundaries, missing inputs, samples and freshness',()=>{
 const boundaries={share:[.55,.65,.75,.85],ratio:[1.2,1.5,2,3],seller:[.25,.4,.55,.7],decline:[.15,.3,.5],price:[-.1,.1],imbalance:[0,.1]};
 const base=fixture();
 for(const [key,edges] of Object.entries(boundaries))for(const value of [null,...edges.flatMap(x=>[x-1e-8,x,x+1e-8])])for(const healthy of [true,false]){
  const m=structuredClone(base),w=m.windows.find(x=>x.minutes===5)!;
  const val=value===null?null:String(value);
  if(key==='share')w.metrics.sellShare!.value=val;
  if(key==='ratio')m.comparisons.sellRateRatio!.value=val;
  if(key==='seller')m.sellers!.riskShare=val;
  if(key==='decline')m.comparisons.buyerSizeDecline!.value=val;
  if(key==='price')w.metrics.priceChange!.value=val;
  if(key==='imbalance')m.comparisons.deterioration!.value=val;
  expect(calculateRisk(m,c,healthy)).toEqual(originalRisk(m,c,healthy));
 }
 for(const count of ['0','4','5','19','20']){const m=fixture();m.baseline.metrics.buyCount!.value=count;m.baseline.metrics.sellCount!.value=count;expect(calculateRisk(m,c,true)).toEqual(originalRisk(m,c,true));}
 // Cross-component branches, rather than only isolated thresholds.
 for(const price of [-.1,0,.1,.2])for(const share of [.54,.55,.64,.65,.75,.86])for(const ratio of [1.19,1.2,1.5,2,3.01]){
  const m=fixture(),w=m.windows.find(x=>x.minutes===5)!;w.metrics.priceChange!.value=String(price);w.metrics.sellShare!.value=String(share);m.comparisons.sellRateRatio!.value=String(ratio);expect(calculateRisk(m,c,true)).toEqual(originalRisk(m,c,true));
 }
});
it('preserves complete confirmation state sequences including repeats, gaps, degradation, fast path and cooldown',()=>{
 for(const score of [69,70,84,85,100]){
  let actual=emptyEpisode(),expected=emptyEpisode();const m=fixture();
  for(const [offset,newTrade,healthy,allowed] of [[0,false,true,true],[5000,false,true,true],[60000,true,true,true],[65000,false,false,true],[125000,true,true,true],[130000,true,true,false],[1400000,true,true,true],[1405000,false,true,true]] as const){
   m.asOf=now+offset;if(newTrade)m.windows.find(x=>x.minutes===5)!.tradeIds.push(`new-${offset}`);
   const r={...calculateRisk(m,c,healthy),score};
   const a=advanceEpisode(actual,m,r,[],c,now+offset,allowed),e=originalEpisode(expected,m,r,[],c,now+offset,allowed);expect(a).toEqual(e);actual=a.state;expected=e.state;
  }
 }
});
it('uses configured thresholds and rejects unordered/out-of-range rules',()=>{
 const changed=structuredClone(c);changed.scoring.v1!.flowDeterioration[0]!.threshold=1.3;
 const m=fixture();m.comparisons.sellRateRatio!.value='1.25';expect(calculateRisk(m,changed,true).components[1]!.contribution).toBe('0');expect(calculateRisk(m,c,true).components[1]!.contribution).toBe('5');
 changed.scoring.v1!.flowDeterioration[0]!.threshold=4;expect(appConfigSchema.safeParse(changed).success).toBe(false);
 const invalid=structuredClone(c);invalid.scoring.v1!.sellDominance.abovePoints=101;expect(appConfigSchema.safeParse(invalid).success).toBe(false);
 const slower=structuredClone(c);slower.scoring.v1!.confirmation.fastScore=100;
 const qualified=fixture(),risk={...calculateRisk(qualified,c,true),score:90};
 expect(advanceEpisode(emptyEpisode(),qualified,risk,[],c,now,true).action).toBe('fire');
 expect(advanceEpisode(emptyEpisode(),qualified,risk,[],slower,now,true).action).toBeNull();
 const sample=[1,2].map(i=>({id:String(i),side:'sell' as const,usd:'1',eventMs:i,knownMs:i,price:'1',sender:'sender'}));
 expect(summarizeSellers(sample,'10000',v1Rules(c).sellers).riskShare).toBe('1');
 expect(summarizeSellers(sample,'10000',{...v1Rules(c).sellers,repeatedSellCount:3}).riskShare).toBe('0');
 const historical=structuredClone(c);delete historical.scoring.v1;expect(calculateRisk(m,historical,true)).toEqual(calculateRisk(m,c,true));
 const sellers=v1Rules(c).sellers;expect(summarizeSellers([], '10000',{...sellers,repeatedSellCount:3}).repeatedSellCount).toBe(3);
});
