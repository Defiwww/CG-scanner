import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { appConfigSchema, type AnalysisInput, type AnalysisTrade } from '@volumechecker/shared';
import { calculateMetrics, quantile } from './metrics';
const config=appConfigSchema.parse(JSON.parse(readFileSync(new URL('../../../config/legacy-v0.json',import.meta.url),'utf8')));
const t=120*60000;
function trade(id:string,minutes:number,side:'buy'|'sell',usd:string):AnalysisTrade{return {id,eventMs:t-minutes*60000,knownMs:t-100,side,usd,price:'10',sender:'sender'};}
function input():AnalysisInput{return {trades:[trade('excluded',15,'sell','9999'),trade('baseline',5,'buy','100'),trade('baseline2',10,'sell','200'),trade('a',4,'buy','10'),trade('b',3,'buy','20'),trade('c',2,'buy','90'),trade('d',1,'sell','240')],coverage:[{from:0,to:t,knownMs:t}],candles:[],observations:[{at:t-300000,knownMs:t-300000,price:'10',reserve:'10000',source:'fixture'},{at:t,knownMs:t,price:'11',reserve:'9900',source:'fixture'}]};}
describe('event-time canonical metrics',()=>{
 it('uses exclusive start/inclusive end, true median, USD/min baseline and decimal formulas',()=>{
 const s=calculateMetrics(input(),config,'fixture',t,t),w=s.windows.find(w=>w.minutes===5)!;
 expect(w.metrics.buyUsd!.value).toBe('120');expect(w.metrics.medianBuy!.value).toBe('20');expect(w.metrics.sellUsd!.value).toBe('240');expect(w.metrics.sellRate!.value).toBe('48');expect(s.baseline.tradeIds).toEqual(['baseline','baseline2']);expect(s.baseline.metrics.sellRate!.value).toBe('20');expect(s.comparisons.sellRateRatio!.value).toBe('2.4');expect(w.metrics.priceChange!.value).toBe('10');expect(w.metrics.reserveChange!.value).toBe('-1');expect(s.threshold.fallback).toBe(true);
 });
 it('excludes future knowledge and event times; live late data recomputes windows',()=>{const data=input();data.trades.push({...trade('late',2,'sell','60'),knownMs:t+1000},trade('future',-1,'sell','999'));const before=calculateMetrics(data,config,'fixture',t,t),after=calculateMetrics(data,config,'fixture',t,t+1000);expect(before.windows[1]!.metrics.sellUsd!.value).toBe('240');expect(after.windows[1]!.metrics.sellUsd!.value).toBe('300');});
 it('distinguishes no trades, missing history and gaps; never invents ratios or zero-sell share',()=>{const data=input();data.trades=[];expect(calculateMetrics(data,config,'fixture',t,t).windows[1]!.metrics.buyUsd!.value).toBe('0');expect(calculateMetrics(data,config,'fixture',t,t).windows[1]!.metrics.imbalance!.value).toBeNull();data.coverage=[{from:t-60000,to:t,knownMs:t}];const s=calculateMetrics(data,config,'fixture',t,t);expect(s.windows[1]!.readiness).toBe('insufficient_history');expect(s.windows[1]!.metrics.buyUsd!.value).toBeNull();data.coverage=[{from:0,to:t-120000,knownMs:t},{from:t-60000,to:t,knownMs:t}];expect(calculateMetrics(data,config,'fixture',t,t).windows[1]!.readiness).toBe('gap');});
 it('type-7 quantiles and frozen minute thresholds are stable',()=>{expect(quantile(['1','2','3','100'],0.5)).toBe('2.5');const a=calculateMetrics(input(),config,'fixture',t,t);const threshold={...a.threshold,value:'12345'};expect(calculateMetrics(input(),config,'fixture',t+1000,t+1000,threshold).threshold.value).toBe('12345');});
});
