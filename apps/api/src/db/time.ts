/**
 * The screener stores `generated_at` as ISO-8601 text with a fixed +07:00
 * (Asia/Jakarta) offset (see crypto_screener/storage.py's `_STORAGE_TZ`), and
 * every "recent history" query in storage.py compares that TEXT column with
 * plain `>=`/`<=`, relying on ISO-string lexical order matching chronological
 * order. That only holds if every string being compared uses the SAME
 * offset. Asia/Jakarta has no DST, so it is a fixed UTC+7 offset -- no
 * IANA tz database is needed to reproduce it.
 *
 * storage.py derives some of its "now" cutoffs from the Python process's
 * *ambient* local timezone (`datetime.now().astimezone()`), which only
 * matches +07:00 because the reference deployment's system clock happens to
 * be set to Asia/Jakarta. A Node/Railway process is not guaranteed to run
 * with that same ambient offset (containers typically default to UTC), so
 * this port always formats "now" cutoffs with the explicit +07:00 offset
 * below instead of trusting the host's local timezone -- otherwise lexical
 * comparisons against existing +07:00-stamped rows would silently break.
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
 * Parses a stored `generated_at` value into the real instant it represents.
 * Mirrors storage.py's `datetime.fromisoformat(...)` plus its legacy-row
 * fallback: strings with no offset/Z suffix are assumed to be Asia/Jakarta
 * local time (`parsed_at.replace(tzinfo=_STORAGE_TZ)`).
 */
export function parseGeneratedAt(text: string): Date {
  const withOffset = EXPLICIT_OFFSET_PATTERN.test(text) ? text : `${text}${STORAGE_OFFSET_SUFFIX}`;
  return new Date(withOffset);
}

/** Mirrors storage.py's `_horizon_tolerance`: an asymmetric 0.75x-1.5x band. */
export function horizonTolerance(hours: number): [min: number, max: number] {
  return [hours * 0.75, hours * 1.5];
}

/**
 * Mirrors storage.py's `_select_horizon_match`: among candidates whose delta
 * (in hours) falls within [minTargetHours, maxTargetHours], returns the one
 * closest to `targetHours`. Ties keep the first candidate encountered
 * (strict `<`, matching Python's `distance < best_distance`).
 *
 * `targetHours` is NOT always the midpoint of the tolerance band -- callers
 * decide. `_find_forward_row` (factor-label matching) passes the midpoint;
 * `load_price_lookback` passes the raw requested horizon itself. Read both
 * call sites in factorHistory.ts before changing this.
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
