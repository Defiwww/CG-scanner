import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {FastifyInstance} from 'fastify';
const compress=promisify(gzip);
export function installJsonCompression(app:FastifyInstance):void {
 app.addHook('onSend',async(req,reply,payload)=>{
  if(!String(reply.getHeader('content-type')??'').includes('application/json')||reply.getHeader('content-encoding')||!(typeof payload==='string'||Buffer.isBuffer(payload))||Buffer.byteLength(payload)<1024)return payload;
  reply.header('vary','Accept-Encoding');
  const accepts=(req.headers['accept-encoding']??'').split(',').some(part=>{const [name,...params]=part.trim().split(';');return name==='gzip'&&!params.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));});
  if(!accepts)return payload;
  const result=await compress(payload);reply.header('content-encoding','gzip').header('content-length',result.length);return result;
 });
}
