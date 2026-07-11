import type { Row } from '../pipeline/types.js';
import { REPORT_FIELDS } from './reportFields.js';

/**
 * The "excel" CSV dialect: comma delimiter, `"` quote char, `\r\n` line terminator, minimal
 * quoting (only when a cell contains a quote/comma/newline). Row keys outside `fields` are
 * dropped; a missing key renders as an empty cell, same as an explicit null.
 */

const DELIMITER = ',';
const LINE_TERMINATOR = '\r\n';
const NEEDS_QUOTING = /["\r\n,]/;

/** null/missing -> '', bool -> 'True'/'False' (not JS's lowercase), a list -> `['a', 'b']`-style
 * repr (only `data_quality_flags` is list-valued among REPORT_FIELDS), everything else -> its
 * plain string form. */
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

/** `fields` defaults to the full REPORT_FIELDS allowlist; overridable only for tests that want to
 * check the escaping/stringification rules in isolation on a smaller column set. */
export function renderCsv(rows: Row[], fields: readonly string[] = REPORT_FIELDS): string {
  const lines = [renderRow([...fields])];
  for (const row of rows) {
    lines.push(renderRow(fields.map((field) => csvCellText(row[field]))));
  }
  return lines.join(LINE_TERMINATOR) + LINE_TERMINATOR;
}
