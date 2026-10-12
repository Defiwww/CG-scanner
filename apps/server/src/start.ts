import {createInterface} from 'node:readline/promises';
import {readFileSync,existsSync,mkdirSync,lstatSync,writeFileSync,renameSync,chmodSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {poolLocation,discoverPools,resolvePool,dashboardConfig,localLaunchEnv,safeLabel,dashboardDataId} from './onboarding';
import {loadAppConfig} from './config';
import {redactText, type PoolConfig} from '@volumechecker/shared';

export async function hiddenKey():Promise<string>{
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run pnpm start in an interactive terminal; the API key must be entered privately');
 process.stdout.write('Your CoinGecko Pro API key (hidden, session only): ');
 process.stdin.setRawMode(true);process.stdin.resume();let value='';
 return new Promise((resolve,reject)=>{const done=(error?:Error)=>{process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');if(error)reject(error);else resolve(value);};const read=(chunk:Buffer)=>{for(const c of chunk.toString()){if(c==='\u0003'){done(Error('Setup cancelled'));return;}if(c==='\r'||c==='\n'){done();return;}if(c==='\u007f'||c==='\b'){value=value.slice(0,-1);}else if(/^[\x21-\x7e]$/.test(c)&&value.length<512)value+=c;}};process.stdin.on('data',read);});
}
let sessionKey='';
async function main(){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 if(!process.stdin.isTTY)throw Error('Interactive setup required. No repository .env credential is used.');
 console.log('VolumeChecker · local dashboard setup\nUses your CoinGecko Pro key with onchain/WS access. EVM pools only. No key is saved to disk.');
 const key=await hiddenKey();sessionKey=key;if(key.length<8)throw Error('No valid API key entered');
 const dir=resolve(root,'.local');if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw Error('Local settings directory must not be a symlink');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
 // An exclusive local launcher lock prevents two processes sharing its database.
 const lock=resolve(dir,'server.lock');if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));try{process.kill(pid,0);throw Error('Another local dashboard is running');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;unlinkSync(lock);}}
 writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});

 process.once('exit',()=>{if(existsSync(lock))unlinkSync(lock);});
 const rl=createInterface({input:process.stdin,output:process.stdout});
 const ask=async(q:string)=>(await rl.question(q)).trim();
 const configPath=resolve(dir,'dashboard.json');let pools:PoolConfig[]=[];let alerts=false;
 try{
  if(existsSync(configPath)&&!lstatSync(configPath).isSymbolicLink()&&(await ask('Use your saved dashboard? [Y/n] ')).toLowerCase()!=='n'){
   const saved=loadAppConfig(configPath).config;pools=[...(saved.pool.catalog??[])];alerts=saved.alerts.liveAlertsEnabled;
   for(const p of pools){const current=await resolvePool({network:p.networkId,address:p.poolAddress},key);if(![current.baseAddress,current.quoteAddress].includes(p.baseAddress)||![current.baseAddress,current.quoteAddress].includes(p.quoteAddress))throw Error('Saved pool token identity changed; configure a new dashboard');}
  }
  if(!pools.length){
   do{
    const input=await ask('Token/pair search (e.g. WETH USDC) or GeckoTerminal pool URL: ');let location=poolLocation(input);
    if(!location){const network=await ask('CoinGecko network ID (e.g. eth, base, arbitrum): ');const choices=await discoverPools(input,network,key);if(!choices.length)throw Error('No supported EVM pools found; retry with a contract address or GeckoTerminal pool URL');choices.forEach((p,i)=>console.log(`${i+1}. ${p.name} · ${p.network} · ${p.address}`));const choice=Number(await ask('Pool number: '));if(!Number.isInteger(choice)||choice<1||choice>choices.length)throw Error('Invalid pool selection');location=choices[choice-1]!;}
    let pool=await resolvePool(location,key);
    console.log(`Verified: ${safeLabel(pool.baseName)}/${safeLabel(pool.quoteName)} · ${pool.networkId}\nPool: ${pool.poolAddress}\n1. ${pool.baseName} ${pool.baseAddress}\n2. ${pool.quoteName} ${pool.quoteAddress}`);
    const tracked=await ask('Token to track [1/2, default 1]: ');if(tracked&&tracked!=='1'&&tracked!=='2')throw Error('Choose token 1 or 2');if(tracked==='2')pool={...pool,baseName:pool.quoteName,baseAddress:pool.quoteAddress,quoteName:pool.baseName,quoteAddress:pool.baseAddress};
    if(pools.some(p=>p.networkId===pool.networkId&&p.poolAddress===pool.poolAddress))throw Error('Pool already selected');pools.push(pool);
   }while(pools.length<20&&(await ask('Add another pool to this dashboard? [y/N] ')).toLowerCase()==='y');
   alerts=(await ask('Enable in-app research alerts with strict sample/freshness gates? [y/N] ')).toLowerCase()==='y';
  }
  const config=dashboardConfig(loadAppConfig(resolve(root,'config/default.json')).config,pools,alerts);
  const temp=resolve(dir,`dashboard-${process.pid}.tmp`);writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,configPath);
 }finally{rl.close();}
 console.log('Dashboard ready at http://127.0.0.1:8787 · press Connect in the browser. Ctrl+C stops the server.');
 const child=spawn(process.execPath,[resolve(root,'apps/server/dist/server.js')],{stdio:'inherit',env:localLaunchEnv(process.env,key,configPath,resolve(dir,'data',dashboardDataId(pools)))});
 const stop=()=>child.kill('SIGTERM');process.on('SIGINT',stop);process.on('SIGTERM',stop);
 child.once('error',()=>{if(existsSync(lock))unlinkSync(lock);console.error('Could not start local server');process.exitCode=1;});
 child.once('exit',code=>{if(existsSync(lock))unlinkSync(lock);process.stdin.pause();process.exitCode=code??1;});
}
main().catch(error=>{console.error(redactText(error instanceof Error?error.message:'Setup failed',[sessionKey]));console.error('Run pnpm start to retry.');process.exitCode=1;process.stdin.pause();});
