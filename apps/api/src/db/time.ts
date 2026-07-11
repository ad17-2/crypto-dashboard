/**
 * `generated_at` is stored as ISO-8601 text with a fixed +07:00 (Asia/Jakarta, no DST) offset,
 * and every "recent history" query compares that TEXT column with plain `>=`/`<=`, relying on
 * ISO-string lexical order matching chronological order. That only holds if every string being
 * compared uses the SAME offset, so "now" cutoffs must always be formatted with the explicit
 * +07:00 offset below rather than the host's ambient local timezone (containers typically default
 * to UTC) — otherwise lexical comparisons against existing +07:00-stamped rows would silently
 * break.
 */
const STORAGE_OFFSET_MINUTES = 7 * 60;
const STORAGE_OFFSET_SUFFIX = '+07:00';
const EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

/** Formats an instant as "YYYY-MM-DDTHH:mm:ss+07:00" (seconds precision). */
export function formatJakartaIso(date: Date): string {
  const shifted = new Date(date.getTime() + STORAGE_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${STORAGE_OFFSET_SUFFIX}`;
}

/**
 * Parses a stored `generated_at` value into the real instant it represents. Legacy rows with no
 * offset/Z suffix are assumed to be Asia/Jakarta (+07:00) local time.
 */
export function parseGeneratedAt(text: string): Date {
  const withOffset = EXPLICIT_OFFSET_PATTERN.test(text) ? text : `${text}${STORAGE_OFFSET_SUFFIX}`;
  return new Date(withOffset);
}

/** An asymmetric 0.75x-1.5x tolerance band around the requested horizon. */
export function horizonTolerance(hours: number): [min: number, max: number] {
  return [hours * 0.75, hours * 1.5];
}

/**
 * Among candidates whose delta (in hours) falls within [minTargetHours, maxTargetHours], returns
 * the one closest to `targetHours`. Ties keep the first candidate encountered (strict `<`).
 *
 * `targetHours` is NOT always the midpoint of the tolerance band — callers decide. See both call
 * sites in factorHistory.ts: `findForwardRow` (factor-label matching) passes the midpoint,
 * `loadPriceLookback` passes the raw requested horizon itself.
 */
export function selectHorizonMatch<T>(
  items: Array<{ value: T; deltaHours: number }>,
  minTargetHours: number,
  maxTargetHours: number,
  targetHours: number,
): T | null {
  let best: T | null = null;
  let bestDistance: number | null = null;
  for (const { value, deltaHours } of items) {
    if (deltaHours < minTargetHours || deltaHours > maxTargetHours) {
      continue;
    }
    const distance = Math.abs(deltaHours - targetHours);
    if (best === null || bestDistance === null || distance < bestDistance) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}
