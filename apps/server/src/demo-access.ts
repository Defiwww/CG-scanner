import type { FastifyInstance } from 'fastify';

/** Dashboard polling uses roughly 40 reads per minute per tab. */
export const PUBLIC_READS_PER_MINUTE = 300;
const MAX_TRACKED_CLIENTS = 5000;

export interface DemoAccess { origin: string; port: number }
export function loadDemoAccess(origin: string | undefined, port: number): DemoAccess | undefined {
  if (!origin) return undefined;
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw Error('Demo address must be one exact HTTPS origin');
  return { origin, port };
}
export function localProxyOnly(address: string, hop: number): boolean {
  return hop === 0 && (address === '127.0.0.1' || address === '::ffff:127.0.0.1');
}
/** Public shared controls, deliberately without credentials. Network boundaries still fail closed. */
export function installDemoAccess(app: FastifyInstance, access: DemoAccess): void {
  const localAuthorities = [`127.0.0.1:${access.port}`, `localhost:${access.port}`, `[::1]:${access.port}`];
  const publicHost = new URL(access.origin).host;
  const hosts = new Set([publicHost, ...localAuthorities]);
  const origins = new Set([access.origin, ...localAuthorities.map(h => `http://${h}`)]);
  const publicReads = new Set(['/','/index.html','/favicon.ico','/login','/api/access','/api/health','/api/pool','/api/pools','/api/inspection','/api/analysis','/api/reports','/api/report','/api/research','/api/signal','/api/case']);
  const commands = new Set(['/api/inspection/start','/api/inspection/stop','/api/replay','/api/synthetic-demo']);
  let recent: number[] = [];
  // Per-client read limit with a bounded table, so anonymous polling cannot exhaust a small host.
  const reads = new Map<string, { count: number; windowStart: number }>();
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'same-origin');
    if (!hosts.has(req.headers.host ?? '')) return reply.code(403).send({error:'Host not allowed'});
    if (req.headers.host === publicHost && req.protocol !== 'https') return reply.code(403).send({error:'HTTPS required'});
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return reply.code(403).send({error:'Origin not allowed'});
    const path = req.url.split('?')[0] ?? '';
    if ((req.method==='GET'||req.method==='HEAD') && (publicReads.has(path)||path.startsWith('/assets/'))) {
      const at = Date.now();
      let entry = reads.get(req.ip);
      if (!entry || at - entry.windowStart >= 60000) {
        if (!entry && reads.size >= MAX_TRACKED_CLIENTS) reads.clear();
        entry = { count: 0, windowStart: at };
        reads.set(req.ip, entry);
      }
      if (++entry.count > PUBLIC_READS_PER_MINUTE) return reply.header('retry-after',String(Math.ceil((entry.windowStart+60000-at)/1000))).code(429).send({error:'Too many requests from this address. Please wait.'});
      return;
    }
    if (req.method!=='POST'||!commands.has(path)) return reply.code(403).send({error:'Route not public'});
    if (!req.headers.origin||!origins.has(req.headers.origin)||req.headers['x-volumechecker-action']!=='1') return reply.code(403).send({error:'Allowed Origin and action header required'});
    const now = Date.now(); recent = recent.filter(t => now-t<60000);
    if (recent.length>=10) return reply.header('retry-after',String(Math.ceil((recent[0]!+60000-now)/1000))).code(429).send({error:'Shared command limit: 10 per minute. Please wait.'});
    recent.push(now);
  });
  app.get('/api/access', async ()=>({canManage:true,publicRead:true}));
  app.get('/login', async (_req,reply)=>reply.redirect('/'));
}
