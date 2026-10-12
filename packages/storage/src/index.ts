import Database from 'better-sqlite3';
export { runMigrations, M2_SCHEMA_SQL } from './migrations';
export type {
  SessionRecord,
  TradeRecord,
  CandleRecord,
  RawEventRecord,
  PollingStateRecord,
} from './repositories';
export { M2Collector } from './collector';
export type { CollectorOptions } from './collector';

export type SqliteDatabase = Database.Database;

/**
 * Opens a SQLite database with the pragmas required by the architecture:
 * WAL journaling, enforced foreign keys and NORMAL sync. Under WAL, NORMAL
 * survives application crashes but can lose the most recent commits on power
 * loss or OS crash.
 * Migrations and transactional writes are available via runMigrations() and M2Collector.
 */
export function openDatabase(filename: string): SqliteDatabase {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Version of the SQLite library compiled into the native better-sqlite3 module. */
export function sqliteVersion(): string {
  const db = new Database(':memory:');
  try {
    return (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
  } finally {
    db.close();
  }
}

export { AnalysisRepository } from './analysis';
export { SignalRepository } from './signals';
export type { StoredJob } from './signals';
