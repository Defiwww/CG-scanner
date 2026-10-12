import {z} from 'zod';
import defaults from './distribution-v1-defaults.json';
const points=z.number().finite().min(0).max(100);
const fraction=z.number().finite().min(0).max(1);
const steps=z.array(z.object({threshold:z.number().finite().nonnegative(),inclusive:z.boolean(),points}).strict()).min(1).superRefine((s,ctx)=>{
 if(s.some((x,i)=>i>0&&(x.threshold<=s[i-1]!.threshold||x.points<s[i-1]!.points)))ctx.addIssue({code:'custom',message:'Steps must have increasing thresholds and nondecreasing points'});
});
export const distributionRulesSchema=z.object({
 sellers:z.object({minIdentityCoverage:fraction,repeatedSellCount:z.number().int().min(2)}).strict(),
 sellDominance:z.object({belowPoints:points,abovePoints:points,segments:z.array(z.object({min:fraction,max:fraction,from:points,to:points}).strict()).min(1)}).strict().superRefine((s,ctx)=>{
  if(s.segments.some((x,i)=>x.min>=x.max||x.from>x.to||(i>0&&(x.min!==s.segments[i-1]!.max||x.from!==s.segments[i-1]!.to)))||s.belowPoints>s.segments[0]!.from||s.abovePoints<s.segments.at(-1)!.to)ctx.addIssue({code:'custom',message:'Sell-share segments must be ordered, contiguous and monotone'});
 }),
 flowDeterioration:steps,sellerConcentration:steps,buyerDeterioration:steps,
 divergence:z.object({flatPricePct:z.number().finite().nonnegative(),minSellShare:fraction,strongSellShare:fraction,extremeSellShare:fraction,minSellRateRatio:z.number().positive(),strongSellRateRatio:z.number().positive(),extremeSellRateRatio:z.number().positive(),minDeteriorationExclusive:z.number().finite(),extremeDeterioration:z.number().finite(),weakPoints:points,strongPoints:points,flatWeakPoints:points,flatStrongPoints:points,extremePoints:points}).strict().superRefine((d,ctx)=>{
  if(d.minSellShare>d.strongSellShare||d.strongSellShare>d.extremeSellShare||d.minSellRateRatio>d.strongSellRateRatio||d.strongSellRateRatio>d.extremeSellRateRatio||d.minDeteriorationExclusive>d.extremeDeterioration||d.weakPoints>d.flatWeakPoints||d.flatWeakPoints>d.strongPoints||d.strongPoints>d.flatStrongPoints||d.flatStrongPoints>d.extremePoints)ctx.addIssue({code:'custom',message:'Divergence thresholds and points must be ordered'});
 }),
 confirmation:z.object({minActiveCategories:z.number().int().min(1).max(5),maxCheckpointGapMultiplier:z.number().finite().positive(),fastScore:z.number().int().min(0).max(100),fastComponents:z.array(z.enum(['Sell dominance','Flow deterioration','Price-flow divergence','Seller concentration','Buyer deterioration'])).min(1).refine(a=>new Set(a).size===a.length,'Duplicate fast-confirmation categories')}).strict(),
}).strict();
/** Versioned compatibility settings for previously approved configs, with no hash mutation. */
function freeze<T>(value:T):T {
 if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
export const historicalV1Rules=freeze(distributionRulesSchema.parse(defaults));
