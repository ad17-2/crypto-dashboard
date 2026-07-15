import { describe, expect, it } from 'vitest';
import { positioningDivergenceRatio } from '../../src/dashboard/rows.js';

describe('positioningDivergenceRatio', () => {
  it('divides top-trader ratio by the crowd ratio', () => {
    expect(positioningDivergenceRatio(1.5, 3.0)).toBe(2.0);
  });

  it('handles top-trader positioning below the crowd', () => {
    expect(positioningDivergenceRatio(2.0, 1.0)).toBe(0.5);
  });

  it('returns null when the crowd ratio is missing', () => {
    expect(positioningDivergenceRatio(null, 1.0)).toBeNull();
  });

  it('returns null when the top-trader ratio is missing', () => {
    expect(positioningDivergenceRatio(1.0, null)).toBeNull();
  });

  it('returns null when the crowd ratio is zero', () => {
    expect(positioningDivergenceRatio(0, 1.0)).toBeNull();
  });

  it('returns null when the crowd ratio is negative', () => {
    expect(positioningDivergenceRatio(-1, 1.0)).toBeNull();
  });
});
