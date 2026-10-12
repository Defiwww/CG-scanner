import { AnalysisPanel } from './AnalysisPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CandleObservation,
  CapabilityState,
  Indicator,
  InspectionSnapshot,
  PoolIdentityResponse,
  PoolConfig,
  RawSample,
  TradeObservation,
} from '@volumechecker/shared';

// Must match ACTION_HEADER in apps/server/src/app.ts.
const ACTION_HEADER = 'x-volumechecker-action';
const POLL_MS = 5000;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

function useOnce<T>(url: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    getJson<T>(url, ctrl.signal).then(setData, () => undefined);
    return () => ctrl.abort();
  }, [url]);
  return data;
}

function short(a: string | null, head = 6, tail = 4): string {
  if (!a) return '—';
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

function makeTimeFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return (iso: string | null): string => (iso ? fmt.format(new Date(iso)) : '—');
}

function utcTime(iso: string | null): string {
  return iso ? `${iso.slice(11, 19)}Z` : '—';
}

function fmtNum(v: string | null, digits = 4): string {
  if (v === null) return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits }) : v;
}

function IndicatorCard({ title, ind }: { title: string; ind: Indicator }) {
  return (
    <div className={`indicator ind-${ind.state}`}>
      <div className="ind-title">{title}</div>
      <div className="ind-state">{ind.state.toUpperCase()}</div>
      <div className="ind-meta">{ind.ageSec !== null ? `${ind.ageSec}s ago` : 'no event'}</div>
      <div className="ind-detail">{ind.detail}</div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{status}</span>;
}

function TradesTable({ trades, local, asset, quote }: { trades: TradeObservation[]; local: (iso: string | null) => string; asset: string; quote: string }) {
  if (trades.length === 0) return <p className="muted">No trades observed yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Delivery</th>
            <th>Received (UTC)</th>
            <th>Provider time (UTC)</th>
            <th className="num">Delivery lag</th>
            <th>Block time (UTC)</th>
            <th>Side vs {asset}</th>
            <th className="num">{asset}</th>
            <th className="num">{quote}</th>
            <th className="num">USD</th>
            <th className="num">{asset}/USD</th>
            <th>Tx</th>
            <th>Sender</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={`${t.providerTradeId ?? t.txHash}-${t.receivedAt}-${i}`}>
              <td>
                <span className={`src src-${t.source}`}>{t.source.toUpperCase()}</span>
              </td>
              <td className={`small delivery-${t.delivery}`}>{t.delivery}</td>
              <td className="mono" title={`Local: ${local(t.receivedAt)}`}>{utcTime(t.receivedAt)}</td>
              <td className="mono" title={t.providerTimeMs !== null ? `t=${t.providerTimeMs} ms (provider update time, not block time)` : ''}>
                {t.providerTimeMs !== null ? utcTime(new Date(t.providerTimeMs).toISOString()) : '—'}
              </td>
              <td className="num mono" title="Local receipt minus provider time t">{t.deliveryLagMs !== null ? `${(t.deliveryLagMs / 1000).toFixed(1)}s` : '—'}</td>
              <td className="mono">{t.blockTimestamp ? utcTime(t.blockTimestamp) : '—'}</td>
              <td title={`basis: ${t.sideBasis}; provider label: ${t.providerSideLabel ?? 'null'}`}>
                <span className={`side side-${t.side ?? 'unknown'}`}>{t.side ?? 'unknown'}</span>
                <span className="muted small"> ({t.providerSideLabel ?? '∅'})</span>
              </td>
              <td className="num mono">{fmtNum(t.trackedAmount)}</td>
              <td className="num mono">{fmtNum(t.counterAmount, 6)}</td>
              <td className="num mono">{fmtNum(t.volumeUsd, 2)}</td>
              <td className="num mono" title={t.trackedPriceBasis}>{fmtNum(t.trackedPriceUsd, 4)}</td>
              <td className="mono" title={t.txHash ?? ''}>{short(t.txHash, 8, 6)}</td>
              <td className="mono" title={t.senderAddress ?? 'not provided by this source'}>{short(t.senderAddress)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandlesTable({ candles }: { candles: CandleObservation[] }) {
  if (candles.length === 0) return <p className="muted">No candles observed yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Open (UTC)</th>
            <th>Token side</th>
            <th className="num">Open</th>
            <th className="num">High</th>
            <th className="num">Low</th>
            <th className="num">Close</th>
            <th className="num">Volume USD</th>
            <th className="num">Updates</th>
          </tr>
        </thead>
        <tbody>
          {candles.slice(0, 15).map((c) => (
            <tr key={`${c.source}-${c.openTimeSec}`}>
              <td>
                <span className={`src src-${c.source}`}>{c.source.toUpperCase()}</span>
              </td>
              <td className="mono" title={`t=${c.openTimeSec} s`}>{utcTime(new Date(c.openTimeSec * 1000).toISOString())}</td>
              <td>{c.tokenSide ?? '—'}</td>
              <td className="num mono">{fmtNum(c.open)}</td>
              <td className="num mono">{fmtNum(c.high)}</td>
              <td className="num mono">{fmtNum(c.low)}</td>
              <td className="num mono">{fmtNum(c.close)}</td>
              <td className="num mono">{fmtNum(c.volumeUsd, 2)}</td>
              <td className="num mono">{c.updates}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RawPanel({ samples }: { samples: RawSample[] }) {
  const [kind, setKind] = useState<RawSample['kind']>('ws_trade');
  const selected = samples.find((s) => s.kind === kind) ?? null;
  const kinds: RawSample['kind'][] = ['ws_trade', 'rest_trade', 'ws_candle', 'rest_pool_metadata', 'rest_ohlcv'];
  let pretty = selected?.rawText ?? '';
  try {
    pretty = JSON.stringify(JSON.parse(pretty), null, 2);
  } catch {
    /* show as received */
  }
  return (
    <section className="card">
      <h2>Raw provider payload and field mapping</h2>
      <div className="tabs">
        {kinds.map((k) => (
          <button key={k} className={k === kind ? 'tab active' : 'tab'} onClick={() => setKind(k)} disabled={!samples.some((s) => s.kind === k)}>
            {k}
          </button>
        ))}
      </div>
      {selected ? (
        <>
          <p className="muted small">
            {selected.endpointOrChannel} · received {selected.receivedAt} · genuine live payload, credentials scrubbed (none present)
          </p>
          <div className="raw-grid">
            <div>
              <h3>Raw (as received)</h3>
              <pre className="raw">{pretty.length > 6000 ? `${pretty.slice(0, 6000)}\n… (truncated for display)` : pretty}</pre>
            </div>
            <div>
              <h3>Extracted fields</h3>
              <pre className="raw">{JSON.stringify(selected.mapped, null, 2)}</pre>
            </div>
          </div>
        </>
      ) : (
        <p className="muted">No {kind} payload received yet.</p>
      )}
    </section>
  );
}

function CapabilityTable({ caps }: { caps: CapabilityState[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Endpoint / channel</th>
            <th>Status</th>
            <th>HTTP</th>
            <th>Last success (UTC)</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {caps.map((c) => (
            <tr key={c.id}>
              <td className="mono small">{c.label}</td>
              <td>
                <StatusChip status={c.status} />
              </td>
              <td className="mono">{c.httpStatus ?? '—'}</td>
              <td className="mono">{utcTime(c.lastSuccessAt)}</td>
              <td className="small">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function App() {
  const canManage = true;
  const [diagnosticsOpen,setDiagnosticsOpen]=useState(false);
  const pool = useOnce<PoolIdentityResponse>('/api/pool');
  const pools = useOnce<{ poolIds: string[]; selectedPoolId: string; pools: PoolConfig[] }>('/api/pools');
  const lifetime = useOnce<{ lifetime?: { expiresAt: string; expired: boolean } }>('/api/health')?.lifetime;
  const [serverSnap, setSnap] = useState<InspectionSnapshot | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const actionRevision = useRef(0);
  const [selectedPoolId, setSelectedPoolId] = useState('');
  const effectivePoolId = serverSnap?.activePoolId ?? (selectedPoolId || pools?.selectedPoolId || '');
  const displayedPool = pools?.pools.find(p=>`${p.networkId}:${p.poolAddress}`===effectivePoolId);
  const snap = serverSnap && `${serverSnap.pool.networkId}:${serverSnap.pool.poolAddress}`===effectivePoolId ? serverSnap : null;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const revision = actionRevision.current;
      return getJson<InspectionSnapshot>(diagnosticsOpen?'/api/inspection':'/api/inspection?view=summary').then(
        (s) => {
          if (!cancelled && !acting.current && revision === actionRevision.current) {
            setSnap(s);
            setApiError(null);
          }
        },
        (err: unknown) => !cancelled && setApiError(err instanceof Error ? err.message : String(err)),
      ).finally(() => { if (!cancelled) timer = setTimeout(tick, POLL_MS); });
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [diagnosticsOpen]);

  const act = useCallback(async (action: 'start' | 'stop') => {
    if (acting.current) return;
    acting.current = true;
    actionRevision.current++;
    setBusy(true);
    try {
      const res = await fetch(`/api/inspection/${action}`, { method:'POST', headers:{[ACTION_HEADER]:'1','content-type':'application/json'},
        body:JSON.stringify(action === 'start' ? {poolId:effectivePoolId} : {}) });
      if (!res.ok) {
        const error = await res.json() as {error?:string};
        throw new Error(error.error ?? `${action} returned HTTP ${res.status}`);
      }
      setSnap(await getJson<InspectionSnapshot>('/api/inspection'));
      setApiError(null);
    } catch(err) { setApiError(err instanceof Error ? err.message : 'Request failed'); }
    finally { acting.current=false; setBusy(false); }
  }, [effectivePoolId]);

  const tz = pool?.displayTimeZone ?? 'UTC';
  const local = makeTimeFormatter(tz);
  const running = !!serverSnap?.activePoolId;

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1>{displayedPool ? `${displayedPool.baseName}/${displayedPool.quoteName} · ${displayedPool.networkId}` : 'VolumeChecker'}</h1>
          <p className="muted">Spot weakening flow beneath a steady price · CoinGecko data</p>
        </div>
        <div className="controls">
          <select
            disabled={!canManage || busy || running}
            style={{ padding: '0.5em', marginRight: '0.5em' }}
            aria-label="Pool"
            value={effectivePoolId}
            onChange={(e) => setSelectedPoolId(e.target.value)}
            title={running ? 'Disconnect to change pool' : undefined}
          >
            {pools?.poolIds.map(pid => (
              <option key={pid} value={pid}>
                {(()=>{const p=pools.pools.find(p=>`${p.networkId}:${p.poolAddress}`===pid);return p?`${p.networkId} ${p.baseName}/${p.quoteName}`:pid;})()}
              </option>
            ))}
          </select>
          {running && <span className="muted small" style={{ marginRight: '0.5em' }}>Disconnect to change pool</span>}
          {canManage && <><button onClick={() => act('start')} disabled={busy || running || !serverSnap?.apiKeyConfigured || !effectivePoolId}>
            Connect
          </button>
          <button onClick={() => act('stop')} disabled={busy || !running}>
            Stop Monitoring
          </button></>}
        </div>
      </header>



      {apiError && <section className="error-box">Server API unavailable: {apiError}</section>}
      {lifetime && <section className={lifetime.expired ? 'error-box' : 'card'}>{lifetime.expired
        ? <><strong>The demonstration period has ended.</strong> Data collection is stopped; saved history remains readable until the server is switched off.</>
        : <>Time-limited demonstration: data collection stops on <strong>{new Intl.DateTimeFormat('en-GB',{timeZone:tz,dateStyle:'medium',timeStyle:'short'}).format(new Date(lifetime.expiresAt))} ({tz})</strong>.</>}</section>}
      <section className="card"><strong>Shared session</strong><p>All open dashboards share the same session. Connecting, stopping or switching the pool affects every viewer. One shared collector · 10 commands/minute. Alerts require fresh data and confirmation.</p></section>
      {effectivePoolId && <AnalysisPanel poolId={effectivePoolId} active={running} canManage={canManage}/>}
      <details onToggle={e=>setDiagnosticsOpen(e.currentTarget.open)}><summary>Advanced / Diagnostics — provider data and collection</summary>
      <section className="monitor" aria-live="polite">
        <strong>{running ? ({connecting:'Connecting',waiting:'Connected — waiting for a new trade',receiving:'Receiving trades',reconnecting:'Reconnecting',error:'Error',disconnected:'Disconnected'}[serverSnap!.connectionState]) : serverSnap?.connectionState === 'error' && snap ? 'Error' : 'Disconnected'}</strong>

        <span> · {snap?.newTrades ?? 0} new confirmed trades · Storage: {snap?.persistence.state ?? 'not collecting'}</span>
        <p>Last unique new trade (UTC): <strong>{snap?.lastNewTradeAt ?? 'None yet'}</strong></p>

        {snap?.persistence.error && <p className="error">{snap.persistence.error}</p>}

        {snap?.monitor === 'blocked' && <p className="error">{snap.monitorDetail}</p>}
      </section>


      <p>Pool: {displayedPool?.networkId}:{displayedPool?.poolAddress}</p>
      <p>{snap?.recovery.detail} · Saved swaps: {snap?.persistence.canonicalTrades} · WS pending: {snap?.persistence.pendingWs}; ambiguous: {snap?.persistence.ambiguousWs}</p>
      {snap && (
        <>
          <section className="indicators">
            <IndicatorCard title="Transport" ind={snap.indicators.transport} />
            <IndicatorCard title={`${displayedPool?.baseName??'Token'}/USD price freshness`} ind={snap.indicators.priceFreshness} />
            <IndicatorCard title="WS trade activity" ind={snap.indicators.tradeInactivity} />
            <IndicatorCard title="USD reserve freshness" ind={snap.indicators.reserveFreshness} />
          </section>

          <section className="grid">
            <article className="card">
              <h2>{`${displayedPool?.baseName??'Token'}/USD`}</h2>
              {snap.latestPrice ? (
                <>
                  <div className="price">${fmtNum(snap.latestPrice.priceUsd, 4)}</div>
                  <dl>
                    <dt>Source</dt>
                    <dd>{snap.latestPrice.source}</dd>
                    <dt>Provider time</dt>
                    <dd className="mono">
                      {snap.latestPrice.providerTime ?? '—'} ({snap.latestPrice.providerTimeKind})
                    </dd>
                    <dt>Evidence time (receipt for metadata; provider update time unknown)</dt>
                    <dd className="mono" title={local(snap.latestPrice.asOf)}>{snap.latestPrice.asOf}</dd>
                    <dt>Received</dt>
                    <dd className="mono" title={local(snap.latestPrice.receivedAt)}>{snap.latestPrice.receivedAt}</dd>
                  </dl>
                  <h3>Recent observations</h3>
                  <ul className="obs">
                    {snap.priceObservations.slice(0, 8).map((p, i) => (
                      <li key={`${p.receivedAt}-${i}`} className="mono small">
                        {utcTime(p.receivedAt)} · {p.source} · ${fmtNum(p.priceUsd, 4)}
                        {p.providerTime ? ` · provider ${utcTime(p.providerTime)} (${p.providerTimeKind})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted">No {displayedPool?.baseName??'Token'}/USD observation yet.</p>
              )}
            </article>

            <article className="card">
              <h2>Pool identity</h2>
              <dl>
                <dt>Network</dt>
                <dd>{snap.pool.networkId}</dd>
                <dt>Pool</dt>
                <dd className="mono">{snap.pool.poolAddress}</dd>
                <dt>Base token</dt>
                <dd className="mono">{snap.orientation.baseTokenAddress ?? '—'}</dd>
                <dt>Quote token</dt>
                <dd className="mono">{snap.orientation.quoteTokenAddress ?? '—'}</dd>
                <dt>Orientation</dt>
                <dd>{snap.orientation.detail}</dd>
                <dt>Verified at</dt>
                <dd className="mono">{snap.orientation.verifiedAt ?? '—'}</dd>
                <dt>USD reserve</dt>
                <dd className="mono">{snap.reserve ? `$${fmtNum(snap.reserve.reserveUsd, 0)} (received ${utcTime(snap.reserve.receivedAt)})` : '—'}</dd>
              </dl>
            </article>

            <article className="card">
              <h2>Connection and subscriptions</h2>
              <dl>
                <dt>Transport</dt>
                <dd>{snap.transport.state}</dd>
                <dt>Connected at</dt>
                <dd className="mono">{snap.transport.connectedAt ?? '—'}</dd>
                <dt>Last frame</dt>
                <dd className="mono">{snap.transport.lastFrameAt ?? '—'}</dd>
                <dt>Last heartbeat</dt>
                <dd className="mono">
                  {snap.transport.lastHeartbeatAt ?? '—'} {snap.transport.heartbeatKind ? `(${snap.transport.heartbeatKind})` : ''}
                </dd>
                <dt>Reconnects</dt>
                <dd>{snap.transport.reconnects}</dd>
                {snap.transport.subscriptions.map((s) => (
                  <div key={s.channel} className="contents">
                    <dt>{s.channel}</dt>
                    <dd>
                      {s.confirmed ? 'confirmed' : 'not confirmed'} · {s.poolsSet ? 'pool set' : 'pool not set'} · {s.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </article>
          </section>

          <section className="card">
            <h2>Canonical trades ({snap.trades.filter(t=>t.source==='rest').length})</h2>
            <p className="muted small">
              WS = OnchainTrade stream (provider update time, no sender); REST = trades endpoint (block time, sender). On subscribe CoinGecko
              replays the latest existing trade — shown as <em>subscription-replay</em>, not live activity. Side is relative to the selected tracked asset using verified orientation. REST IDs identify canonical swaps; WS observations are provisional and do not increase the confirmed new-trade counter.
            </p>
            <TradesTable trades={snap.trades.filter(t=>t.source==='rest')} local={local} asset={displayedPool?.baseName ?? 'Asset'} quote={displayedPool?.quoteName ?? 'Quote'} />
          </section>

          <section className="card">
            <h2>1m candles ({displayedPool?.baseName}, USD)</h2>
            <CandlesTable candles={snap.candles} />
          </section>

          <RawPanel samples={snap.rawSamples} />

          <section className="card">
            <h2>CoinGecko endpoints and channels (runtime status)</h2>
            <CapabilityTable caps={snap.capabilities} />
            <h3>Mapping checks</h3>
            {snap.checks.length === 0 ? (
              <p className="muted">No checks evaluated yet.</p>
            ) : (
              <ul className="checks">
                {snap.checks.map((c) => (
                  <li key={c.id}>
                    <StatusChip status={c.status} /> <span className="mono small">{c.id}</span> — {c.detail}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid">
            <article className="card">
              <h2>Errors ({snap.errors.length})</h2>
              {snap.errors.length === 0 ? (
                <p className="muted">None.</p>
              ) : (
                <ul className="errors">
                  {snap.errors.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="small">
                      <span className="mono">{utcTime(e.at)}</span> {e.operation} · {e.kind}
                      {e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''} — {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article className="card">
              <h2>Usage (local estimate)</h2>
              <dl>
                <dt>REST attempts / ok / errors</dt>
                <dd>
                  {snap.usage.restAttempts} / {snap.usage.restSuccesses} / {snap.usage.restErrors}
                </dd>
                <dt>WS data / control / heartbeats</dt>
                <dd>
                  {snap.usage.wsDataMessages} / {snap.usage.wsControlMessages} / {snap.usage.wsHeartbeats}
                </dd>
                <dt>Estimated credits</dt>
                <dd>{snap.usage.estimatedCredits}</dd>
              </dl>
              <p className="muted small">{snap.usage.note}</p>
            </article>
            <article className="card">
              <h2>Control frames</h2>
              {snap.controlFrames.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="obs">
                  {snap.controlFrames.slice(0, 8).map((f, i) => (
                    <li key={`${f.receivedAt}-${i}`} className="mono small">
                      {utcTime(f.receivedAt)} {f.rawText.slice(0, 160)}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>
        </>
      )}

      </details>
      <footer className="footer">{pool?.riskDisclaimer ?? ''}</footer>
    </main>
  );
}
