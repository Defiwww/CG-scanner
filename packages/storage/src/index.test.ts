import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, sqliteVersion } from './index';

describe('better-sqlite3 native module on this machine', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('loads and reports the SQLite version', () => {
    expect(sqliteVersion()).toMatch(/^3\.\d+\.\d+$/);
  });

  it('opens a file database in WAL mode with foreign keys enforced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'volumechecker-storage-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'smoke.sqlite'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      db.exec('create table parent (id integer primary key); create table child (pid integer references parent(id));');
      expect(() => db.prepare('insert into child (pid) values (42)').run()).toThrow(/FOREIGN KEY/);
      const insert = db.transaction(() => {
        db.prepare('insert into parent (id) values (1)').run();
        db.prepare('insert into child (pid) values (1)').run();
      });
      insert();
      expect((db.prepare('select count(*) as n from child').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});
