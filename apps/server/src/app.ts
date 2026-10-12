import {installLocalAccess} from './local-access';
import {installJsonCompression} from './compression';
import { ResearchService, reportCsv } from './research';
import { installDemoAccess, localProxyOnly, type DemoAccess } from './demo-access';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ALLOWED_POOLS, poolIdentity } from '@volumechecker/shared';
import { M2Collector, openDatabase, runMigrations } from '@volumechecker/storage';
import { sameSwap } from '@volumechecker/engine';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { getPoolConfig as resolvePool } from '@volumechecker/shared';
import type { HealthResponse, InspectionSnapshot, PoolIdentityResponse } from '@volumechecker/shared';
import type { FetchLike, SocketFactory } from '@volumechecker/coingecko';
import { sqliteVersion } from '@volumechecker/storage';
import type { DestinationStream } from 'pino';
import type { LoadedConfig } from './config';
import { createLogger } from './logger';
import { InspectionMonitor } from './monitor';
import { AnalysisService } from './analysis';
import { OutcomeWorker } from './signals';
import { runSyntheticDemo } from './synthetic';
import { replaySaved } from './replay';
import type { Lifetime } from './lifetime';

export const MILESTONE = 'Local research dashboard with provisional analysis and durable outcomes';

/** Header required on mutation routes. A custom header forces a CORS preflight, which this server never grants. */
export const ACTION_HEADER = 'x-volumechecker-action';

export interface AppOptions {
  loaded: LoadedConfig;
  demoAccess?: DemoAccess;
  /** Fixed deployment window; after expiresAtMs no provider request or background job runs. */
  lifetime?: Lifetime;
  /** Clock override for lifetime tests. */
  now?: () => number;
  databasePath?: string;
  /** The configured CoinGecko key, used only for log redaction here. Never serialized. */
  apiKey: string | undefined;
  logLevel: string;
  /** Log sink override for tests. */
  logDestination?: DestinationStream;
  /** Built dashboard (apps/web/dist). Served only when it exists (production mode). */
  webDistDir?: string;
  /** Injected provider transports for tests; production uses fetch and ws. */
  fetchImpl?: FetchLike;
  socketFactory?: SocketFactory;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const logger = createLogger({
    level: opts.logLevel,
    secrets: [opts.apiKey],
    ...(opts.logDestination ? { destination: opts.logDestination } : {}),
  });
  const app = Fastify({ forceCloseConnections: true, loggerInstance: logger as FastifyBaseLogger, trustProxy: opts.demoAccess ? localProxyOnly : false });
  installJsonCompression(app);
  if (opts.demoAccess) installDemoAccess(app, opts.demoAccess);
  else {installLocalAccess(app);app.get('/api/access',async()=>({canManage:true,publicRead:false}));}
  app.addHook('onRequest',async(_req,reply)=>{reply.header('x-content-type-options','nosniff').header('x-frame-options','DENY').header('referrer-policy','same-origin').header('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");});
  const apiKeyConfigured = opts.apiKey !== undefined;
  const startedAt = Date.now();
  const { config, hash } = opts.loaded;
  const catalog=(config.pool.catalog??ALLOWED_POOLS).map(poolIdentity);
  const getPoolConfig=(id:string)=>resolvePool(id,catalog);
  const sqlite = sqliteVersion();
  const clock = opts.now ?? Date.now;
  let expired = opts.lifetime ? clock() >= opts.lifetime.expiresAtMs : false;
  const ENDED = 'The demonstration period has ended';
  const restStarts:number[]=[];
  const providerFetch:FetchLike=async(url,init)=>{
    if(expired)throw new Error('Deployment lifetime ended; provider requests are disabled');
    const now=Date.now();while(restStarts.length&&restStarts[0]!<=now-60000)restStarts.shift();
    if(restStarts.length>=config.budget.maxRestRequestsPerMinute)throw new Error('Shared local REST rate limit reached');
    restStarts.push(now);return (opts.fetchImpl??fetch)(url,init);
  };


  const databasePath = opts.databasePath ?? ':memory:';
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), {recursive:true});
  const db = openDatabase(databasePath);
  const versions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").get();
  const currentVersion = versions ? (db.prepare('SELECT max(version) v FROM _migrations').get() as {v:number|null}).v ?? 0 : 0;
  if (databasePath !== ':memory:' && currentVersion < 9) {
    await db.backup(`${databasePath}.before-v9-${Date.now()}.bak`);
  }
  const migration = runMigrations(db);
  if (migration.failed.length) { db.close(); throw new Error(migration.failed.join('; ')); }
  db.prepare("UPDATE sessions SET stopped_at_sec=unixepoch(),final_state='interrupted' WHERE stopped_at_sec IS NULL").run();
  let runtimeSelectedPoolId = config.pool.selectedPoolId as string;
  let stopping: Promise<void> | null = null;
  let operations: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = operations.then(action);
    operations = result.catch(() => undefined);
    return result;
  };
  const makeMonitor = (poolId: string, collect: boolean) => new InspectionMonitor({
    config, poolId, apiKey:opts.apiKey, log:app.log,
    ...(collect ? {collector:new M2Collector({sessionId:randomUUID(),selectedPoolId:poolId,pool:getPoolConfig(poolId)!,configHash:hash,db,
      matches:(ws,rest)=>sameSwap(ws,rest,config.reconciliation)})} : {}),
    fetchImpl:providerFetch,
    ...(opts.socketFactory ? {socketFactory:opts.socketFactory} : {}),
  });
  let monitor = makeMonitor(runtimeSelectedPoolId, false);
  const control = (poolId:string, enabled:boolean) => db.prepare('INSERT INTO collector_control VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET pool_id=excluded.pool_id,enabled=excluded.enabled').run(poolId,Number(enabled));
  const saved = db.prepare('SELECT pool_id,enabled FROM collector_control WHERE id=1').get() as {pool_id:string;enabled:number}|undefined;
  if (!expired && saved?.enabled && getPoolConfig(saved.pool_id) && apiKeyConfigured) {
    runtimeSelectedPoolId = saved.pool_id;
    monitor = makeMonitor(saved.pool_id,true);
    void monitor.start().then(()=>analysis.refreshAll()).catch(err=>app.log.error({err},'start refresh failed'));
  }
  const research = new ResearchService(db,config);
  const analysis = new AnalysisService(db,opts.loaded,()=>monitor.snapshot());
  analysis.refreshAll();
  const outcomes=new OutcomeWorker(db,{apiKey:opts.apiKey,fetchImpl:providerFetch});
  const outcomeTimer=expired?undefined:setInterval(()=>{void outcomes.tick().catch(err=>app.log.error({err},'outcome worker failed'));},30000);
  const analysisTimer = expired?undefined:setInterval(()=>{try {analysis.tick();const s=monitor.snapshot();if(s.activePoolId)research.observe(s,analysis.read(s.activePoolId),Date.now());} catch(err) {app.log.error({err},'analysis failed');}},config.polling.metricsRecomputeIntervalSec*1000);
  app.get('/api/analysis',async(req,reply)=>{
    const poolId=(req.query as {poolId?:string}).poolId ?? runtimeSelectedPoolId;
    if(!getPoolConfig(poolId))return reply.code(400).send({error:'Unknown pool'});
    try {const value=analysis.read(poolId);if((req.query as {view?:string}).view==='summary')return {...value,signals:value.signals.filter(s=>s.mode==='live'),metrics:value.metrics?{...value.metrics,windows:value.metrics.windows.filter(w=>w.minutes===config.scoring.currentWindowMinutes)}:null};return value;} catch {return reply.code(503).send({error:'Analysis storage unavailable'});}
  });
  // End of the deployment window: stop every provider request and background job, keep the database.
  // The desired collection state is left untouched; only the window decides whether collection may run.
  let expiryTimer: NodeJS.Timeout | undefined;
  const expire = (): Promise<void> => {
    if (expired) return Promise.resolve();
    expired = true;
    return serialize(async () => {
      clearInterval(analysisTimer); clearInterval(outcomeTimer);
      await outcomes.stop();
      stopping ??= monitor.stop();
      await stopping;
      stopping = null;
      const id=monitor.snapshot().persistence.sessionId;
      if(id)research.finish(id,Date.now(),Date.parse(monitor.snapshot().connectedSince??'')||undefined);
      analysis.refreshAll();
      db.pragma('wal_checkpoint(TRUNCATE)');
      app.log.warn({expiresAt:new Date(opts.lifetime!.expiresAtMs).toISOString()},'deployment lifetime ended; provider requests and background jobs stopped');
    });
  };
  if (opts.lifetime && !expired) {
    const arm = (): void => {
      const left = opts.lifetime!.expiresAtMs - clock();
      if (left <= 0) { void expire().catch(err=>app.log.error({err},'lifetime shutdown failed')); return; }
      expiryTimer = setTimeout(arm, Math.min(left, 2 ** 31 - 1));
    };
    arm();
  }
  // Shutdown preserves the desired run state; explicit Disconnect disables restart recovery.
  app.addHook('onClose', async () => { clearTimeout(expiryTimer); clearInterval(analysisTimer); clearInterval(outcomeTimer); await outcomes.stop(); await operations; await (stopping ?? monitor.stop());const id=monitor.snapshot().persistence.sessionId;if(id)research.finish(id,Date.now(),Date.parse(monitor.snapshot().connectedSince??'')||undefined); db.close(); });

  // Mutation guard: loopback Host header (DNS-rebinding defence) + custom action header (cross-site defence).
  const guardMutation = (req: { headers: Record<string, string | string[] | undefined> }): string | null => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) && req.headers.host !== (opts.demoAccess ? new URL(opts.demoAccess.origin).host : undefined)) return 'host not allowed';
    const origin = req.headers.origin;
    const localOrigins = ['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:8787','http://localhost:8787',`http://${String(req.headers.host)}`];
    if (origin !== undefined && (typeof origin !== 'string' || !(opts.demoAccess ? [opts.demoAccess.origin, ...['127.0.0.1','localhost','[::1]'].map(h=>`http://${h}:${opts.demoAccess!.port}`)] : localOrigins).includes(origin))) return 'origin not allowed';
    if (req.headers[ACTION_HEADER] !== '1') return `missing ${ACTION_HEADER} header`;
    return null;
  };

  app.post('/api/replay',async(req,reply)=>{
    const denied=guardMutation(req);if(denied)return reply.code(403).send({error:denied});
    if(expired)return reply.code(410).send({error:ENDED});
    const poolId=(req.body as {poolId?:unknown}|null)?.poolId;
    if(typeof poolId!=='string'||!getPoolConfig(poolId))return reply.code(400).send({error:'Allowlisted poolId required'});
    return replaySaved(db,opts.loaded,poolId);
  });
  app.post('/api/synthetic-demo',async(req,reply)=>{
    const denied=guardMutation(req);if(denied)return reply.code(403).send({error:denied});
    if(expired)return reply.code(410).send({error:ENDED});
    const poolId=(req.body as {poolId?:unknown}|null)?.poolId;
    if(typeof poolId!=='string'||!getPoolConfig(poolId))return reply.code(400).send({error:'Allowlisted poolId required'});
    return {mode:'synthetic',signals:runSyntheticDemo(db,opts.loaded,poolId)};
  });
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    milestone: MILESTONE,
    serverTimeUtc: new Date().toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    config: {
      configVersion: config.configVersion,
      configHash: hash,
      approvalStatus: config.approval.status,
      liveAlertsEnabled: config.alerts.liveAlertsEnabled,
    },
    provider: {
      apiKeyConfigured,
      ...monitor.status(),
    },
    storage: { driver: 'better-sqlite3', sqliteVersion: sqlite },
    ...(opts.lifetime ? { lifetime: { startedAt: new Date(opts.lifetime.startedAtMs).toISOString(), expiresAt: new Date(opts.lifetime.expiresAtMs).toISOString(), expired, collectorActive: monitor.snapshot().activePoolId !== null } } : {}),
  }));

  app.get('/api/pool', async (): Promise<PoolIdentityResponse> => {
    const poolConfig = getPoolConfig(runtimeSelectedPoolId);
    if (!poolConfig) throw new Error(`Unknown pool ID: ${config.pool.selectedPoolId}`);
    return {
      networkId: poolConfig.networkId,
      poolAddress: poolConfig.poolAddress,
      trackedTokenAddress: poolConfig.baseAddress ?? '',
      counterTokenAddress: poolConfig.quoteAddress ?? '',
      // Orientation is never taken from configuration; it becomes
      // 'verified' only from actual CoinGecko metadata.
      orientationStatus: 'unverified',
      source: 'fixed-contract',
      displayTimeZone: config.ui.displayTimeZone,
      riskDisclaimer: config.ui.riskDisclaimer,
    };
  });

  app.get('/api/pools', async () => {
    return {
      poolIds: catalog.map(p=>`${p.networkId}:${p.poolAddress}`),
      pools: catalog,
      selectedPoolId: runtimeSelectedPoolId,
    };
  });

  app.get('/api/reports',async()=>research.list());
  app.get('/api/report',async(req,reply)=>{
    const q=req.query as {id?:string;format?:string};const report=research.report(q.id??'');
    if(!report)return reply.code(404).send({error:'Report not found'});
    if(q.format==='csv')return reply.type('text/csv').header('content-disposition','attachment; filename="session-report.csv"').send(reportCsv(report));
    return reply.header('content-disposition','attachment; filename="session-report.json"').send(report);
  });
  app.get('/api/signal',async(req,reply)=>{const value=research.signal((req.query as {id?:string}).id??'');return value??reply.code(404).send({error:'Signal not found'});});
  app.get('/api/case',async(req,reply)=>{const id=Number((req.query as {id?:string}).id);if(!Number.isSafeInteger(id)||id<1)return reply.code(400).send({error:'Invalid case id'});const value=research.case(id);return value??reply.code(404).send({error:'Case not found'});});
  app.get('/api/research',async(req,reply)=>{const poolId=(req.query as {poolId?:string}).poolId??runtimeSelectedPoolId;if(!getPoolConfig(poolId))return reply.code(400).send({error:'Unknown pool'});return research.summary(poolId);});
  app.get('/api/inspection', async (req): Promise<InspectionSnapshot> => {const s=monitor.snapshot();return (req.query as {view?:string}).view==='summary'?{...s,trades:[],candles:[],rawSamples:[],priceObservations:[],controlFrames:[],checks:[],capabilities:[]}:s;});

  app.post('/api/inspection/start', async (req, reply) => {
    const denied = guardMutation(req);
    if (denied) return reply.code(403).send({ error: denied });
    const poolId = (req.body as {poolId?:unknown}|null)?.poolId;
    if (typeof poolId !== 'string' || !getPoolConfig(poolId)) return reply.code(400).send({error:'An allowlisted poolId is required'});
    if (expired) return reply.code(410).send({error:ENDED});
    return serialize(async () => {
    if (expired) return reply.code(410).send({error:ENDED});
    if (stopping) return reply.code(409).send({error:'Disconnect is still completing'});
    const state = monitor.snapshot();
    if (state.activePoolId) {
      if (state.activePoolId !== poolId) return reply.code(409).send({error:'Disconnect to change pool'});
      return reply.code(202).send({accepted:true,poolId});
    }
    if (!apiKeyConfigured) return reply.code(409).send({error:'Server API key is not configured'});
    // Reserve ownership before any await so simultaneous tabs cannot create another collector.
    stopping = monitor.stop();
    await stopping;
    stopping = null;
    runtimeSelectedPoolId = poolId;
    monitor = makeMonitor(poolId,true);
    control(poolId,true);
    void monitor.start().then(()=>analysis.refreshAll()).catch(err=>app.log.error({err},'start refresh failed'));
    return reply.code(202).send({accepted:true,poolId});
    });
  });

  app.post('/api/inspection/stop', async (req, reply) => {
    const denied = guardMutation(req);
    if (denied) return reply.code(403).send({error:denied});
    return serialize(async () => {
    control(runtimeSelectedPoolId,false);
    stopping ??= monitor.stop();
    await stopping;
    stopping = null;
    const reportId=monitor.snapshot().persistence.sessionId;
    if(reportId)research.finish(reportId,Date.now(),Date.parse(monitor.snapshot().connectedSince??'')||undefined);
    analysis.refreshAll();
    return reply.send({accepted:true,reportId});
    });
  });

  if (opts.webDistDir && existsSync(opts.webDistDir)) {
    await app.register(fastifyStatic, { root: opts.webDistDir });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (req.method === 'GET' && path !== '/api' && !path.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
