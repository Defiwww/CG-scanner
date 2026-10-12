import { z } from 'zod';

/**
 * Provider payload schemas. Deliberately lenient about extra fields (passthrough
 * via z.looseObject) and nullable where the docs say fields "may return null";
 * strict about the fields this product depends on. Built from the official
 * provider documentation.
 */

const decimalString = z.string().regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/, 'expected a decimal string');
const nullableDecimalString = decimalString.nullable();
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

// ---------- REST: pool metadata ----------

const relationship = z.looseObject({
  data: z.looseObject({ id: z.string(), type: z.string() }).nullable(),
});

export const poolMetadataSchema = z.looseObject({
  data: z.looseObject({
    id: z.string(),
    type: z.string(),
    attributes: z.looseObject({
      address: z.string(),
      name: z.string().nullable().optional(),
      base_token_price_usd: nullableDecimalString,
      quote_token_price_usd: nullableDecimalString,
      reserve_in_usd: nullableDecimalString,
    }),
    relationships: z.looseObject({
      base_token: relationship,
      quote_token: relationship,
    }),
  }),
  included: z
    .array(
      z.looseObject({
        id: z.string(),
        type: z.string(),
        attributes: z.looseObject({ address: z.string().nullable().optional(), symbol: z.string().nullable().optional() }),
      }),
    )
    .optional(),
});
export type PoolMetadata = z.infer<typeof poolMetadataSchema>;

// ---------- REST: trades ----------

export const restTradeSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  attributes: z.looseObject({
    block_number: z.number().int().nullable(),
    tx_hash: z.string(),
    tx_from_address: address.nullable(),
    from_token_amount: nullableDecimalString,
    to_token_amount: nullableDecimalString,
    price_from_in_usd: nullableDecimalString,
    price_to_in_usd: nullableDecimalString,
    block_timestamp: z.string().nullable(),
    kind: z.string().nullable(),
    volume_in_usd: nullableDecimalString,
    from_token_address: address.nullable(),
    to_token_address: address.nullable(),
  }),
});
export type RestTrade = z.infer<typeof restTradeSchema>;

export const tradesResponseSchema = z.looseObject({
  data: z.array(restTradeSchema),
  meta: z.looseObject({ next_cursor: z.string().nullable().optional() }).optional(),
});

// ---------- REST: OHLCV ----------

const ohlcvRow = z.tuple([z.number(), z.number().nullable(), z.number().nullable(), z.number().nullable(), z.number().nullable(), z.number().nullable()]);

const ohlcvTokenMeta = z.looseObject({ address: z.string().nullable().optional(), symbol: z.string().nullable().optional() });

export const ohlcvResponseSchema = z.looseObject({
  data: z.looseObject({ attributes: z.looseObject({ ohlcv_list: z.array(ohlcvRow) }) }),
  meta: z.looseObject({ base: ohlcvTokenMeta.optional(), quote: ohlcvTokenMeta.optional() }).optional(),
});

// ---------- WebSocket: G2 OnchainTrade ----------

const num = z.number().nullable();

export const g2TradeSchema = z.looseObject({
  c: z.literal('G2'),
  n: z.string(),
  pa: z.string(),
  tx: z.string().nullable(),
  ty: z.enum(['b', 's']).nullable(),
  to: num, // base token amount
  toq: num, // quote token amount
  vo: num, // volume USD
  pc: num.optional(), // price in native currency (documented; not in the original plan list)
  pu: num, // price USD for the provider base token
  t: z.number().int().nullable(), // provider last_updated_at, milliseconds
});
export type G2Trade = z.infer<typeof g2TradeSchema>;

// ---------- WebSocket: G3 OnchainOHLCV ----------

export const g3CandleSchema = z.looseObject({
  ch: z.literal('G3'),
  n: z.string(),
  pa: z.string(),
  to: z.enum(['base', 'quote']).nullable(),
  i: z.string().nullable(),
  o: num,
  h: num,
  l: num,
  c: num,
  v: num,
  t: z.number().int().nullable(), // candle open time, seconds
});
export type G3Candle = z.infer<typeof g3CandleSchema>;
