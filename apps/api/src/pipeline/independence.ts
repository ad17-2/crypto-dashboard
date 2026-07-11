import { pyRound, spearmanCorr, toFloat } from './scoring.js';
import { asRecord } from './types.js';

/** Port of crypto_screener/independence.py. */

const DUPLICATE_THRESHOLD = 0.95;
const REDUNDANT_THRESHOLD = 0.8;
const FLAG_THRESHOLD = 0.6;

export interface FactorCorrelationFlag {
  a: string;
  b: string;
  rho: number;
  verdict: 'duplicate' | 'redundant' | 'correlated';
}

/** Port of independence.py::factor_correlations. */
export function factorCorrelations(
  rows: Array<Record<string, unknown>>,
  factorNames: string[],
  minPairs = 10,
): FactorCorrelationFlag[] {
  const flagged: FactorCorrelationFlag[] = [];
  for (let index = 0; index < factorNames.length; index += 1) {
    const factorA = factorNames[index] as string;
    for (let j = index + 1; j < factorNames.length; j += 1) {
      const factorB = factorNames[j] as string;
      const pairs = jointPairs(rows, factorA, factorB);
      if (pairs.length < minPairs) {
        continue;
      }
      const rho = spearmanCorr(
        pairs.map((pair) => pair[0]),
        pairs.map((pair) => pair[1]),
      );
      if (rho === null || Math.abs(rho) < FLAG_THRESHOLD) {
        continue;
      }
      const absRho = Math.abs(rho);
      const verdict =
        absRho >= DUPLICATE_THRESHOLD
          ? 'duplicate'
          : absRho >= REDUNDANT_THRESHOLD
            ? 'redundant'
            : 'correlated';
      flagged.push({ a: factorA, b: factorB, rho: pyRound(rho, 4), verdict });
    }
  }
  flagged.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  return flagged;
}

function jointPairs(
  rows: Array<Record<string, unknown>>,
  factorA: string,
  factorB: string,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (const row of rows) {
    const valueA = factorValue(row, factorA);
    const valueB = factorValue(row, factorB);
    if (valueA === null || valueB === null) {
      continue;
    }
    pairs.push([valueA, valueB]);
  }
  return pairs;
}

function factorValue(row: Record<string, unknown>, factor: string): number | null {
  const factors = row.factors;
  if (typeof factors === 'object' && factors !== null) {
    return toFloat(asRecord(factors)[factor]);
  }
  return toFloat(row[factor]);
}
