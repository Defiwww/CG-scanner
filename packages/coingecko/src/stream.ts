import { COINGECKO_ENDPOINTS, type TrackedTokenSide, type PoolConfig, type TransportState } from '@volumechecker/shared';
import WebSocket from 'ws';
import { API_KEY_HEADER, WS_CHANNELS, type WsChannelName } from './constants';
import { ProviderError } from './errors';
import { classifyText, setPoolsCommand, subscribeCommand, type ClassifiedFrame } from './protocol';
import type { UsageCounters } from './usage';

/**
 * One server-side CoinGecko WebSocket connection with serialized subscriptions:
 *   open → welcome → subscribe G2 → confirm → set_pools G2 → code 2000
 *        → subscribe G3 → confirm → set_pools G3 (1m, verified tracked token side) → code 2000 → streaming
 * Steps are serialized because the documented set_pools result (code 2000)
 * does not name its channel. The key is sent only as a connection header;
 * redirects are not followed. Reconnects use bounded backoff with jitter and
 * re-run the whole procedure. An HTTP 401/403 handshake stops reconnecting.
 */

export interface SocketLike {
  on(event: 'open', cb: () => void): unknown;
  on(event: 'message', cb: (data: WebSocket.RawData, isBinary: boolean) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'ping', cb: () => void): unknown;
  on(event: 'unexpected-response', cb: (req: unknown, res: { statusCode?: number }) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: 15_000 }) as unknown as SocketLike;

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StreamOptions {
  apiKey: string;
  pool: PoolConfig;
  trackedTokenSide: TrackedTokenSide;
  backoffSec: readonly number[];
  jitterFraction: number;
  /** Declare the connection dead after this long without any frame or ping. */
  silenceTimeoutMs: number;
  /** Max wait for each protocol step (welcome, confirm, pools result). */
  stepTimeoutMs: number;
  socketFactory?: SocketFactory;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  usage?: UsageCounters;
}

export interface StreamEvents {
  state(state: TransportState, detail: string): void;
  frame(frame: ClassifiedFrame, rawText: string, receivedAt: string): void;
  heartbeat(kind: 'ws-ping' | 'json-ping', at: string): void;
  subscription(channel: WsChannelName, step: 'confirmed' | 'pools_set' | 'rejected', detail: string): void;
  error(err: ProviderError): void;
}

type Step =
  | { name: 'await_welcome' }
  | { name: 'await_confirm'; channel: WsChannelName }
  | { name: 'await_pools'; channel: WsChannelName }
  | { name: 'streaming' };

const CHANNEL_ORDER: WsChannelName[] = [WS_CHANNELS.trade, WS_CHANNELS.ohlcv];

export class CoinGeckoStream {
  private socket: SocketLike | null = null;
  private step: Step = { name: 'await_welcome' };
  private stopped = true;
  private authFailed = false;
  private attempt = 0;
  private reconnects = 0;
  private stepTimer: unknown = null;
  private silenceTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private readonly listeners: { [K in keyof StreamEvents]: StreamEvents[K][] } = {
    state: [],
    frame: [],
    heartbeat: [],
    subscription: [],
    error: [],
  };
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly factory: SocketFactory;

  constructor(private readonly opts: StreamOptions) {
    this.timers = opts.timers ?? { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.factory = opts.socketFactory ?? defaultSocketFactory;
  }

  on<K extends keyof StreamEvents>(event: K, cb: StreamEvents[K]): void {
    this.listeners[event].push(cb);
  }

  private emit<K extends keyof StreamEvents>(event: K, ...args: Parameters<StreamEvents[K]>): void {
    for (const cb of this.listeners[event]) (cb as (...a: Parameters<StreamEvents[K]>) => void)(...args);
  }

  get reconnectCount(): number {
    return this.reconnects;
  }

  start(): void {
    if (!this.stopped) return; // idempotent
    this.stopped = false;
    this.authFailed = false;
    this.connect();
  }

  /** A bounded caller-triggered recovery follows the normal backoff; it never creates another collector. */
  recoverDelivery(): void {
    if(!this.stopped&&!this.authFailed&&this.step.name==='streaming')this.socket?.terminate();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((resolve) => {
      s.on('close', () => resolve());
      s.terminate();
    });
    this.emit('state', 'disconnected', 'stopped by server');
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private clearTimers(): void {
    for (const t of [this.stepTimer, this.silenceTimer, this.reconnectTimer]) if (t !== null) this.timers.clearTimeout(t);
    this.stepTimer = this.silenceTimer = this.reconnectTimer = null;
  }

  private connect(): void {
    const url = COINGECKO_ENDPOINTS.wsUrl;
    if (new URL(url).protocol !== 'wss:') throw new Error('refusing non-TLS WebSocket URL');
    this.step = { name: 'await_welcome' };
    this.emit('state', this.attempt === 0 ? 'connecting' : 'reconnecting', `connecting to ${url}`);
    this.opts.usage?.wsConnection();
    const socket = this.factory(url, { [API_KEY_HEADER]: this.opts.apiKey });
    this.socket = socket;

    socket.on('unexpected-response', (_req, res) => {
      if (socket !== this.socket) return;
      const status = res.statusCode ?? null;
      const auth = status === 401 || status === 403;
      if (auth) this.authFailed = true;
      this.emit('error', new ProviderError(auth ? 'auth' : 'http', 'ws.connect', 'handshake rejected', { httpStatus: status }));
      if (auth) this.emit('state', 'auth_failed', 'WebSocket handshake rejected the API key; not retrying');
      socket.terminate();
    });
    socket.on('open', () => {
      if (socket !== this.socket) return;
      this.emit('state', 'open', 'socket open; waiting for welcome');
      this.armStep('welcome');
      this.armSilence();
    });
    socket.on('ping', () => {
      if (socket !== this.socket) return;
      this.opts.usage?.wsHeartbeat();
      this.emit('heartbeat', 'ws-ping', this.iso());
      this.armSilence();
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== this.socket) return;
      this.armSilence();
      const text = isBinary ? '' : data.toString();
      const receivedAt = this.iso();
      for (const frame of classifyText(text)) this.onFrame(frame, text, receivedAt);
    });
    socket.on('error', () => {
      if (socket !== this.socket) return;
      // The ws error object may reference request options; only an allowlisted error is emitted.
      this.emit('error', new ProviderError('network', 'ws.socket', 'socket error'));
    });
    socket.on('close', (code) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped) return;
      if (this.authFailed) return;
      this.emit('state', 'reconnecting', `socket closed (code ${code})`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const seq = this.opts.backoffSec;
    const base = seq[Math.min(this.attempt, seq.length - 1)]!;
    const jitter = base * this.opts.jitterFraction * (this.random() * 2 - 1);
    this.attempt++;
    this.reconnects++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, Math.max(0, Math.round((base + jitter) * 1000)));
  }

  private armStep(what: string): void {
    if (this.stepTimer !== null) this.timers.clearTimeout(this.stepTimer);
    this.stepTimer = this.timers.setTimeout(() => {
      this.stepTimer = null;
      this.emit('error', new ProviderError('protocol', 'ws.protocol', `timed out waiting for ${what}`));
      this.socket?.terminate();
    }, this.opts.stepTimeoutMs);
  }

  private armSilence(): void {
    if (this.silenceTimer !== null) this.timers.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.timers.setTimeout(() => {
      this.silenceTimer = null;
      this.emit('error', new ProviderError('timeout', 'ws.heartbeat', `no frame or ping for ${this.opts.silenceTimeoutMs} ms`));
      this.socket?.terminate();
    }, this.opts.silenceTimeoutMs);
  }

  private send(text: string): void {
    this.opts.usage?.wsSent();
    this.socket?.send(text);
  }

  private subscribe(channel: WsChannelName): void {
    this.step = { name: 'await_confirm', channel };
    this.emit('state', 'subscribing', `subscribing to ${channel}`);
    this.send(subscribeCommand(channel));
    this.armStep(`${channel} confirmation`);
  }

  private onFrame(frame: ClassifiedFrame, rawText: string, receivedAt: string): void {
    if (frame.kind === 'trade' || frame.kind === 'candle') this.opts.usage?.wsData();
    else if (frame.kind === 'heartbeat') {
      this.opts.usage?.wsHeartbeat();
      this.emit('heartbeat', 'json-ping', receivedAt);
    } else this.opts.usage?.wsControl();
    this.emit('frame', frame, rawText, receivedAt);

    const step = this.step;
    switch (frame.kind) {
      case 'welcome':
        if (step.name === 'await_welcome') this.subscribe(CHANNEL_ORDER[0]!);
        return;
      case 'confirm_subscription':
        if (step.name === 'await_confirm' && frame.channel === step.channel) {
          this.emit('subscription', step.channel, 'confirmed', 'confirm_subscription received');
          this.step = { name: 'await_pools', channel: step.channel };
          this.send(setPoolsCommand(step.channel, { pool: this.opts.pool, trackedTokenSide: this.opts.trackedTokenSide }));
          this.armStep(`${step.channel} set_pools result`);
        }
        return;
      case 'reject_subscription':
        this.emit('subscription', (frame.channel as WsChannelName) ?? CHANNEL_ORDER[0]!, 'rejected', 'reject_subscription received');
        this.emit('error', new ProviderError('protocol', 'ws.subscribe', `subscription rejected for ${frame.channel ?? 'unknown channel'}`));
        return;
      case 'pools_result':
        if (step.name !== 'await_pools') return;
        if (!frame.ok) {
          this.emit('subscription', step.channel, 'rejected', frame.message ?? `code ${frame.code}`);
          this.emit('error', new ProviderError('protocol', 'ws.set_pools', `set_pools for ${step.channel} returned code ${frame.code}`));
          return;
        }
        this.emit('subscription', step.channel, 'pools_set', frame.message ?? 'code 2000');
        {
          const next = CHANNEL_ORDER[CHANNEL_ORDER.indexOf(step.channel) + 1];
          if (next) {
            this.subscribe(next);
          } else {
            this.step = { name: 'streaming' };
            if (this.stepTimer !== null) this.timers.clearTimeout(this.stepTimer);
            this.stepTimer = null;
            this.attempt = 0;
            this.emit('state', 'streaming', 'both channels subscribed; waiting for market data');
          }
        }
        return;
      case 'provider_error':
        this.emit('error', new ProviderError('protocol', 'ws.provider', `provider error code ${frame.code ?? 'n/a'}: ${frame.message ?? ''}`));
        return;
      case 'disconnect':
        this.emit('error', new ProviderError('protocol', 'ws.disconnect', `provider requested disconnect: ${frame.reason ?? 'no reason'}`));
        return;
      default:
        return;
    }
  }
}
