import { z } from 'zod';

/**
 * Zod port of the `GET /api/dashboard` wire contract built by
 * crypto_screener/dashboard_payload.py + crypto_screener/dashboard_rows.py.
 *
 * Keys stay snake_case — this is a preserved wire contract consumed by an existing client, not a
 * TS-idiomatic API.
 *
 * Scope note: unlike the config schema, these schemas are intentionally NOT `.strict()`. The
 * Python source has no pydantic model for this payload either — `regime`, `market_context`,
 * `provider_status`, `factor_weights`, `factor_decay`, `walk_forward`, and `validation` are all
 * built as plain `dict[str, Any]` blobs that the factor pipeline (factors.py, regime.py) has
 * grown incrementally across phases (see Phase 3-5 commits). Modeling them as
 * `z.record(z.string(), z.unknown())` reflects that they carry no fixed schema on the producing
 * side; the well-defined, stable pieces (the row shape, run summaries, quality, watchlists) are
 * fully typed below per dashboard_rows.py.
 */

/** Opaque JSON blob: dict[str, Any] on the Python side, no fixed schema. */
const jsonRecord = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Dashboard row (crypto_screener/dashboard_rows.py::dashboard_row)
// ---------------------------------------------------------------------------

const FactorPartSchema = z.object({
  name: z.string(),
  label: z.string(),
  value: z.number(),
  tone: z.string(),
});

const ConfluenceFamilySchema = z.object({
  key: z.string(),
  label: z.string(),
  tone: z.string(),
  /**
   * Nullable: confluence.py::_family_entry emits `None` (`round(contribution, 3)` is only called
   * when a contribution was computed) whenever none of that family's factors are present on the
   * row. In practice this happens for an excluded/untrusted row that still reaches
   * dashboard_row() -- e.g. dashboard_payload.py's "core" section is built from BTC/ETH/SOL
   * unconditionally, with no `is_trusted` filter, unlike every other watchlist section.
   */
  value: z.number().nullable(),
});

const ConfluenceSummarySchema = z.object({
  direction: z.string(),
  aligned: z.number(),
  against: z.number(),
  neutral: z.number(),
  total: z.number(),
  net_score: z.number(),
  families: z.array(ConfluenceFamilySchema),
});

const SignalConflictItemSchema = z.object({
  code: z.string(),
  label: z.string(),
  severity: z.number(),
  detail: z.string(),
});

const ReasonPartSchema = z.object({
  kind: z.string(),
  label: z.string(),
  value: z.string(),
  tone: z.string(),
  help: z.string(),
});

const RowExplanationSchema = z.object({
  read: z.string(),
  confirm: z.array(z.string()),
  risk: z.array(z.string()),
});

const RowScoresSchema = z.object({
  factor_score: z.number().nullable(),
  long_score: z.number().nullable(),
  short_score: z.number().nullable(),
  crowded_long_score: z.number().nullable(),
  squeeze_risk_score: z.number().nullable(),
  confidence_score: z.number().nullable(),
  signal_conflict_score: z.number().nullable(),
  regime_alignment_score: z.number().nullable(),
  breadth_alignment_score: z.number().nullable(),
});

/** Known technical fields (crypto_screener/dashboard_rows.py::technical_state); all optional. */
const TechnicalStateSchema = z.object({
  technical_interval: z.string().optional(),
  technical_candle_count: z.number().optional(),
  technical_close: z.number().optional(),
  ema_20: z.number().optional(),
  ema_50: z.number().optional(),
  ema_200: z.number().optional(),
  distance_ema20_pct: z.number().optional(),
  rsi_14: z.number().optional(),
  macd_histogram_pct: z.number().optional(),
  atr_14_pct: z.number().optional(),
  bb_position: z.number().optional(),
  bb_width_pct: z.number().optional(),
  technical_trend_score: z.number().optional(),
  technical_momentum_score: z.number().optional(),
});

/** One point of factor_history (crypto_screener/dashboard_payload.py::_history_by_symbol). */
const HistoryPointSchema = z.object({
  generated_at: z.string(),
  price_usd: z.number().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  funding_rate_pct: z.number().nullable(),
  long_short_ratio: z.number().nullable(),
  long_short_account_ratio: z.number().nullable(),
  top_trader_long_short_ratio: z.number().nullable(),
  quote_volume_usd: z.number().nullable(),
  confidence_score: z.number().nullable(),
  technical_trend_4h: z.number().nullable(),
  technical_momentum_4h: z.number().nullable(),
  rsi_14: z.number().nullable(),
  factor_score: z.number().nullable(),
  long_score: z.number().nullable(),
  short_score: z.number().nullable(),
  crowded_long_score: z.number().nullable(),
  squeeze_risk_score: z.number().nullable(),
  signal_conflict_score: z.number().nullable(),
});

export const DashboardRowSideSchema = z.enum([
  'core',
  'long',
  'short',
  'fade-long',
  'squeeze-risk',
]);

export const DashboardRowSchema = z.object({
  symbol: z.string().nullable(),
  side: DashboardRowSideSchema,
  setup: z.string(),
  setup_tone: z.string(),
  score_field: z.string(),
  score: z.number().nullable(),
  priority: z.number(),
  confidence_score: z.number().nullable(),
  quality: z.number(),
  primary_exchange: z.string().nullable(),
  contract_symbol: z.string().nullable(),
  price_usd: z.number().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  funding_rate_pct: z.number().nullable(),
  long_short_ratio: z.number().nullable(),
  long_short_account_ratio: z.number().nullable(),
  top_trader_long_short_ratio: z.number().nullable(),
  positioning_ratio: z.number().nullable(),
  funding_percentile: z.number().nullable(),
  oi_change_percentile: z.number().nullable(),
  positioning_percentile: z.number().nullable(),
  confluence: ConfluenceSummarySchema,
  confluence_score: z.number(),
  quote_volume_usd: z.number().nullable(),
  open_interest_usd: z.number().nullable(),
  technical_setup: z.string().nullable(),
  technical_state: TechnicalStateSchema,
  signal_conflict_label: z.string().nullable(),
  signal_conflict_score: z.number().nullable(),
  signal_conflicts: z.array(SignalConflictItemSchema),
  regime_alignment_score: z.number().nullable(),
  breadth_alignment_score: z.number().nullable(),
  data_source: z.string().nullable(),
  is_trusted: z.boolean(),
  data_quality_flags: z.array(z.string()),
  scores: RowScoresSchema,
  factor_parts: z.array(FactorPartSchema),
  primary_driver: FactorPartSchema.nullable(),
  history: z.array(HistoryPointSchema),
  reason: z.string(),
  reason_parts: z.array(ReasonPartSchema),
  explanation: RowExplanationSchema,
});

// ---------------------------------------------------------------------------
// Runs (crypto_screener/dashboard_payload.py::_recent_runs / _selected_run)
// ---------------------------------------------------------------------------

export const RunSummarySchema = z.object({
  run_id: z.string(),
  generated_at: z.string(),
  row_count: z.number(),
  excluded_count: z.number(),
  bias: z.string(),
  factor_regime: z.string(),
  coinglass_status: z.string(),
});

export const SelectedRunSchema = RunSummarySchema.pick({
  run_id: true,
  generated_at: true,
  row_count: true,
});

// ---------------------------------------------------------------------------
// Freshness (crypto_screener/dashboard_freshness.py::freshness_summary)
// ---------------------------------------------------------------------------

export const FreshnessSchema = z.object({
  status: z.string(),
  label: z.string(),
  generated_at: z.string().optional(),
  age_seconds: z.number().nullable(),
  age_minutes: z.number().nullable(),
  help: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Quality (crypto_screener/dashboard_payload.py::_quality_summary)
// ---------------------------------------------------------------------------

const FlaggedRowSchema = z.object({
  symbol: z.string().nullable(),
  data_source: z.string().nullable(),
  price_change_24h_pct: z.number().nullable(),
  oi_change_24h_pct: z.number().nullable(),
  flags: z.array(z.string()),
});

export const QualitySchema = z.object({
  trusted_count: z.number(),
  excluded_count: z.number(),
  flagged_count: z.number(),
  flagged_rows: z.array(FlaggedRowSchema),
});

// ---------------------------------------------------------------------------
// Factor correlations (crypto_screener/independence.py::factor_correlations)
// ---------------------------------------------------------------------------

export const FactorCorrelationSchema = z.object({
  a: z.string(),
  b: z.string(),
  rho: z.number(),
  verdict: z.string(),
});

// ---------------------------------------------------------------------------
// Model weights (crypto_screener/dashboard_payload.py::_model_weights_summary)
// ---------------------------------------------------------------------------

const ModelWeightFactorSchema = z.object({
  name: z.string(),
  label: z.string(),
  weight: z.number().nullable(),
  base_weight: z.number().nullable(),
  mode: z.string().nullable(),
  ic: z.number().nullable(),
  t_stat: z.number().nullable(),
  n_periods: z.number(),
  credibility_k: z.number().nullable(),
  regime_multiplier: z.number().nullable(),
  robustness: z.unknown(),
  oos_ic: z.number().nullable(),
  regime_ic: z.number().nullable(),
  regime_mode: z.unknown(),
});

export const ModelWeightsSchema = z.object({
  mode: z.string().nullable(),
  regime: jsonRecord,
  factors: z.array(ModelWeightFactorSchema),
  factor_correlations: z.array(FactorCorrelationSchema),
  factor_decay: jsonRecord,
  walk_forward: jsonRecord,
});

// ---------------------------------------------------------------------------
// Sections / watchlists
// ---------------------------------------------------------------------------

export const SectionsSchema = z.object({
  core: z.array(DashboardRowSchema),
  long: z.array(DashboardRowSchema),
  regime_fit: z.array(DashboardRowSchema),
  short: z.array(DashboardRowSchema),
  crowded_longs: z.array(DashboardRowSchema),
  squeeze_risks: z.array(DashboardRowSchema),
});

export const WatchlistIdSchema = z.enum([
  'chart_next',
  'regime_fit',
  'long',
  'short',
  'squeeze_risks',
  'crowded_longs',
  'core',
]);

export const WatchlistSchema = z.object({
  id: WatchlistIdSchema,
  label: z.string(),
  rows: z.array(DashboardRowSchema),
});

// ---------------------------------------------------------------------------
// Top-level payload (crypto_screener/dashboard_payload.py::build_dashboard_payload)
// ---------------------------------------------------------------------------

const DashboardPayloadEmptySchema = z.object({
  status: z.literal('empty'),
  database: z.string(),
  runs: z.array(RunSummarySchema),
  /** Injected by the HTTP handler (dashboard.py::do_GET); null while no refresh has run yet. */
  refresh_status: z.unknown().nullable(),
});

const DashboardPayloadOkSchema = z.object({
  status: z.literal('ok'),
  database: z.string(),
  run: SelectedRunSchema,
  runs: z.array(RunSummarySchema),
  regime: jsonRecord,
  market_context: jsonRecord,
  provider_status: jsonRecord,
  factor_weights: jsonRecord,
  model_weights: ModelWeightsSchema,
  factor_correlations: z.array(FactorCorrelationSchema),
  factor_decay: jsonRecord,
  walk_forward: jsonRecord,
  validation: jsonRecord,
  freshness: FreshnessSchema,
  quality: QualitySchema,
  sections: SectionsSchema,
  watchlists: z.array(WatchlistSchema),
  /**
   * Injected by the HTTP handler (dashboard.py::do_GET), not by build_dashboard_payload itself —
   * optional here so this schema also validates the payload-builder's raw return value.
   */
  refresh_status: z.unknown().nullable().optional(),
});

export const DashboardPayloadSchema = z.discriminatedUnion('status', [
  DashboardPayloadEmptySchema,
  DashboardPayloadOkSchema,
]);

export type DashboardRow = z.infer<typeof DashboardRowSchema>;
export type DashboardRowSide = z.infer<typeof DashboardRowSideSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type SelectedRun = z.infer<typeof SelectedRunSchema>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type Quality = z.infer<typeof QualitySchema>;
export type FactorCorrelation = z.infer<typeof FactorCorrelationSchema>;
export type ModelWeights = z.infer<typeof ModelWeightsSchema>;
export type Sections = z.infer<typeof SectionsSchema>;
export type WatchlistId = z.infer<typeof WatchlistIdSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;
export type DashboardPayload = z.infer<typeof DashboardPayloadSchema>;
