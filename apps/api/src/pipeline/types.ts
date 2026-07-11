/**
 * Shared shapes for the factor-ranking stage (factors.ts, weighting.ts, regime.ts, market.ts,
 * validation.ts, rowScoring.ts, independence.ts). The Python source passes loosely-typed
 * `dict[str, Any]` rows/context/config everywhere and reads them with `.get(key, default)`; these
 * types and helpers preserve that same tolerance instead of assuming every field is present, since
 * the ported unit tests (and the parity fixture) build partial objects by hand exactly like the
 * Python tests do.
 */

/** A market/factor row flowing through the scoring pipeline: an open bag of metric fields. */
export interface Row {
  symbol?: string | null;
  is_trusted?: boolean;
  [key: string]: unknown;
}

/** The enriched market-context dict (breadth, categories, sector_rotation, dominance, ...). */
export type MarketContext = Record<string, unknown>;

/** Narrows an unknown value to a plain object, mirroring Python's `dict.get(key, {})`. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Narrows an unknown value to an array, mirroring Python's `list.get(key, []) or []`. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// config.factors, ported as an all-optional shape (mirrors `factor_cfg.get(key, default)`
// tolerating a missing or partially-populated config, exactly like the Python unit tests do).
// Structurally compatible with `AppConfig['factors']` from ../config/schema.ts, so a config
// loaded/validated through the zod schema can be passed here as-is.

export interface RegimeWeightingConfigInput {
  enabled?: boolean;
  max_factor_multiplier?: number;
  score_adjustment_strength?: number;
  conflict_penalty_strength?: number;
}

export interface RegimeConfigInput {
  dispersion_threshold_pct?: number;
  hysteresis_margin?: number;
  breadth_weak_threshold?: number;
  breadth_strong_threshold?: number;
  dominance_delta_scale_pct?: number;
  eth_btc_scale_pct?: number;
  nudge_btc_led?: number;
  nudge_alts_strong?: number;
  nudge_chaos_trend?: number;
  nudge_chaos_contrarian?: number;
}

export interface FactorsConfigInput {
  forward_return_hours?: number;
  decay_horizons?: number[];
  reversal_lookback_hours?: number;
  ic_window_days?: number;
  min_observations?: number;
  min_abs_ic?: number;
  max_abs_weight?: number;
  ic_min_periods?: number;
  min_abs_t?: number;
  ic_prior_strength?: number;
  ic_min_cross_section?: number;
  walk_forward_train_fraction?: number;
  walk_forward_min_train_periods?: number;
  walk_forward_min_oos_periods?: number;
  walk_forward_robust_min_ic?: number;
  walk_forward_overfit_penalty?: number;
  walk_forward_gating?: boolean;
  regime_conditional_prior_strength?: number;
  regime_min_periods?: number;
  regime_weighting?: RegimeWeightingConfigInput;
  regime?: RegimeConfigInput;
  priors?: Record<string, number>;
}

/** The `{factors: {...}}` slice of AppConfig that every factor-engine function reads. */
export interface PipelineConfig {
  factors?: FactorsConfigInput;
}
