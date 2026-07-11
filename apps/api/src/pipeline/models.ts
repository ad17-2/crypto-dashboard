import type { MarketContext, Row } from './types.js';

/**
 * The shape of one completed pipeline run, built directly as a plain object in runPipeline.ts.
 *
 * `market_context`/`provider_status`/`factor_weights`/`regime` are kept as loosely-typed
 * `Record<string, unknown>` rather than the specific `MarketContext`/`FactorWeights`/
 * `InferredRegime` interfaces the scoring stage returns, so that reports/*.ts's defensive
 * `.get(key, default)`-style access stays decoupled from those internal factor-engine types.
 */
export interface RunPayload {
  run_id: string;
  generated_at: string;
  rows: Row[];
  market_context: MarketContext;
  provider_status: Record<string, unknown>;
  factor_weights: Record<string, unknown>;
  regime: Record<string, unknown>;
}
