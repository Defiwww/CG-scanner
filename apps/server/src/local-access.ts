import type {FastifyInstance} from 'fastify';

const localHost = (value:string):boolean => {
 const match=/^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/.exec(value);
 return !!match && (match[2]===undefined || (Number(match[2])>=1&&Number(match[2])<=65535));
};
/** Protect local reads against DNS rebinding as well as cross-origin commands. */
export function installLocalAccess(app:FastifyInstance):void {
 let commands:number[]=[];
 app.addHook('onRequest',async(req,reply)=>{
  if(!localHost(req.headers.host??''))return reply.code(403).send({error:'Host not allowed'});
  if(req.headers.origin!==undefined){
   let allowed=false;
   try {const u=new URL(req.headers.origin);allowed=u.protocol==='http:'&&u.origin===req.headers.origin&&localHost(u.host);}catch{/* Invalid origins fail closed. */}
   if(!allowed)return reply.code(403).send({error:'Origin not allowed'});
  }
  if(req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:'Cross-site access denied'});
  if(req.method==='POST'){
   const now=Date.now();commands=commands.filter(t=>now-t<60000);
   if(commands.length>=10)return reply.header('retry-after','60').code(429).send({error:'Shared command limit: 10 per minute. Please wait.'});
   commands.push(now);
  }
 });
}
