import { describe, expect, it } from 'vitest';
import { rawFactors, scoreSnapshot } from '../../src/pipeline/factors.js';
import type { Row } from '../../src/pipeline/types.js';
import { factorWeights } from '../../src/pipeline/weighting.js';

/** Port of tests/test_scoring.py's factor-engine tests (the math-primitive-only tests in that
 * file are ported separately in scoringMath.test.ts). */

describe('factorWeights', () => {
  it('falls back to prior weights without history (test_prior_weights_without_history)', () => {
    const config = { factors: { min_observations: 30 } };
    const weights = factorWeights([], config);
    expect(weights.mode).toBe('prior');
    expect(weights.directional.momentum_24h as number).toBeGreaterThan(0);
    expect(weights.validation.status).toBe('insufficient');
  });

  it('includes validation metrics (test_factor_weights_include_validation_metrics)', () => {
    const records = [
      {
        forward_return_pct: 2,
        factors: { momentum_24h: 1, reversal_3d: -1 },
        scores: { factor_score: 0.4 },
      },
      {
        forward_return_pct: -3,
        factors: { momentum_24h: -1, reversal_3d: 1 },
        scores: { factor_score: -0.5 },
      },
      {
        forward_return_pct: 1,
        factors: { momentum_24h: -1, reversal_3d: 1 },
        scores: { factor_score: -0.2 },
      },
    ];
    const weights = factorWeights(records, { factors: { min_observations: 3, min_abs_ic: 0.0 } });

    expect(weights.validation.observations).toBe(3);
    expect(weights.validation.model.hit_rate as number).toBeCloseTo(66.67, 2);
    expect(weights.validation.factors).toHaveProperty('momentum_24h');
  });

  it('weights factors by cross-sectional IC when there is enough history (test_cross_sectional_ic_weighting)', () => {
    const records: Array<Record<string, unknown>> = [];
    const symbols = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let period = 0; period < 12; period += 1) {
      const generatedAt = `2026-01-${String(period + 1).padStart(2, '0')}T00:00:00`;
      symbols.forEach((symbol, index) => {
        const rank = index + 1;
        let forward = rank;
        if (period % 2 === 1 && index === 2) {
          forward = 4.0;
        } else if (period % 2 === 1 && index === 3) {
          forward = 3.0;
        }
        records.push({
          symbol,
          generated_at: generatedAt,
          forward_return_pct: forward,
          factors: {
            momentum_24h: rank,
            reversal_3d: period % 2 === 0 ? rank : -rank,
          },
        });
      });
    }
    const config = {
      factors: {
        ic_min_periods: 10,
        min_abs_t: 2.0,
        min_abs_ic: 0.02,
        ic_prior_strength: 10,
        ic_min_cross_section: 5,
      },
    };
    const weights = factorWeights(records, config);
    expect(weights.stats.momentum_24h?.mode).toBe('ic');
    expect(weights.stats.reversal_3d?.mode).toBe('prior');
  });
});

describe('rawFactors', () => {
  it('normalizes reversal by volatility (test_reversal_is_volatility_normalized)', () => {
    const rows: Row[] = [
      {
        symbol: 'LOWVOL',
        price_change_24h_pct: 10.0,
        price_change_72h_pct: 10.0,
        atr_14_pct: 2.0,
        quote_volume_usd: 1,
      },
      {
        symbol: 'HIGHVOL',
        price_change_24h_pct: 10.0,
        price_change_72h_pct: 10.0,
        atr_14_pct: 5.0,
        quote_volume_usd: 1,
      },
    ];
    const context = { median_atr_pct: 3.5 };
    const low = rawFactors(rows[0] as Row, rows, context);
    const high = rawFactors(rows[1] as Row, rows, context);
    expect(low.reversal_3d).not.toBeCloseTo(high.reversal_3d as number, 5);
    expect(low.reversal_3d).toBeCloseTo(-5.0, 9);
    expect(high.reversal_3d).toBeCloseTo(-2.0, 9);
  });

  it('drives ls_ratio_contrarian off the account ratio (test_account_ratio_drives_ls_contrarian)', () => {
    const row: Row = {
      long_short_account_ratio: 2.0,
      long_short_ratio: 1.1,
      quote_volume_usd: 1_000_000,
    };
    const raw = rawFactors(row, [row], {});
    expect(raw.ls_ratio_contrarian).toBeCloseTo(-Math.log(2.0), 9);
  });
});

describe('scoreSnapshot', () => {
  function longShortRows(): Row[] {
    return [
      {
        symbol: 'LONG',
        price_usd: 10,
        price_change_24h_pct: 5,
        oi_change_24h_pct: 4,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        long_liquidation_usd_24h: 1_000_000,
        short_liquidation_usd_24h: 2_000_000,
        technical_trend_score: 0.8,
        technical_momentum_score: 0.6,
        oi_acceleration_4h_pct: 3,
        funding_avg_24h_pct: 0.01,
        taker_imbalance_24h_pct: 8,
        liquidation_imbalance_24h_pct: 12,
      },
      {
        symbol: 'SHORT',
        price_usd: 10,
        price_change_24h_pct: -5,
        oi_change_24h_pct: 5,
        funding_rate_pct: 0.04,
        quote_volume_usd: 100_000_000,
        long_liquidation_usd_24h: 3_000_000,
        short_liquidation_usd_24h: 500_000,
        technical_trend_score: -0.7,
        technical_momentum_score: -0.5,
        oi_acceleration_4h_pct: 4,
        funding_avg_24h_pct: 0.04,
        taker_imbalance_24h_pct: -10,
        liquidation_imbalance_24h_pct: -20,
      },
      {
        symbol: 'BTC',
        price_usd: 100,
        price_change_24h_pct: 1,
        oi_change_24h_pct: 1,
        funding_rate_pct: 0.01,
        quote_volume_usd: 200_000_000,
      },
    ];
  }

  it('ranks long and short setups correctly (test_score_snapshot_ranks_long_and_short)', () => {
    const scored = scoreSnapshot(longShortRows(), {}, [], { factors: {} }).rows;
    const longRow = scored.find((row) => row.symbol === 'LONG') as Row;
    const shortRow = scored.find((row) => row.symbol === 'SHORT') as Row;
    expect(longRow.long_score as number).toBeGreaterThan(longRow.short_score as number);
    expect(shortRow.short_score as number).toBeGreaterThan(shortRow.long_score as number);
    expect(longRow.factors).toHaveProperty('technical_trend_4h');
    expect(longRow.factors).toHaveProperty('oi_acceleration_signal');
    expect(longRow.factors).toHaveProperty('taker_flow_24h');
    expect(longRow.confidence_score as number).toBeGreaterThan(0);
    expect(scoreSnapshot(longShortRows(), {}, [], { factors: {} }).market_context).toHaveProperty(
      'breadth',
    );
  });

  it('adds regime adjustments and conflict labels (test_score_snapshot_adds_regime_adjustments_and_conflict_labels)', () => {
    const rows: Row[] = [
      {
        symbol: 'BTC',
        price_usd: 100,
        price_change_24h_pct: 3,
        oi_change_24h_pct: 2,
        funding_rate_pct: 0.01,
        quote_volume_usd: 200_000_000,
        technical_trend_score: 0.8,
        technical_momentum_score: 0.7,
        derivatives_confirmation_score: 0.8,
      },
      {
        symbol: 'ALT',
        price_usd: 10,
        price_change_24h_pct: 5,
        oi_change_24h_pct: 4,
        funding_rate_pct: 0.01,
        quote_volume_usd: 100_000_000,
        technical_trend_score: -0.8,
        technical_momentum_score: -0.7,
        derivatives_confirmation_score: -0.8,
        taker_imbalance_24h_pct: -8,
      },
      {
        symbol: 'WEAK',
        price_usd: 10,
        price_change_24h_pct: -4,
        oi_change_24h_pct: 3,
        funding_rate_pct: 0.03,
        quote_volume_usd: 80_000_000,
        technical_trend_score: 0.5,
        technical_momentum_score: 0.4,
        derivatives_confirmation_score: 0.5,
        taker_imbalance_24h_pct: 6,
      },
    ];
    const context = {
      market_cap_change_24h_pct: 2,
      categories: {
        leaders: [{ name: 'Layer 1', market_cap_change_24h_pct: 3 }],
        laggards: [{ name: 'Meme', market_cap_change_24h_pct: -1 }],
      },
    };

    const scored = scoreSnapshot(rows, context, [], { factors: {} });
    const alt = scored.rows.find((row) => row.symbol === 'ALT') as Row;

    expect(scored.factor_weights.regime_adjusted).toBe(true);
    expect(scored.factor_weights).toHaveProperty('base_directional');
    expect((scored.market_context.breadth as Record<string, unknown>).status).toBe('ok');
    expect(['selective-risk-on', 'broad-risk-on', 'mixed']).toContain(scored.regime.breadth_label);
    expect(alt.signal_conflict_label).toBe('high-conflict');
    expect(alt.signal_conflict_score as number).toBeGreaterThan(0);
    expect((alt.signal_conflicts as unknown[]).length).toBeGreaterThan(0);
  });
});
