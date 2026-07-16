import { z } from 'zod';

/** GET /api/btc-pulse -- near-live BTC spot price the dashboard uses for staleness detection. */
export const BtcPulseSchema = z.object({
  price_usd: z.number(),
  fetched_at: z.string(),
  source: z.enum(['binance', 'coinbase']),
});

export type BtcPulse = z.infer<typeof BtcPulseSchema>;
