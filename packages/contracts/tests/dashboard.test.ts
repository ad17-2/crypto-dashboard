import { describe, expect, it } from 'vitest';
import { DashboardPayloadSchema, DashboardRowSchema } from '../src/dashboard';

const sampleRow = {
  symbol: 'BTC',
  side: 'long',
  setup: 'OI Momentum Long',
  setup_tone: 'pos',
  score_field: 'long_score',
  score: 42.5,
  priority: 38.1,
  quality: 100,
  primary_exchange: 'Binance',
  price_usd: 65000.12,
  price_change_24h_pct: 2.4,
  oi_change_24h_pct: 1.1,
  funding_rate_pct: 0.01,
  long_short_ratio: 1.05,
  long_short_account_ratio: 1.02,
  top_trader_long_short_ratio: 1.1,
  btc_correlation: 0.82,
  funding_percentile: 55,
  oi_change_percentile: 60,
  positioning_percentile: 50,
  positioning_divergence: 1.08,
  liquidation_imbalance_24h_pct: 12.5,
  taker_imbalance_24h_pct: -8.3,
  quote_volume_usd: 500_000_000,
  open_interest_usd: 1_000_000_000,
  technical_setup: 'Bullish Trend',
  technical_state: { rsi_14: 58.2, ema_20: 64000.1 },
  data_source: 'coinglass',
  is_trusted: true,
  data_quality_flags: [],
  scores: {
    long_score: 42.5,
    short_score: 0,
    crowded_long_score: 10,
    squeeze_risk_score: 5,
    round_trip_cost_pct: 0.16,
    size_multiplier: 1.1,
  },
  history: [
    {
      generated_at: '2026-07-10T12:00:00+00:00',
      price_usd: 64000,
      price_change_24h_pct: 1.8,
      oi_change_24h_pct: 0.9,
      funding_rate_pct: 0.008,
      long_short_ratio: 1.03,
      long_short_account_ratio: 1.01,
      top_trader_long_short_ratio: 1.05,
      quote_volume_usd: 480_000_000,
      technical_trend_4h: 0.5,
      technical_momentum_4h: 0.3,
      rsi_14: 56.1,
      long_score: 40.1,
      short_score: 0,
      crowded_long_score: 8,
      squeeze_risk_score: 4,
    },
  ],
  reason_parts: [
    {
      kind: 'metric',
      label: '24h',
      value: '+2.40%',
      tone: 'pos',
      help: 'Spot or mark price change over the last 24 hours.',
    },
  ],
};

describe('DashboardRowSchema', () => {
  it('parses a well-formed row', () => {
    expect(() => DashboardRowSchema.parse(sampleRow)).not.toThrow();
  });

  it('rejects a row missing a required field', () => {
    const { setup: _setup, ...withoutSetup } = sampleRow;
    expect(() => DashboardRowSchema.parse(withoutSetup)).toThrow();
  });

  it('rejects an unknown side value', () => {
    expect(() => DashboardRowSchema.parse({ ...sampleRow, side: 'sideways' })).toThrow();
  });

  it('parses a row carrying the new TA-expansion fields', () => {
    const row = {
      ...sampleRow,
      setup_confidence: 'A',
      cvd_trend_72h_pct: -6.2,
      cvd_absorption_state: 'absorption_bearish',
      oi_change_72h_pct_history: 4.1,
      oi_price_trend_state: 'diverging_short',
      technical_state: {
        ...sampleRow.technical_state,
        trend_state: 'uptrend',
        breakout_pct_20: 1.5,
        breakdown_pct_20: 0,
        donchian_position_20: 0.8,
        breakout_volume_ratio_20: 1.3,
        ema_cross_direction: 'bullish',
        ema_cross_bars_since: 3,
        technical_divergence: 'bearish',
        technical_divergence_strength: 0.4,
      },
    };
    expect(() => DashboardRowSchema.parse(row)).not.toThrow();
  });

  it('parses a row without any of the new TA-expansion fields (legacy shape)', () => {
    expect(() => DashboardRowSchema.parse(sampleRow)).not.toThrow();
  });

  it('rejects an unrecognized cvd_absorption_state value', () => {
    expect(() =>
      DashboardRowSchema.parse({ ...sampleRow, cvd_absorption_state: 'sideways' }),
    ).toThrow();
  });

  it('rejects an unrecognized oi_price_trend_state value', () => {
    expect(() =>
      DashboardRowSchema.parse({ ...sampleRow, oi_price_trend_state: 'sideways' }),
    ).toThrow();
  });

  it('rejects an unrecognized setup_confidence value', () => {
    expect(() => DashboardRowSchema.parse({ ...sampleRow, setup_confidence: 'D' })).toThrow();
  });

  it('rejects an unrecognized technical_state.trend_state value', () => {
    expect(() =>
      DashboardRowSchema.parse({
        ...sampleRow,
        technical_state: { ...sampleRow.technical_state, trend_state: 'sideways' },
      }),
    ).toThrow();
  });
});

describe('DashboardPayloadSchema', () => {
  it('parses the empty-database payload shape', () => {
    const payload = {
      status: 'empty',
      database: 'data/crypto_screener.sqlite3',
      runs: [],
      refresh_status: null,
    };
    expect(() => DashboardPayloadSchema.parse(payload)).not.toThrow();
  });

  it('parses a full ok payload', () => {
    const payload = {
      status: 'ok',
      database: 'data/crypto_screener.sqlite3',
      run: { run_id: 'run_1', generated_at: '2026-07-11T00:00:00+00:00', row_count: 1 },
      runs: [
        {
          run_id: 'run_1',
          generated_at: '2026-07-11T00:00:00+00:00',
          row_count: 1,
          excluded_count: 0,
          bias: 'risk-on',
          factor_regime: 'trend',
          coinglass_status: 'ok',
        },
      ],
      regime: { bias: 'risk-on', label: 'trend' },
      market_context: { breadth_score: 0.4 },
      provider_status: { coinglass: { status: 'ok' } },
      validation: { observations: 100 },
      freshness: {
        status: 'ok',
        label: 'fresh',
        generated_at: '2026-07-11T00:00:00+00:00',
        age_seconds: 60,
        age_minutes: 1,
      },
      quality: { trusted_count: 1, excluded_count: 0, flagged_count: 0, flagged_rows: [] },
      sections: {
        core: [sampleRow],
        long: [sampleRow],
        short: [],
        crowded_longs: [],
        squeeze_risks: [],
      },
      watchlists: [
        { id: 'chart_next', label: 'Top Setups', rows: [sampleRow] },
        { id: 'core', label: 'Core', rows: [sampleRow] },
      ],
    };

    expect(() => DashboardPayloadSchema.parse(payload)).not.toThrow();
  });

  it('rejects an unrecognized status', () => {
    expect(() => DashboardPayloadSchema.parse({ status: 'weird' })).toThrow();
  });
});
