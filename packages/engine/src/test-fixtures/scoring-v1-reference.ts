/** Frozen reference implementation for behavioral parity tests only. Not used at runtime. */
import Decimal from 'decimal.js';
import type {AppConfig,MetricsSnapshot,RiskSnapshot,ScoreComponent} from '@volumechecker/shared';
const d=(v:Decimal.Value)=>new Decimal(v);
export function sellPoints(x:number):number {
 if(x<.55)return 0;if(x>.85)return 25;
 const ranges=[[.55,.65,5,10],[.65,.75,10,18],[.75,.85,18,23]];
 const [a,b,lo,hi]=ranges.find(([,b])=>x<=b!)!;
 return d(x).minus(a!).div(d(b!).minus(a!)).mul(hi!-lo!).plus(lo!).toNumber();
}
export function distributionRisk(m:MetricsSnapshot,c:AppConfig,healthy:boolean):RiskSnapshot {
 const w=m.windows.find(x=>x.minutes===5)!,base=m.baseline;
 const val=(k:string)=>w.metrics[k]?.value??null,bval=(k:string)=>base.metrics[k]?.value??null;
 const num=(v:string|null)=>v===null?null:Number(v);
 const coverage=[w,base].every(x=>x.readiness==='ready'||x.readiness==='no_trades');
 const baselineSells=num(bval('sellCount'))??0,currentSells=num(val('sellCount'))??0;
 const ratio=baselineSells>=c.alerts.minSellsCurrent&&currentSells>=c.alerts.minSellsCurrent?num(m.comparisons.sellRateRatio?.value??null):null;
 const decline=(num(val('buyCount'))??0)>=c.alerts.minBuysEachWindow&&(num(bval('buyCount'))??0)>=c.alerts.minBuysEachWindow?num(m.comparisons.buyerSizeDecline?.value??null):null;
 const share=num(val('sellShare')),price=num(val('priceChange')),imbalance=num(m.comparisons.deterioration?.value??null);
 const seller=num(m.sellers?.riskShare??val('largeSellShare'));
 let divergence:number|null=null;
 if(price!==null&&share!==null&&ratio!==null&&imbalance!==null){
  divergence=0;
  if(price>=-.1&&share>=.55&&ratio>=1.2&&imbalance>0){
   divergence=share<.65?5:15;
   if(Math.abs(price)<=.1)divergence=share<.65?10:ratio>=1.5?20:15;
   if(price>.1&&share>=.75&&ratio>=2&&imbalance>=.1)divergence=25;
  }
 }
 const components:ScoreComponent[]=[];
 const add=(name:string,input:number|null,points:number|null,weight:number,reason:string)=>components.push({name,input:input===null?null:String(input),severity:points===null?null:d(points).div(weight).toString(),contribution:points===null?'0':d(points).toString(),weight,reason:points===null?'Unavailable: covered, meaningful comparison or sufficient observations missing. '+reason:reason});
 add('Sell dominance',share,share===null?null:sellPoints(share),25,'Share of sell USD in current 5m flow. Cannot confirm an alert alone.');
 add('Flow deterioration',ratio,ratio===null?null:ratio>3?20:ratio>=2?15:ratio>=1.5?10:ratio>=1.2?5:0,20,'Selling USD/min versus preceding 10m; requires at least 5 sells in each window and a nonzero baseline.');
 add('Price-flow divergence',price,divergence,25,'Price holds within −0.1% or rises while selling dominates and pressure/imbalance deteriorate. Falling price alone adds no divergence points.');
 add('Seller concentration',seller,seller===null?null:seller>.7?20:seller>=.55?15:seller>=.4?10:seller>=.25?5:0,20,`${m.sellers?.basis??'trade-based'}: ${m.sellers?.reason??'Large-trade share fallback; wallet evidence unavailable.'}`);
 add('Buyer deterioration',decline,decline===null?null:decline>.5?10:decline>=.3?6:decline>=.15?3:0,10,'Change in median buy size, with at least five buys in both windows.');
 const available=components.filter(x=>x.severity!==null).reduce((s,x)=>s+x.weight,0);
 const score=coverage&&available>0?components.reduce((s,x)=>s.plus(x.contribution),d(0)).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber():null;
 const gates:RiskSnapshot['gates']=[];
 const gate=(name:string,pass:boolean,actual:unknown,required:unknown)=>gates.push({name,pass,actual:String(actual??'unavailable'),required:String(required)});
 gate('Coverage',coverage,m.status,'full current 5m and preceding 10m');
 gate('Collection quality',healthy,healthy?'fresh':'stale / degraded','fresh WS trades, transport, canonical REST, price and verified pool');
 for(const [name,value,min] of [ ['Current trades',(num(val('buyCount'))??0)+currentSells,c.alerts.minTradesCurrent],['Baseline trades',(num(bval('buyCount'))??0)+baselineSells,c.alerts.minTradesBaseline],['Current buys',num(val('buyCount'))??0,c.alerts.minBuysEachWindow],['Baseline buys',num(bval('buyCount'))??0,c.alerts.minBuysEachWindow],['Current sells',currentSells,c.alerts.minSellsCurrent]] as const)gate(name,value>=min,value,`≥ ${min}`);
 gate('All components available',available===100,available,'100/100; no reweighting');
 gate('Price-flow divergence',(divergence??0)>0,divergence,'> 0');
 const active=components.filter(x=>Number(x.contribution)>0).length;
 gate('Independent component categories',active>=2,active,'≥ 2 distinct risk components including divergence');
 gate('Score',score!==null&&score>=70,score,'≥ 70');
 const samples=gates.filter(g=>['Current trades','Baseline trades','Current buys','Baseline buys','Current sells'].includes(g.name)).every(g=>g.pass);
 const provisional=!coverage||!healthy||!samples||available<100;
 const state=provisional?'Insufficient data':score===null?'Insufficient data':score>=85?'High-Risk Distribution':score>=70?'Distribution Confirmed':score>=50?'Distribution Watch':score>=30?'Caution':'Normal';
 const f=(x:number|null,suffix='')=>x===null?'not available':`${d(x).toFixed(1)}${suffix}`;
 const explanation=`Price ${f(price,'%')} over 5 minutes. ${ratio===null?'Selling pressure cannot yet be compared reliably.':`Selling pressure is ${f(Math.abs(ratio-1)*100,'%')} ${ratio>=1?'higher than':'lower than'} the previous 10-minute baseline (${f(ratio,'×')}).`} ${seller===null?'Seller concentration is not available.':`${f(seller*100,'%')} of sell volume comes from ${m.sellers?.basis==='wallet-based'?'large or repeated senders':'large individual trades (wallet fallback)'}.`} ${decline===null?'Buyer-size comparison needs more observations.':`Median buy size has ${decline>=0?'fallen':'increased'} ${f(Math.abs(decline)*100,'%')}.`} ${provisional?'Provisional: quality or sample requirements are not met.':'Score band only; a confirmed alert also needs the confirmation rules.'}`;
 return {score,state,provisional,activeMaxWeight:available,components,gates,explanation,asOf:m.asOf};
}
