/** Header carrying the Pro API key (REST and WebSocket). The value never leaves the server process. */
export const API_KEY_HEADER = 'x-cg-pro-api-key';

/** Documented WebSocket channels (G2/G3). */
export const WS_CHANNELS = {
  trade: 'OnchainTrade',
  ohlcv: 'OnchainOHLCV',
} as const;
export type WsChannelName = (typeof WS_CHANNELS)[keyof typeof WS_CHANNELS];
