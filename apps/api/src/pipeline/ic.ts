import { mean, spearmanCorr, stdev, toFloat } from './scoring.js';
import { asRecord } from './types.js';

/**
 * Port of crypto_screener/factors.py::_cross_sectional_ic. Shared by weighting.ts::factorWeights
 * (pooled + regime-conditional IC) and validation.ts::walkForward/factorDecay (in-sample/
 * out-of-sample and per-horizon IC) -- kept in its own module since both of those import it and
 * also import each other's exports, and this avoids a circular dependency between them.
 */

export interface CrossSectionalIcResult {
  mean_ic: number | null;
  t_stat: number | null;
  n_periods: number;
  n_obs: number;
}

/** A minimal labeled factor record: `{symbol, generated_at, forward_return_pct, factors, regime?}`. */
export interface FactorRecord {
  generated_at?: unknown;
  forward_return_pct?: unknown;
  factors?: unknown;
  regime?: unknown;
  [key: string]: unknown;
}

/** Port of factors.py::_cross_sectional_ic. Per-section rank IC already neutralizes cross-time
 * market drift; no explicit demeaning needed. */
export function crossSectionalIc(
  records: FactorRecord[],
  factor: string,
  minCrossSection: number,
): CrossSectionalIcResult {
  const grouped = new Map<unknown, Array<[number, number]>>();
  let nObs = 0;
  for (const record of records) {
    const factorValue = toFloat(asRecord(record.factors)[factor]);
    const forwardReturn = toFloat(record.forward_return_pct);
    if (factorValue === null || forwardReturn === null) {
      continue;
    }
    nObs += 1;
    const key = record.generated_at;
    const existing = grouped.get(key);
    if (existing) {
      existing.push([factorValue, forwardReturn]);
    } else {
      grouped.set(key, [[factorValue, forwardReturn]]);
    }
  }

  const icSeries: number[] = [];
  for (const pairs of grouped.values()) {
    if (pairs.length < minCrossSection) {
      continue;
    }
    const xValues = pairs.map((pair) => pair[0]);
    const yValues = pairs.map((pair) => pair[1]);
    const ic = spearmanCorr(xValues, yValues);
    if (ic !== null) {
      icSeries.push(ic);
    }
  }

  const nPeriods = icSeries.length;
  const meanIc = icSeries.length > 0 ? mean(icSeries) : null;
  let tStat: number | null = null;
  if (nPeriods >= 2 && meanIc !== null) {
    const icStdev = stdev(icSeries);
    if (icStdev > 0) {
      tStat = meanIc / (icStdev / Math.sqrt(nPeriods));
    }
  }

  return { mean_ic: meanIc, t_stat: tStat, n_periods: nPeriods, n_obs: nObs };
}
