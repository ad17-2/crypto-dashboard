/**
 * A market/factor row as produced by the scoring pipeline: an open bag of
 * flat metric fields (technical indicators, derivatives stats, etc.) plus
 * the `symbol`/`price_usd`/`factors`/`scores` fields storage.py reads
 * explicitly. Mirrors the loosely-typed `dict[str, Any]` row the Python
 * pipeline passes to `save_snapshot`.
 */
export interface MarketRow {
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Mirrors the `payload` dict save_snapshot() receives from the pipeline. */
export interface SnapshotPayload {
  run_id: string;
  generated_at: string;
  market_context?: Record<string, unknown>;
  provider_status?: Record<string, unknown>;
  regime?: Record<string, unknown>;
  factor_weights?: Record<string, unknown>;
  rows?: MarketRow[];
}

/** A record as accepted by save_factor_history_records(): a backfill-shaped row. */
export interface FactorHistoryRecordInput {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Output of load_labeled_records_by_horizon() / the un-regime-labeled half of load_labeled_factor_records(). */
export interface LabeledFactorRecord {
  symbol: string;
  generated_at: string;
  forward_return_pct: number;
  factors: Record<string, unknown>;
}

/** Output of load_labeled_factor_records(): a LabeledFactorRecord with the matching regime_state merged in. */
export interface LabeledFactorRecordWithRegime extends LabeledFactorRecord {
  regime: string | null;
}

/** Output of load_latest_regime_state(). */
export interface RegimeStateSummary {
  btc_dominance_pct: number | null;
  eth_btc_performance_pct: number | null;
  regime_state: string | null;
}

/** Result of prune_old_runs(): field names kept snake_case to mirror the Python dict verbatim. */
export interface PruneResult {
  kept_runs: number;
  deleted_runs: number;
  deleted_rows: number;
}
