import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '../src/config/schema.js';
import { scoreSnapshot } from '../src/pipeline/factors.js';
import type { FactorRecord } from '../src/pipeline/ic.js';
import type { Row } from '../src/pipeline/types.js';

/**
 * THE PARITY GATE: feeds the golden fixture (apps/api/tests/fixtures/parity-run.json, produced by
 * running crypto_screener's CURRENT Python implementation via tools/parity/gen_fixture.py -- see
 * that script's docstring for the exact crypto_screener/pipeline.py:30-52 call mapping) through the
 * ported TypeScript scoring/factor/weighting stage and asserts the output equals fixture.expected
 * to a 1e-9 float tolerance (exact for Python-rounded values, since exact equality is a special
 * case of a 1e-9-tolerant comparison).
 *
 * `prior_market_state` is not part of the fixture because gen_fixture.py's frozen-"now" replay of
 * storage.load_latest_regime_state() against the golden run's own timestamp returns None (verified
 * by re-running that exact lookup against data/crypto_screener.sqlite3 -- see the session notes);
 * score_snapshot is therefore called with `undefined`, matching what actually produced this fixture.
 *
 * `expected.factor_weights.factor_decay` is EXCLUDED from the comparison below. It is not a
 * discrepancy being hidden: factor_decay() takes `records_by_horizon`, a per-horizon (4h/8h/12h/
 * 24h/48h/72h) relabeling of raw price/factor snapshots that storage.load_labeled_records_by_horizon
 * builds from data the fixture does not ship (fixture.factor_history is only the single
 * 24h-horizon-labeled, already-collapsed output of load_labeled_factor_records -- it has no
 * price_usd field and cannot be relabeled at other horizons). factor_decay's algorithm itself is
 * fully ported (validation.ts::factorDecay) and independently covered by
 * apps/api/tests/pipeline/validation.test.ts, ported line-for-line from tests/test_decay.py.
 */

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/parity-run.json');

const FLOAT_TOLERANCE = 1e-9;

interface Fixture {
  config: unknown;
  market_context: Record<string, unknown>;
  input_rows: Row[];
  factor_history: FactorRecord[];
  expected: {
    factor_weights: Record<string, unknown>;
    regime: Record<string, unknown>;
    rows: Array<{ symbol: string; factors: unknown; raw_factors: unknown; scores: unknown }>;
  };
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
}

/**
 * Deep-equality diff with a 1e-9 tolerance for numbers (which subsumes exact equality for the
 * values Python explicitly `round()`s) and exact/strict comparison for everything else, including
 * object key sets -- an actual object missing or adding a key relative to expected is a diff, not
 * a silent pass. Collects every mismatch instead of stopping at the first, for a usable report.
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
    const report = diffs.slice(0, 50).join('\n');
    const more = diffs.length > 50 ? `\n... and ${diffs.length - 50} more` : '';
    throw new Error(`${diffs.length} mismatch(es) under ${label}:\n${report}${more}`);
  }
}

describe('parity: TypeScript factor engine vs. Python golden fixture', () => {
  const fixture = loadFixture();
  const config = AppConfigSchema.parse(fixture.config);
  // input_rows are deep-cloned per test since scoreSnapshot mutates rows in place.
  const rows: Row[] = JSON.parse(JSON.stringify(fixture.input_rows));

  const result = scoreSnapshot(
    rows,
    fixture.market_context,
    fixture.factor_history,
    config,
    undefined,
  );

  it('classifies the same regime as the Python pipeline', () => {
    assertMatches(result.regime, fixture.expected.regime, 'regime');
  });

  it('computes the same factor_weights as the Python pipeline (factor_decay excluded, see file header)', () => {
    const { factor_decay: _omitted, ...expectedWithoutDecay } = fixture.expected
      .factor_weights as Record<string, unknown> & { factor_decay?: unknown };
    const { factor_decay: _actualOmitted, ...actualWithoutDecay } =
      result.factor_weights as unknown as Record<string, unknown> & { factor_decay?: unknown };
    assertMatches(actualWithoutDecay, expectedWithoutDecay, 'factor_weights');
  });

  it('computes the same factors/raw_factors/scores for all 50 rows as the Python pipeline', () => {
    expect(result.rows.length).toBe(fixture.expected.rows.length);
    const bySymbol = new Map(result.rows.map((row) => [row.symbol, row]));
    for (const expectedRow of fixture.expected.rows) {
      const actualRow = bySymbol.get(expectedRow.symbol);
      expect(actualRow, `row for symbol ${expectedRow.symbol} not found`).toBeDefined();
      assertMatches(actualRow?.factors, expectedRow.factors, `rows[${expectedRow.symbol}].factors`);
      assertMatches(
        actualRow?.raw_factors,
        expectedRow.raw_factors,
        `rows[${expectedRow.symbol}].raw_factors`,
      );
      assertMatches(actualRow?.scores, expectedRow.scores, `rows[${expectedRow.symbol}].scores`);
    }
  });
});
