import type {AnalysisResponse,SignalRecord} from '@volumechecker/shared';
export function FlowChart({data,alerts=[]}:{data:NonNullable<AnalysisResponse['metrics']>['chart'];alerts?:SignalRecord[]}) {
  const prices=data.flatMap(p=>p.price===null?[]:[Number(p.price)]),low=Math.min(...prices),high=Math.max(...prices);
  const max=Math.max(1,...data.flatMap(p=>[Number(p.buy??0),Number(p.sell??0)]));
  const x=(i:number)=>50+i*14;
  return <figure className="card"><figcaption>Price and buy/sell flow · shared UTC minute axis · gaps are not interpolated</figcaption><svg viewBox="0 0 920 290" role="img" aria-label="Price and buy/sell flow over 60 minutes">
    <text x="5" y="18">Price (USD)</text><text x="5" y="150">USD / min</text>
    {data.map((p,i)=><g key={p.at}>{!p.covered&&<rect x={x(i)} y="25" width="13" height="215" fill="#d7dbe0" opacity="0.6"><title>Uncovered interval</title></rect>}{p.price!==null&&<circle cx={x(i)+6} cy={120-(Number(p.price)-low)/(high-low||1)*80} r="2.4" fill="#225cc5"><title>{new Date(p.at+60000).toISOString()}: ${p.price}</title></circle>}{p.buy!==null&&<rect x={x(i)} y={225-Number(p.buy)/max*60} width="6" height={Number(p.buy)/max*60} fill="#21826b"><title>Buy ${p.buy}</title></rect>}{p.sell!==null&&<rect x={x(i)+7} y={225-Number(p.sell)/max*60} width="6" height={Number(p.sell)/max*60} fill="#bb4c55"><title>Sell ${p.sell}</title></rect>}{i%10===0&&<text x={x(i)} y="260" fontSize="11">{new Date(p.at).toISOString().slice(11,16)}</text>}</g>)}
    {alerts.filter(a=>a.mode==='live'&&data.length&&a.firedAt>=data[0]!.at&&a.firedAt<=data[data.length-1]!.at+60000).map(a=><g key={a.id}><line x1={50+(a.firedAt-data[0]!.at)/60000*14} x2={50+(a.firedAt-data[0]!.at)/60000*14} y1="25" y2="240" stroke="#84269b" strokeWidth="2"/><title>Confirmed alert: {new Date(a.firedAt).toISOString()} · {a.score}/100</title></g>)}
    <text x="60" y="285" fontSize="12">Blue: observed price · Green: buys · Red: sells · Gray: missing coverage · Purple: confirmed live alerts</text></svg></figure>;
}
