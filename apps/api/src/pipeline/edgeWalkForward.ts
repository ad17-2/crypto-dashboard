import type { LabeledFactorRecord } from '../db/types.js';
import {
  type EconomicEdgeOptions,
  type EconomicEdgeSummary,
  economicEdge,
} from './economicEdge.js';

export interface EdgeWalkForwardOptions {
  forwardReturnHours: number;
  costPctPerLeg: number;
  /** Latest fraction of distinct timestamps held out as validation; earliest 1 - this is train. */
  validationFraction: number;
  minAbsT: number;
  /** Forwarded to economicEdge() as-is. */
  sizing?: NonNullable<EconomicEdgeOptions['sizing']>;
}

export interface EdgeWalkForwardResult {
  train: EconomicEdgeSummary | null;
  validation: EconomicEdgeSummary | null;
  verdict: 'validated' | 'failed-forward' | 'failed-train' | 'insufficient-data';
  validated: boolean;
}

/**
 * Chronological walk-forward gate on the measured economic edge (economicEdge.ts): a factor must
 * earn its money on the past (train) AND still hold on the future (validation). An in-sample-only
 * money gate still overfits -- see MEASURED note on technical_trend_4h vs reversal_3d.
 */
export function edgeWalkForward(
  records: LabeledFactorRecord[],
  factorKey: string,
  options: EdgeWalkForwardOptions,
): EdgeWalkForwardResult {
  // Split on distinct timestamps, not record count: cross-sections have unequal name counts, so a
  // record-count split can straddle a timestamp and leak names from one side into the other.
  const timestamps = [...new Set(records.map((record) => record.generated_at))].sort();
  const splitIndex = Math.floor((1 - options.validationFraction) * timestamps.length);
  const trainTimestamps = new Set(timestamps.slice(0, splitIndex));
  const validationTimestamps = new Set(timestamps.slice(splitIndex));

  const trainRecords = records.filter((record) => trainTimestamps.has(record.generated_at));
  const validationRecords = records.filter((record) =>
    validationTimestamps.has(record.generated_at),
  );

  const edgeOptions = {
    forwardReturnHours: options.forwardReturnHours,
    costPctPerLeg: options.costPctPerLeg,
    ...(options.sizing !== undefined ? { sizing: options.sizing } : {}),
  };

  const train = economicEdge(trainRecords, factorKey, edgeOptions);
  const validation = economicEdge(validationRecords, factorKey, edgeOptions);

  if (train === null || validation === null) {
    return { train, validation, verdict: 'insufficient-data', validated: false };
  }

  const trainPasses = Math.abs(train.t_stat) >= options.minAbsT && train.net_spread_pct > 0;
  if (!trainPasses) {
    return { train, validation, verdict: 'failed-train', validated: false };
  }

  // Deliberately not requiring |t| >= minAbsT on validation: that window is small, so sign + profit
  // is the robust test. Both rules agree on the real data (see MEASURED note).
  const validationHolds = validation.direction === train.direction && validation.net_spread_pct > 0;
  if (!validationHolds) {
    return { train, validation, verdict: 'failed-forward', validated: false };
  }

  return { train, validation, verdict: 'validated', validated: true };
}
