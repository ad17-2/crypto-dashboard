import { describe, expect, it, vi } from 'vitest';
import { AppConfigSchema } from '../../src/config/schema.js';

/** Port of tests/test_pipeline.py::test_pipeline_can_save_sqlite_without_report_files. */

const { collectMarketMock, scoreSnapshotMock, saveSnapshotMock, writeReportsMock } = vi.hoisted(
  () => ({
    collectMarketMock: vi.fn(),
    scoreSnapshotMock: vi.fn(),
    saveSnapshotMock: vi.fn(),
    writeReportsMock: vi.fn(),
  }),
);

// Mirrors the Python test's `patch("crypto_screener.pipeline.collect_market", ...)` /
// `patch("crypto_screener.pipeline.score_snapshot", ...)` / `patch(".save_snapshot")` /
// `patch(".write_reports")`. `db/index.js`'s read-path functions (loadLabeledFactorRecords,
// loadPriceLookback, loadLatestRegimeState, loadLabeledRecordsByHorizon, openDatabase) are left
// real -- pointed at config.storage_path=":memory:" below, they run against a genuine but
// freshly-empty in-memory database and naturally return empty results, no network/disk touched.
vi.mock('../../src/pipeline/collector.js', () => ({ collectMarket: collectMarketMock }));
vi.mock('../../src/pipeline/factors.js', () => ({ scoreSnapshot: scoreSnapshotMock }));
vi.mock('../../src/reports/writeReports.js', () => ({ writeReports: writeReportsMock }));
vi.mock('../../src/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/index.js')>();
  return { ...actual, saveSnapshot: saveSnapshotMock };
});

const { runPipeline } = await import('../../src/pipeline/runPipeline.js');

describe('runPipeline', () => {
  it('save=true + writeReportFiles=false calls saveSnapshot once and skips writeReports', async () => {
    const config = AppConfigSchema.parse({ storage_path: ':memory:' });
    const collected = {
      rows: [{ symbol: 'BTC' }],
      market_context: { btc_dominance_pct: 55 },
      provider_status: { coinglass: { status: 'ok' } },
    };
    // `market_context` intentionally omitted from the mocked scoreSnapshot result, exercising
    // pipeline.py:58's `scored.get("market_context", collected.get("market_context", {}))`
    // fallback to `collected.market_context`.
    const scored = {
      rows: [{ symbol: 'BTC', scores: {}, factors: {} }],
      factor_weights: { mode: 'prior' },
      regime: { bias: 'risk-on' },
    };

    collectMarketMock.mockResolvedValueOnce(collected);
    scoreSnapshotMock.mockReturnValueOnce(scored);

    const { payload, paths } = await runPipeline(config, '/tmp/crypto-screener-unused-out-dir', {
      save: true,
      writeReportFiles: false,
    });

    expect(payload.rows).toEqual(scored.rows);
    expect(payload.market_context).toEqual(collected.market_context);
    expect(paths).toEqual({});
    expect(saveSnapshotMock).toHaveBeenCalledOnce();
    expect(writeReportsMock).not.toHaveBeenCalled();
  });
});
