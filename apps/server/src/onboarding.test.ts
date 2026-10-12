import {it,expect} from 'vitest';
import {poolLocation,providerJson,resolvePool,discoverPools,dashboardConfig,localLaunchEnv,dashboardDataId} from './onboarding';
import {loadAppConfig,validateAppConfig} from './config';
import {buildApp} from './app';
import {buildRestUrl,poolMetadataRoute} from '@volumechecker/coingecko';
import {poolMetadata,ohlcvResponse,tradesResponse} from '../../../tests/fixtures/synthetic/coingecko';
import {FakeSocket} from '../../../tests/helpers/fake-socket';
const template=loadAppConfig(new URL('../../../config/default.json',import.meta.url).pathname).config;
const location={network:'arbitrum',address:'0x'+'12'.repeat(20)};
const metadata=()=>JSON.parse(JSON.stringify(poolMetadata({poolAddress:location.address})).replaceAll('eth_','arbitrum_'));
const responder=(body:unknown)=>(async()=>new Response(JSON.stringify(body),{status:200})) as typeof fetch;
it('resolves a custom EVM pool against provider identity and prevents credential redirects/foreign URL injection',async()=>{
 const pool=await resolvePool(location,'TEST-KEY',responder(metadata()));expect(pool.networkId).toBe('arbitrum');expect(buildRestUrl(poolMetadataRoute(pool)).origin).toBe('https://pro-api.coingecko.com');
 expect(poolLocation(`https://www.geckoterminal.com/arbitrum/pools/${location.address}`)).toEqual(location);
 for(const url of ['https://evil.test/eth/pools/'+location.address,'https://www.geckoterminal.com@evil.test/eth/pools/'+location.address,'https://www.geckoterminal.com/solana/pools/AbCd','https://www.geckoterminal.com/eth/pools/'+location.address+'?key=secret'])expect(()=>poolLocation(url)).toThrow();
 await expect(resolvePool({...location,network:'../../evil'},'TEST-KEY',responder(metadata()))).rejects.toThrow();
 await providerJson(`/onchain/networks/arbitrum/pools/${location.address}?include=base_token,quote_token`,'TEST-KEY',(async(url,init)=>{expect(String(url)).not.toContain('TEST-KEY');expect(init?.redirect).toBe('error');expect((init?.headers as Record<string,string>)['x-cg-pro-api-key']).toBe('TEST-KEY');return new Response('{}');}) as typeof fetch);
 const bad=metadata();bad.data.attributes.address='0x'+'ab'.repeat(20);await expect(resolvePool(location,'TEST-KEY',responder(bad))).rejects.toThrow('identity');
});
it('search filters unsupported/mismatched pools and sanitizes provider terminal labels',async()=>{
 const result=await discoverPools('LINK','arbitrum','TEST-KEY',responder({data:[{id:`arbitrum_${location.address}`,attributes:{address:location.address,name:'\u001b[31mLINK'}},{id:'eth_wrong',attributes:{address:location.address,name:'wrong'}}]}));expect(result).toHaveLength(1);expect(result[0]!.name).not.toContain('\u001b');
});
it('isolates each user credential/data directory and defaults to unapproved alerts',async()=>{
 const pool=await resolvePool(location,'TEST-KEY',responder(metadata()));const config=dashboardConfig(template,[pool],false);expect(config.alerts.liveAlertsEnabled).toBe(false);expect(config.approval.status).toBe('proposed');expect(validateAppConfig(dashboardConfig(template,[pool],true),'test').config.approval.status).toBe('approved');
 const env=localLaunchEnv({COINGECKO_API_KEY:'OLD-KEY',DEMO_PUBLIC_ORIGIN:'https://old.example',LIFETIME_FILE:'old',NODE_OPTIONS:'unsafe',PATH:'normal'},'NEW-KEY','local-config','local-data');expect(env.COINGECKO_API_KEY).toBe('NEW-KEY');expect(env.VC_ISOLATED_LOCAL).toBe('1');expect(env.DEMO_PUBLIC_ORIGIN).toBeUndefined();expect(env.NODE_OPTIONS).toBeUndefined();expect(env.DATA_DIR).toBe('local-data');
});
it('custom dashboard uses its own catalog and key for API, collector and provider without changing other app instances',async()=>{
 const pool=await resolvePool(location,'NEW-KEY',responder(metadata()));const loaded=validateAppConfig(dashboardConfig(template,[pool],false),'test');const calls:string[]=[];
 const app=await buildApp({loaded,apiKey:'NEW-KEY',logLevel:'silent',fetchImpl:async(url,init)=>{calls.push(String(url));expect((init.headers as Record<string,string>)['x-cg-pro-api-key']).toBe('NEW-KEY');return new Response(JSON.stringify(url.pathname.endsWith('/trades')?JSON.parse(JSON.stringify(tradesResponse()).replaceAll('eth_','arbitrum_')):url.pathname.endsWith('/minute')?ohlcvResponse():metadata()));},socketFactory:(url,h)=>new FakeSocket(url,h)});
 const other=await buildApp({loaded:loadAppConfig(new URL('../../../config/legacy-v0.json',import.meta.url).pathname),apiKey:undefined,logLevel:'silent'});
 try{expect((await app.inject('/api/pools')).json().poolIds).toEqual([`${pool.networkId}:${pool.poolAddress}`]);expect((await other.inject('/api/pools')).json().poolIds).toHaveLength(2);expect((await app.inject({method:'POST',url:'/api/inspection/start',headers:{'x-volumechecker-action':'1'},payload:{poolId:`${pool.networkId}:${pool.poolAddress}`}})).statusCode).toBe(202);for(let i=0;i<30&&calls.length<3;i++)await new Promise(r=>setTimeout(r,5));for(let i=0;i<100&&(await app.inject('/api/inspection')).json().persistence.canonicalTrades<2;i++)await new Promise(r=>setTimeout(r,5));expect((await app.inject('/api/inspection')).json().persistence.canonicalTrades).toBe(2);expect(calls.length).toBeGreaterThanOrEqual(3);expect(calls.every(u=>u.startsWith('https://pro-api.coingecko.com/api/v3/onchain/networks/arbitrum/'))).toBe(true);expect((await app.inject('/api/analysis')).statusCode).toBe(200);}finally{await app.close();await other.close();}
});

it('separates storage when a pool is configured with the opposite tracked token',async()=>{
 const pool=await resolvePool(location,'TEST-KEY',responder(metadata()));
 const flipped={...pool,baseAddress:pool.quoteAddress,quoteAddress:pool.baseAddress,baseName:pool.quoteName,quoteName:pool.baseName};
 expect(dashboardDataId([pool])).not.toBe(dashboardDataId([flipped]));
 expect(dashboardDataId([pool])).toBe(dashboardDataId([{...pool,baseName:'Renamed'}]));
});
it('bounds onboarding responses and rejects HTTP failures without disclosing provider bodies',async()=>{
 await expect(providerJson('/onchain/search/pools?query=token','TEST-KEY',responder('x'.repeat(2_000_001)))).rejects.toThrow('limit');
 await expect(providerJson('/onchain/search/pools?query=token','TEST-KEY',(async()=>new Response('TEST-KEY',{status:401})) as typeof fetch)).rejects.toThrow('HTTP 401');
});
