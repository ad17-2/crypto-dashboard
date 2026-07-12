import { describe, expect, it } from 'vitest';
import type { LabeledFactorRecord } from '../../src/db/types.js';
import {
  type EdgeWalkForwardOptions,
  edgeWalkForward,
} from '../../src/pipeline/edgeWalkForward.js';

const FACTOR = 'edge_factor';
const NAMES_PER_PERIOD = 20; // matches economicEdge's default minNamesPerPeriod.

function isoAt(hoursOffset: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + hoursOffset * 3_600_000).toISOString();
}

// factor = 1..20 fixed; forward = slope * factor, so top3{18,19,20} mean=19, bottom3{1,2,3} mean=2
// -> decile spread = 17 * slope (default decileFraction 0.1 -> k = max(3, floor(20*0.1)) = 3).
function periodAt(hoursOffset: number, slope: number): LabeledFactorRecord[] {
  return Array.from({ length: NAMES_PER_PERIOD }, (_, i) => {
    const factorValue = i + 1;
    return {
      symbol: `S${i}`,
      generated_at: isoAt(hoursOffset),
      forward_return_pct: slope * factorValue,
      factors: { [FACTOR]: factorValue },
      scores: {},
    };
  });
}

function periods(
  count: number,
  startHoursOffset: number,
  slopeAt: (periodIndex: number) => number,
): LabeledFactorRecord[] {
  return Array.from({ length: count }, (_, p) =>
    periodAt(startHoursOffset + p * 24, slopeAt(p)),
  ).flat();
}

const BASE_OPTIONS: EdgeWalkForwardOptions = {
  forwardReturnHours: 24,
  costPctPerLeg: 0,
  validationFraction: 1 / 3,
  minAbsT: 2.0,
  // These records carry no atr_pct; economicEdge's default 'inverse_vol' sizing would drop every one.
  sizing: 'equal_weight',
};

describe('edgeWalkForward', () => {
  it('pays in train and keeps paying forward -> validated', () => {
    // 20 train periods, slope alternates 1.0/1.2 (always positive, non-zero variance -> big t-stat).
    const train = periods(20, 0, (p) => (p % 2 === 0 ? 1.0 : 1.2));
    // 10 validation periods, same direction, different magnitude.
    const validation = periods(10, 20 * 24, (p) => (p % 2 === 0 ? 0.8 : 1.0));
    const records = [...train, ...validation];

    const result = edgeWalkForward(records, FACTOR, BASE_OPTIONS);

    expect(result.verdict).toBe('validated');
    expect(result.validated).toBe(true);
    expect(result.train?.direction).toBe(1);
    expect(result.validation?.direction).toBe(1);
    expect(result.train?.net_spread_pct as number).toBeGreaterThan(0);
    expect(result.validation?.net_spread_pct as number).toBeGreaterThan(0);
  });

  it('pays in train then reverses sign forward -> failed-forward', () => {
    const train = periods(20, 0, (p) => (p % 2 === 0 ? 1.0 : 1.2));
    // Same train as the validated case, but validation flips negative.
    const validation = periods(10, 20 * 24, (p) => (p % 2 === 0 ? -0.8 : -1.0));
    const records = [...train, ...validation];

    const result = edgeWalkForward(records, FACTOR, BASE_OPTIONS);

    expect(result.verdict).toBe('failed-forward');
    expect(result.validated).toBe(false);
    expect(result.train?.direction).toBe(1);
    expect(result.validation?.direction).toBe(-1);
  });

  it('never pays in train (sign flips period to period, mean spread = 0) -> failed-train', () => {
    // Slope alternates +1.0/-1.0 -> spreads alternate +17/-17 -> mean = 0 exactly -> t_stat = 0.
    const train = periods(20, 0, (p) => (p % 2 === 0 ? 1.0 : -1.0));
    const validation = periods(10, 20 * 24, (p) => (p % 2 === 0 ? 1.0 : 1.2));
    const records = [...train, ...validation];

    const result = edgeWalkForward(records, FACTOR, BASE_OPTIONS);

    expect(result.verdict).toBe('failed-train');
    expect(result.validated).toBe(false);
    expect(result.train?.t_stat).toBe(0);
  });

  it('too few periods on either side -> insufficient-data', () => {
    // 5 train + 3 validation periods, both well under economicEdge's MIN_PERIODS (10).
    const train = periods(5, 0, () => 1.0);
    const validation = periods(3, 5 * 24, () => 1.0);
    const records = [...train, ...validation];

    const options: EdgeWalkForwardOptions = { ...BASE_OPTIONS, validationFraction: 3 / 8 };
    const result = edgeWalkForward(records, FACTOR, options);

    expect(result.verdict).toBe('insufficient-data');
    expect(result.validated).toBe(false);
    expect(result.train).toBeNull();
    expect(result.validation).toBeNull();
  });

  it('train is the earlier half chronologically -- a reversed split would swap these numbers', () => {
    // Constant slope per half (zero within-half variance) so gross_spread_pct is exact and distinct:
    // earlier half -> 17, later half -> 51. Records are also fed in shuffled (later-first) order, so
    // a correct split can only come from generated_at, never from array order.
    const earlier = periods(10, 0, () => 1.0);
    const later = periods(10, 10 * 24, () => 3.0);
    const records = [...later, ...earlier];

    const options: EdgeWalkForwardOptions = { ...BASE_OPTIONS, validationFraction: 0.5 };
    const result = edgeWalkForward(records, FACTOR, options);

    expect(result.train?.gross_spread_pct).toBeCloseTo(17, 9);
    expect(result.validation?.gross_spread_pct).toBeCloseTo(51, 9);
  });
});
