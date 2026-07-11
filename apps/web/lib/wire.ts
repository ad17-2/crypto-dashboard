/** Narrows an untyped wire value (e.g. a field the API returns as a free-form object) to a
 * plain record, defaulting to `{}` for anything else. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
