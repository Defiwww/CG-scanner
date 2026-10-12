import {it,expect} from 'vitest';
import {readStoredObservation} from '../../../packages/storage/src/collector';
import {mapRestTrade,mapWsTrade} from '@volumechecker/coingecko';
import {restTrade,g2Frame} from '../../../tests/fixtures/synthetic/coingecko';
import {g2TradeSchema} from '@volumechecker/coingecko';
import {sameSwap} from '@volumechecker/engine';
import {readFileSync} from 'node:fs';
import {appConfigSchema} from '@volumechecker/shared';
it('adapts old persisted observations for reconciliation without rewriting source JSON',()=>{
 const current=mapWsTrade(g2TradeSchema.parse(g2Frame({t:Date.parse('2026-09-30T12:00:12Z')})),'base','2026-09-30T12:00:00Z');
 const {trackedAmount,counterAmount,trackedPriceUsd,trackedPriceBasis,...rest}=current;
 const json=JSON.stringify({...rest,linkAmount:trackedAmount,wethAmount:counterAmount,linkPriceUsd:trackedPriceUsd,linkPriceBasis:trackedPriceBasis});
 const restored=readStoredObservation(json);expect(restored).toEqual(current);expect(readStoredObservation(JSON.stringify(current))).toEqual(current);
 expect(Object.keys(restored)).not.toContain('linkAmount');
 const c=appConfigSchema.parse(JSON.parse(readFileSync(new URL('../../../config/default.json',import.meta.url),'utf8')));
 const canonical=mapRestTrade(restTrade({side:'buy'}),'2026-09-30T12:00:00Z').trade;
 expect(sameSwap(restored,canonical,c.reconciliation)).toBe(true);
});
