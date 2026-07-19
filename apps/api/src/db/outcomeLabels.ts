import type Database from 'better-sqlite3';
import {
  formatJakartaIso,
  horizonTolerance,
  parseGeneratedAt,
  selectHorizonMatch,
} from './time.js';

// factor_history has no FK on run_id (see schema.ts); BTC's own leg is looked up by run_id, not by
// a foreign key -- matches the same synthetic backfill-* run_ids the base rows may carry.
const BTC_SYMBOL = 'BTC';
const DEFAULT_HORIZONS = [24, 72];

interface FactorHistoryLabelDbRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd: number | null;
  metrics_json: string;
}

interface SeriesPoint {
  run_id: string;
  generated_at: string;
  instant: Date;
  price_usd: number | null;
  metrics: Record<string, unknown>;
}

/** Local, not imported from dashboard/payload.ts's loadsJson -- the db layer does not depend on dashboard/. */
function parseMetrics(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Shared row->SeriesPoint mapping for both the full-table (loadSeriesBySymbol) and windowed (loadSeriesInWindow) fetchers below. */
function rowsToSeriesBySymbol(rows: FactorHistoryLabelDbRow[]): Map<string, SeriesPoint[]> {
  const bySymbol = new Map<string, SeriesPoint[]>();
  for (const row of rows) {
    const point: SeriesPoint = {
      run_id: row.run_id,
      generated_at: row.generated_at,
      instant: parseGeneratedAt(row.generated_at),
      price_usd: row.price_usd,
      metrics: parseMetrics(row.metrics_json),
    };
    const existing = bySymbol.get(row.symbol);
    if (existing) {
      existing.push(point);
    } else {
      bySymbol.set(row.symbol, [point]);
    }
  }
  return bySymbol;
}

/**
 * `symbols`, when given, pushes the filter into SQL so a --symbols run doesn't full-scan
 * factor_history (never-pruned) and JSON-parse every row just to throw most of them away. BTC is
 * always added to the fetch set -- the residual leg needs BTC's own series even when BTC itself
 * wasn't requested -- but callers still gate BTC *output* by whether BTC was actually requested
 * (see buildOutcomeLabels's symbolFilter check).
 */
function loadSeriesBySymbol(
  db: Database.Database,
  symbols?: string[] | undefined,
): Map<string, SeriesPoint[]> {
  let query = `SELECT run_id, generated_at, symbol, price_usd, metrics_json
       FROM factor_history`;
  const params: string[] = [];
  if (symbols && symbols.length > 0) {
    const fetchSymbols = new Set(symbols);
    fetchSymbols.add(BTC_SYMBOL);
    query += ` WHERE symbol IN (${Array.from(fetchSymbols, () => '?').join(', ')})`;
    params.push(...fetchSymbols);
  }
  query += ` ORDER BY symbol ASC, generated_at ASC`;

  const rows = db.prepare(query).all(...params) as FactorHistoryLabelDbRow[];
  return rowsToSeriesBySymbol(rows);
}

/**
 * Same shape as loadSeriesBySymbol, but bounded to [minGeneratedAt, maxGeneratedAt] and to a given
 * symbol set (always widened to include BTC, for the residual leg) -- used by labelClosedWindows so
 * a bounded labeling pass never has to load the entire factor_history table into memory, only the
 * slice its candidate rows actually need. Uses idx_factor_history_symbol_time(symbol, generated_at).
 */
function loadSeriesInWindow(
  db: Database.Database,
  symbols: string[],
  minGeneratedAt: string,
  maxGeneratedAt: string,
): Map<string, SeriesPoint[]> {
  const fetchSymbols = new Set(symbols);
  fetchSymbols.add(BTC_SYMBOL);
  const placeholders = Array.from(fetchSymbols, () => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT run_id, generated_at, symbol, price_usd, metrics_json
       FROM factor_history
       WHERE symbol IN (${placeholders}) AND generated_at >= ? AND generated_at <= ?
       ORDER BY symbol ASC, generated_at ASC`,
    )
    .all(...fetchSymbols, minGeneratedAt, maxGeneratedAt) as FactorHistoryLabelDbRow[];
  return rowsToSeriesBySymbol(rows);
}

/** `(future/base - 1) x 100`. Callers only invoke this once `basePrice > 0` is already known. */
function forwardReturnPct(basePrice: number, futurePrice: number): number {
  return ((futurePrice - basePrice) / basePrice) * 100;
}

/** Same tolerance semantics as loadPriceLookback (factorHistory.ts), but forward: candidates strictly after `baseInstant`. */
function findForwardMatch(
  series: SeriesPoint[],
  baseInstant: Date,
  hours: number,
): SeriesPoint | null {
  const [minHours, maxHours] = horizonTolerance(hours);
  const candidates = series
    .filter((point) => point.price_usd !== null && point.price_usd > 0)
    .map((point) => ({
      value: point,
      deltaHours: (point.instant.getTime() - baseInstant.getTime()) / 3_600_000,
    }));
  return selectHorizonMatch(candidates, minHours, maxHours, hours);
}

export interface OutcomeLabelRecord {
  run_id: string;
  generated_at: string;
  symbol: string;
  horizon_hours: number;
  fwd_return_pct: number;
  fwd_residual_pct: number | null;
  btc_fwd_return_pct: number | null;
  beta_used: number | null;
  matched_run_id: string;
  matched_delta_hours: number;
}

type ResidualOutcome = 'ok' | 'missing_beta' | 'missing_btc_match';

type LabelOutcome =
  | { kind: 'no_forward_match' }
  | { kind: 'labeled'; record: OutcomeLabelRecord; residualOutcome: ResidualOutcome };

/**
 * Core per-(base row, horizon) labeling pass, shared by buildOutcomeLabels' full-table scan (CLI)
 * and labelClosedWindows' bounded scan (auto-labeling) below -- the two differ only in how they
 * gather `series`/`btcSeries`/`btcByRunId`, never in how a match is scored once gathered.
 */
function labelBaseAtHorizon(
  base: SeriesPoint,
  symbol: string,
  series: SeriesPoint[],
  btcSeries: SeriesPoint[],
  btcByRunId: Map<string, SeriesPoint>,
  hours: number,
): LabelOutcome {
  const hasValidBasePrice = base.price_usd !== null && base.price_usd > 0;
  if (!hasValidBasePrice) {
    return { kind: 'no_forward_match' };
  }
  const matched = findForwardMatch(series, base.instant, hours);
  if (matched === null || matched.price_usd === null) {
    return { kind: 'no_forward_match' };
  }

  const basePrice = base.price_usd as number;
  const fwdReturnPct = forwardReturnPct(basePrice, matched.price_usd);
  const matchedDeltaHours = (matched.instant.getTime() - base.instant.getTime()) / 3_600_000;

  const betaUsed = numberOrNull(base.metrics.btc_beta);
  let btcFwdReturnPct: number | null = null;
  const btcBase = btcByRunId.get(base.run_id);
  if (btcBase && btcBase.price_usd !== null && btcBase.price_usd > 0) {
    // Prefer BTC's row at the symbol's own matched run -- both legs then span exactly
    // [base run -> matched run] instead of an independent closest-to-target search that can
    // land BTC on a different run than the symbol. Fall back to that independent search when
    // BTC has no row (or no valid price) at the matched run.
    const btcAtMatchedRun = btcByRunId.get(matched.run_id);
    const btcMatched =
      btcAtMatchedRun && btcAtMatchedRun.price_usd !== null && btcAtMatchedRun.price_usd > 0
        ? btcAtMatchedRun
        : findForwardMatch(btcSeries, btcBase.instant, hours);
    if (btcMatched !== null && btcMatched.price_usd !== null) {
      btcFwdReturnPct = forwardReturnPct(btcBase.price_usd, btcMatched.price_usd);
    }
  }

  let fwdResidualPct: number | null = null;
  let residualOutcome: ResidualOutcome = 'ok';
  if (betaUsed === null) {
    residualOutcome = 'missing_beta';
  } else if (btcFwdReturnPct === null) {
    residualOutcome = 'missing_btc_match';
  } else {
    fwdResidualPct = fwdReturnPct - betaUsed * btcFwdReturnPct;
  }

  return {
    kind: 'labeled',
    residualOutcome,
    record: {
      run_id: base.run_id,
      generated_at: base.generated_at,
      symbol,
      horizon_hours: hours,
      fwd_return_pct: fwdReturnPct,
      fwd_residual_pct: fwdResidualPct,
      btc_fwd_return_pct: btcFwdReturnPct,
      beta_used: betaUsed,
      matched_run_id: matched.run_id,
      matched_delta_hours: matchedDeltaHours,
    },
  };
}

/** Folds a labelBaseAtHorizon outcome into `records`/`summary`, identically for every caller below. */
function applyLabelOutcome(
  outcome: LabelOutcome,
  hours: number,
  records: OutcomeLabelRecord[],
  summary: OutcomeLabelSummary,
): void {
  if (outcome.kind === 'no_forward_match') {
    summary.skipped_no_forward_match[hours] = (summary.skipped_no_forward_match[hours] ?? 0) + 1;
    return;
  }
  records.push(outcome.record);
  summary.labeled[hours] = (summary.labeled[hours] ?? 0) + 1;
  if (outcome.residualOutcome === 'missing_beta') {
    summary.null_residual_missing_beta[hours] =
      (summary.null_residual_missing_beta[hours] ?? 0) + 1;
    summary.null_residual[hours] = (summary.null_residual[hours] ?? 0) + 1;
  } else if (outcome.residualOutcome === 'missing_btc_match') {
    summary.null_residual_missing_btc_match[hours] =
      (summary.null_residual_missing_btc_match[hours] ?? 0) + 1;
    summary.null_residual[hours] = (summary.null_residual[hours] ?? 0) + 1;
  }
}

export function prepareOutcomeLabelInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO outcome_labels
        (run_id, generated_at, symbol, horizon_hours, fwd_return_pct, fwd_residual_pct,
         btc_fwd_return_pct, beta_used, matched_run_id, matched_delta_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

/** Idempotent: INSERT OR REPLACE on the (run_id, symbol, horizon_hours) primary key. */
export function saveOutcomeLabelRecords(
  db: Database.Database,
  records: OutcomeLabelRecord[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const insert = prepareOutcomeLabelInsert(db);
  const insertAll = db.transaction((rows: OutcomeLabelRecord[]) => {
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.generated_at,
        row.symbol,
        row.horizon_hours,
        row.fwd_return_pct,
        row.fwd_residual_pct,
        row.btc_fwd_return_pct,
        row.beta_used,
        row.matched_run_id,
        row.matched_delta_hours,
      );
    }
  });
  insertAll(records);
  return records.length;
}

export interface LabelOutcomesOptions {
  horizons?: number[] | undefined;
  symbols?: string[] | undefined;
}

export interface OutcomeLabelSummary {
  horizons: number[];
  base_rows_considered: number;
  base_rows_skipped_untrusted: number;
  base_rows_trusted_missing_flag: number;
  labeled: Record<number, number>;
  skipped_no_forward_match: Record<number, number>;
  null_residual: Record<number, number>;
  null_residual_missing_beta: Record<number, number>;
  null_residual_missing_btc_match: Record<number, number>;
}

export interface BuildOutcomeLabelsResult {
  records: OutcomeLabelRecord[];
  summary: OutcomeLabelSummary;
}

/**
 * Builds forward-outcome labels for every factor_history base row (any run_id, including
 * backfill-*) whose metrics_json.is_trusted !== false, at each requested horizon. Read-only --
 * does not write to the database; callers decide whether/how to persist `records` (see
 * cli/outcomes.ts's --dry-run and saveOutcomeLabelRecords).
 */
export function buildOutcomeLabels(
  db: Database.Database,
  options: LabelOutcomesOptions = {},
): BuildOutcomeLabelsResult {
  const horizons = options.horizons ?? DEFAULT_HORIZONS;
  const symbolFilter = options.symbols ? new Set(options.symbols) : null;
  const bySymbol = loadSeriesBySymbol(db, options.symbols);
  const btcSeries = bySymbol.get(BTC_SYMBOL) ?? [];
  const btcByRunId = new Map(btcSeries.map((point) => [point.run_id, point]));

  const summary = emptySummary(horizons);

  const records: OutcomeLabelRecord[] = [];

  for (const [symbol, series] of bySymbol) {
    if (symbolFilter && !symbolFilter.has(symbol)) {
      continue;
    }
    for (const base of series) {
      const isTrusted = base.metrics.is_trusted;
      if (isTrusted === false) {
        summary.base_rows_skipped_untrusted += 1;
        continue;
      }
      if (isTrusted === undefined) {
        summary.base_rows_trusted_missing_flag += 1;
      }
      summary.base_rows_considered += 1;

      for (const hours of horizons) {
        const outcome = labelBaseAtHorizon(base, symbol, series, btcSeries, btcByRunId, hours);
        applyLabelOutcome(outcome, hours, records, summary);
      }
    }
  }

  return { records, summary };
}

function emptySummary(horizons: number[]): OutcomeLabelSummary {
  return {
    horizons,
    base_rows_considered: 0,
    base_rows_skipped_untrusted: 0,
    base_rows_trusted_missing_flag: 0,
    labeled: Object.fromEntries(horizons.map((h) => [h, 0])),
    skipped_no_forward_match: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual_missing_beta: Object.fromEntries(horizons.map((h) => [h, 0])),
    null_residual_missing_btc_match: Object.fromEntries(horizons.map((h) => [h, 0])),
  };
}

interface HorizonCandidateRow {
  run_id: string;
  generated_at: string;
  symbol: string;
  price_usd: number | null;
  metrics_json: string;
}

/**
 * Candidate base rows for one horizon: closed (generated_at old enough that the whole
 * [0.75x, 1.5x] tolerance band has elapsed) and not yet labeled at this horizon. Bounded on both
 * ends -- `cutoff` from above, and the highest generated_at already labeled at this horizon (the
 * "low-water mark") from below -- so a steady-state call only ever touches the slice of
 * factor_history that closed since the last labeling pass, not the whole (never-pruned) table.
 * The very first call, with no prior outcome_labels rows for this horizon, has no low-water mark
 * and legitimately scans from the beginning -- the one-time catch-up this feature exists for.
 *
 * One accepted tradeoff of the low-water mark: a base row whose horizon window closed with no
 * forward match at all (so it never produced an outcome_labels row) will not be retried once an
 * even-newer row at the same horizon *has* been labeled -- unlike the CLI's unbounded rescan
 * (buildOutcomeLabels), which naturally retries everything on every invocation. Accepted because
 * these are steady per-refresh calls, not one-off backfills; a stuck symbol stays stuck rather
 * than costing a full rescan every refresh.
 */
function fetchClosedUnlabeledCandidates(
  db: Database.Database,
  hours: number,
  cutoff: string,
): HorizonCandidateRow[] {
  // No index covers (horizon_hours, generated_at) -- this is a full outcome_labels scan, but a
  // cheap one (two TEXT columns, no JSON parsing), done once per horizon per call.
  const lowWaterMarkRow = db
    .prepare('SELECT MAX(generated_at) AS mark FROM outcome_labels WHERE horizon_hours = ?')
    .get(hours) as { mark: string | null };
  const lowWaterMark = lowWaterMarkRow.mark;

  let query = `
    SELECT fh.run_id, fh.generated_at, fh.symbol, fh.price_usd, fh.metrics_json
    FROM factor_history fh
    WHERE fh.generated_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM outcome_labels ol
        WHERE ol.run_id = fh.run_id AND ol.symbol = fh.symbol AND ol.horizon_hours = ?
      )`;
  const params: Array<string | number> = [cutoff, hours];
  if (lowWaterMark !== null) {
    query += ' AND fh.generated_at > ?';
    params.push(lowWaterMark);
  }
  query += ' ORDER BY fh.generated_at ASC';

  return db.prepare(query).all(...params) as HorizonCandidateRow[];
}

function labelHorizon(
  db: Database.Database,
  hours: number,
  now: Date,
  summary: OutcomeLabelSummary,
  consideredRowKeys: Set<string>,
): OutcomeLabelRecord[] {
  const [, maxToleranceHours] = horizonTolerance(hours);
  const cutoff = formatJakartaIso(new Date(now.getTime() - maxToleranceHours * 3_600_000));
  const candidateRows = fetchClosedUnlabeledCandidates(db, hours, cutoff);
  if (candidateRows.length === 0) {
    return [];
  }

  const trustedBySymbol = new Map<string, SeriesPoint[]>();
  for (const row of candidateRows) {
    const metrics = parseMetrics(row.metrics_json);
    const isTrusted = metrics.is_trusted;
    if (isTrusted === false) {
      summary.base_rows_skipped_untrusted += 1;
      continue;
    }
    if (isTrusted === undefined) {
      summary.base_rows_trusted_missing_flag += 1;
    }
    // A base row (run_id+symbol -- factor_history's own primary key) can be a closed, unlabeled
    // candidate at more than one horizon at once; count it into base_rows_considered only the first
    // time it's seen so this matches buildOutcomeLabels' once-per-base-row semantics instead of
    // once-per-(row, horizon).
    const rowKey = `${row.run_id}|${row.symbol}`;
    if (!consideredRowKeys.has(rowKey)) {
      consideredRowKeys.add(rowKey);
      summary.base_rows_considered += 1;
    }

    const point: SeriesPoint = {
      run_id: row.run_id,
      generated_at: row.generated_at,
      instant: parseGeneratedAt(row.generated_at),
      price_usd: row.price_usd,
      metrics,
    };
    const existing = trustedBySymbol.get(row.symbol);
    if (existing) {
      existing.push(point);
    } else {
      trustedBySymbol.set(row.symbol, [point]);
    }
  }

  if (trustedBySymbol.size === 0) {
    return [];
  }

  // candidateRows is ORDER BY generated_at ASC, so its first/last rows bound the window this
  // horizon's forward-match search needs.
  const minGeneratedAt = candidateRows[0]?.generated_at as string;
  const maxBaseGeneratedAt = candidateRows[candidateRows.length - 1]?.generated_at as string;
  const maxForwardGeneratedAt = formatJakartaIso(
    new Date(parseGeneratedAt(maxBaseGeneratedAt).getTime() + maxToleranceHours * 3_600_000),
  );

  const seriesBySymbol = loadSeriesInWindow(
    db,
    [...trustedBySymbol.keys()],
    minGeneratedAt,
    maxForwardGeneratedAt,
  );
  const btcSeries = seriesBySymbol.get(BTC_SYMBOL) ?? [];
  const btcByRunId = new Map(btcSeries.map((point) => [point.run_id, point]));

  const records: OutcomeLabelRecord[] = [];
  for (const [symbol, bases] of trustedBySymbol) {
    const series = seriesBySymbol.get(symbol) ?? [];
    for (const base of bases) {
      const outcome = labelBaseAtHorizon(base, symbol, series, btcSeries, btcByRunId, hours);
      applyLabelOutcome(outcome, hours, records, summary);
    }
  }
  return records;
}

export interface LabelClosedWindowsResult extends BuildOutcomeLabelsResult {
  written: number;
}

/**
 * The bounded, auto-labeling counterpart to buildOutcomeLabels (see that function's doc comment):
 * labels only factor_history base rows whose horizon window has already closed and that have no
 * outcome_labels row yet, then persists them via saveOutcomeLabelRecords. Idempotent -- a second
 * call with no new closed rows in between writes nothing (fetchClosedUnlabeledCandidates' anti-join
 * already excludes anything labeled by the first call; the low-water mark is a bounded-cost
 * optimization on top of that, not the idempotence guarantee itself).
 */
export function labelClosedWindows(db: Database.Database, now: Date): LabelClosedWindowsResult {
  const horizons = DEFAULT_HORIZONS;
  const summary = emptySummary(horizons);
  // Shared across every horizon's labelHorizon call below -- see that function's own comment.
  const consideredRowKeys = new Set<string>();

  const records: OutcomeLabelRecord[] = [];
  for (const hours of horizons) {
    records.push(...labelHorizon(db, hours, now, summary, consideredRowKeys));
  }

  const written = saveOutcomeLabelRecords(db, records);
  return { records, summary, written };
}
