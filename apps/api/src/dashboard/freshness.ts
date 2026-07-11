import type Database from 'better-sqlite3';
import { pyRound } from '../pipeline/scoring.js';

/** Port of crypto_screener/dashboard_freshness.py. */

const EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO-8601 `generated_at` string the way `datetime.fromisoformat` does, with the SAME
 * naive-string fallback dashboard_freshness.py uses: a string with no offset/Z suffix is assumed
 * to be **UTC**. This deliberately differs from db/time.ts::parseGeneratedAt, which assumes
 * Asia/Jakarta (+07:00) for naive strings -- that is storage.py's convention for its own cutoff
 * math, not dashboard_freshness.py's. Returns null on an unparseable string (mirrors the
 * `except ValueError` branch).
 */
function parseIsoAssumingUtc(text: string): Date | null {
  const withOffset = EXPLICIT_OFFSET_PATTERN.test(text) ? text : `${text}Z`;
  const parsed = new Date(withOffset);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface FreshnessSummary {
  status: string;
  label: string;
  generated_at?: string;
  age_seconds: number | null;
  age_minutes: number | null;
  help?: string;
}

/** Port of dashboard_freshness.py::freshness_summary. */
export function freshnessSummary(generatedAt: string | null | undefined): FreshnessSummary {
  if (!generatedAt) {
    return { status: 'unknown', label: 'unknown', age_seconds: null, age_minutes: null };
  }
  const parsed = parseIsoAssumingUtc(generatedAt);
  if (parsed === null) {
    return {
      status: 'unknown',
      label: 'unknown',
      generated_at: generatedAt,
      age_seconds: null,
      age_minutes: null,
    };
  }
  const ageSeconds = Math.max(0.0, (Date.now() - parsed.getTime()) / 1000.0);
  let label: string;
  if (ageSeconds <= 4 * 60 * 60) {
    label = 'fresh';
  } else if (ageSeconds <= 12 * 60 * 60) {
    label = 'aging';
  } else if (ageSeconds <= 24 * 60 * 60) {
    label = 'stale';
  } else {
    label = 'old';
  }
  return {
    status: 'ok',
    label,
    generated_at: generatedAt,
    age_seconds: pyRound(ageSeconds, 0),
    age_minutes: pyRound(ageSeconds / 60.0, 1),
    help: 'Freshness is based on the selected saved run, not live tick data.',
  };
}

/** Port of dashboard_freshness.py::latest_run_generated_at, taking an already-open db handle
 * instead of a db path (this port's convention -- see apps/api/src/db/client.ts::openDatabase). */
export function latestRunGeneratedAt(db: Database.Database): Date | null {
  const row = db
    .prepare('SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1')
    .get() as { generated_at: string } | undefined;
  if (row === undefined) {
    return null;
  }
  return parseIsoAssumingUtc(row.generated_at);
}

/** Port of dashboard_freshness.py::latest_run_age_seconds. */
export function latestRunAgeSeconds(db: Database.Database): number | null {
  const generatedAt = latestRunGeneratedAt(db);
  if (generatedAt === null) {
    return null;
  }
  return Math.max(0.0, (Date.now() - generatedAt.getTime()) / 1000.0);
}
