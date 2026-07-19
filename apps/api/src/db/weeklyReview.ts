import type Database from 'better-sqlite3';
import { previousRunMembership, watchlistDiff } from '../dashboard/runDiff.js';
import { stableStringify } from './json.js';

/**
 * Computes and persists the weekly forward-outcome review (pipeline/weeklyReview.ts drives the
 * trigger + DeepSeek narration; this module owns the DB reads/writes and the pure metrics math).
 * "No significance claims -- descriptive only": every stat below is a plain rate/mean/median, never
 * a p-value or confidence interval, and every one carries its own `n`.
 */

// Mirrors db/outcomeLabels.ts's own DEFAULT_HORIZONS -- kept as a separate constant (not imported)
// because this module's horizons are a *reporting* grid (always both, even at n=0, so a thin
// cohort still gets an explicit n=0 entry), not a labeling request.
const REVIEW_HORIZONS = [24, 72] as const;
const REVIEW_SIDES = ['long', 'short'] as const;
const REVIEW_CONFIDENCES = ['A', 'B', 'C'] as const;

type Side = (typeof REVIEW_SIDES)[number];
type Confidence = (typeof REVIEW_CONFIDENCES)[number];

/** Local, not imported from db/outcomeLabels.ts's parseMetrics -- same isolation precedent as that module's own comment on why it doesn't import from dashboard/. */
function parseMetricsJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function sideOf(metrics: Record<string, unknown>): Side | null {
  const value = metrics.watchlist_side;
  return value === 'long' || value === 'short' ? value : null;
}

function confidenceOf(metrics: Record<string, unknown>): Confidence | null {
  const value = metrics.setup_confidence;
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

export interface WeeklyReviewInputRow {
  symbol: string;
  run_id: string;
  horizon_hours: number;
  fwd_return_pct: number;
  fwd_residual_pct: number | null;
  side: Side | null;
  setup_confidence: Confidence | null;
  new_to_list: boolean;
}

interface JoinedDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  horizon_hours: number;
  fwd_return_pct: number;
  fwd_residual_pct: number | null;
  metrics_json: string;
}

/**
 * Joins outcome_labels to factor_history (same run_id + symbol -- factor_history's own primary
 * key) over [weekStartIso, weekEndIso), for the metrics below. `new_to_list` is not itself a
 * persisted metrics_json key, so it's recomputed per distinct run_id the same way runPipeline's
 * briefing does for the latest run -- dashboard/runDiff.ts's previousRunMembership/watchlistDiff --
 * reusing this window's own rows to build each run's "current" membership rather than a fresh
 * factor_history-wide scan.
 */
export function loadWeeklyReviewInputs(
  db: Database.Database,
  weekStartIso: string,
  weekEndIso: string,
): WeeklyReviewInputRow[] {
  const joined = db
    .prepare(
      `SELECT ol.run_id, ol.generated_at, ol.symbol, ol.horizon_hours,
              ol.fwd_return_pct, ol.fwd_residual_pct, fh.metrics_json
       FROM outcome_labels ol
       JOIN factor_history fh ON fh.run_id = ol.run_id AND fh.symbol = ol.symbol
       WHERE ol.generated_at >= ? AND ol.generated_at < ?
       ORDER BY ol.generated_at ASC`,
    )
    .all(weekStartIso, weekEndIso) as JoinedDbRow[];

  if (joined.length === 0) {
    return [];
  }

  const runGeneratedAt = new Map<string, string>();
  const currentMembershipByRun = new Map<string, Map<string, Side>>();
  const parsed: Array<{ row: JoinedDbRow; metrics: Record<string, unknown> }> = [];
  for (const row of joined) {
    const metrics = parseMetricsJson(row.metrics_json);
    parsed.push({ row, metrics });
    runGeneratedAt.set(row.run_id, row.generated_at);
    const side = sideOf(metrics);
    if (side !== null) {
      const membership = currentMembershipByRun.get(row.run_id) ?? new Map<string, Side>();
      membership.set(row.symbol, side);
      currentMembershipByRun.set(row.run_id, membership);
    }
  }

  const newToListByRun = new Map<string, Set<string>>();
  for (const [runId, generatedAt] of runGeneratedAt) {
    const previous = previousRunMembership(db, runId, generatedAt);
    const current = currentMembershipByRun.get(runId) ?? new Map<string, Side>();
    newToListByRun.set(runId, watchlistDiff(previous, current).newToList);
  }

  return parsed.map(({ row, metrics }) => {
    const side = sideOf(metrics);
    return {
      symbol: row.symbol,
      run_id: row.run_id,
      horizon_hours: row.horizon_hours,
      fwd_return_pct: row.fwd_return_pct,
      fwd_residual_pct: row.fwd_residual_pct,
      side,
      setup_confidence: confidenceOf(metrics),
      new_to_list: side !== null && (newToListByRun.get(row.run_id)?.has(row.symbol) ?? false),
    };
  });
}

export interface SideHitRateStat {
  side: Side;
  horizon_hours: number;
  hit_rate_raw: number | null;
  n_raw: number;
  hit_rate_residual: number | null;
  n_residual: number;
}

export interface UniverseStat {
  horizon_hours: number;
  median_return_pct: number | null;
  n: number;
}

export interface ConfidenceCohortStat {
  setup_confidence: Confidence;
  horizon_hours: number;
  mean_return_pct: number | null;
  n: number;
}

export interface NewToListCohortStat {
  cohort: 'new' | 'incumbent';
  horizon_hours: number;
  mean_return_pct: number | null;
  n: number;
}

export interface WeeklyReviewMetrics {
  week_start: string;
  week_end: string;
  horizons: number[];
  side_hit_rates: SideHitRateStat[];
  universe: UniverseStat[];
  confidence_cohorts: ConfidenceCohortStat[];
  new_to_list_cohorts: NewToListCohortStat[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/** A "hit" is a return whose sign matches the side's expected direction; exactly 0 counts as a miss for both sides. */
function isDirectionCorrect(side: Side, returnPct: number): boolean {
  return side === 'long' ? returnPct > 0 : returnPct < 0;
}

/**
 * Reframes a raw forward return in win/loss terms, same direction convention as isDirectionCorrect
 * above: long keeps the raw sign, short is negated so a winning short (price fell, negative raw
 * return) contributes a positive number to a cohort mean instead of dragging it down. Cohort
 * callers below exclude side=null rows before ever calling this.
 */
function sideAdjustedReturn(side: Side, fwdReturnPct: number): number {
  return side === 'long' ? fwdReturnPct : -fwdReturnPct;
}

function hitRate(
  rows: WeeklyReviewInputRow[],
  side: Side,
  field: 'fwd_return_pct' | 'fwd_residual_pct',
): { rate: number | null; n: number } {
  const withValue = rows.filter((row) => row[field] !== null);
  if (withValue.length === 0) {
    return { rate: null, n: 0 };
  }
  const hits = withValue.filter((row) => isDirectionCorrect(side, row[field] as number));
  return { rate: hits.length / withValue.length, n: withValue.length };
}

/**
 * Pure and unit-testable on a hand-built `rows` fixture. `new_to_list_cohorts` is scoped to rows
 * that carry a side (long/short) -- "new to the list" only means something relative to watchlist
 * membership, so the universe's never-watchlisted rows (most of it) would otherwise dilute
 * "incumbent" into "not new" for coins that were never candidates at all.
 */
export function computeWeeklyReviewMetrics(
  rows: WeeklyReviewInputRow[],
  weekStart: string,
  weekEnd: string,
): WeeklyReviewMetrics {
  const sideHitRates: SideHitRateStat[] = [];
  for (const side of REVIEW_SIDES) {
    for (const horizon of REVIEW_HORIZONS) {
      const sideRows = rows.filter((row) => row.side === side && row.horizon_hours === horizon);
      const raw = hitRate(sideRows, side, 'fwd_return_pct');
      const residual = hitRate(sideRows, side, 'fwd_residual_pct');
      sideHitRates.push({
        side,
        horizon_hours: horizon,
        hit_rate_raw: raw.rate,
        n_raw: raw.n,
        hit_rate_residual: residual.rate,
        n_residual: residual.n,
      });
    }
  }

  const universe: UniverseStat[] = REVIEW_HORIZONS.map((horizon) => {
    const horizonRows = rows.filter((row) => row.horizon_hours === horizon);
    return {
      horizon_hours: horizon,
      median_return_pct: median(horizonRows.map((row) => row.fwd_return_pct)),
      n: horizonRows.length,
    };
  });

  const confidenceCohorts: ConfidenceCohortStat[] = [];
  for (const confidence of REVIEW_CONFIDENCES) {
    for (const horizon of REVIEW_HORIZONS) {
      const cohortRows = rows.filter(
        (row) =>
          row.setup_confidence === confidence && row.horizon_hours === horizon && row.side !== null,
      );
      confidenceCohorts.push({
        setup_confidence: confidence,
        horizon_hours: horizon,
        mean_return_pct: mean(
          cohortRows.map((row) => sideAdjustedReturn(row.side as Side, row.fwd_return_pct)),
        ),
        n: cohortRows.length,
      });
    }
  }

  const watchlistedRows = rows.filter((row) => row.side !== null);
  const newToListCohorts: NewToListCohortStat[] = [];
  for (const cohort of ['new', 'incumbent'] as const) {
    for (const horizon of REVIEW_HORIZONS) {
      const cohortRows = watchlistedRows.filter(
        (row) =>
          row.horizon_hours === horizon && (cohort === 'new' ? row.new_to_list : !row.new_to_list),
      );
      newToListCohorts.push({
        cohort,
        horizon_hours: horizon,
        mean_return_pct: mean(
          cohortRows.map((row) => sideAdjustedReturn(row.side as Side, row.fwd_return_pct)),
        ),
        n: cohortRows.length,
      });
    }
  }

  return {
    week_start: weekStart,
    week_end: weekEnd,
    horizons: [...REVIEW_HORIZONS],
    side_hit_rates: sideHitRates,
    universe,
    confidence_cohorts: confidenceCohorts,
    new_to_list_cohorts: newToListCohorts,
  };
}

/** Cheap existence check for the trigger gate -- never loads/parses rows. */
export function hasLabeledRowsInWindow(
  db: Database.Database,
  weekStartIso: string,
  weekEndIso: string,
): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS present FROM outcome_labels WHERE generated_at >= ? AND generated_at < ? LIMIT 1',
    )
    .get(weekStartIso, weekEndIso) as { present: number } | undefined;
  return row !== undefined;
}

export interface WeeklyReviewRecord {
  generated_at: string;
  week_start: string;
  week_end: string;
  metrics: WeeklyReviewMetrics;
  narrative: string | null;
  model: string | null;
}

export function saveWeeklyReview(db: Database.Database, record: WeeklyReviewRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO weekly_reviews
        (generated_at, week_start, week_end, metrics_json, narrative, model)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.generated_at,
    record.week_start,
    record.week_end,
    stableStringify(record.metrics),
    record.narrative,
    record.model,
  );
}

interface WeeklyReviewDbRow {
  generated_at: string;
  week_start: string;
  week_end: string;
  metrics_json: string;
  narrative: string | null;
  model: string | null;
}

/**
 * What a row surviving a JSON round-trip from disk actually guarantees -- `metrics` stays a loose
 * `Record<string, unknown>` (not WeeklyReviewMetrics) rather than asserting an unverified shape,
 * matching the dashboard contract's own untyped `jsonRecord` for this field.
 */
export interface LoadedWeeklyReview {
  generated_at: string;
  week_start: string;
  week_end: string;
  metrics: Record<string, unknown>;
  narrative: string | null;
  model: string | null;
}

/** The row the dashboard shows (dashboard/payload.ts) and the trigger gate reads (pipeline/weeklyReview.ts) -- newest by generated_at, or null before the first computation ever runs. */
export function loadLatestWeeklyReview(db: Database.Database): LoadedWeeklyReview | null {
  const row = db
    .prepare(
      'SELECT generated_at, week_start, week_end, metrics_json, narrative, model FROM weekly_reviews ORDER BY generated_at DESC LIMIT 1',
    )
    .get() as WeeklyReviewDbRow | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    generated_at: row.generated_at,
    week_start: row.week_start,
    week_end: row.week_end,
    metrics: parseMetricsJson(row.metrics_json),
    narrative: row.narrative,
    model: row.model,
  };
}
