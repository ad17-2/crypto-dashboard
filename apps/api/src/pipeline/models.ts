import type { MarketContext, Row } from './types.js';

// provider_status/regime stay Record<string, unknown> on purpose, decoupling reports/*.ts from the factor engine's internal types.
export interface RunPayload {
  run_id: string;
  generated_at: string;
  rows: Row[];
  market_context: MarketContext;
  provider_status: Record<string, unknown>;
  regime: Record<string, unknown>;
}
