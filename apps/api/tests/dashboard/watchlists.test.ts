import { describe, expect, it } from 'vitest';
import {
  isCrowdedLong,
  isCrowdedShort,
  isLongCandidate,
  isShortCandidate,
} from '../../src/dashboard/watchlists.js';
import type { Row } from '../../src/pipeline/types.js';

function row(overrides: Partial<Row>): Row {
  return { symbol: 'DOGE', ...overrides };
}

describe('isLongCandidate', () => {
  it('rejects a move below the 0.5% noise floor', () => {
    expect(isLongCandidate(row({ price_change_24h_pct: 0.4 }))).toBe(false);
  });

  it('accepts a move at the 0.5% noise floor', () => {
    expect(isLongCandidate(row({ price_change_24h_pct: 0.5 }))).toBe(true);
  });

  it.each(['BTC', 'ETH', 'SOL'])('never treats core symbol %s as a long candidate', (symbol) => {
    expect(isLongCandidate(row({ symbol, price_change_24h_pct: 5.0 }))).toBe(false);
  });
});

describe('isShortCandidate', () => {
  it('rejects a move below the -0.5% noise floor', () => {
    expect(isShortCandidate(row({ price_change_24h_pct: -0.4 }))).toBe(false);
  });

  it('accepts a move at the -0.5% noise floor', () => {
    expect(isShortCandidate(row({ price_change_24h_pct: -0.5 }))).toBe(true);
  });

  it.each(['BTC', 'ETH', 'SOL'])('never treats core symbol %s as a short candidate', (symbol) => {
    expect(isShortCandidate(row({ symbol, price_change_24h_pct: -5.0 }))).toBe(false);
  });
});

describe('isCrowdedLong', () => {
  it('is unaffected by the membership move floor or core-symbol gate', () => {
    expect(
      isCrowdedLong(row({ symbol: 'BTC', price_change_24h_pct: 0.1, funding_rate_pct: 0.02 })),
    ).toBe(true);
    expect(
      isCrowdedLong(row({ symbol: 'ETH', price_change_24h_pct: 0.1, long_short_ratio: 1.5 })),
    ).toBe(true);
  });
});

describe('isCrowdedShort', () => {
  it('is unaffected by the membership move floor or core-symbol gate', () => {
    expect(
      isCrowdedShort(row({ symbol: 'SOL', price_change_24h_pct: -0.1, funding_rate_pct: -0.02 })),
    ).toBe(true);
    expect(
      isCrowdedShort(row({ symbol: 'BTC', price_change_24h_pct: -0.1, long_short_ratio: 0.5 })),
    ).toBe(true);
  });
});
