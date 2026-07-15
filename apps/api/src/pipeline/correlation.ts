import { sortByTime } from './derivatives.js';
import { pearsonCorr, toFloat } from './scoring.js';

export interface PriceBar {
  time: number;
  close: number;
}

/** Sorted {time, close} bars from raw CoinGlass candles; drops rows with non-finite time/close or close <= 0. */
export function closeSeries(candles: Array<Record<string, unknown>>): PriceBar[] {
  const bars: PriceBar[] = [];
  for (const candle of sortByTime(candles)) {
    const time = toFloat(candle.time);
    const close = toFloat(candle.close);
    if (time === null || close === null || close <= 0) {
      continue;
    }
    bars.push({ time, close });
  }
  return bars;
}

/** Period-over-period simple returns keyed by the CLOSING bar's timestamp. Only emits a return when
 *  consecutive bars are exactly one interval apart, so a dropped/missing candle cannot turn a
 *  multi-period move into a mislabeled single-period return that would skew the paired correlation. */
export function returnsByTime(bars: PriceBar[]): Map<number, number> {
  const returns = new Map<number, number>();
  const step = baseInterval(bars);
  if (step === null) {
    return returns;
  }
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1] as PriceBar;
    const current = bars[index] as PriceBar;
    if (previous.close <= 0 || current.time - previous.time !== step) {
      continue;
    }
    returns.set(current.time, (current.close - previous.close) / previous.close);
  }
  return returns;
}

/** Smallest positive gap between consecutive (sorted) bars — the true candle interval when nothing was dropped. */
function baseInterval(bars: PriceBar[]): number | null {
  let step: number | null = null;
  for (let index = 1; index < bars.length; index += 1) {
    const delta = (bars[index] as PriceBar).time - (bars[index - 1] as PriceBar).time;
    if (delta > 0 && (step === null || delta < step)) {
      step = delta;
    }
  }
  return step;
}

/** Pearson correlation of two symbols' returns over their SHARED timestamps; null if fewer than minPairs shared points. */
export function returnCorrelation(
  a: Map<number, number>,
  b: Map<number, number>,
  minPairs: number,
): number | null {
  const xValues: number[] = [];
  const yValues: number[] = [];
  for (const [time, x] of a) {
    const y = b.get(time);
    if (y !== undefined) {
      xValues.push(x);
      yValues.push(y);
    }
  }
  if (xValues.length < minPairs) {
    return null;
  }
  return pearsonCorr(xValues, yValues);
}
