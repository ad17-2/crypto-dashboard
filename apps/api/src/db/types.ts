/**
 * A market/factor row as produced by the scoring pipeline: an open bag of flat metric fields
 * (technical indicators, derivatives stats, etc.) plus the `symbol`/`price_usd`/`factors`/`scores`
 * fields the db layer reads explicitly.
 */
export interface MarketRow {
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotPayload {
  run_id: string;
  generated_at: string;
  market_context?: Record<string, unknown>;
  provider_status?: Record<string, unknown>;
  regime?: Record<string, unknown>;
  factor_weights?: Record<string, unknown>;
  rows?: MarketRow[];
}

/** A backfill-shaped row, as accepted by `saveFactorHistoryRecords`. */
export interface FactorHistoryRecordInput {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd?: number | null;
  factors?: Record<string, unknown>;
  scores?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LabeledFactorRecord {
  symbol: string;
  generated_at: string;
  forward_return_pct: number;
  factors: Record<string, unknown>;
}

/** A `LabeledFactorRecord` with the matching `regime_state` merged in. */
export interface LabeledFactorRecordWithRegime extends LabeledFactorRecord {
  regime: string | null;
}

export interface RegimeStateSummary {
  btc_dominance_pct: number | null;
  eth_btc_performance_pct: number | null;
  regime_state: string | null;
}

export interface PruneResult {
  kept_runs: number;
  deleted_runs: number;
  deleted_rows: number;
}
