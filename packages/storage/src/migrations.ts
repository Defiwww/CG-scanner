import type { SqliteDatabase } from './index';

/**
 * Schema migrations runner for durable ingestion.
 * Migrations are tracked in a _migrations table (bootstrap).
 * SQL for each migration is defined inline as constants (below).
 */

interface Migration {
  version: number;
  name: string;
  sql: string;
  apply?: (db: SqliteDatabase) => void;
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_sec INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
    );
  `);
}

/** Built-in SQL for the ingestion schema (inlined for bundled builds). */
export const M2_SCHEMA_SQL = `
-- Durable ingestion and recovery with SQLite.
-- Pragmas are set in openDatabase(); this migration creates the schema.
-- WAL mode, foreign keys enforced, NORMAL sync (survives app crash, not power loss).
-- All times are epoch seconds (Unix), except raw_text payloads which carry provider format.
-- Added network_id and pool_address for multi-pool support.

-- Sessions: lifecycle tracking, config snapshots, and pool identity.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  started_at_sec INTEGER NOT NULL,
  stopped_at_sec INTEGER,
  config_hash TEXT NOT NULL,
  final_state TEXT,
  error_detail TEXT,
  created_at_unix_sec INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

-- Raw events: unchanged REST responses and WS frames.
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('rest_pool_metadata', 'rest_trade', 'rest_ohlcv', 'ws_trade', 'ws_candle', 'ws_control')),
  endpoint_or_channel TEXT NOT NULL,
  received_at_sec INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  mapped TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS raw_events_session_kind ON raw_events(session_id, network_id, pool_address, kind);

-- Trades: REST and WS trades, deduplicated and reconciled.
-- provider_trade_id is UNIQUE per (network_id, pool_address) to prevent cross-pool conflicts.
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  provider_trade_id TEXT,
  tx_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('rest', 'ws')),
  block_timestamp_sec INTEGER,
  received_at_sec INTEGER NOT NULL,
  side TEXT CHECK(side IN ('buy', 'sell', NULL)),
  base_amount TEXT,
  quote_amount TEXT,
  volume_usd TEXT,
  base_price_usd TEXT,
  sender_address TEXT,
  ws_frames INTEGER DEFAULT 0,
  rest_raw_event_id INTEGER,
  ws_raw_event_id INTEGER,
  UNIQUE (network_id, pool_address, provider_trade_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (rest_raw_event_id) REFERENCES raw_events(id),
  FOREIGN KEY (ws_raw_event_id) REFERENCES raw_events(id)
);
CREATE INDEX IF NOT EXISTS trades_session_tx ON trades(session_id, network_id, pool_address, tx_hash);
CREATE INDEX IF NOT EXISTS trades_session_timestamp ON trades(session_id, network_id, pool_address, block_timestamp_sec DESC);
CREATE INDEX IF NOT EXISTS trades_provider_trade_id ON trades(network_id, pool_address, provider_trade_id);

-- Candles: OHLC + volume, reconciled from REST and WS.
-- UNIQUE constraint per (session_id, network_id, pool_address, open_time_sec) for pool isolation.
CREATE TABLE IF NOT EXISTS candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  open_time_sec INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('rest', 'ws')),
  open TEXT,
  high TEXT,
  low TEXT,
  close TEXT,
  volume_usd TEXT,
  update_count INTEGER DEFAULT 1,
  received_at_sec INTEGER NOT NULL,
  rest_raw_event_id INTEGER,
  ws_raw_event_id INTEGER,
  UNIQUE (session_id, network_id, pool_address, open_time_sec),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (rest_raw_event_id) REFERENCES raw_events(id),
  FOREIGN KEY (ws_raw_event_id) REFERENCES raw_events(id)
);
CREATE INDEX IF NOT EXISTS candles_session_time ON candles(session_id, network_id, pool_address, open_time_sec DESC);

-- Reconciliation state: tracks WS→REST matching per pool.
CREATE TABLE IF NOT EXISTS reconciliation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  ws_provider_trade_id TEXT,
  rest_provider_trade_id TEXT,
  matched_at_sec INTEGER,
  UNIQUE (network_id, pool_address, ws_provider_trade_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX IF NOT EXISTS reconciliation_session ON reconciliation_state(session_id, network_id, pool_address);

-- Polling state: REST pagination and rate-limit recovery.
CREATE TABLE IF NOT EXISTS polling_state (
  session_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  last_cursor TEXT,
  last_fetch_sec INTEGER,
  retry_after_until_sec INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`;

const M2_MIGRATION_002_SQL = `
-- Migration 002: Add pool identity columns for multi-pool support.
-- This migration runs on databases that already have M2_SCHEMA_SQL applied (migration 001).
-- New installations apply both 001 and 002 atomically; existing installations upgrade via 002.

-- Sessions: add network_id and pool_address (backfill with Ethereum defaults).
-- ALTER is NOT used here because SQLite has limited ALTER TABLE support.
-- Instead, we use a trigger-based copy strategy for production databases.
-- For initial deployment, this is a placeholder for databases that have data.
-- In practice, systems with existing sessions should use schema rebuild or
-- application-level migration (read old schema, write new schema).

-- For now, assume sessions table has these columns from 001 (updated schema).
-- If an existing database lacks them, the application must rebuild.
-- (This is documented in the upgrade guide for operators.)
`;

/** Repair both historical 001 layouts without pretending the placeholder 002 upgraded data. */
function upgradeV3(db: SqliteDatabase): void {
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
  if (!columns('sessions').includes('network_id')) {
    // Preserve IDs and every supported field. Foreign keys are checked before commit.
    const names = ['sessions', 'raw_events', 'trades', 'candles', 'reconciliation_state', 'polling_state'];
    const rows = new Map(names.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]]));
    for (const t of [...names].reverse()) db.exec(`DROP TABLE ${t}`);
    db.exec(M2_SCHEMA_SQL);
    for (const t of names) {
      const cols = columns(t);
      for (const original of rows.get(t)!) {
        const row = { ...original, network_id: 'eth', pool_address: '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8',
          base_amount: original.link_amount, quote_amount: original.weth_amount, base_price_usd: original.link_price_usd };
        const keys = cols.filter(k => (row as Record<string, unknown>)[k] !== undefined);
        db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => (row as Record<string, unknown>)[k]));
      }
    }
  }
  db.exec(`
    CREATE TABLE ws_observations (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      network_id TEXT NOT NULL, pool_address TEXT NOT NULL, fingerprint TEXT NOT NULL,
      observation TEXT NOT NULL, raw_event_id INTEGER NOT NULL REFERENCES raw_events(id),
      rest_trade_id INTEGER REFERENCES trades(id), match_status TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(network_id, pool_address, fingerprint)
    );
    CREATE INDEX ws_tx ON ws_observations(network_id,pool_address,json_extract(observation,'$.txHash'));
    CREATE INDEX canonical_tx ON trades(network_id,pool_address,tx_hash);
    CREATE UNIQUE INDEX ws_one_to_one ON ws_observations(rest_trade_id) WHERE rest_trade_id IS NOT NULL;
    CREATE TABLE collection_state (
      network_id TEXT NOT NULL, pool_address TEXT NOT NULL,
      last_success_ms INTEGER, incomplete_from_ms INTEGER, detail TEXT NOT NULL,
      PRIMARY KEY(network_id, pool_address)
    );
    CREATE TABLE collector_control (id INTEGER PRIMARY KEY CHECK(id=1), pool_id TEXT NOT NULL, enabled INTEGER NOT NULL);
    CREATE TABLE session_trades (session_id TEXT NOT NULL REFERENCES sessions(id), trade_id INTEGER NOT NULL REFERENCES trades(id),
      PRIMARY KEY(session_id, trade_id));
    INSERT OR IGNORE INTO session_trades SELECT session_id, id FROM trades;
  `);
}

const ANALYSIS_SCHEMA = `
CREATE TABLE trade_versions(id INTEGER PRIMARY KEY,trade_id INTEGER NOT NULL REFERENCES trades(id),network_id TEXT NOT NULL,pool_address TEXT NOT NULL,event_ms INTEGER NOT NULL,known_ms INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE INDEX trade_history ON trade_versions(network_id,pool_address,known_ms,trade_id);
CREATE TABLE pool_observations(id INTEGER PRIMARY KEY,network_id TEXT NOT NULL,pool_address TEXT NOT NULL,at_ms INTEGER NOT NULL,known_ms INTEGER NOT NULL,price TEXT,reserve TEXT,source TEXT NOT NULL);
CREATE INDEX observations_pool ON pool_observations(network_id,pool_address,at_ms);
CREATE TABLE candle_versions(id INTEGER PRIMARY KEY,network_id TEXT NOT NULL,pool_address TEXT NOT NULL,open_ms INTEGER NOT NULL,known_ms INTEGER NOT NULL,close TEXT NOT NULL,volume TEXT,source TEXT NOT NULL);
CREATE TABLE coverage_ranges(id INTEGER PRIMARY KEY,network_id TEXT NOT NULL,pool_address TEXT NOT NULL,from_ms INTEGER NOT NULL,to_ms INTEGER NOT NULL,known_ms INTEGER NOT NULL);
CREATE TABLE metric_snapshots(id INTEGER PRIMARY KEY,pool_id TEXT NOT NULL,as_of_ms INTEGER NOT NULL,computed_ms INTEGER NOT NULL,config_hash TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX metrics_pool ON metric_snapshots(pool_id,as_of_ms);
INSERT INTO trade_versions(trade_id,network_id,pool_address,event_ms,known_ms,payload)
SELECT id,network_id,pool_address,block_timestamp_sec*1000,received_at_sec*1000,json_object('id',provider_trade_id,'eventMs',block_timestamp_sec*1000,'knownMs',received_at_sec*1000,'side',side,'usd',volume_usd,'price',base_price_usd,'sender',sender_address) FROM trades WHERE source='rest' AND provider_trade_id IS NOT NULL AND block_timestamp_sec IS NOT NULL;
INSERT INTO candle_versions(network_id,pool_address,open_ms,known_ms,close,volume,source) SELECT network_id,pool_address,open_time_sec*1000,received_at_sec*1000,close,volume_usd,source FROM candles WHERE close IS NOT NULL;
`;

function loadMigrations(): Migration[] {
  // Migrations are defined inline as constants.
  const migrations: Migration[] = [];
  migrations.push({
    version: 1,
    name: '001-m2-durable-ingestion',
    sql: M2_SCHEMA_SQL,
  });
  migrations.push({
    version: 2,
    name: '002-m2-multi-pool-support',
    sql: M2_MIGRATION_002_SQL,
  });
  migrations.push({ version: 3, name: '003-repair-and-wire-collection', sql: '', apply: upgradeV3 });
  migrations.push({version:4,name:'004-analysis-history',sql:ANALYSIS_SCHEMA});
  migrations.push({version:5,name:'005-risk-snapshots',sql:'CREATE TABLE score_snapshots(id INTEGER PRIMARY KEY,pool_id TEXT NOT NULL,computed_ms INTEGER NOT NULL,config_hash TEXT NOT NULL,payload TEXT NOT NULL);'});
  migrations.push({version:6,name:'006-signals-and-outcomes',sql:`
CREATE TABLE signal_state(pool_id TEXT NOT NULL,mode TEXT NOT NULL,config_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(pool_id,mode,config_hash));
CREATE TABLE signals(id TEXT PRIMARY KEY,pool_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('live','replay','synthetic')),fired_ms INTEGER NOT NULL,metrics_json TEXT NOT NULL,risk_json TEXT NOT NULL,config_json TEXT NOT NULL,config_hash TEXT NOT NULL,reference_price TEXT NOT NULL,reference_ms INTEGER NOT NULL,reference_source TEXT NOT NULL,evidence_json TEXT NOT NULL);
CREATE TRIGGER immutable_signal_update BEFORE UPDATE ON signals BEGIN SELECT RAISE(ABORT,'signal evidence is immutable'); END;
CREATE TRIGGER immutable_signal_delete BEFORE DELETE ON signals BEGIN SELECT RAISE(ABORT,'signal evidence is immutable'); END;
CREATE TABLE outcome_jobs(id INTEGER PRIMARY KEY,alert_id TEXT NOT NULL REFERENCES signals(id),pool_id TEXT NOT NULL,mode TEXT NOT NULL,horizon INTEGER NOT NULL,due_ms INTEGER NOT NULL,status TEXT NOT NULL,next_ms INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,result_json TEXT,reason TEXT NOT NULL DEFAULT 'Horizon is pending',UNIQUE(alert_id,horizon));
CREATE INDEX due_outcomes ON outcome_jobs(mode,status,next_ms);
CREATE TABLE signal_timeline(id INTEGER PRIMARY KEY,alert_id TEXT NOT NULL REFERENCES signals(id),at_ms INTEGER NOT NULL,event TEXT NOT NULL);
`});
  migrations.push({version:7,name:'007-outcome-raw',sql:'CREATE TABLE outcome_raw(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES outcome_jobs(id),received_ms INTEGER NOT NULL,payload TEXT NOT NULL);'});
  migrations.push({version:8,name:'008-research-reports',sql:`
CREATE TABLE session_events(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),at_ms INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE session_reports(session_id TEXT PRIMARY KEY REFERENCES sessions(id),payload TEXT NOT NULL);
CREATE TRIGGER immutable_report BEFORE UPDATE ON session_reports BEGIN SELECT RAISE(ABORT,'session report is immutable'); END;
CREATE TRIGGER immutable_report_delete BEFORE DELETE ON session_reports BEGIN SELECT RAISE(ABORT,'session report is immutable'); END;
CREATE TABLE research_cases(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),pool_id TEXT NOT NULL,as_of_ms INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(session_id,as_of_ms));
`});
  migrations.push({version:9,name:'009-protect-report-deletion',sql:"CREATE TRIGGER IF NOT EXISTS immutable_report_delete BEFORE DELETE ON session_reports BEGIN SELECT RAISE(ABORT,'session report is immutable'); END;"});
  return migrations;
}

export function runMigrations(db: SqliteDatabase): { applied: number; failed: string[] } {
  ensureMigrationsTable(db);

  const appliedMigrations = new Set<number>(
    (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>).map((row) => row.version),
  );

  const migrations = loadMigrations();
  let applied = 0;
  const failed: string[] = [];

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.version)) {
      continue;
    }

    const repairing = migration.version === 3;
    if (repairing) db.pragma('foreign_keys = OFF');
    try {
      const stmt = db.transaction(() => {
        db.exec(migration.sql);
        migration.apply?.(db);
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('migration foreign key check failed');
        db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      });
      stmt();
      applied++;
    } catch (err) {
      failed.push(`${migration.name}: ${err instanceof Error ? err.message : String(err)}`);
      break; // Never mark later migrations applied after a failure.
    } finally {
      if (repairing) db.pragma('foreign_keys = ON');
    }
  }

  return { applied, failed };
}
