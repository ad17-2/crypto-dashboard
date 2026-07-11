import { clamp, pyRound, toFloat } from '../pipeline/scoring.js';
import type { Row } from '../pipeline/types.js';
import { asRecord } from '../pipeline/types.js';

/** Port of crypto_screener/confluence.py. */

const SCALE = 1.5;
const SCALE_ALIGN = 1.0;
const TONE_POS_THRESHOLD = 0.15;
const TONE_NEG_THRESHOLD = -0.15;
const TOTAL_FAMILIES = 6;

const FAMILY_DEFINITIONS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['trend', 'Trend', ['technical_trend_4h']],
  ['momentum', 'Momentum', ['momentum_24h', 'technical_momentum_4h', 'reversal_3d']],
  [
    'oi_flow',
    'OI / Flow',
    [
      'oi_price_signal',
      'oi_acceleration_signal',
      'taker_flow_24h',
      'liquidation_imbalance',
      'liquidation_pressure_24h',
    ],
  ],
  ['funding', 'Funding', ['funding_rate_contrarian', 'funding_persistence_contrarian']],
  ['crowding', 'Crowding', ['ls_ratio_contrarian']],
  ['regime', 'Regime / Breadth', []],
];

export interface ConfluenceFamily {
  key: string;
  label: string;
  tone: string;
  value: number | null;
}

export interface ConfluenceSummary {
  direction: string;
  aligned: number;
  against: number;
  neutral: number;
  total: number;
  net_score: number;
  families: ConfluenceFamily[];
}

/** Port of confluence.py::thesis_sign. */
export function thesisSign(side: string, row: Row): number {
  if (side === 'long' || side === 'squeeze-risk') {
    return 1;
  }
  if (side === 'short' || side === 'fade-long') {
    return -1;
  }
  let factorScore = toFloat(asRecord(row.scores).factor_score);
  if (factorScore === null) {
    factorScore = toFloat(row.factor_score);
  }
  if (factorScore === null) {
    return 1;
  }
  return factorScore >= 0 ? 1 : -1;
}

/** Port of confluence.py::thesis_direction. */
export function thesisDirection(sign: number): string {
  return sign >= 0 ? 'long' : 'short';
}

function presentValues(factors: Record<string, unknown>, memberKeys: readonly string[]): number[] {
  const values: number[] = [];
  for (const key of memberKeys) {
    const value = toFloat(factors[key]);
    if (value !== null) {
      values.push(value);
    }
  }
  return values;
}

function factorContribution(values: number[], sign: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const raw = values.reduce((sum, value) => sum + value, 0) / values.length;
  return clamp((raw * sign) / SCALE, -1.0, 1.0);
}

function regimeContribution(row: Row): number | null {
  const values: number[] = [];
  for (const key of ['regime_alignment_score', 'breadth_alignment_score']) {
    const value = toFloat(row[key]);
    if (value !== null) {
      values.push(value);
    }
  }
  if (values.length === 0) {
    return null;
  }
  const raw = values.reduce((sum, value) => sum + value, 0) / values.length;
  return clamp(raw / SCALE_ALIGN, -1.0, 1.0);
}

/** Port of confluence.py::contribution_tone. */
export function contributionTone(contribution: number | null): string {
  if (contribution === null) {
    return 'neutral';
  }
  if (contribution > TONE_POS_THRESHOLD) {
    return 'pos';
  }
  if (contribution < TONE_NEG_THRESHOLD) {
    return 'neg';
  }
  return 'neutral';
}

function familyEntry(key: string, label: string, contribution: number | null): ConfluenceFamily {
  return {
    key,
    label,
    tone: contributionTone(contribution),
    value: contribution === null ? null : pyRound(contribution, 3),
  };
}

/** Port of confluence.py::confluence_summary. */
export function confluenceSummary(row: Row, side: string): ConfluenceSummary {
  const sign = thesisSign(side, row);
  const direction = thesisDirection(sign);
  const factors = asRecord(row.factors);

  const families: ConfluenceFamily[] = FAMILY_DEFINITIONS.map(([key, label, memberKeys]) => {
    const contribution =
      key === 'regime'
        ? regimeContribution(row)
        : factorContribution(presentValues(factors, memberKeys), sign);
    return familyEntry(key, label, contribution);
  });

  const aligned = families.filter((family) => family.tone === 'pos').length;
  const against = families.filter((family) => family.tone === 'neg').length;
  const neutral = families.filter((family) => family.tone === 'neutral').length;

  return {
    direction,
    aligned,
    against,
    neutral,
    total: TOTAL_FAMILIES,
    net_score: aligned - against,
    families,
  };
}
