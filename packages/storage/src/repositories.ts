/**
 * Repositories for durable ingestion: database access layer.
 * Record types shared by the transactional M2Collector. All writes go through the collector.
 */


export interface SessionRecord {
  id: string;
  network_id: string;
  pool_address: string;
  started_at_sec: number;
  stopped_at_sec: number | null;
  config_hash: string;
  final_state: string | null;
  error_detail: string | null;
  created_at_unix_sec: number;
}

export interface TradeRecord {
  id: number;
  session_id: string;
  network_id: string;
  pool_address: string;
  provider_trade_id: string | null;
  tx_hash: string;
  source: 'rest' | 'ws';
  block_timestamp_sec: number | null;
  received_at_sec: number;
  side: 'buy' | 'sell' | null;
  base_amount: string | null;
  quote_amount: string | null;
  volume_usd: string | null;
  base_price_usd: string | null;
  sender_address: string | null;
  ws_frames: number;
  rest_raw_event_id: number | null;
  ws_raw_event_id: number | null;
}

export interface CandleRecord {
  id: number;
  session_id: string;
  network_id: string;
  pool_address: string;
  open_time_sec: number;
  source: 'rest' | 'ws';
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume_usd: string | null;
  update_count: number;
  received_at_sec: number;
  rest_raw_event_id: number | null;
  ws_raw_event_id: number | null;
}

export interface RawEventRecord {
  id: number;
  session_id: string;
  network_id: string;
  pool_address: string;
  kind: 'rest_pool_metadata' | 'rest_trade' | 'rest_ohlcv' | 'ws_trade' | 'ws_candle' | 'ws_control';
  endpoint_or_channel: string;
  received_at_sec: number;
  raw_text: string;
  mapped: string | null;
}

export interface PollingStateRecord {
  session_id: string;
  endpoint: string;
  last_cursor: string | null;
  last_fetch_sec: number | null;
  retry_after_until_sec: number | null;
}
