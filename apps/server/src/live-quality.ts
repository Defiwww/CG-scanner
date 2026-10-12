import type {InspectionSnapshot} from '@volumechecker/shared';
export function liveQuality(s:InspectionSnapshot,now:number,maxAgeMs=90000):{state:'LIVE'|'STALE'|'DISCONNECTED';reason:string} {
 if(!s.activePoolId||s.monitor!=='running')return {state:'DISCONNECTED',reason:s.monitor==='starting'?'Connecting and recovering history':'Monitoring is stopped or blocked'};
 const ws=s.indicators.tradeInactivity;
 const eventTime=Date.parse(ws.lastAt??'');
 if(s.orientation.status!=='verified'||s.persistence.state!=='ok')return {state:'STALE',reason:'Pool identity or persistence is not verified; new alerts disabled'};
 if(s.indicators.transport.state!=='ok'||ws.state!=='ok'||!Number.isFinite(eventTime)||eventTime>now||now-eventTime>maxAgeMs)return {state:'STALE',reason:'Degraded: REST may continue, but no fresh non-replay WS trade is verified. New alerts disabled.'};
 return {state:'LIVE',reason:'Fresh non-replay WebSocket trades and verified pool/storage; alert sample gates still apply'};
}
