import type Database from 'better-sqlite3';
import { stableStringify } from './json.js';
import type { RegimeStateSummary, SnapshotPayload } from './types.js';

/** Mirrors scoring.py's `to_float`: best-effort numeric coercion, None/unparseable -> null. */
function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Mirrors storage.py's `_persist_market_regime_history`: appends one row per
 * run to market_regime_history. Plain INSERT, not INSERT OR REPLACE -- this
 * table has no primary key and is meant to accumulate a full history.
 */
export function recordRegimeHistory(db: Database.Database, payload: SnapshotPayload): void {
  const regime = payload.regime ?? {};
  const marketContext = payload.market_context ?? {};
  db.prepare(`
    INSERT INTO market_regime_history
        (run_id, generated_at, btc_dominance_pct, eth_btc_performance_pct, regime_state, regime_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    payload.run_id,
    payload.generated_at,
    toFloat(marketContext.btc_dominance_pct),
    toFloat(marketContext.eth_btc_performance_pct || regime.eth_btc_performance_pct),
    (regime.regime_state as string | undefined) || (regime.label as string | undefined) || null,
    stableStringify(regime),
  );
}

/** Mirrors storage.py's `load_regime_states`. */
export function loadRegimeStates(db: Database.Database): Record<string, string> {
  const rows = db
    .prepare(`
      SELECT generated_at, regime_state
      FROM market_regime_history
      WHERE regime_state IS NOT NULL
    `)
    .all() as Array<{ generated_at: string; regime_state: string }>;

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.generated_at] = row.regime_state;
  }
  return result;
}

/** Mirrors storage.py's `load_latest_regime_state`. */
export function loadLatestRegimeState(db: Database.Database): RegimeStateSummary | null {
  const row = db
    .prepare(`
      SELECT btc_dominance_pct, eth_btc_performance_pct, regime_state
      FROM market_regime_history
      ORDER BY generated_at DESC
      LIMIT 1
    `)
    .get() as
    | {
        btc_dominance_pct: number | null;
        eth_btc_performance_pct: number | null;
        regime_state: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }
  return {
    btc_dominance_pct: row.btc_dominance_pct,
    eth_btc_performance_pct: row.eth_btc_performance_pct,
    regime_state: row.regime_state,
  };
}
