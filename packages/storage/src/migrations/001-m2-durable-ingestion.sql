-- Durable ingestion and recovery with SQLite.
-- Pragmas are set in openDatabase(); this migration creates the schema.
-- WAL mode, foreign keys enforced, NORMAL sync (survives app crash, not power loss).
-- All times are epoch seconds (Unix), except raw_text payloads which carry provider format.

-- Sessions: lifecycle tracking and config snapshots.
-- A session starts when monitoring begins and ends when stopped (gracefully or by error).
-- config_hash allows per-session config version (config hash may change between sessions).
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at_sec INTEGER NOT NULL,
  stopped_at_sec INTEGER,
  config_hash TEXT NOT NULL,
  final_state TEXT,
  error_detail TEXT,
  created_at_unix_sec INTEGER NOT NULL DEFAULT (CAST(UNIXEPOCH() AS INTEGER))
);

-- Raw events: unchanged REST responses and WS frames, no credentials (never added by provider).
-- kind: what was the source (rest_pool_metadata, rest_trade, rest_ohlcv, ws_trade, ws_candle, ws_control).
-- endpoint_or_channel: the REST endpoint path or WS channel name.
-- received_at_sec: local reception time (epoch seconds).
-- raw_text: the provider's text, unchanged (JSON arrays/objects as-is).
-- mapped: extracted fields from raw_text for quick lookup (JSON, varies by kind).
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('rest_pool_metadata', 'rest_trade', 'rest_ohlcv', 'ws_trade', 'ws_candle', 'ws_control')),
  endpoint_or_channel TEXT NOT NULL,
  received_at_sec INTEGER NOT NULL,
  raw_text TEXT NOT NULL,
  mapped TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX raw_events_session_kind ON raw_events(session_id, kind);

-- Trades: REST and WS trades, deduplicated and reconciled.
-- Each unique trade is stored once, with fields from both REST (primary, has block_timestamp)
-- and WS (provisional until matched via tx_hash).
-- source: 'rest' if first seen in REST, 'ws' if first seen via WS.
-- provider_trade_id: REST data.id (unique per swap in CoinGecko), null for WS-only trades.
-- tx_hash: the transaction hash (primary reconciliation key).
-- block_timestamp_sec: block time (epoch seconds, from REST block_timestamp).
-- received_at_sec: local reception time (WS or REST, whichever is earlier).
-- side: 'buy' or 'sell' relative to LINK.
-- link_amount, weth_amount, volume_usd, link_price_usd: all decimal strings (JSON numbers converted).
-- sender_address: transaction sender (REST only).
-- ws_frames: count of WS frames that matched this trade (for candle/lag analysis).
-- rest_raw_event_id, ws_raw_event_id: foreign keys to raw_events for audit trail.
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  provider_trade_id TEXT UNIQUE,
  tx_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('rest', 'ws')),
  block_timestamp_sec INTEGER,
  received_at_sec INTEGER NOT NULL,
  side TEXT CHECK(side IN ('buy', 'sell', NULL)),
  link_amount TEXT,
  weth_amount TEXT,
  volume_usd TEXT,
  link_price_usd TEXT,
  sender_address TEXT,
  ws_frames INTEGER DEFAULT 0,
  rest_raw_event_id INTEGER,
  ws_raw_event_id INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (rest_raw_event_id) REFERENCES raw_events(id),
  FOREIGN KEY (ws_raw_event_id) REFERENCES raw_events(id)
);
CREATE INDEX trades_session_tx ON trades(session_id, tx_hash);
CREATE INDEX trades_session_timestamp ON trades(session_id, block_timestamp_sec DESC);
CREATE INDEX trades_provider_trade_id ON trades(provider_trade_id);

-- Candles: OHLC + volume, reconciled from REST and WS (both provide 1m candles).
-- Candle identity: session + open_time_sec (LINK/WETH pool, 1m interval).
-- source: 'rest' if first from REST, 'ws' if first from WS.
-- open_time_sec: candle open time (epoch seconds, minute-aligned).
-- open, high, low, close, volume_usd: all decimal strings.
-- update_count: how many WS frames updated this candle (for freshness/lag analysis).
-- rest_raw_event_id, ws_raw_event_id: audit trail.
CREATE TABLE candles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
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
  UNIQUE (session_id, open_time_sec),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (rest_raw_event_id) REFERENCES raw_events(id),
  FOREIGN KEY (ws_raw_event_id) REFERENCES raw_events(id)
);
CREATE INDEX candles_session_time ON candles(session_id, open_time_sec DESC);

-- Reconciliation state: tracks which WS trades have been matched to REST trades.
-- Used during startup recovery and ongoing reconciliation.
-- ws_trade_id: the WS trade (from raw_events, kind='ws_trade', mapped carries tx_hash).
-- rest_trade_id: the REST trade it was matched to (trades.id), NULL if not yet matched.
-- matched_at_sec: when the match was made (for debugging gaps).
CREATE TABLE reconciliation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ws_provider_trade_id TEXT UNIQUE,
  rest_provider_trade_id TEXT,
  matched_at_sec INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (rest_provider_trade_id) REFERENCES trades(provider_trade_id)
);
CREATE INDEX reconciliation_session ON reconciliation_state(session_id);

-- Polling state: tracks REST pagination and rate limit info for recovery across restarts.
-- last_cursor: the next_cursor from the previous REST /trades response (for resuming pagination).
-- last_fetch_sec: when we last fetched /trades (for backoff/rate-limit decisions).
-- retry_after_until_sec: if a 429 or Retry-After was received, don't retry until this time.
CREATE TABLE polling_state (
  session_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  last_cursor TEXT,
  last_fetch_sec INTEGER,
  retry_after_until_sec INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
