import {historicalV1Rules,type AppConfig} from '@volumechecker/shared';
import Decimal from 'decimal.js';
import type {AnalysisTrade,SellerSummary,SellerWallet} from '@volumechecker/shared';
/** Transaction senders are observable identities, not claims about ownership or expertise. */
export function summarizeSellers(trades:AnalysisTrade[],largeThreshold:string,rules:NonNullable<AppConfig['scoring']['v1']>['sellers']=historicalV1Rules.sellers):SellerSummary {
 const rows=new Map<string,SellerWallet>();let total=new Decimal(0),known=new Decimal(0);
 const positive=new Map<string,number>();
 const ordered=[...trades].sort((a,b)=>a.eventMs-b.eventMs||a.id.localeCompare(b.id));
 let groupTime:number|null=null;const touched=new Set<string>();
 const finishGroup=()=>{if(groupTime===null)return;for(const address of touched){const w=rows.get(address)!;if(new Decimal(w.netFlow).gt(0)&&!positive.has(w.address))positive.set(w.address,groupTime);if(new Decimal(w.netFlow).lt(0)&&positive.has(w.address)&&positive.get(w.address)!<groupTime)w.shiftedToSelling=true;}touched.clear();};
 for(const t of ordered) {
  if(groupTime!==t.eventMs){finishGroup();groupTime=t.eventMs;}
  if(t.usd===null||!t.side)continue;
  const usd=new Decimal(t.usd);if(!usd.isFinite()||usd.lt(0))continue;
  if(t.side==='sell')total=total.plus(usd);
  if(!t.sender)continue;
  const address=t.sender.toLowerCase();
  const w=rows.get(address)??{address,buyUsd:'0',sellUsd:'0',netFlow:'0',trades:0,sells:0,firstSeen:t.eventMs,lastSeen:t.eventMs,shiftedToSelling:false};
  if(t.side==='buy')w.buyUsd=new Decimal(w.buyUsd).plus(usd).toString();
  else {w.sellUsd=new Decimal(w.sellUsd).plus(usd).toString();w.sells++;known=known.plus(usd);}
  w.netFlow=new Decimal(w.buyUsd).minus(w.sellUsd).toString();w.trades++;w.lastSeen=t.eventMs;
  // A transition needs an earlier timestamp: unordered swaps in one block do not prove sequence.
  rows.set(address,w);touched.add(address);
 }
 finishGroup();
 const wallets=[...rows.values()].sort((a,b)=>new Decimal(a.netFlow).cmp(b.netFlow));
 const coverage=total.gt(0)?known.div(total):null;
 const walletBased=coverage!==null&&coverage.gte(rules.minIdentityCoverage);
 const qualifying=wallets.filter(w=>w.sells>=rules.repeatedSellCount||new Decimal(w.sellUsd).gte(largeThreshold));
 const risk=walletBased?qualifying.reduce((s,w)=>s.plus(w.sellUsd),new Decimal(0)):trades.filter(t=>t.side==='sell'&&t.usd!==null&&new Decimal(t.usd).gte(largeThreshold)).reduce((s,t)=>s.plus(t.usd!),new Decimal(0));
 return {repeatedSellCount:rules.repeatedSellCount,wallets,top3Share:total.gt(0)?[...wallets].sort((a,b)=>new Decimal(b.sellUsd).cmp(a.sellUsd)).slice(0,3).reduce((s,w)=>s.plus(w.sellUsd),new Decimal(0)).div(total).toString():null,repeatedShare:total.gt(0)?wallets.filter(w=>w.sells>=rules.repeatedSellCount).reduce((s,w)=>s.plus(w.sellUsd),new Decimal(0)).div(total).toString():null,riskShare:total.gt(0)?risk.div(total).toString():null,senderCoverage:coverage?.toString()??null,basis:walletBased?'wallet-based':'trade-based',reason:walletBased?`Observed senders with ≥${rules.repeatedSellCount} sells or aggregate sells above the large-trade threshold. Senders may be routers; no ownership or expertise inferred.`:`Fallback: less than ${rules.minIdentityCoverage*100}% of sell USD has sender identity; large individual trades used instead. Missing identity is not evidence of no concentration.`};
}
