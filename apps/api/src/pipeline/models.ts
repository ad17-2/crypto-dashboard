import type { MarketContext, Row } from './types.js';

/**
 * Port of crypto_screener/models.py::RunPayload. Python's pydantic model additionally enforces
 * `extra="forbid"` and exposes `to_runtime_dict()` (== `model_dump(mode="json")`, a JSON-safe
 * plain dict); this port builds the same shape as a plain object directly in runPipeline.ts
 * instead, since every field is already a plain JSON-serializable value by the time the payload
 * is assembled -- there is no separate validation/coercion step to replicate.
 *
 * `market_context`/`provider_status`/`factor_weights`/`regime` are kept as loosely-typed
 * `Record<string, unknown>` (mirroring Python's `dict[str, Any]`) rather than the specific
 * `MarketContext`/`FactorWeights`/`InferredRegime` interfaces the scoring stage returns, so that
 * reports/*.ts -- a straight port of report.py's defensive `.get(key, default)` access pattern --
 * stays decoupled from those internal factor-engine types.
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
