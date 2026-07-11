/**
 * Shared formatting helpers for the watchlist and the bottom context panels.
 *
 * `numeric()` and the `fmt*` functions deliberately disagree on how to treat null: `numeric()`
 * feeds sort and arrow-direction comparisons, where `Number(null) === 0` is a real zero the
 * comparator can order against. `fmtNum`/`fmtPct` feed display, where `null`/`undefined` render
 * as "-" so "absent" never looks like "zero". Do not unify the two.
 */

/** `Number(value)` guarded against NaN. Note: `numeric(null) === 0`, not `null` — see file header. */
export function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNum(value: unknown, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return Number(value).toFixed(digits);
}

/** Signed percent, e.g. "+1.23%" / "-0.50%". */
export function fmtPct(value: unknown, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** Unsigned rate/percent, e.g. "56.4%" (no leading sign, unlike fmtPct). */
export function fmtRate(value: unknown, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `${Number(value).toFixed(digits)}%`;
}

/** Compact USD, e.g. "$1.52B". */
export function fmtUsd(value: unknown): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

/** `text-up` for positive, `text-down` for negative, `''` for zero/unparseable. */
export function clsFor(value: unknown): string {
  const n = Number(value || 0);
  if (n > 0) return 'text-up';
  if (n < 0) return 'text-down';
  return '';
}

/** Signed percent prefixed with a ▲/▼ direction arrow (no arrow when the value is null/zero). */
export function arrowPct(value: unknown, digits = 2): string {
  const n = numeric(value);
  if (n === null) return fmtPct(value, digits);
  const mark = n > 0 ? '▲ ' : n < 0 ? '▼ ' : '';
  return `${mark}${fmtPct(value, digits)}`;
}

export type QualityTone = 'bad' | 'warn' | '';

/** Quality-pill color threshold: <75 bad, <90 warn, else the default (green) look. */
export function qualityTone(value: unknown): QualityTone {
  const q = numeric(value);
  if (q === null || q < 75) return 'bad';
  if (q < 90) return 'warn';
  return '';
}

export type ConflictTone = 'pos' | 'bad' | 'warn' | 'neutral';

/** Signal-conflict badge color threshold, keyed off the row's `signal_conflict_label`. */
export function conflictTone(label: unknown): ConflictTone {
  const normalized = String(label ?? '').toLowerCase();
  if (normalized === 'aligned' || normalized === 'neutral') return 'pos';
  if (normalized === 'high-conflict' || normalized === 'excluded') return 'bad';
  if (normalized && normalized !== 'unknown') return 'warn';
  return 'neutral';
}

/** Confluence-segment color class for a family's tone ('pos'/'neg'/anything else -> neutral). */
export function confluenceToneClass(tone: string): string {
  if (tone === 'pos') return 'conf-pos';
  if (tone === 'neg') return 'conf-neg';
  return 'conf-neutral';
}
