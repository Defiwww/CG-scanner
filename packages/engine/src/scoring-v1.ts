import {v1Rules,historicalV1Rules} from '@volumechecker/shared';
import Decimal from 'decimal.js';
import type {AppConfig,MetricsSnapshot,RiskSnapshot,ScoreComponent} from '@volumechecker/shared';
const d=(v:Decimal.Value)=>new Decimal(v);
export function sellPoints(x:number,r:ReturnType<typeof v1Rules>['sellDominance']=historicalV1Rules.sellDominance):number {
 if(x<r.segments[0]!.min)return r.belowPoints;if(x>r.segments.at(-1)!.max)return r.abovePoints;
 const {min,max,from,to}=r.segments.find(s=>x<=s.max)!;
 return d(x).minus(min).div(d(max).minus(min)).mul(to-from).plus(from).toNumber();
}
function stepPoints(x:number,steps:readonly {threshold:number;inclusive:boolean;points:number}[]):number {
 return [...steps].reverse().find(s=>s.inclusive?x>=s.threshold:x>s.threshold)?.points??0;
}
export function distributionRisk(m:MetricsSnapshot,c:AppConfig,healthy:boolean):RiskSnapshot {
 const rules=v1Rules(c),div=rules.divergence,weights=c.scoring.components;
 const w=m.windows.find(x=>x.minutes===c.scoring.currentWindowMinutes)!,base=m.baseline;
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
  if(price>=-div.flatPricePct&&share>=div.minSellShare&&ratio>=div.minSellRateRatio&&imbalance>div.minDeteriorationExclusive){
   divergence=share<div.strongSellShare?div.weakPoints:div.strongPoints;
   if(Math.abs(price)<=div.flatPricePct)divergence=share<div.strongSellShare?div.flatWeakPoints:ratio>=div.strongSellRateRatio?div.flatStrongPoints:div.strongPoints;
   if(price>div.flatPricePct&&share>=div.extremeSellShare&&ratio>=div.extremeSellRateRatio&&imbalance>=div.extremeDeterioration)divergence=div.extremePoints;
  }
 }
 const components:ScoreComponent[]=[];
 const add=(name:string,input:number|null,points:number|null,weight:number,reason:string)=>components.push({name,input:input===null?null:String(input),severity:points===null?null:d(points).div(weight).toString(),contribution:points===null?'0':d(points).toString(),weight,reason:points===null?'Unavailable: covered, meaningful comparison or sufficient observations missing. '+reason:reason});
 add('Sell dominance',share,share===null?null:sellPoints(share,rules.sellDominance),weights.sellDominance.weight,`Share of sell USD in current ${c.scoring.currentWindowMinutes}m flow. Cannot confirm an alert alone.`);
 add('Flow deterioration',ratio,ratio===null?null:stepPoints(ratio,rules.flowDeterioration),weights.flowDeterioration.weight,`Selling USD/min versus preceding ${c.scoring.baselineWindowMinutes}m; requires at least ${c.alerts.minSellsCurrent} sells in each window and a nonzero baseline.`);
 add('Price-flow divergence',price,divergence,weights.priceFlowDivergence!.weight,`Price holds within −${div.flatPricePct}% or rises while selling dominates and pressure/imbalance deteriorate. Falling price alone adds no divergence points.`);
 add('Seller concentration',seller,seller===null?null:stepPoints(seller,rules.sellerConcentration),weights.largeSellConcentration.weight,`${m.sellers?.basis??'trade-based'}: ${m.sellers?.reason??'Large-trade share fallback; wallet evidence unavailable.'}`);
 add('Buyer deterioration',decline,decline===null?null:stepPoints(decline,rules.buyerDeterioration),weights.buyerSizeDecline.weight,`Change in median buy size, with at least ${c.alerts.minBuysEachWindow===5?'five':c.alerts.minBuysEachWindow} buys in both windows.`);
 const available=components.filter(x=>x.severity!==null).reduce((s,x)=>s+x.weight,0);
 const score=coverage&&available>0?components.reduce((s,x)=>s.plus(x.contribution),d(0)).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber():null;
 const gates:RiskSnapshot['gates']=[];
 const gate=(name:string,pass:boolean,actual:unknown,required:unknown)=>gates.push({name,pass,actual:String(actual??'unavailable'),required:String(required)});
 gate('Coverage',coverage,m.status,`full current ${c.scoring.currentWindowMinutes}m and preceding ${c.scoring.baselineWindowMinutes}m`);
 gate('Collection quality',healthy,healthy?'fresh':'stale / degraded','fresh WS trades, transport, canonical REST, price and verified pool');
 for(const [name,value,min] of [ ['Current trades',(num(val('buyCount'))??0)+currentSells,c.alerts.minTradesCurrent],['Baseline trades',(num(bval('buyCount'))??0)+baselineSells,c.alerts.minTradesBaseline],['Current buys',num(val('buyCount'))??0,c.alerts.minBuysEachWindow],['Baseline buys',num(bval('buyCount'))??0,c.alerts.minBuysEachWindow],['Current sells',currentSells,c.alerts.minSellsCurrent]] as const)gate(name,value>=min,value,`≥ ${min}`);
 gate('All components available',available===100,available,'100/100; no reweighting');
 gate('Price-flow divergence',(divergence??0)>0,divergence,'> 0');
 const active=components.filter(x=>Number(x.contribution)>0).length;
 gate('Independent component categories',active>=rules.confirmation.minActiveCategories,active,`≥ ${rules.confirmation.minActiveCategories} distinct risk components including divergence`);
 gate('Score',score!==null&&score>=c.alerts.minScore,score,`≥ ${c.alerts.minScore}`);
 const samples=gates.filter(g=>['Current trades','Baseline trades','Current buys','Baseline buys','Current sells'].includes(g.name)).every(g=>g.pass);
 const provisional=!coverage||!healthy||!samples||available<100;
 const state=provisional?'Insufficient data':score===null?'Insufficient data':c.scoring.states.find(b=>score>=b.min&&score<=b.max)!.name;
 const f=(x:number|null,suffix='')=>x===null?'not available':`${d(x).toFixed(1)}${suffix}`;
 const explanation=`Price ${f(price,'%')} over ${c.scoring.currentWindowMinutes} minutes. ${ratio===null?'Selling pressure cannot yet be compared reliably.':`Selling pressure is ${f(Math.abs(ratio-1)*100,'%')} ${ratio>=1?'higher than':'lower than'} the previous ${c.scoring.baselineWindowMinutes}-minute baseline (${f(ratio,'×')}).`} ${seller===null?'Seller concentration is not available.':`${f(seller*100,'%')} of sell volume comes from ${m.sellers?.basis==='wallet-based'?'large or repeated senders':'large individual trades (wallet fallback)'}.`} ${decline===null?'Buyer-size comparison needs more observations.':`Median buy size has ${decline>=0?'fallen':'increased'} ${f(Math.abs(decline)*100,'%')}.`} ${provisional?'Provisional: quality or sample requirements are not met.':'Score band only; a confirmed alert also needs the confirmation rules.'}`;
 return {score,state,provisional,activeMaxWeight:available,components,gates,explanation,asOf:m.asOf};
}
