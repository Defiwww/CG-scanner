import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@volumechecker/shared';
import { approvalContentHash, configHash, loadAppConfig, validateAppConfig } from './config';
import { createHash } from 'node:crypto';

const configPath = fileURLToPath(new URL('../../../config/legacy-v0.json', import.meta.url));
const raw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

describe('loaded config and hash identity', () => {
  it('rejects mutation of nested settings and keeps the hash equal to the active settings', () => {
    const loaded = loadAppConfig(configPath) as any;
    expect(() => (loaded.config.alerts.liveAlertsEnabled = true)).toThrow(TypeError);
    expect(() => (loaded.config.scoring.components.buyerSizeDecline.weight = 0)).toThrow(TypeError);
    expect(() => (loaded.hash = 'x')).toThrow(TypeError);
    const independent = createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(loaded.config)))).digest('hex');
    expect(loaded.hash).toBe(independent);
    expect(configHash(loaded.config)).toBe(loaded.hash);
  });

  it('a changed setting is a new validated snapshot with a different hash', () => {
    const a = validateAppConfig(raw(), 'a');
    const changed = raw();
    changed.alerts.minScore = 71;
    const b = validateAppConfig(changed, 'b');
    expect(b.hash).not.toBe(a.hash);
    expect(a.config.alerts.minScore).toBe(70);
  });
});

describe('approval bound to exact settings', () => {
  // TEST-ONLY in-memory records; no real approval is created.
  function approvedConfig(contentHash: string | ((content: unknown) => string)) {
    const cfg = raw();
    cfg.alerts.liveAlertsEnabled = true;
    const { approval: _approval, ...content } = cfg;
    const hash = typeof contentHash === 'string' ? contentHash : contentHash(content);
    cfg.approval = { status: 'approved', approvedBy: 'TEST-ONLY approver', approvedAt: '2026-10-01T12:00:00Z', approvedContentHash: hash, note: 'test' };
    return cfg;
  }
  const independentHash = (content: unknown) => createHash('sha256').update(canonicalJson(content)).digest('hex');

  it('accepts an approval whose content hash matches the settings', () => {
    const loaded = validateAppConfig(approvedConfig(independentHash), 'approved');
    expect(loaded.config.approval.status).toBe('approved');
    expect(approvalContentHash(loaded.config)).toBe(loaded.config.approval.approvedContentHash);
  });

  it('rejects an approval whose content hash does not match (settings changed after sign-off)', () => {
    const cfg = approvedConfig(independentHash);
    cfg.alerts.minScore = 60; // changed after sign-off
    expect(() => validateAppConfig(cfg, 'tampered')).toThrow(/approvedContentHash does not match/);
  });
});

it('loads old approved v1 configs without adding rules or changing their frozen hashes',()=>{
 const original=JSON.parse(readFileSync(new URL('../../../config/default.json',import.meta.url),'utf8'));
 delete original.scoring.v1;
 original.approval.approvedContentHash=approvalContentHash(original);
 const before=configHash(original),loaded=validateAppConfig(original,'historical frozen config');
 expect(loaded.hash).toBe(before);expect(loaded.config.scoring.v1).toBeUndefined();
});
