import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { RunPayload } from '../pipeline/models.js';
import { renderCsv } from './csv.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';

/**
 * Derives "YYYYMMDD-HHMMSS" from a `generated_at` string already formatted as Jakarta-local
 * ISO-8601 with an explicit offset (`db/time.ts::formatJakartaIso`'s output shape). Mirrors
 * report.py's `datetime.fromisoformat(payload["generated_at"]).strftime("%Y%m%d-%H%M%S")`, which
 * re-derives the stamp from that string rather than depending on run_id already carrying it --
 * report.py never reads `run_id`, and pipeline.py never imports report.py's stem logic, so this
 * intentionally does not share code with runPipeline.ts's identical-looking run_id stamp: the two
 * modules independently format the same instant, exactly like the Python originals do.
 */
function compactJakartaStamp(generatedAtIso: string): string {
  const [datePart, timePart] = generatedAtIso.slice(0, 19).split('T');
  return `${(datePart ?? '').replace(/-/g, '')}-${(timePart ?? '').replace(/:/g, '')}`;
}

/**
 * Port of report.py::write_reports: writes the JSON/CSV/Markdown trio for one run and returns
 * their paths keyed exactly like the Python dict (`json`/`csv`/`markdown`) -- cli/screener.ts's
 * stdout contract iterates these keys directly, in this insertion order.
 */
export function writeReports(
  payload: RunPayload,
  config: AppConfig,
  outDir: string,
): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  const stem = `crypto-quant-daily-${compactJakartaStamp(payload.generated_at)}`;

  const jsonPath = join(outDir, `${stem}.json`);
  const csvPath = join(outDir, `${stem}.csv`);
  const mdPath = join(outDir, `${stem}.md`);

  writeFileSync(jsonPath, renderJson(payload), 'utf-8');
  writeFileSync(csvPath, renderCsv(payload.rows), 'utf-8');
  writeFileSync(mdPath, renderMarkdown(payload, config), 'utf-8');

  return { json: jsonPath, csv: csvPath, markdown: mdPath };
}
