import type { Row } from '../pipeline/types.js';
import { REPORT_FIELDS } from './reportFields.js';

/**
 * Port of report.py::write_reports' `csv.DictWriter(handle, fieldnames=REPORT_FIELDS,
 * extrasaction="ignore")` call (Python's default "excel" dialect: comma delimiter, `"` quote
 * char, `\r\n` line terminator, QUOTE_MINIMAL). `extrasaction="ignore"` means row keys outside
 * `fields` are dropped; a `restval`-style missing key renders as an empty cell, same as an
 * explicit `None`.
 */

const DELIMITER = ',';
const LINE_TERMINATOR = '\r\n';
const NEEDS_QUOTING = /["\r\n,]/;

/** Mirrors the csv module's cell stringification: `None`/missing -> '', bool -> Python's
 * `True`/`False`, a list -> Python's `repr(list)` (only `data_quality_flags` is list-valued among
 * REPORT_FIELDS), everything else -> its plain string form. */
function csvCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === 'string' ? `'${item}'` : csvCellText(item)));
    return `[${items.join(', ')}]`;
  }
  return String(value);
}

function escapeField(raw: string): string {
  if (NEEDS_QUOTING.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function renderRow(cells: string[]): string {
  return cells.map(escapeField).join(DELIMITER);
}

/** Port of the CSV half of report.py::write_reports. `fields` defaults to the full REPORT_FIELDS
 * allowlist; overridable only for tests that want to check the escaping/stringification rules in
 * isolation on a smaller column set. */
export function renderCsv(rows: Row[], fields: readonly string[] = REPORT_FIELDS): string {
  const lines = [renderRow([...fields])];
  for (const row of rows) {
    lines.push(renderRow(fields.map((field) => csvCellText(row[field]))));
  }
  return lines.join(LINE_TERMINATOR) + LINE_TERMINATOR;
}
