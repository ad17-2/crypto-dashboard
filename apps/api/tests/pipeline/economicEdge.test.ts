import { describe, expect, it } from 'vitest';
import type { LabeledFactorRecord } from '../../src/db/types.js';
import { type EconomicEdgeOptions, economicEdge } from '../../src/pipeline/economicEdge.js';
import { crossSectionalIc } from '../../src/pipeline/ic.js';

const FACTOR = 'edge_factor';

function isoAt(hoursOffset: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + hoursOffset * 3_600_000).toISOString();
}

// atrPct defaults to 1 (uniform) when omitted, so tests that don't care about sizing get
// inverse_vol collapsing to equal_weight (see the sanity-anchor test below) rather than having
// all their pairs dropped as null-ATR.
function period(
  generatedAt: string,
  pairs: Array<[number, number, (number | null)?]>,
): LabeledFactorRecord[] {
  return pairs.map(([factorValue, forward, atrPct = 1], index) => ({
    symbol: `S${index}`,
    generated_at: generatedAt,
    forward_return_pct: forward,
    factors: { [FACTOR]: factorValue },
    scores: {},
    atr_pct: atrPct,
  }));
}

describe('economicEdge', () => {
  it('perfectly-ordering factor: exact decile spread, direction = 1, net = gross - 2*cost', () => {
    // n=20/period (default minNamesPerPeriod), default decileFraction 0.10 -> k=max(3, floor(2))=3.
    // factor = 1..20, forward = 10*factor -- perfect concordance.
    const pairs: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    // 10 identical periods -> gross_spread_pct is exactly each period's spread.
    const records = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    const options: EconomicEdgeOptions = { forwardReturnHours: 24, costPctPerLeg: 0.15 };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    // bottom3 = factor{1,2,3} -> forward{10,20,30}, mean=20; top3 = factor{18,19,20} -> forward{180,190,200}, mean=190.
    expect(result?.gross_spread_pct).toBe(170);
    expect(result?.direction).toBe(1);
    expect(result?.net_spread_pct).toBeCloseTo(170 - 2 * 0.15, 9);
  });

  it('edge != IC: strongly negative rank IC, but a huge outlier in the bottom decile flips the decile spread positive', () => {
    // 9 "clean" periods: factor=1..10, forward=100-10*factor -- perfect negative concordance (Spearman = -1 each).
    const cleanPairs: Array<[number, number]> = Array.from({ length: 10 }, (_, i) => {
      const factor = i + 1;
      return [factor, 100 - 10 * factor];
    });
    // 1 "outlier" period: identical except factor=1 (bottom decile) gets a huge NEGATIVE forward
    // return instead of the clean 90 -- still rank-consistent-ish (low factor, low return dampens
    // the negative IC slightly) but it drags the bottom-decile RAW mean far below the top decile's,
    // flipping that period's (and the aggregate's) decile spread strongly positive.
    const outlierPairs: Array<[number, number]> = cleanPairs.map(([factor, forward]) =>
      factor === 1 ? [factor, -100_000] : [factor, forward],
    );

    const cleanRecords = Array.from({ length: 9 }, (_, p) =>
      period(isoAt(p * 24), cleanPairs),
    ).flat();
    const outlierRecords = period(isoAt(9 * 24), outlierPairs);
    const records = [...cleanRecords, ...outlierRecords];

    const csResult = crossSectionalIc(records, FACTOR, 10, {
      forwardReturnHours: 24,
      overlapCorrection: true,
    });
    // Hand-computed: 9 periods at ic=-1, 1 period at ic=-5/11 -> mean = (-9 - 5/11)/10 = -52/55.
    expect(csResult.mean_ic as number).toBeCloseTo(-52 / 55, 9);
    expect(csResult.mean_ic as number).toBeLessThan(-0.5); // strongly negative rank IC

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.3,
      minNamesPerPeriod: 10,
    };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    // clean-period spread = mean(top3 {20,10,0}) - mean(bottom3 {90,80,70}) = 10 - 80 = -70.
    // outlier-period spread = mean(top3 {20,10,0}) - mean(bottom3 {-100000,80,70}) = 10 - (-33283.33..) = 33293.33..
    // gross = (9*(-70) + 99880/3) / 10 = 9799/3.
    expect(result?.gross_spread_pct).toBeCloseTo(9799 / 3, 6);
    expect(result?.gross_spread_pct as number).toBeGreaterThan(0);
    expect(result?.direction).toBe(1); // opposite sign of the rank IC -- this is the whole point
  });

  it('overlap correction: 24h horizon on 4h-spaced periods -> overlap_factor = 6, n_effective = n/6', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    // 12 periods, regular 4h cadence.
    const records = Array.from({ length: 12 }, (_, p) => period(isoAt(p * 4), pairs)).flat();

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    expect(result?.n_periods).toBe(12);
    expect(result?.overlap_factor).toBeCloseTo(6, 9);
    expect(result?.n_effective).toBeCloseTo(12 / 6, 9);
  });

  it('skips periods with fewer than minNamesPerPeriod finite (factor, forward) pairs entirely', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    const baseRecords = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    // Too few raw names (2 < minNamesPerPeriod=6).
    const tooFewNames = period(isoAt(100 * 24), [
      [1, 10],
      [2, 20],
    ]);
    // 6 raw names, but one has a non-finite forward_return_pct -> only 5 finite pairs, still < 6.
    const withNonFinite = period(isoAt(101 * 24), pairs).map((record, index) =>
      index === 0 ? { ...record, forward_return_pct: Number.NaN } : record,
    );

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };

    const baseline = economicEdge(baseRecords, FACTOR, options);
    const withExtras = economicEdge(
      [...baseRecords, ...tooFewNames, ...withNonFinite],
      FACTOR,
      options,
    );

    expect(withExtras).not.toBeNull();
    expect(withExtras?.n_periods).toBe(10);
    expect(withExtras).toEqual(baseline);
  });

  it('returns null with fewer than 10 qualifying periods', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 6 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor];
    });
    const records = Array.from({ length: 9 }, (_, p) => period(isoAt(p * 24), pairs)).flat();

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      decileFraction: 0.5,
      minNamesPerPeriod: 6,
    };
    expect(economicEdge(records, FACTOR, options)).toBeNull();
  });
});

describe('economicEdge position sizing', () => {
  it('inverse_vol preserves the edge that a short-leg ATR outlier flips under equal_weight', () => {
    // Bottom (short) leg: two ordinary names (atr=1, forward=-20) plus one huge-ATR outlier
    // (atr=100) with a huge positive forward return (+700). Top (long) leg: three ordinary
    // names (atr=1, forward=+20), so topMean = 20 under either sizing mode.
    const pairs: Array<[number, number, number]> = [
      [1, -20, 1],
      [2, -20, 1],
      [3, 700, 100], // short-leg outlier
      [4, 20, 1],
      [5, 20, 1],
      [6, 20, 1],
    ];
    const records = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();
    const baseOptions: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      minNamesPerPeriod: 6,
    };

    const equalWeight = economicEdge(records, FACTOR, { ...baseOptions, sizing: 'equal_weight' });
    const inverseVol = economicEdge(records, FACTOR, { ...baseOptions, sizing: 'inverse_vol' });

    expect(equalWeight).not.toBeNull();
    expect(inverseVol).not.toBeNull();

    // equal_weight bottomMean = mean(-20,-20,700) = 220, above topMean(20) -- going long top /
    // short bottom on this cross-section loses money.
    expect(equalWeight?.gross_spread_pct).toBeCloseTo(20 - 220, 9);
    expect(equalWeight?.gross_spread_pct as number).toBeLessThan(0);
    expect(equalWeight?.direction).toBe(-1);

    // inverse_vol bottomMean weights 1/atr: (-20*1 -20*1 + 700*(1/100)) / (1 + 1 + 1/100).
    const inverseVolBottomMean = (-20 * 1 + -20 * 1 + 700 * (1 / 100)) / (1 + 1 + 1 / 100);
    expect(inverseVol?.gross_spread_pct).toBeCloseTo(20 - inverseVolBottomMean, 9);
    expect(inverseVol?.gross_spread_pct as number).toBeGreaterThan(0);
    expect(inverseVol?.direction).toBe(1);
  });

  it('inverse_vol with all ATRs equal reproduces equal_weight exactly (sanity anchor)', () => {
    const pairs: Array<[number, number, number]> = Array.from({ length: 20 }, (_, i) => {
      const factor = i + 1;
      return [factor, 10 * factor, 3.5]; // uniform, non-floor ATR
    });
    const records = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();
    const options: EconomicEdgeOptions = { forwardReturnHours: 24, costPctPerLeg: 0.15 };

    const equalWeight = economicEdge(records, FACTOR, { ...options, sizing: 'equal_weight' });
    const inverseVol = economicEdge(records, FACTOR, { ...options, sizing: 'inverse_vol' });

    expect(equalWeight).not.toBeNull();
    expect(inverseVol).not.toBeNull();
    expect(inverseVol?.n_periods).toBe(equalWeight?.n_periods);
    expect(inverseVol?.direction).toBe(equalWeight?.direction);
    // Weighting by a constant then renormalising is the same mean mathematically, but summed in a
    // different order than plain mean() -- close to machine precision, not bit-identical.
    expect(inverseVol?.gross_spread_pct).toBeCloseTo(equalWeight?.gross_spread_pct as number, 9);
    expect(inverseVol?.net_spread_pct).toBeCloseTo(equalWeight?.net_spread_pct as number, 9);
    expect(inverseVol?.t_stat).toBeCloseTo(equalWeight?.t_stat as number, 9);
  });

  it('floors the ATR divisor at 1.0 when weighting the inverse_vol legs', () => {
    const pairs: Array<[number, number, number]> = [
      [1, 10, 0.2], // floored to 1.0 -- same weight as the atr=1 names below
      [2, 20, 1],
      [3, 30, 1],
      [4, 100, 1],
      [5, 100, 1],
      [6, 100, 1],
    ];
    const records = Array.from({ length: 10 }, (_, p) => period(isoAt(p * 24), pairs)).flat();
    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      minNamesPerPeriod: 6,
      sizing: 'inverse_vol',
    };
    const result = economicEdge(records, FACTOR, options);

    expect(result).not.toBeNull();
    // Floored, all three bottom-leg weights are 1/max(atr,1) = 1 -> plain mean(10,20,30) = 20.
    // Without the floor, name 1's weight would be 1/0.2=5, giving (10*5+20+30)/7 = 100/7 ~= 14.29.
    expect(result?.gross_spread_pct).toBeCloseTo(100 - 20, 9);
  });

  it('drops null-ATR names under inverse_vol -- spread equals the cross-section with those names removed', () => {
    const withNullAtr: Array<[number, number, (number | null)?]> = [
      [1, -20, 1],
      [2, -20, null], // no ATR: dropped under inverse_vol, not equal-weighted as a fallback
      [3, -20, 1],
      [4, 20, 1],
      [5, 20, null], // no ATR: dropped under inverse_vol
      [6, 20, 1],
      [7, 20, 1],
    ];
    const withoutNullAtr = withNullAtr.filter(([, , atrPct]) => atrPct !== null);

    const recordsWithNull = Array.from({ length: 10 }, (_, p) =>
      period(isoAt(p * 24), withNullAtr),
    ).flat();
    const recordsWithoutNull = Array.from({ length: 10 }, (_, p) =>
      period(isoAt(p * 24), withoutNullAtr),
    ).flat();

    const options: EconomicEdgeOptions = {
      forwardReturnHours: 24,
      costPctPerLeg: 0,
      minNamesPerPeriod: 5,
      sizing: 'inverse_vol',
    };

    const withNullResult = economicEdge(recordsWithNull, FACTOR, options);
    const withoutNullResult = economicEdge(recordsWithoutNull, FACTOR, options);

    expect(withNullResult).not.toBeNull();
    expect(withNullResult).toEqual(withoutNullResult);
  });
});
