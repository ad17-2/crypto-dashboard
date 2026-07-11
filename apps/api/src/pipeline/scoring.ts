/**
 * Numeric primitives shared by the collector/enrichment/quality stages and the factor-ranking
 * stage. median/zscore/rank/correlation helpers below back the factor engine
 * (factors.ts, weighting.ts, regime.ts, ...).
 */

/** An empty or non-numeric string returns `defaultValue` rather than parsing to 0/NaN. */
export function toFloat(value: unknown, defaultValue: number | null = null): number | null {
  if (value === null || value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : defaultValue;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return defaultValue;
    }
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

export function clamp(value: number, low = 0.0, high = 1.0): number {
  return Math.max(low, Math.min(high, value));
}

export function pctChange(oldValue: number | null, newValue: number | null): number | null {
  if (oldValue === null || oldValue === 0 || newValue === null) {
    return null;
  }
  return ((newValue - oldValue) / oldValue) * 100.0;
}

/** Perpetual funding is commonly 8-hourly; annualization assumes 3 periods/day. */
export function fundingAnnualizedPct(rate: number | null): number | null {
  if (rate === null) {
    return null;
  }
  return rate * 3 * 365 * 100.0;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0.0;
}

/** Population standard deviation (ddof=0), not sample stdev. */
export function stdev(values: number[]): number {
  if (values.length < 2) {
    return 0.0;
  }
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Rounds to `digits` decimal places (non-negative only) using round-HALF-TO-EVEN tie-breaking
 * (`pyRound(2.5, 0) === 2`, `pyRound(-2.5, 0) === -2`), the convention used throughout the factor
 * engine -- `Number.prototype.toFixed` rounds exact ties AWAY from zero instead
 * (`(2.5).toFixed(0) === '3'`), which is the wrong rule for values that land on an exact decimal
 * tie (plausible here: e.g. a weight ratio of two simple priors).
 *
 * Correctness relies on `toFixed`'s *non-tie* digits being correctly rounded from the double's
 * exact value (true per the ECMA-262 spec and V8's implementation) -- this only overrides the
 * final tie-break decision, using extra precision digits to detect a genuine exact tie versus a
 * value merely close to one.
 */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value) || value === 0) {
    return value;
  }
  const negative = value < 0;
  const absValue = Math.abs(value);

  // Extra fractional digits beyond `digits`, used only to distinguish an exact decimal tie from a
  // value that merely rounds close to one. Doubles have a bounded exact decimal expansion, and 25
  // extra digits comfortably covers it for this codebase's value magnitudes (correlations,
  // weights, percentages -- all well within normal float range).
  const extraPrecision = Math.min(100, digits + 25);
  const fixed = absValue.toFixed(extraPrecision);
  const [intPart, fracPart] = fixed.split('.') as [string, string];

  const keptFrac = fracPart.slice(0, digits);
  const roundDigit = fracPart.charCodeAt(digits) - 48;
  const restNonZero = /[1-9]/.test(fracPart.slice(digits + 1));

  const digitsStr = intPart + keptFrac;
  let roundUp: boolean;
  if (roundDigit > 5 || (roundDigit === 5 && restNonZero)) {
    roundUp = true;
  } else if (roundDigit < 5) {
    roundUp = false;
  } else {
    // Exact tie: round to even (the last digit being kept).
    const lastKeptDigit = digitsStr.charCodeAt(digitsStr.length - 1) - 48;
    roundUp = lastKeptDigit % 2 === 1;
  }

  const magnitude = BigInt(digitsStr) + (roundUp ? 1n : 0n);
  const scale = 10 ** digits;
  const wholeUnits = Number(magnitude) / scale;
  return negative ? -wholeUnits : wholeUnits;
}

/**
 * `|magnitude|` carrying the sign of `sign`, including the sign of a signed zero (`sign = -0.0`
 * yields a negative result).
 */
export function copysign(magnitude: number, sign: number): number {
  const negative = sign < 0 || Object.is(sign, -0);
  const absMagnitude = Math.abs(magnitude);
  return negative ? -absMagnitude : absMagnitude;
}

export function safeLog10(value: number | null): number {
  if (value === null || value <= 0) {
    return 0.0;
  }
  return Math.log10(value);
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0.0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2.0;
  }
  return sorted[middle] as number;
}

/** Weighted average of `valueKey` by `weightKey`; rows with a missing value or non-positive
 * weight are excluded, and `null` is returned when total weight is 0. */
export function weightedAverage(
  rows: Array<Record<string, unknown>>,
  valueKey: string,
  weightKey: string,
): number | null {
  let weightedSum = 0.0;
  let totalWeight = 0.0;
  for (const row of rows) {
    const value = toFloat(row[valueKey]);
    const weight = toFloat(row[weightKey], 0.0) ?? 0.0;
    if (value === null || weight <= 0) {
      continue;
    }
    weightedSum += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

export function zscoreByKey(rows: Array<Record<string, unknown>>, key: string): number[] {
  const values = rows.map((row) => toFloat(row[key]));
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) {
    return rows.map(() => 0.0);
  }

  const avg = mean(valid);
  const std = stdev(valid);
  if (std === 0) {
    return rows.map(() => 0.0);
  }
  return values.map((value) => (value === null ? 0.0 : (value - avg) / std));
}

// Scale MAD to approximate standard deviation under normality.
const MAD_SCALE = 1.4826;

export function robustZscoreByKey(
  rows: Array<Record<string, unknown>>,
  key: string,
  winsor = 3.0,
): number[] {
  const values = rows.map((row) => toFloat(row[key]));
  const valid = values.filter((value): value is number => value !== null);
  if (valid.length === 0) {
    return rows.map(() => 0.0);
  }

  const med = median(valid);
  const deviations = valid.map((value) => Math.abs(value - med));
  const mad = median(deviations);
  const scale = mad * MAD_SCALE;
  if (scale === 0) {
    return zscoreByKey(rows, key);
  }

  return values.map((value) =>
    value === null ? 0.0 : clamp((value - med) / scale, -winsor, winsor),
  );
}

/** Ranks are 1-indexed; ties get the average rank of the tied span (tied-rank Spearman). */
export function averageRanks(values: number[]): number[] {
  const indexed = values
    .map((value, index) => ({ index, value }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let index = 0;
  while (index < indexed.length) {
    let end = index + 1;
    while (end < indexed.length && indexed[end]?.value === indexed[index]?.value) {
      end += 1;
    }
    const avgRank = (index + 1 + end) / 2.0;
    for (let rankedIndex = index; rankedIndex < end; rankedIndex += 1) {
      const originalIndex = indexed[rankedIndex]?.index as number;
      ranks[originalIndex] = avgRank;
    }
    index = end;
  }
  return ranks;
}

export function pearsonCorr(xValues: number[], yValues: number[]): number | null {
  if (xValues.length !== yValues.length || xValues.length < 2) {
    return null;
  }
  const xAvg = mean(xValues);
  const yAvg = mean(yValues);
  let numerator = 0;
  let xSumSq = 0;
  let ySumSq = 0;
  for (let i = 0; i < xValues.length; i += 1) {
    const x = xValues[i] as number;
    const y = yValues[i] as number;
    numerator += (x - xAvg) * (y - yAvg);
    xSumSq += (x - xAvg) ** 2;
    ySumSq += (y - yAvg) ** 2;
  }
  const xDen = Math.sqrt(xSumSq);
  const yDen = Math.sqrt(ySumSq);
  if (xDen === 0 || yDen === 0) {
    return null;
  }
  return numerator / (xDen * yDen);
}

export function spearmanCorr(xValues: number[], yValues: number[]): number | null {
  if (xValues.length !== yValues.length || xValues.length < 2) {
    return null;
  }
  return pearsonCorr(averageRanks(xValues), averageRanks(yValues));
}
