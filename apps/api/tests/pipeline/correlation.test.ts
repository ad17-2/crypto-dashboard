import { describe, expect, it } from 'vitest';
import { closeSeries, returnCorrelation, returnsByTime } from '../../src/pipeline/correlation.js';

describe('closeSeries', () => {
  it('sorts by time and drops non-finite/<=0 closes', () => {
    const candles = [
      { time: 3, close: 103 },
      { time: 1, close: 101 },
      { time: 2, close: -5 }, // dropped: close <= 0
      { time: 'not-a-number', close: 105 }, // dropped: non-finite time
      { time: 4, close: 'also-not-a-number' }, // dropped: non-finite close
      { time: 5, close: 0 }, // dropped: close <= 0
    ];

    expect(closeSeries(candles)).toEqual([
      { time: 1, close: 101 },
      { time: 3, close: 103 },
    ]);
  });
});

describe('returnsByTime', () => {
  it('computes period-over-period returns keyed by the closing bar time', () => {
    const bars = [
      { time: 1, close: 100 },
      { time: 2, close: 110 },
      { time: 3, close: 99 },
    ];

    const returns = returnsByTime(bars);

    expect(returns.size).toBe(2);
    expect(returns.get(2)).toBeCloseTo(0.1, 12); // (110-100)/100
    expect(returns.get(3)).toBeCloseTo(-0.1, 12); // (99-110)/110
    expect(returns.has(1)).toBe(false); // the opening bar of the series has no prior close
  });

  it('skips a step when the prior close is <= 0', () => {
    const bars = [
      { time: 1, close: 0 },
      { time: 2, close: 50 },
    ];

    expect(returnsByTime(bars).size).toBe(0);
  });

  it('skips the step across a dropped bar instead of mislabeling a multi-period return', () => {
    // Bar at t=3 was dropped; surviving bars are 0,1,2,4. Base interval = 1.
    const bars = [
      { time: 0, close: 100 },
      { time: 1, close: 110 },
      { time: 2, close: 121 },
      { time: 4, close: 133 },
    ];
    const returns = returnsByTime(bars);
    expect(returns.has(1)).toBe(true);
    expect(returns.has(2)).toBe(true);
    expect(returns.has(4)).toBe(false); // gap: delta 2 != base interval 1 — old code emitted a bogus 2-period return here
    expect(returns.size).toBe(2);
  });
});

describe('returnCorrelation', () => {
  it('returns 1 for an identical returns series (within 1e-9)', () => {
    const a = new Map([
      [1, 0.1],
      [2, -0.05],
      [3, 0.2],
      [4, 0.0],
    ]);
    const b = new Map(a);

    const correlation = returnCorrelation(a, b, 3);

    expect(correlation).not.toBeNull();
    expect(correlation as number).toBeCloseTo(1, 9);
  });

  it('returns -1 for an exactly inverse returns series', () => {
    const a = new Map([
      [1, 0.1],
      [2, -0.05],
      [3, 0.2],
      [4, 0.0],
    ]);
    const b = new Map([...a.entries()].map(([time, value]) => [time, -value]));

    const correlation = returnCorrelation(a, b, 3);

    expect(correlation).not.toBeNull();
    expect(correlation as number).toBeCloseTo(-1, 9);
  });

  it('returns null when the two series share fewer than minPairs timestamps', () => {
    const a = new Map([
      [1, 0.1],
      [2, 0.2],
      [3, 0.3],
      [4, 0.4],
      [5, 0.5],
    ]);
    // Only timestamps 1 and 2 overlap with `a` -- 2 shared points, below minPairs.
    const b = new Map([
      [1, 0.05],
      [2, 0.15],
      [100, 0.9],
      [101, -0.4],
    ]);

    expect(returnCorrelation(a, b, 3)).toBeNull();
  });

  it('computes the expected Pearson r on a hand-built example over shared timestamps', () => {
    // x-values (keyed by time 1,2,3) are 1,2,3; y-values are 2,4,5. Extra non-overlapping keys on
    // both sides prove the function intersects by timestamp rather than assuming aligned order.
    const a = new Map([
      [1, 1],
      [2, 2],
      [3, 3],
      [999, 42], // not present in b -- must be excluded from the computation
    ]);
    const b = new Map([
      [1, 2],
      [2, 4],
      [3, 5],
      [888, -7], // not present in a -- must be excluded from the computation
    ]);

    const correlation = returnCorrelation(a, b, 3);

    // Hand-computed: mean(x)=2, mean(y)=11/3; r = 3 / sqrt(2 * 14/3) = 0.9819805060619659.
    expect(correlation).not.toBeNull();
    expect(correlation as number).toBeCloseTo(0.9819805060619659, 9);
  });
});
