import type { SocketLike } from '@volumechecker/coingecko';

/** In-memory WebSocket double for protocol tests (no network). */
export class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  handlers: Record<string, ((...a: never[]) => void)[]> = {};
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  on(event: string, cb: (...a: never[]) => void) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers[event] ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  msg(obj: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close', 1000, Buffer.from(''));
  }
  terminate() {
    this.closed = true;
    this.emit('close', 1006, Buffer.from(''));
  }
}

/** Drives the documented handshake (welcome → G2 → G3) to the streaming state. */
export function handshake(s: FakeSocket, pool = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8') {
  s.emit('open');
  s.msg({ code: 3000, message: 'Connection established', uuid: 'u' });
  s.msg({ type: 'welcome', sid: 'u' });
  s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainTrade"}' });
  s.msg({ code: 2000, message: `Subscription successful for eth:${pool}` });
  s.msg({ type: 'confirm_subscription', identifier: '{"channel":"OnchainOHLCV"}' });
  s.msg({ code: 2000, message: `Subscription successful for eth:${pool}` });
}
