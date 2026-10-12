import {existsSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.stdin.isTTY){console.error('Run pnpm start in an interactive terminal. Setup never loads a repository API key.');process.exit(1);}
if(!existsSync(resolve(root,'apps/server/dist/start.js'))||!existsSync(resolve(root,'apps/web/dist/index.html'))){
 const result=spawnSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['build'],{cwd:root,stdio:'inherit',shell:process.platform==='win32'});if(result.status!==0)process.exit(result.status??1);
}
const child=spawn(process.execPath,[resolve(root,'apps/server/dist/start.js')],{cwd:root,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
