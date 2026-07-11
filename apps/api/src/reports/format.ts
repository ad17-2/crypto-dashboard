import { formatSigned } from '../pipeline/factorExplanations.js';
import { toFloat } from '../pipeline/scoring.js';

/** Port of report.py's `format_usd`/`format_pct` string-formatting helpers. */

/** Port of report.py::format_usd. */
export function formatUsd(value: unknown): string {
  const numeric = toFloat(value);
  if (numeric === null) {
    return '-';
  }
  const absValue = Math.abs(numeric);
  if (absValue >= 1_000_000_000_000) {
    return `$${(numeric / 1_000_000_000_000).toFixed(2)}T`;
  }
  if (absValue >= 1_000_000_000) {
    return `$${(numeric / 1_000_000_000).toFixed(2)}B`;
  }
  if (absValue >= 1_000_000) {
    return `$${(numeric / 1_000_000).toFixed(2)}M`;
  }
  if (absValue >= 1_000) {
    return `$${(numeric / 1_000).toFixed(2)}K`;
  }
  return `$${numeric.toFixed(2)}`;
}

/** Port of report.py::format_pct. `digits`/`signed` default exactly like the Python signature. */
export function formatPct(value: unknown, digits = 2, signed = true): string {
  const numeric = toFloat(value);
  if (numeric === null) {
    return '-';
  }
  const body = signed ? formatSigned(numeric, digits) : numeric.toFixed(digits);
  return `${body}%`;
}
