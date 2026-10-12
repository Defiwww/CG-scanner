import {v1Rules} from '@volumechecker/shared';
import { summarizeSellers } from './wallets';
import Decimal from 'decimal.js';
import type { AnalysisInput, AnalysisObservation, AppConfig, CoverageRange, Measurement, MetricsSnapshot, MetricWindow, Readiness } from '@volumechecker/shared';
const D = (x: Decimal.Value) => new Decimal(x);
const sum = (xs: string[]) => xs.reduce((a,b)=>a.plus(b),D(0));
export function quantile(xs: string[], q: number): string | null {
  if (!xs.length) return null;
  const s=xs.map(D).sort((a,b)=>a.cmp(b)), h=D(s.length-1).mul(q), i=h.floor().toNumber();
  return s[i]!.plus((s[i+1]??s[i]!).minus(s[i]!).mul(h.minus(i))).toString();
}
export function coverage(from:number,to:number,ranges:CoverageRange[]): {readiness:Readiness;seconds:number} {
  let cursor=from,total=0,gap=false;
  for(const r of [...ranges].sort((a,b)=>a.from-b.from)) {
    if(r.to<=cursor || r.from>=to) continue;
    if(r.from>cursor) gap=true;
    const end=Math.min(to,r.to);total+=Math.max(0,end-Math.max(cursor,r.from));cursor=Math.max(cursor,end);
  }
  const first=Math.min(...ranges.map(r=>r.from));
  return {readiness:total>=to-from?'ready':first>from?'insufficient_history':gap||cursor<to?'gap':'insufficient_history',seconds:total/1000};
}
export function calculateMetrics(input:AnalysisInput, config:AppConfig, poolId:string, asOf:number, knownAt:number, frozenThreshold?:MetricsSnapshot['threshold']): MetricsSnapshot {
  // Replay has its own knowledge clock. Never include a revision received after that clock.
  const trades=input.trades.filter(t=>t.eventMs<=asOf&&t.knownMs<=knownAt);
  const observations=input.observations.filter(o=>o.at<=asOf&&o.knownMs<=knownAt);
  const candles=input.candles.filter(c=>c.openMs+60000<=asOf&&c.knownMs>=c.openMs+60000&&c.knownMs<=knownAt);
  const ranges=input.coverage.filter(r=>r.knownMs<=knownAt);
  const minute=Math.floor(asOf/60000)*60000;
  const lookEnd=minute-config.scoring.currentWindowMinutes*60000,lookStart=lookEnd-config.scoring.largeTrade.lookbackMinutes*60000;
  const look=trades.filter(t=>t.eventMs>lookStart&&t.eventMs<=lookEnd&&t.usd!==null);
  const fallback=look.length<config.scoring.largeTrade.minBaselineTrades||coverage(lookStart,lookEnd,ranges).readiness!=='ready';
  const threshold=frozenThreshold?.frozenAt===minute?frozenThreshold:{value:Decimal.max(config.scoring.largeTrade.minimumUsd,fallback?0:quantile(look.map(t=>t.usd!),config.scoring.largeTrade.quantile)!).toString(),from:lookStart,to:lookEnd,observations:look.length,readiness:'ready' as const,reason:fallback?'Fallback: insufficient covered large-trade baseline':'P90, type-7 interpolation; excludes current window',fallback,frozenAt:minute};
  const priceObs:AnalysisObservation[]=[...observations,...trades.filter(t=>t.price!==null).map(t=>({at:t.eventMs,knownMs:t.knownMs,price:t.price,reserve:null,source:'rest-trade'})),...candles.filter(c=>c.volume!==null&&D(c.volume).gt(0)).map(c=>({at:c.openMs+60000,knownMs:c.knownMs,price:c.close,reserve:null,source:c.source}))];
  function change(field:'price'|'reserve', from:number,to:number):Measurement {
    const age=(field==='price'?config.freshness.maxPriceAgeSec:config.freshness.maxReserveAgeSec)*1000;
    const source=(field==='price'?priceObs:observations).filter(o=>o[field]!==null);
    const at=(t:number)=>source.filter(o=>o.at<=t&&t-o.at<=age).sort((a,b)=>b.at-a.at)[0];
    const a=at(from),b=at(to),ok=a&&b&&D(a[field]!).gt(0);
    return {value:ok?D(b[field]!).div(a[field]!).minus(1).mul(100).toString():null,from,to,observations:Number(!!a)+Number(!!b),readiness:ok?'ready':'unavailable',reason:ok?`${a.source} @ ${new Date(a.at).toISOString()} → ${b.source} @ ${new Date(b.at).toISOString()}`:'No sufficiently fresh observations at both boundaries; no carry-forward'};
  }
  function window(from:number,to:number):MetricWindow {
    const ts=trades.filter(t=>t.eventMs>from&&t.eventMs<=to),buys=ts.filter(t=>t.side==='buy'),sells=ts.filter(t=>t.side==='sell');
    const cov=coverage(from,to,ranges),invalid=ts.some(t=>t.usd===null||!t.side||(t.usd!==null&&(!D(t.usd).isFinite()||D(t.usd).lt(0))));
    const status:Readiness=cov.readiness!=='ready'?cov.readiness:invalid?'unavailable':ts.length?'ready':'no_trades';
    const B=sum(buys.flatMap(t=>t.usd===null?[]:[t.usd])),S=sum(sells.flatMap(t=>t.usd===null?[]:[t.usd])),total=B.plus(S),minutes=(to-from)/60000;
    const metrics:Record<string,Measurement>={};
    const add=(name:string,value:Decimal.Value|null,n=ts.length,reason='Canonical REST events; event-time window')=>{
      const usable=status==='ready'||status==='no_trades';metrics[name]={value:usable&&value!==null?D(value).toString():null,from,to,observations:n,readiness:!usable?status:value===null?'unavailable':status,reason:!usable?`${status}; observed ${ts.length} trades without extrapolation`:reason};
    };
    add('buyCount',buys.length,buys.length);add('sellCount',sells.length,sells.length);add('buyUsd',B,buys.length);add('sellUsd',S,sells.length);add('netFlow',B.minus(S));
    add('imbalance',total.gt(0)?B.minus(S).div(total):null);add('sellShare',total.gt(0)?S.div(total):null);
    add('buyRate',B.div(minutes),buys.length);add('sellRate',S.div(minutes),sells.length);
    add('medianBuy',quantile(buys.flatMap(t=>t.usd===null?[]:[t.usd]),0.5),buys.length);add('medianSell',quantile(sells.flatMap(t=>t.usd===null?[]:[t.usd]),0.5),sells.length);
    add('largeSellShare',S.gt(0)?sum(sells.filter(t=>t.usd!==null&&D(t.usd).gte(threshold.value!)).map(t=>t.usd!)).div(S):null,sells.length,'No sells → undefined share (strict formula; proposal to treat as zero not approved)');
    metrics.priceChange=change('price',from,to);metrics.reserveChange=change('reserve',from,to);
    const price=priceObs.filter(o=>o.price!==null&&o.at<=to&&to-o.at<=config.freshness.maxPriceAgeSec*1000).sort((a,b)=>b.at-a.at)[0];
    metrics.currentPrice={value:price?.price??null,from:price?.at??to,to,observations:price?1:0,readiness:price?'ready':'unavailable',reason:price?`${price.source} @ ${new Date(price.at).toISOString()}`:'No fresh observed price'};
    const senders=ts.filter(t=>t.sender);add('uniqueSenders',new Set(senders.map(t=>t.sender)).size,senders.length);add('senderCoverage',ts.length?D(senders.length).div(ts.length).mul(100):null,senders.length);
    const cs=candles.filter(c=>c.openMs>=from&&c.openMs+60000<=to&&c.volume!==null&&D(c.volume).gt(0)).sort((a,b)=>a.openMs-b.openMs);
    const returns=cs.slice(1).flatMap((c,i)=>c.openMs-cs[i]!.openMs===60000&&D(c.close).gt(0)&&D(cs[i]!.close).gt(0)?[D(c.close).div(cs[i]!.close).ln()]:[]);
    const mean=returns.length?returns.reduce((a,b)=>a.plus(b),D(0)).div(returns.length):null;
    add('volatility',cs.length>=config.metrics.volatilityMinClosedCandles&&returns.length===cs.length-1&&mean?returns.reduce((a,b)=>a.plus(b.minus(mean).pow(2)),D(0)).div(returns.length).sqrt():null,cs.length,'Population stddev of contiguous real minute log returns, no annualization');
    return {minutes,from,to,readiness:status,coveredSeconds:cov.seconds,metrics,tradeIds:ts.map(t=>t.id),sellIds:sells.map(t=>t.id)};
  }
  const windows=config.metrics.windowsMinutes.map(w=>window(asOf-w*60000,asOf));
  const current=window(asOf-config.scoring.currentWindowMinutes*60000,asOf),baseline=window(current.from-config.scoring.baselineWindowMinutes*60000,current.from);
  const compare=(name:string,a:string,b:string,fn:(a:Decimal,b:Decimal)=>Decimal|null):Measurement=>{
    const x=current.metrics[a]!,y=baseline.metrics[b]!;const v=x.value!==null&&y.value!==null?fn(D(x.value),D(y.value)):null;
    return {value:v?.toString()??null,from:baseline.from,to:asOf,observations:x.observations+y.observations,readiness:v===null?'unavailable':'ready',reason:name};
  };
  const comparisons={deterioration:compare('Baseline imbalance − current imbalance','imbalance','imbalance',(a,b)=>b.minus(a)),sellRateRatio:compare('Current sell USD/min / baseline sell USD/min; zero baseline is undefined','sellRate','sellRate',(a,b)=>b.gt(0)?a.div(b):null),buyerSizeDecline:compare('1 − current median buy / baseline median buy','medianBuy','medianBuy',(a,b)=>b.gt(0)?D(1).minus(a.div(b)):null)};
  const chart=[];
  for(let at=minute-59*60000;at<=minute;at+=60000){const end=Math.min(at+60000,asOf),w=window(at,end>at?end:at+1);const c=candles.filter(c=>c.openMs===at).sort((a,b)=>b.knownMs-a.knownMs)[0];chart.push({at,price:c&&c.volume!==null&&D(c.volume).gt(0)?c.close:null,buy:w.metrics.buyUsd!.value,sell:w.metrics.sellUsd!.value,covered:w.readiness==='ready'||w.readiness==='no_trades'});}
  return {sellers:summarizeSellers(trades.filter(t=>t.eventMs>current.from),threshold.value!,v1Rules(config).sellers),algorithm:cAlgorithm(config),poolId,asOf,computedAt:knownAt,status:current.readiness!=='ready'?current.readiness:baseline.readiness,windows,baseline,threshold,comparisons,chart};
}

function cAlgorithm(c:AppConfig):string {return c.scoring.algorithm==='distribution-v1'?'distribution-v1':'metrics-v1-strict-zero-sells';}
