import {createHash} from 'node:crypto';
import {poolMetadataSchema,verifyOrientation} from '@volumechecker/coingecko';
import {poolIdentity,type PoolConfig, type AppConfig} from '@volumechecker/shared';
import {approvalContentHash,validateAppConfig} from './config';

export const NETWORK=/^[a-z0-9][a-z0-9-]{0,39}$/;
export const ADDRESS=/^0x[0-9a-f]{40}$/;
const ORIGIN='https://pro-api.coingecko.com/api/v3';
export function poolLocation(value:string):{network:string;address:string}|null {
 if(!value.startsWith('https://'))return null;
 const u=new URL(value);
 if(!['www.geckoterminal.com','geckoterminal.com'].includes(u.hostname)||u.port||u.username||u.password||u.search||u.hash)throw Error('Use an exact GeckoTerminal HTTPS pool URL without query parameters');
 const match=/^\/([a-z0-9-]+)\/pools\/(0x[0-9a-fA-F]{40})\/?$/.exec(u.pathname);
 if(!match||!NETWORK.test(match[1]!))throw Error('Only EVM pool URLs are supported');
 return {network:match[1]!,address:match[2]!.toLowerCase()};
}
export async function providerJson(path:string,key:string,fetchImpl:typeof fetch=fetch):Promise<unknown>{
 if(!/^\/onchain\/(search\/pools\?|networks\/[a-z0-9-]+\/pools\/0x[0-9a-f]{40}\?)/.test(path))throw Error('Invalid provider route');
 let response:Response;
 try{response=await fetchImpl(ORIGIN+path,{headers:{'x-cg-pro-api-key':key,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('CoinGecko connection failed; check connectivity and try again');}
 if(!response.ok)throw Error(`CoinGecko returned HTTP ${response.status}; check your Pro API key, plan access and quota`);
 const reader=response.body?.getReader();if(!reader)throw Error('Empty CoinGecko response');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000)throw Error('Provider response exceeds the setup limit');chunks.push(value);}}finally{await reader.cancel();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid CoinGecko response');}
}
export const safeLabel=(value:string)=>[...value].filter(c=>{const n=c.codePointAt(0)!;return n>=32&&(n<127||n>159)&&!(n>=0x202a&&n<=0x202e)&&!(n>=0x2066&&n<=0x2069);}).join('').slice(0,80);
export async function discoverPools(query:string,network:string,key:string,fetchImpl:typeof fetch=fetch){
 if(!NETWORK.test(network)||query.length<2||query.length>120)throw Error('Enter a network ID and a token symbol, pair or contract (2–120 characters)');
 const body=await providerJson('/onchain/search/pools?'+new URLSearchParams({query,network,include:'base_token,quote_token',page:'1'}),key,fetchImpl) as {data?:{id?:string;attributes?:{address?:string;name?:string}}[]};
 if(!Array.isArray(body.data))throw Error('Invalid pool search response');
 return body.data.slice(0,20).flatMap(p=>{const address=p.attributes?.address?.toLowerCase();return address&&ADDRESS.test(address)&&p.id===`${network}_${address}`?[{network,address,name:safeLabel(p.attributes?.name??address)}]:[];});
}
export async function resolvePool(location:{network:string;address:string},key:string,fetchImpl:typeof fetch=fetch):Promise<PoolConfig>{
 if(!NETWORK.test(location.network)||!ADDRESS.test(location.address))throw Error('Invalid EVM pool');
 const body=await providerJson(`/onchain/networks/${location.network}/pools/${location.address}?include=base_token,quote_token`,key,fetchImpl);
 const parsed=poolMetadataSchema.safeParse(body);if(!parsed.success)throw Error('CoinGecko pool metadata is incomplete');
 const token=(side:'base_token'|'quote_token')=>{const id=parsed.data.data.relationships[side].data?.id;const t=parsed.data.included?.find(t=>t.id===id);const address=t?.attributes.address?.toLowerCase();if(!address||!ADDRESS.test(address)||id!==`${location.network}_${address}`)throw Error('Pool token identity could not be verified');return {address,name:safeLabel(t?.attributes.symbol??'Token').slice(0,40)||'Token'};};
 const base=token('base_token'),quote=token('quote_token');const pool:PoolConfig={networkId:location.network,poolAddress:location.address,baseName:base.name,baseAddress:base.address,quoteName:quote.name,quoteAddress:quote.address,trackedAsset:'base'};
 if(verifyOrientation(body,new Date().toISOString(),pool).status!=='verified')throw Error('Pool identity or token orientation mismatch');return pool;
}
export function dashboardConfig(template:AppConfig,pools:PoolConfig[],alerts:boolean):AppConfig {
 const config={...template,pool:{catalog:pools.map(p=>({...poolIdentity(p),trackedAsset:'base' as const})),selectedPoolId:`${pools[0]!.networkId}:${pools[0]!.poolAddress}`},alerts:{...template.alerts,liveAlertsEnabled:alerts}};
 const approval=alerts?{status:'approved' as const,approvedBy:'Local user',approvedAt:new Date().toISOString(),approvedContentHash:approvalContentHash({...config,approval:template.approval}),note:'Local interactive opt-in; research signals only.'}:{status:'proposed' as const,approvedBy:null,approvedAt:null,approvedContentHash:null,note:'Live alerts are off until the local user opts in.'};
 return validateAppConfig({...config,approval},'local dashboard').config;
}
/** No inherited owner credential, tunnel origin or lifetime setting is forwarded. */
export function localLaunchEnv(env:NodeJS.ProcessEnv,key:string,configPath:string,dataDir:string):NodeJS.ProcessEnv {
 const clean={...env};for(const k of Object.keys(clean))if(/COINGECKO|VITE_|DEMO_|LIFETIME_|CONFIG_PATH|DATA_DIR|NODE_OPTIONS|NODE_PATH/i.test(k))delete clean[k];
 return {...clean,VC_ISOLATED_LOCAL:'1',COINGECKO_API_KEY:key,CONFIG_PATH:configPath,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:'8787',LOG_LEVEL:'info'};
}

/** Separate token orientations must never reinterpret an existing pool history. */
export function dashboardDataId(pools:readonly PoolConfig[]):string {
 return createHash('sha256').update(JSON.stringify(pools.map(p=>[p.networkId,p.poolAddress,p.baseAddress,p.quoteAddress]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex').slice(0,24);
}
