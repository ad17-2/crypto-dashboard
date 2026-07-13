import type Database from 'better-sqlite3';
import type { RecommendationRecordInput, RecommendationWatchlistInput } from './types.js';

function prepareRecommendationsInsert(db: Database.Database): Database.Statement {
  return db.prepare(`
    INSERT OR REPLACE INTO recommendations
        (run_id, generated_at, symbol, watchlist, side, score_field, signal_value, size_multiplier, round_trip_cost_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

export function saveRecommendations(
  db: Database.Database,
  records: RecommendationRecordInput[],
): number {
  if (records.length === 0) {
    return 0;
  }
  const insert = prepareRecommendationsInsert(db);
  const insertAll = db.transaction((rows: RecommendationRecordInput[]) => {
    for (const row of rows) {
      insert.run(
        row.run_id,
        row.generated_at,
        row.symbol,
        row.watchlist,
        row.side ?? null,
        row.score_field ?? null,
        row.signal_value ?? null,
        row.size_multiplier ?? null,
        row.round_trip_cost_pct ?? null,
      );
    }
  });
  insertAll(records);
  return records.length;
}

/** side/score_field/signal_value/size_multiplier/round_trip_cost_pct never depend on buildSections/buildWatchlists' `history` argument, so callers may pass an empty history map here without drift from the dashboard. */
export function recommendationsFromWatchlists(
  watchlists: RecommendationWatchlistInput[],
  runId: string,
  generatedAt: string,
): RecommendationRecordInput[] {
  const records: RecommendationRecordInput[] = [];
  for (const watchlist of watchlists) {
    for (const row of watchlist.rows) {
      if (!row.symbol) {
        continue;
      }
      records.push({
        run_id: runId,
        generated_at: generatedAt,
        symbol: row.symbol,
        watchlist: watchlist.id,
        side: row.side,
        score_field: row.score_field,
        signal_value: row.score ?? null,
        size_multiplier: row.scores.size_multiplier ?? null,
        round_trip_cost_pct: row.scores.round_trip_cost_pct ?? null,
      });
    }
  }
  return records;
}
