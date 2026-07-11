import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import {
  loadLabeledFactorRecords,
  loadLabeledRecordsByHorizon,
  loadLatestRegimeState,
  loadPriceLookback,
  openDatabase,
  saveSnapshot,
} from '../db/index.js';
import { formatJakartaIso } from '../db/time.js';
import type { SnapshotPayload } from '../db/types.js';
import { writeReports } from '../reports/writeReports.js';
import { collectMarket } from './collector.js';
import { scoreSnapshot } from './factors.js';
import type { FactorRecord } from './ic.js';
import type { RunPayload } from './models.js';
import { pctChange, toFloat } from './scoring.js';
import { factorDecay } from './validation.js';

/**
 * Orchestrates one full pipeline run in a fixed stage order:
 *   collectMarket -> loadLabeledFactorRecords -> loadPriceLookback (adds price_change_72h_pct) ->
 *   loadLatestRegimeState -> scoreSnapshot -> loadLabeledRecordsByHorizon -> factorDecay ->
 *   build RunPayload -> saveSnapshot -> writeReports.
 */

export interface RunPipelineOptions {
  /** Write this run into SQLite history. Defaults to `true`, matching `run_pipeline`'s `save=True`. */
  save?: boolean;
  /** Write the Markdown/JSON/CSV report files. Defaults to `true`, matching
   * `run_pipeline`'s `write_report_files=True`. */
  writeReportFiles?: boolean;
}

export interface RunPipelineResult {
  payload: RunPayload;
  paths: Record<string, string>;
}

/**
 * Derives "YYYYMMDD-HHMMSS" from a Jakarta-local ISO-8601 string (with explicit `+07:00` offset,
 * i.e. `formatJakartaIso`'s own output) for the run_id stamp. reports/writeReports.ts keeps an
 * independent copy of this same formatting for its report-file stem -- both derive from
 * `payload.generated_at` rather than sharing this helper; keep them in sync if either changes.
 */
function compactJakartaStamp(generatedAtIso: string): string {
  const [datePart, timePart] = generatedAtIso.slice(0, 19).split('T');
  return `${(datePart ?? '').replace(/-/g, '')}-${(timePart ?? '').replace(/:/g, '')}`;
}

export async function runPipeline(
  config: AppConfig,
  outDir: string,
  options: RunPipelineOptions = {},
): Promise<RunPipelineResult> {
  const save = options.save ?? true;
  const writeReportFiles = options.writeReportFiles ?? true;

  const generatedAtIso = formatJakartaIso(new Date());
  // randomUUID()'s embedded version nibble falls after the first 8 hex characters (once hyphens
  // are stripped), so slicing the first 8 hex chars stays uniformly random.
  const runId = `${compactJakartaStamp(generatedAtIso)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  const db = openDatabase(config.storage_path);
  try {
    const collected = await collectMarket(config);

    const historyRecords = loadLabeledFactorRecords(db, {
      forwardReturnHours: config.factors.forward_return_hours,
      icWindowDays: config.factors.ic_window_days,
    });

    const lookbackHours = config.factors.reversal_lookback_hours;
    const lookbackPrices = loadPriceLookback(db, lookbackHours);
    for (const row of collected.rows) {
      const currentPrice = toFloat(row.price_usd);
      const pastPrice = lookbackPrices[String(row.symbol ?? '')];
      row.price_change_72h_pct =
        currentPrice !== null && pastPrice !== undefined && pastPrice > 0
          ? pctChange(pastPrice, currentPrice)
          : null;
    }

    const latestRegimeState = loadLatestRegimeState(db);
    // Same fresh-literal exemption as `regime` below: RegimeStateSummary has no index signature.
    const priorMarketState = latestRegimeState ? { ...latestRegimeState } : null;
    // LabeledFactorRecordWithRegime (db/types.ts) and FactorRecord (pipeline/ic.ts) are two
    // independently-typed shapes for the same open dict-of-fields record; FactorRecord declares an
    // index signature (`[key: string]: unknown`) that LabeledFactorRecordWithRegime, being a
    // closed set of named fields, does not -- a type-checker-only distinction, since every field
    // FactorRecord reads is present on LabeledFactorRecordWithRegime.
    const scored = scoreSnapshot(
      collected.rows,
      collected.market_context,
      historyRecords as unknown as FactorRecord[],
      config,
      priorMarketState,
    );

    const decayHorizons = config.factors.decay_horizons;
    const recordsByHorizon = loadLabeledRecordsByHorizon(db, decayHorizons, {
      icWindowDays: config.factors.ic_window_days,
    });
    const decay = factorDecay(recordsByHorizon as unknown as Map<number, FactorRecord[]>, config);

    const payload: RunPayload = {
      run_id: runId,
      generated_at: generatedAtIso,
      rows: scored.rows,
      market_context: scored.market_context ?? collected.market_context,
      provider_status: collected.provider_status,
      factor_weights: { ...scored.factor_weights, factor_decay: decay },
      // Spread into a fresh object literal: InferredRegime (pipeline/regime.ts) has no index
      // signature, so assigning the bare named-interface value directly to RunPayload's
      // `Record<string, unknown>` field is rejected even though every field is unknown-compatible;
      // a fresh literal is exempt from that check.
      regime: { ...scored.regime },
    };

    if (save) {
      // Row (pipeline/types.ts) and MarketRow (db/types.ts) are two independently-typed shapes for
      // the same open dict-of-fields row; they differ only in whether `symbol` is required, which
      // always holds at runtime by this point (collectMarket/scoreSnapshot always populate it)
      // even though the type checker can't see that across module boundaries.
      saveSnapshot(db, payload as unknown as SnapshotPayload, config);
    }
    const paths = writeReportFiles ? writeReports(payload, config, outDir) : {};
    return { payload, paths };
  } finally {
    db.close();
  }
}
