import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appConfigSchema, canonicalJson, parseAppConfig } from './config';

const defaultConfig = (): Record<string, any> =>
  JSON.parse(readFileSync(new URL('../../../config/legacy-v0.json', import.meta.url), 'utf8'));

function issuesFor(cfg: unknown): string[] {
  const r = appConfigSchema.safeParse(cfg);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('config/legacy-v0.json', () => {
  it('validates against the schema', () => {
    expect(issuesFor(defaultConfig())).toEqual([]);
  });

  it('is marked proposed with live alerts disabled and no approval metadata', () => {
    const cfg = appConfigSchema.parse(defaultConfig());
    expect(cfg.approval).toMatchObject({ status: 'proposed', approvedBy: null, approvedAt: null, approvedContentHash: null });
    expect(cfg.alerts.liveAlertsEnabled).toBe(false);
  });

  it('carries the spec v0 weights and severity ramps unchanged', () => {
    const c = appConfigSchema.parse(defaultConfig()).scoring.components;
    expect([c.sellDominance, c.flowDeterioration, c.largeSellConcentration, c.buyerSizeDecline, c.usdReserveDecline]).toEqual([
      { weight: 30, ramp: { a: 0.5, b: 0.75 } },
      { weight: 25, ramp: { a: 0.1, b: 0.5 } },
      { weight: 20, ramp: { a: 0.25, b: 0.7 } },
      { weight: 15, ramp: { a: 0.1, b: 0.5 } },
      { weight: 10, ramp: { a: 0.5, b: 3.0 } },
    ]);
  });
});

describe('config schema guards', () => {
  it('rejects enabling live alerts on a proposed config', () => {
    const cfg = defaultConfig();
    cfg.alerts.liveAlertsEnabled = true;
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/^alerts\.liveAlertsEnabled:/));
  });

  it('rejects weights that do not sum to 100', () => {
    const cfg = defaultConfig();
    cfg.scoring.components.sellDominance.weight = 31;
    expect(issuesFor(cfg).length).toBeGreaterThan(0);
  });

  it('rejects state bands with a gap', () => {
    const cfg = defaultConfig();
    cfg.scoring.states[1].min = 31;
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/contiguously/));
  });

  it('rejects unknown keys', () => {
    const extra = defaultConfig();
    extra.scoring.unexpected = 1;
    expect(issuesFor(extra).length).toBeGreaterThan(0);
  });
});

describe('fixed identity and provider boundary', () => {
  const mutations: [string, (c: Record<string, any>) => void, RegExp][] = [
    ['arbitrary selected pool', (c) => (c.pool.selectedPoolId = 'eth:0x1234567890123456789012345678901234567890'), /^pool\.selectedPoolId:/],
    ['unknown network in pool ID', (c) => (c.pool.selectedPoolId = 'arbitrum:0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8'), /^pool\.selectedPoolId:/],
    ['foreign REST origin', (c) => (c.provider.restBaseUrl = 'http://example.invalid/collect'), /^provider\.restBaseUrl:/],
    ['CoinGecko REST over http', (c) => (c.provider.restBaseUrl = 'http://pro-api.coingecko.com/api/v3'), /^provider\.restBaseUrl:/],
    ['REST URL with userinfo', (c) => (c.provider.restBaseUrl = 'https://user:pass@pro-api.coingecko.com/api/v3'), /^provider\.restBaseUrl:/],
    ['demo API host', (c) => (c.provider.restBaseUrl = 'https://api.coingecko.com/api/v3'), /^provider\.restBaseUrl:/],
    ['foreign WS origin', (c) => (c.provider.wsUrl = 'wss://example.invalid/v1'), /^provider\.wsUrl:/],
    ['unencrypted WS', (c) => (c.provider.wsUrl = 'ws://stream.coingecko.com/v1'), /^provider\.wsUrl:/],
  ];
  for (const [name, mutate, path] of mutations) {
    it(`rejects ${name}`, () => {
      const cfg = defaultConfig();
      mutate(cfg);
      expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(path));
    });
  }
});

describe('approval records', () => {
  const approved = (approval: Record<string, unknown>) => {
    const cfg = defaultConfig();
    cfg.approval = { status: 'approved', note: 'TEST-ONLY record', approvedContentHash: 'a'.repeat(64), ...approval };
    cfg.alerts.liveAlertsEnabled = true;
    return cfg;
  };
  const validTime = '2026-10-01T12:00:00Z';

  it.each([
    ['null approver', { approvedBy: null, approvedAt: validTime }],
    ['empty approver', { approvedBy: '', approvedAt: validTime }],
    ['whitespace approver', { approvedBy: '   ', approvedAt: validTime }],
    ['padded approver', { approvedBy: ' Test ', approvedAt: validTime }],
    ['null date', { approvedBy: 'TEST-ONLY approver', approvedAt: null }],
    ['empty date', { approvedBy: 'TEST-ONLY approver', approvedAt: '' }],
    ['whitespace date', { approvedBy: 'TEST-ONLY approver', approvedAt: '  ' }],
    ['malformed date', { approvedBy: 'TEST-ONLY approver', approvedAt: 'not-a-date' }],
    ['date without time zone', { approvedBy: 'TEST-ONLY approver', approvedAt: '2026-10-01T12:00:00' }],
    ['missing content hash', { approvedBy: 'TEST-ONLY approver', approvedAt: validTime, approvedContentHash: null }],
    ['malformed content hash', { approvedBy: 'TEST-ONLY approver', approvedAt: validTime, approvedContentHash: 'abc' }],
  ])('rejects %s with live alerts enabled', (_name, approval) => {
    expect(issuesFor(approved(approval)).some((i) => i.startsWith('approval'))).toBe(true);
  });

  it('accepts a structurally complete approval record (content hash is verified by the server loader)', () => {
    expect(issuesFor(approved({ approvedBy: 'TEST-ONLY approver', approvedAt: validTime }))).toEqual([]);
  });

  it('rejects approval metadata on a proposed config', () => {
    const cfg = defaultConfig();
    cfg.approval.approvedBy = 'TEST-ONLY approver';
    expect(issuesFor(cfg).some((i) => i.startsWith('approval'))).toBe(true);
  });

  it('still rejects proposed + live alerts enabled', () => {
    const cfg = defaultConfig();
    cfg.alerts.liveAlertsEnabled = true;
    expect(issuesFor(cfg).length).toBeGreaterThan(0);
  });
});

describe('immutable validated snapshot', () => {
  it('deep-freezes nested objects and arrays', () => {
    const cfg = parseAppConfig(defaultConfig()) as any;
    const before = canonicalJson(cfg);
    expect(() => (cfg.alerts.liveAlertsEnabled = true)).toThrow(TypeError);
    expect(() => (cfg.approval.status = 'approved')).toThrow(TypeError);
    expect(() => (cfg.scoring.components.sellDominance.weight = 100)).toThrow(TypeError);
    expect(() => (cfg.scoring.components.sellDominance.ramp.a = 0)).toThrow(TypeError);
    expect(() => (cfg.scoring.states[0].max = 99)).toThrow(TypeError);
    expect(() => cfg.outcomes.horizonsMinutes.push(1)).toThrow(TypeError);
    expect(() => (cfg.retry.backoffSec[0] = 99)).toThrow(TypeError);
    expect(canonicalJson(cfg)).toBe(before);
  });

  it('does not freeze or alias the caller input', () => {
    const input = defaultConfig();
    parseAppConfig(input);
    input.alerts.minScore = 1;
    expect(input.alerts.minScore).toBe(1);
  });
});

describe('cross-field configuration checks', () => {
  it('rejects every band renamed to Normal', () => {
    const cfg = defaultConfig();
    for (const band of cfg.scoring.states) band.name = 'Normal';
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/^scoring\.states: states must be exactly/));
  });

  it('rejects reordered state names', () => {
    const cfg = defaultConfig();
    [cfg.scoring.states[3].name, cfg.scoring.states[4].name] = [cfg.scoring.states[4].name, cfg.scoring.states[3].name];
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/^scoring\.states:/));
  });

  it('rejects a missing state', () => {
    const cfg = defaultConfig();
    cfg.scoring.states.pop();
    cfg.scoring.states[3].max = 100;
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/^scoring\.states:/));
  });

  it('accepts adjusted bounds that keep the five ordered states', () => {
    const cfg = defaultConfig();
    cfg.scoring.states[0].max = 24;
    cfg.scoring.states[1].min = 25;
    expect(issuesFor(cfg)).toEqual([]);
  });

  it('rejects an evaluation horizon that is not scheduled', () => {
    const cfg = defaultConfig();
    cfg.outcomes.evaluation.horizonMinutes = 123;
    expect(issuesFor(cfg)).toContainEqual(expect.stringMatching(/^outcomes\.evaluation\.horizonMinutes:/));
  });

  it('rejects duplicate or unordered horizons', () => {
    const dup = defaultConfig();
    dup.outcomes.horizonsMinutes = [5, 15, 15, 60, 240];
    expect(issuesFor(dup)).toContainEqual(expect.stringMatching(/^outcomes\.horizonsMinutes:/));
    const unordered = defaultConfig();
    unordered.outcomes.horizonsMinutes = [60, 5, 15, 240];
    expect(issuesFor(unordered)).toContainEqual(expect.stringMatching(/^outcomes\.horizonsMinutes:/));
  });
});

describe('canonicalJson', () => {
  it('is independent of key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('changes when a value changes', () => {
    expect(canonicalJson({ a: 0.5 })).not.toBe(canonicalJson({ a: 0.51 }));
  });

  it('uses JavaScript number spelling (documented cross-language caveat)', () => {
    expect(canonicalJson({ a: 3.0, b: 0.000001, c: 1e21 })).toBe('{"a":3,"b":0.000001,"c":1e+21}');
  });
});
