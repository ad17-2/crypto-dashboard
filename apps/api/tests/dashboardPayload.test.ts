import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { buildDashboardPayload } from '../src/dashboard/payload.js';
import { openDatabase } from '../src/db/client.js';

/**
 * THE PARITY GATE: apps/api/tests/fixtures/dashboard-payload.json is a REAL `GET /api/dashboard`
 * response (see apps/api/tests/fixtures/README.md for provenance), and
 * apps/api/tests/fixtures/parity.sqlite3 is a frozen snapshot of the database it was captured
 * against. This test copies that snapshot to a temp path (never opens the fixture read-write),
 * builds the payload with the ported TypeScript buildDashboardPayload(), and deep-compares the
 * result against the fixture with a 1e-9 float tolerance and STRICT key-set equality at every level
 * (sections, watchlists, every row, every nested object) -- missing or extra keys are failures, not
 * just differing values.
 *
 * The snapshot is deliberately NOT data/crypto_screener.sqlite3. That file is live, mutable state:
 * any real screener run appends a run and new factor_history rows, which legitimately shifts the IC
 * weights and decay curves and would break this comparison for reasons that have nothing to do with
 * the port's correctness. A correctness gate must be hermetic, so it pins its own input.
 *
 * EXCLUSION LIST (kept as short as possible; each entry justified individually, each excluded
 * field still asserted present with the right type before being excluded from the value compare):
 *
 *   1. freshness.age_seconds  -- `Date.now() - generated_at`; recomputed fresh every time this
 *      test runs, so it necessarily differs from the value the Python server happened to compute
 *      at its own capture time. Not a bug: buildDashboardPayload's whole *job* here is to report
 *      "how old is this run right now".
 *   2. freshness.age_minutes  -- derived from age_seconds (age_seconds / 60, rounded); same
 *      justification.
 *   3. top-level refresh_status -- injected by the HTTP handler (http/routes/dashboard.ts's
 *      dashboardRoute) AFTER calling buildDashboardPayload, not by the payload builder itself.
 *      packages/contracts/src/dashboard.ts's
 *      DashboardPayloadOkSchema already documents this ("optional here so this schema also
 *      validates the payload-builder's raw return value"). This is genuinely an HTTP-layer field,
 *      not a payload-builder field, so buildDashboardPayload() correctly never produces it.
 *
 * No other field is excluded: run/runs/regime/market_context/provider_status/factor_weights/
 * model_weights/factor_correlations/factor_decay/walk_forward/validation/quality/sections/
 * watchlists (every row inside them, including history/confluence/factor_parts/reason_parts/
 * explanation) are all compared exactly.
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/dashboard-payload.json',
);
const SOURCE_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/parity.sqlite3');

const FLOAT_TOLERANCE = 1e-9;

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
}

/**
 * Deep-equality diff with a 1e-9 tolerance for numbers and exact comparison for everything else,
 * including object key sets (an actual object missing or adding a key relative to expected is a
 * diff). Ported verbatim from apps/api/tests/parity.test.ts's collectDiffs -- see that file for
 * the original; duplicated here rather than exported/shared because the two tests' proximity to
 * their respective parity gates matters more than DRYing out ~60 lines of test-only comparison
 * logic shared by exactly two call sites.
 */
function collectDiffs(actual: unknown, expected: unknown, path: string, diffs: string[]): void {
  if (expected === null) {
    if (actual !== null) {
      diffs.push(`${path}: expected null, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'number') {
    if (
      typeof actual !== 'number' ||
      !Number.isFinite(actual) ||
      Math.abs(actual - expected) > FLOAT_TOLERANCE
    ) {
      diffs.push(`${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (typeof expected === 'string' || typeof expected === 'boolean') {
    if (actual !== expected) {
      diffs.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${path}: expected an array, got ${JSON.stringify(actual)}`);
      return;
    }
    if (actual.length !== expected.length) {
      diffs.push(
        `${path}: expected array of length ${expected.length}, got length ${actual.length}`,
      );
      return;
    }
    expected.forEach((item, index) => {
      collectDiffs(actual[index], item, `${path}[${index}]`, diffs);
    });
    return;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null) {
      diffs.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    const expectedKeys = Object.keys(expected as Record<string, unknown>).sort();
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (missing.length > 0) {
      diffs.push(`${path}: missing key(s) ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      diffs.push(`${path}: unexpected extra key(s) ${extra.join(', ')}`);
    }
    for (const key of expectedKeys) {
      if (actualKeys.includes(key)) {
        collectDiffs(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
          `${path}.${key}`,
          diffs,
        );
      }
    }
    return;
  }
  throw new Error(`collectDiffs: unhandled expected type at ${path}: ${typeof expected}`);
}

function assertMatches(actual: unknown, expected: unknown, label: string): void {
  const diffs: string[] = [];
  collectDiffs(actual, expected, label, diffs);
  if (diffs.length > 0) {
    const report = diffs.slice(0, 80).join('\n');
    const more = diffs.length > 80 ? `\n... and ${diffs.length - 80} more` : '';
    throw new Error(`${diffs.length} mismatch(es) under ${label}:\n${report}${more}`);
  }
}

describe('buildDashboardPayload parity vs. captured Python /api/dashboard response', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-screener-dashboard-payload-'));
  const dbPath = join(dir, 'crypto_screener.sqlite3');
  // Copy-then-open: the original repo database is NEVER opened read-write by this test.
  copyFileSync(SOURCE_DB_PATH, dbPath);
  const db = openDatabase(dbPath);

  const fixture = loadFixture();
  // config.storage_path/report.limit default to exactly 'data/crypto_screener.sqlite3' / 12 (see
  // config/schema.ts), matching both the fixture's "database" field and the CRYPTO_DASHBOARD_LIMIT
  // default (config.report.limit) used to capture it.
  const config = AppConfigSchema.parse({});
  expect(config.storage_path).toBe('data/crypto_screener.sqlite3');
  expect(config.report.limit).toBe(12);

  const actual = buildDashboardPayload(db, config, {
    limit: config.report.limit,
  }) as unknown as Record<string, unknown>;

  it('never produces a top-level refresh_status key (HTTP-layer only)', () => {
    // Assert the excluded field is present and correctly typed in the captured fixture (proving
    // it is a real field we've inspected, not one we're pretending doesn't exist) ...
    expect(fixture).toHaveProperty('refresh_status');
    expect(typeof fixture.refresh_status === 'object').toBe(true);
    // ... and that buildDashboardPayload's own return value correctly omits it.
    expect('refresh_status' in actual).toBe(false);
  });

  it('reports freshness.age_seconds/age_minutes as fresh numeric values (clock-dependent)', () => {
    const freshness = actual.freshness as Record<string, unknown>;
    expect(typeof freshness.age_seconds).toBe('number');
    expect(typeof freshness.age_minutes).toBe('number');
    expect(freshness.age_seconds as number).toBeGreaterThan(0);
    expect(freshness.age_minutes as number).toBeGreaterThan(0);
  });

  it('matches the captured payload exactly on every other field (strict key-set + 1e-9 tolerance)', () => {
    const { refresh_status: _refreshStatus, ...expectedWithoutRefreshStatus } = fixture;
    const expectedFreshness = expectedWithoutRefreshStatus.freshness as Record<string, unknown>;
    const {
      age_seconds: _expectedAgeSeconds,
      age_minutes: _expectedAgeMinutes,
      ...expectedFreshnessRest
    } = expectedFreshness;
    const comparableExpected = {
      ...expectedWithoutRefreshStatus,
      freshness: expectedFreshnessRest,
    };

    const actualFreshness = actual.freshness as Record<string, unknown>;
    const {
      age_seconds: _actualAgeSeconds,
      age_minutes: _actualAgeMinutes,
      ...actualFreshnessRest
    } = actualFreshness;
    const comparableActual = { ...actual, freshness: actualFreshnessRest };

    assertMatches(comparableActual, comparableExpected, 'dashboardPayload');
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
