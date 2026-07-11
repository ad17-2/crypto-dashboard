import { stableStringify } from '../db/json.js';
import type { RunPayload } from '../pipeline/models.js';

/**
 * Port of the JSON half of report.py::write_reports' `json.dumps(payload, indent=2,
 * sort_keys=True)` call. Reuses db/json.ts's `stableStringify` for the `sort_keys=True`
 * lexicographic key ordering (see that module's doc comment), then re-serializes the
 * already-key-sorted result with 2-space indentation for a human-readable report file --
 * `stableStringify` itself only targets compact single-line SQLite JSON columns.
 */
export function renderJson(payload: RunPayload): string {
  const sorted: unknown = JSON.parse(stableStringify(payload));
  return JSON.stringify(sorted, null, 2);
}
