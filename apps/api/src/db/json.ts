/**
 * Serializes a value the same way Python's `json.dumps(value, sort_keys=True)`
 * orders it: object keys are sorted lexicographically at every nesting level;
 * array order is left untouched. storage.py uses `sort_keys=True` on every
 * JSON column it writes (config_json, context_json, factors_json, ...), so
 * this keeps key ordering deterministic and consistent with the existing
 * data. Exact whitespace/separator bytes are not matched (JSON.parse /
 * json.loads on both sides make that irrelevant) -- only key order is.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
