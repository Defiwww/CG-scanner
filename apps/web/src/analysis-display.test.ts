import {expect,it} from 'vitest';
import {componentBar,ageSeconds} from './analysis-display';
const c={name:'Sell dominance',input:'0.8289',severity:'1',contribution:'30',weight:30,reason:'test'};
it('renders maximum risk red, fractional widths from contribution/maximum and unavailable/stale neutral',()=>{
 expect(componentBar(c,false)).toMatchObject({percent:100,tone:'high'});
 expect(componentBar({...c,contribution:'15'},false)).toMatchObject({percent:50,tone:'medium'});
 expect(componentBar({...c,contribution:'0'},false).percent).toBe(0);
 expect(componentBar(c,true).tone).toBe('neutral');expect(componentBar({...c,severity:null},false).tone).toBe('neutral');
});
it('ages evidence from its original timestamp, never an HTTP or heartbeat receipt',()=>{
 expect(ageSeconds(1000,91000)).toBe(90);expect(ageSeconds(1000,151000)).toBe(150);
});
