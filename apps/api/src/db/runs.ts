import type Database from 'better-sqlite3';
import { historyMetrics, prepareFactorHistoryInsert } from './factorHistory.js';
import { stableStringify } from './json.js';
import { recordRegimeHistory } from './regimeHistory.js';
import type { PruneResult, SnapshotPayload } from './types.js';

/**
 * Mirrors storage.py's `save_snapshot`: upserts the `runs` row, upserts
 * `market_rows` + `factor_history` for every row in the payload, and appends
 * a `market_regime_history` entry, all in one transaction.
 */
export function saveSnapshot(
  db: Database.Database,
  payload: SnapshotPayload,
  config: Record<string, unknown>,
): void {
  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO runs
        (run_id, generated_at, config_json, context_json, provider_status_json, regime_json, factor_weights_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMarketRow = db.prepare(`
    INSERT OR REPLACE INTO market_rows
        (run_id, generated_at, symbol, price_usd, factors_json, scores_json, row_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFactorHistory = prepareFactorHistoryInsert(db);

  const persistSnapshot = db.transaction(() => {
    insertRun.run(
      payload.run_id,
      payload.generated_at,
      stableStringify(config),
      stableStringify(payload.market_context ?? {}),
      stableStringify(payload.provider_status ?? {}),
      stableStringify(payload.regime ?? {}),
      stableStringify(payload.factor_weights ?? {}),
    );

    for (const row of payload.rows ?? []) {
      const factorsJson = stableStringify(row.factors ?? {});
      const scoresJson = stableStringify(row.scores ?? {});

      insertMarketRow.run(
        payload.run_id,
        payload.generated_at,
        row.symbol ?? null,
        row.price_usd ?? null,
        factorsJson,
        scoresJson,
        stableStringify(row),
      );
      insertFactorHistory.run(
        payload.run_id,
        payload.generated_at,
        row.symbol ?? null,
        row.price_usd ?? null,
        factorsJson,
        scoresJson,
        stableStringify(historyMetrics(row)),
      );
    }

    recordRegimeHistory(db, payload);
  });
  persistSnapshot();
}

/**
 * Mirrors storage.py's `prune_old_runs`: deletes from `runs` and
 * `market_rows` ONLY, keeping the `keep` most recent runs by `generated_at`.
 *
 * factor_history and market_regime_history are NEVER touched here -- the
 * IC / decay / walk-forward engine depends on the full, unpruned
 * factor_history series. Do not add deletes for them, and do not add
 * ON DELETE CASCADE to the schema.
 */
export function pruneOldRuns(db: Database.Database, keep: number): PruneResult {
  if (keep <= 0) {
    return { kept_runs: 0, deleted_runs: 0, deleted_rows: 0 };
  }

  const prune = db.transaction((): PruneResult => {
    const keepRows = db
      .prepare('SELECT run_id FROM runs ORDER BY generated_at DESC LIMIT ?')
      .all(keep) as Array<{ run_id: string }>;
    const keepRunIds = keepRows.map((row) => row.run_id);

    const totalRuns = (db.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number })
      .count;
    if (totalRuns <= keepRunIds.length) {
      return { kept_runs: keepRunIds.length, deleted_runs: 0, deleted_rows: 0 };
    }

    const placeholders = keepRunIds.map(() => '?').join(',');
    const rowDelete = db
      .prepare(`DELETE FROM market_rows WHERE run_id NOT IN (${placeholders})`)
      .run(...keepRunIds);
    const runDelete = db
      .prepare(`DELETE FROM runs WHERE run_id NOT IN (${placeholders})`)
      .run(...keepRunIds);

    return {
      kept_runs: keepRunIds.length,
      deleted_runs: runDelete.changes,
      deleted_rows: rowDelete.changes,
    };
  });
  return prune();
}
