import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatJakartaIso } from '../../src/db/time.js';
import type { WeeklyReviewInputRow } from '../../src/db/weeklyReview.js';
import {
  computeWeeklyReviewMetrics,
  hasLabeledRowsInWindow,
  loadLatestWeeklyReview,
  loadWeeklyReviewInputs,
  saveWeeklyReview,
} from '../../src/db/weeklyReview.js';
import { setupTempDb, teardownTempDb } from '../support/tempDb.js';

const REFERENCE = new Date('2026-01-01T00:00:00.000Z');

function atHours(offsetHours: number): string {
  return formatJakartaIso(new Date(REFERENCE.getTime() + offsetHours * 3_600_000));
}

function row(overrides: Partial<WeeklyReviewInputRow> & { symbol: string }): WeeklyReviewInputRow {
  return {
    run_id: 'r1',
    horizon_hours: 24,
    fwd_return_pct: 0,
    fwd_residual_pct: null,
    side: null,
    setup_confidence: null,
    new_to_list: false,
    ...overrides,
  };
}

describe('computeWeeklyReviewMetrics', () => {
  // Hand-computed fixture -- see the numbers worked out per bucket in each assertion below.
  const rows: WeeklyReviewInputRow[] = [
    row({
      symbol: 'A',
      horizon_hours: 24,
      fwd_return_pct: 5,
      fwd_residual_pct: 4,
      side: 'long',
      setup_confidence: 'A',
      new_to_list: true,
    }),
    row({
      symbol: 'B',
      horizon_hours: 24,
      fwd_return_pct: -3,
      fwd_residual_pct: -2,
      side: 'long',
      setup_confidence: 'B',
      new_to_list: false,
    }),
    row({
      symbol: 'C',
      horizon_hours: 24,
      fwd_return_pct: 2,
      fwd_residual_pct: null,
      side: 'short',
      setup_confidence: 'A',
      new_to_list: false,
    }),
    row({
      symbol: 'D',
      horizon_hours: 24,
      fwd_return_pct: -6,
      fwd_residual_pct: -5,
      side: 'short',
      setup_confidence: null,
      new_to_list: true,
    }),
    row({
      symbol: 'E',
      horizon_hours: 24,
      fwd_return_pct: 1,
      fwd_residual_pct: 1,
      side: null,
      setup_confidence: null,
      new_to_list: false,
    }),
  ];
  const metrics = computeWeeklyReviewMetrics(rows, atHours(-168), atHours(0));

  it('carries the week bounds and the fixed horizon grid through untouched', () => {
    expect(metrics.week_start).toBe(atHours(-168));
    expect(metrics.week_end).toBe(atHours(0));
    expect(metrics.horizons).toEqual([24, 72]);
  });

  it('computes long/short hit rates: direction-correct = sign matches side, exact 0 counts as a miss', () => {
    // long/24h: A(+5, hit), B(-3, miss) -> 1/2 raw. Residual: A(+4, hit), B(-2, miss) -> 1/2.
    const long24 = metrics.side_hit_rates.find((s) => s.side === 'long' && s.horizon_hours === 24);
    expect(long24).toMatchObject({
      hit_rate_raw: 0.5,
      n_raw: 2,
      hit_rate_residual: 0.5,
      n_residual: 2,
    });

    // short/24h: C(+2, miss), D(-6, hit) -> 1/2 raw. Residual: C excluded (null), D(-5, hit) -> 1/1.
    const short24 = metrics.side_hit_rates.find(
      (s) => s.side === 'short' && s.horizon_hours === 24,
    );
    expect(short24).toMatchObject({
      hit_rate_raw: 0.5,
      n_raw: 2,
      hit_rate_residual: 1,
      n_residual: 1,
    });
  });

  it('reports n=0 / null rate for a horizon with no rows at all (72h here)', () => {
    const long72 = metrics.side_hit_rates.find((s) => s.side === 'long' && s.horizon_hours === 72);
    expect(long72).toMatchObject({
      hit_rate_raw: null,
      n_raw: 0,
      hit_rate_residual: null,
      n_residual: 0,
    });
  });

  it('computes the universe median return across ALL rows for a horizon, including never-watchlisted ones', () => {
    // sorted [-6,-3,1,2,5] -> median = 1 (E's side is null but still counts toward the universe).
    const universe24 = metrics.universe.find((u) => u.horizon_hours === 24);
    expect(universe24).toMatchObject({ median_return_pct: 1, n: 5 });
  });

  it('computes mean forward return per setup_confidence cohort, side-adjusted (short returns negated) and excluding rows with no confidence', () => {
    // A: long A(+5 as-is) + short C(+2 raw -> -2 adjusted, a losing short) -> mean 1.5, n=2.
    // B: long B(-3 as-is, unaffected by side-adjustment) -> mean -3, n=1.
    // C: none -> null, n=0 (D's null confidence excluded from all three).
    const a24 = metrics.confidence_cohorts.find(
      (c) => c.setup_confidence === 'A' && c.horizon_hours === 24,
    );
    const b24 = metrics.confidence_cohorts.find(
      (c) => c.setup_confidence === 'B' && c.horizon_hours === 24,
    );
    const c24 = metrics.confidence_cohorts.find(
      (c) => c.setup_confidence === 'C' && c.horizon_hours === 24,
    );
    expect(a24).toMatchObject({ mean_return_pct: 1.5, n: 2 });
    expect(b24).toMatchObject({ mean_return_pct: -3, n: 1 });
    expect(c24).toMatchObject({ mean_return_pct: null, n: 0 });
  });

  it('computes new-to-list vs incumbent means, side-adjusted and scoped to watchlisted (sided) rows only', () => {
    // watchlisted rows: A,B,C,D. new: A(long, +5 as-is), D(short, -6 raw -> +6 adjusted, a winning
    // short) -> mean 5.5, n=2. incumbent: B(long, -3 as-is), C(short, +2 raw -> -2 adjusted, a
    // losing short) -> mean -2.5, n=2. E (side=null) must not leak into either bucket.
    const newCohort = metrics.new_to_list_cohorts.find(
      (c) => c.cohort === 'new' && c.horizon_hours === 24,
    );
    const incumbentCohort = metrics.new_to_list_cohorts.find(
      (c) => c.cohort === 'incumbent' && c.horizon_hours === 24,
    );
    expect(newCohort).toMatchObject({ mean_return_pct: 5.5, n: 2 });
    expect(incumbentCohort).toMatchObject({ mean_return_pct: -2.5, n: 2 });
  });

  it('side-adjusts a cohort of one winning short (negative raw return) to a positive mean', () => {
    // Red-proof for the side-adjustment fix: without it, a lone winning short (price fell, raw
    // return negative) would wrongly report a negative cohort mean in both cohort computations.
    const winningShortRows: WeeklyReviewInputRow[] = [
      row({
        symbol: 'F',
        horizon_hours: 24,
        fwd_return_pct: -5,
        fwd_residual_pct: null,
        side: 'short',
        setup_confidence: 'A',
        new_to_list: true,
      }),
    ];
    const winningShortMetrics = computeWeeklyReviewMetrics(
      winningShortRows,
      atHours(-168),
      atHours(0),
    );

    const confidenceA24 = winningShortMetrics.confidence_cohorts.find(
      (c) => c.setup_confidence === 'A' && c.horizon_hours === 24,
    );
    const newCohort24 = winningShortMetrics.new_to_list_cohorts.find(
      (c) => c.cohort === 'new' && c.horizon_hours === 24,
    );
    expect(confidenceA24).toMatchObject({ mean_return_pct: 5, n: 1 });
    expect(newCohort24).toMatchObject({ mean_return_pct: 5, n: 1 });
  });

  it('returns an empty-input shape with every bucket at n=0', () => {
    const empty = computeWeeklyReviewMetrics([], atHours(-168), atHours(0));
    expect(empty.side_hit_rates.every((s) => s.n_raw === 0 && s.n_residual === 0)).toBe(true);
    expect(empty.universe.every((u) => u.n === 0 && u.median_return_pct === null)).toBe(true);
    expect(empty.confidence_cohorts.every((c) => c.n === 0)).toBe(true);
    expect(empty.new_to_list_cohorts.every((c) => c.n === 0)).toBe(true);
  });
});

describe('loadWeeklyReviewInputs / hasLabeledRowsInWindow / save+load', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    ({ dir, db } = setupTempDb('crypto-screener-weekly-review-'));
  });

  afterEach(() => {
    teardownTempDb(dir, db);
  });

  function insertFactorHistoryRow(
    runId: string,
    offsetHours: number,
    symbol: string,
    metrics: Record<string, unknown> = {},
  ): void {
    db.prepare(
      `INSERT INTO factor_history (run_id, generated_at, symbol, price_usd, factors_json, scores_json, metrics_json)
       VALUES (?, ?, ?, 100, '{}', '{}', ?)`,
    ).run(runId, atHours(offsetHours), symbol, JSON.stringify(metrics));
  }

  function insertOutcomeLabelRow(
    runId: string,
    offsetHours: number,
    symbol: string,
    horizonHours: number,
    fwdReturnPct: number,
  ): void {
    db.prepare(
      `INSERT INTO outcome_labels
          (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
           btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(runId, atHours(offsetHours), symbol, horizonHours, fwdReturnPct, runId, horizonHours);
  }

  it('joins outcome_labels to factor_history and reads side/setup_confidence off metrics_json', () => {
    insertFactorHistoryRow('run1', 0, 'X', { watchlist_side: 'long', setup_confidence: 'A' });
    insertOutcomeLabelRow('run1', 0, 'X', 24, 5);

    const rows = loadWeeklyReviewInputs(db, atHours(-1), atHours(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'X',
      side: 'long',
      setup_confidence: 'A',
      fwd_return_pct: 5,
    });
  });

  it('excludes rows outside [weekStart, weekEnd)', () => {
    insertFactorHistoryRow('in', 0, 'X');
    insertOutcomeLabelRow('in', 0, 'X', 24, 1);
    insertFactorHistoryRow('out', 200, 'X');
    insertOutcomeLabelRow('out', 200, 'X', 24, 1);

    const rows = loadWeeklyReviewInputs(db, atHours(-10), atHours(10));
    expect(rows.map((r) => r.run_id)).toEqual(['in']);
  });

  it('recomputes new_to_list per run via the same previousRunMembership/watchlistDiff dashboard uses', () => {
    // run1 is the first run ever recorded -- no earlier baseline exists, so watchlistDiff
    // suppresses new_to_list entirely (matches dashboard/runDiff.ts's own documented guard).
    insertFactorHistoryRow('run1', 0, 'X', { watchlist_side: 'long' });
    insertOutcomeLabelRow('run1', 0, 'X', 24, 5);

    // run2: X stays long (incumbent), Y joins long for the first time (new).
    insertFactorHistoryRow('run2', 48, 'X', { watchlist_side: 'long' });
    insertFactorHistoryRow('run2', 48, 'Y', { watchlist_side: 'long' });
    insertOutcomeLabelRow('run2', 48, 'X', 24, 1);
    insertOutcomeLabelRow('run2', 48, 'Y', 24, 2);

    const rows = loadWeeklyReviewInputs(db, atHours(-1), atHours(100));
    const run1X = rows.find((r) => r.run_id === 'run1' && r.symbol === 'X');
    const run2X = rows.find((r) => r.run_id === 'run2' && r.symbol === 'X');
    const run2Y = rows.find((r) => r.run_id === 'run2' && r.symbol === 'Y');

    expect(run1X?.new_to_list).toBe(false);
    expect(run2X?.new_to_list).toBe(false);
    expect(run2Y?.new_to_list).toBe(true);
  });

  it('hasLabeledRowsInWindow is a cheap presence check, not a count', () => {
    expect(hasLabeledRowsInWindow(db, atHours(-1), atHours(1))).toBe(false);

    insertFactorHistoryRow('r', 0, 'X');
    insertOutcomeLabelRow('r', 0, 'X', 24, 1);

    expect(hasLabeledRowsInWindow(db, atHours(-1), atHours(1))).toBe(true);
    expect(hasLabeledRowsInWindow(db, atHours(10), atHours(20))).toBe(false);
  });

  it('returns null before any weekly_reviews row exists', () => {
    expect(loadLatestWeeklyReview(db)).toBeNull();
  });

  it('round-trips through save/load, returning the newest row by generated_at', () => {
    const metricsA = computeWeeklyReviewMetrics([], atHours(-168), atHours(0));
    saveWeeklyReview(db, {
      generated_at: atHours(0),
      week_start: atHours(-168),
      week_end: atHours(0),
      metrics: metricsA,
      narrative: 'first review',
      model: 'deepseek-v4-pro',
    });
    expect(loadLatestWeeklyReview(db)?.narrative).toBe('first review');

    const metricsB = computeWeeklyReviewMetrics([], atHours(0), atHours(168));
    saveWeeklyReview(db, {
      generated_at: atHours(168),
      week_start: atHours(0),
      week_end: atHours(168),
      metrics: metricsB,
      narrative: null,
      model: null,
    });

    const latest = loadLatestWeeklyReview(db);
    expect(latest?.generated_at).toBe(atHours(168));
    expect(latest?.narrative).toBeNull();
    expect(latest?.model).toBeNull();
    expect(latest?.metrics).toEqual(JSON.parse(JSON.stringify(metricsB)));
  });

  it('INSERT OR REPLACE on generated_at: saving the same generated_at again overwrites, not duplicates', () => {
    const metrics = computeWeeklyReviewMetrics([], atHours(-168), atHours(0));
    saveWeeklyReview(db, {
      generated_at: atHours(0),
      week_start: atHours(-168),
      week_end: atHours(0),
      metrics,
      narrative: 'v1',
      model: 'deepseek-v4-pro',
    });
    saveWeeklyReview(db, {
      generated_at: atHours(0),
      week_start: atHours(-168),
      week_end: atHours(0),
      metrics,
      narrative: 'v2',
      model: 'deepseek-v4-pro',
    });

    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM weekly_reviews').get() as { count: number }
    ).count;
    expect(count).toBe(1);
    expect(loadLatestWeeklyReview(db)?.narrative).toBe('v2');
  });
});
