import { describe, expect, it } from 'vitest';
import { g2Frame, g3Frame } from '../../../tests/fixtures/synthetic/coingecko';
import { classifyText, setPoolsCommand, subscribeCommand } from './protocol';

const P = '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8';

describe('WebSocket envelopes', () => {
  it('serializes identifier and data as JSON strings exactly like the documented examples', () => {
    expect(subscribeCommand('OnchainTrade')).toBe('{"command":"subscribe","identifier":"{\\"channel\\":\\"OnchainTrade\\"}"}');
    expect(setPoolsCommand('OnchainTrade')).toBe(
      `{"command":"message","identifier":"{\\"channel\\":\\"OnchainTrade\\"}","data":"{\\"network_id:pool_addresses\\":[\\"eth:${P}\\"],\\"action\\":\\"set_pools\\"}"}`,
    );
    const g3 = JSON.parse(setPoolsCommand('OnchainOHLCV', { trackedTokenSide: 'quote' }));
    expect(typeof g3.identifier).toBe('string');
    expect(typeof g3.data).toBe('string');
    expect(JSON.parse(g3.data)).toEqual({ 'network_id:pool_addresses': [`eth:${P}`], interval: '1m', token: 'quote', action: 'set_pools' });
  });

  it('refuses an OHLCV subscription without a verified tracked token side', () => {
    expect(() => setPoolsCommand('OnchainOHLCV')).toThrow(/verified tracked token side/);
  });
});

describe('frame classification', () => {
  const one = (o: unknown) => classifyText(JSON.stringify(o))[0]!;

  it('separates connection, subscription and heartbeat frames from market data', () => {
    expect(one({ code: 3000, message: 'Connection established', uuid: 'x' }).kind).toBe('connection_established');
    expect(one({ type: 'welcome', sid: 'x' }).kind).toBe('welcome');
    expect(one({ type: 'confirm_subscription', identifier: '{"channel":"OnchainOHLCV"}' })).toEqual({ kind: 'confirm_subscription', channel: 'OnchainOHLCV' });
    expect(one({ type: 'reject_subscription', identifier: '{"channel":"OnchainTrade"}' })).toEqual({ kind: 'reject_subscription', channel: 'OnchainTrade' });
    expect(one({ code: 2000, message: `Subscription successful for eth:${P}` })).toMatchObject({ kind: 'pools_result', ok: true });
    expect(one({ code: 4001, message: 'bad' })).toMatchObject({ kind: 'provider_error', code: 4001 });
    expect(one({ type: 'ping', message: 1790000000 }).kind).toBe('heartbeat');
    expect(one({ type: 'disconnect', reason: 'unauthorized', reconnect: false })).toMatchObject({ kind: 'disconnect', reconnect: false });
  });

  it('classifies G2 as trade and G3 as candle even though G3 uses `c` for close', () => {
    expect(one(g2Frame()).kind).toBe('trade');
    expect(one(g3Frame()).kind).toBe('candle');
    expect(one(g3Frame({ c: 'G2' })).kind).toBe('trade'); // documents precedence: `c === "G2"` wins
  });

  it('handles batches, unknown objects and unparseable text', () => {
    expect(classifyText(JSON.stringify([g2Frame(), g3Frame()])).map((f) => f.kind)).toEqual(['trade', 'candle']);
    expect(one({ hello: 1 }).kind).toBe('unknown');
    expect(classifyText('not json')).toEqual([{ kind: 'unparseable' }]);
  });
});
