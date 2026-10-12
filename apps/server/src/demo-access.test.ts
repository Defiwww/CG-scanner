import {it,expect} from 'vitest';
import {buildApp,ACTION_HEADER} from './app';
import {loadAppConfig} from './config';
import {localProxyOnly,loadDemoAccess} from './demo-access';
const loaded=loadAppConfig(new URL('../../../config/legacy-v0.json',import.meta.url).pathname);
const demoAccess={origin:'https://exact-demo.ngrok-free.app',port:8787};
const headers={host:'exact-demo.ngrok-free.app','x-forwarded-proto':'https',origin:demoAccess.origin,[ACTION_HEADER]:'1'};
it('anonymous controls work while exact host, origin, command and private-route boundaries remain enforced',async()=>{
 const app=await buildApp({loaded,apiKey:undefined,logLevel:'silent',demoAccess});
 try{
 for(const url of ['/api/access','/api/health','/api/inspection','/api/pools','/api/analysis'])expect((await app.inject({url,headers})).statusCode).toBe(200);
 expect((await app.inject({url:'/api/access',headers})).json().canManage).toBe(true);
 expect((await app.inject({url:'/login',headers})).headers.location).toBe('/');
 expect((await app.inject({method:'POST',url:'/api/inspection/stop',headers,payload:{}})).statusCode).toBe(200);
 expect((await app.inject({method:'POST',url:'/api/inspection/start',headers,payload:{poolId:'not-allowed'}})).statusCode).toBe(400);
 for(const url of ['/api/config','/.env','/data/volumechecker.sqlite'])expect((await app.inject({url,headers})).statusCode).toBe(403);
 for(const origin of ['https://other.ngrok-free.app','https://exact-demo.ngrok-free.app.evil.test','null',undefined])expect((await app.inject({method:'POST',url:'/api/inspection/stop',headers:Object.fromEntries(Object.entries({...headers,origin}).filter(([,v])=>v!==undefined)) as Record<string,string>,payload:{}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:'/api/inspection/stop',headers:{host:headers.host,origin:headers.origin,'x-forwarded-proto':'https'},payload:{}})).statusCode).toBe(403);
 expect((await app.inject({url:'/api/health',headers:{...headers,host:'evil.test','x-forwarded-host':headers.host}})).statusCode).toBe(403);
 expect((await app.inject({url:'/api/health',remoteAddress:'203.0.113.7',headers})).statusCode).toBe(403);
 expect((await app.inject({url:'/api/health',headers:{...headers,'x-forwarded-proto':'http'}})).statusCode).toBe(403);
 expect((await app.inject({method:'POST',url:'/api/inspection/stop',headers:{...headers,host:'localhost:8787',origin:'http://localhost:8787'},payload:{}})).statusCode).toBe(200);
 }finally{await app.close();}
});
it('limits all visitors to 10 shared commands per minute without passwords',async()=>{
 const app=await buildApp({loaded,apiKey:undefined,logLevel:'silent',demoAccess});
 try{
 for(let i=0;i<10;i++)expect((await app.inject({method:'POST',url:'/api/inspection/stop',headers,payload:{}})).statusCode).toBe(200);
 const r=await app.inject({method:'POST',url:'/api/inspection/stop',headers,payload:{}});expect(r.statusCode).toBe(429);expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
 expect((await app.inject({url:'/api/inspection',headers})).statusCode).toBe(200);
 }finally{await app.close();}
});
it('trusts only the direct local proxy and validates one HTTPS origin',()=>{
 expect(localProxyOnly('127.0.0.1',0)).toBe(true);expect(localProxyOnly('127.0.0.1',1)).toBe(false);expect(localProxyOnly('192.168.1.2',0)).toBe(false);
 expect(()=>loadDemoAccess('http://unsafe.test',8787)).toThrow();expect(loadDemoAccess(undefined,8787)).toBeUndefined();
});
it('anonymous polling does not create collectors or provider requests',async()=>{
 let calls=0;const app=await buildApp({loaded,apiKey:'TEST-ONLY-key',logLevel:'silent',demoAccess,fetchImpl:async()=>{calls++;throw Error('unexpected provider call');}});
 try{
 for(let i=0;i<3;i++)await Promise.all(['/api/inspection','/api/analysis','/api/health','/api/pools'].map(url=>app.inject({url,headers})));
 expect(calls).toBe(0);expect((await app.inject({url:'/api/inspection',headers})).json().activePoolId).toBeNull();
 }finally{await app.close();}
});
