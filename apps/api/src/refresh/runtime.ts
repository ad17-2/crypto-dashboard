import type Database from 'better-sqlite3';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { pruneOldRuns } from '../db/index.js';
import type { PruneResult } from '../db/types.js';
import type { RunPipelineResult } from '../pipeline/runPipeline.js';
import { runPipeline as runPipelineDefault } from '../pipeline/runPipeline.js';
import { pyRound } from '../pipeline/scoring.js';

/**
 * Port of crypto_screener/dashboard.py::RefreshRuntime. Tracks the four `self.status` shapes the
 * Python class assigns (idle / running / ok / error) and mirrors `refresh`/`refresh_async`
 * exactly, including the "merge current status with state forced to running" fallback each uses
 * when a refresh is already in flight (dashboard.py:54 and :92: `self.status | {"state": "running"}`).
 *
 * Python guards re-entrancy with a `threading.Lock` because `refresh()` can run on a background
 * thread. Node has no real threads, so a boolean flag does the same job: the flag is checked and
 * set synchronously (no `await` between the check and the set), so there is no window for a
 * second caller to interleave and see a stale `false` -- strictly simpler than the Python lock,
 * not weaker.
 */

export type RefreshStatus =
  | { state: 'idle' }
  | { state: 'running'; reason: string; started_at: string }
  | {
      state: 'ok';
      reason: string;
      run_id: string;
      generated_at: string;
      finished_at: string;
      duration_seconds: number;
      paths: Record<string, string>;
      retention: PruneResult | null;
    }
  | { state: 'error'; reason: string; error: string; finished_at: string };

/** `RefreshRuntime.refresh_async`'s immediate return value, distinct from the polled status. */
export interface RefreshAsyncResult {
  state: string;
  reason: string;
  [key: string]: unknown;
}

export interface RefreshRuntimeSettings {
  configPath: string;
  dbPath: string;
  reportDir: string;
  retainRuns: number;
}

export interface RefreshRuntimeDeps {
  db: Database.Database;
  settings: RefreshRuntimeSettings;
  /** Injectable for tests; defaults to the real config loader / pipeline runner. */
  loadConfig?: (path: string) => AppConfig;
  runPipeline?: (
    config: AppConfig,
    outDir: string,
    options: { save?: boolean; writeReportFiles?: boolean },
  ) => Promise<RunPipelineResult>;
}

/** Formats an instant as "YYYY-MM-DDTHH:mm:ss+00:00" -- Python's
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")`, which uses an explicit "+00:00"
 * suffix rather than "Z". */
function isoSecondsUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

export class RefreshRuntime {
  private readonly db: Database.Database;
  private readonly settings: RefreshRuntimeSettings;
  private readonly loadConfigFn: (path: string) => AppConfig;
  private readonly runPipelineFn: (
    config: AppConfig,
    outDir: string,
    options: { save?: boolean; writeReportFiles?: boolean },
  ) => Promise<RunPipelineResult>;
  private busy = false;
  private status: RefreshStatus = { state: 'idle' };

  constructor(deps: RefreshRuntimeDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.loadConfigFn = deps.loadConfig ?? loadConfig;
    this.runPipelineFn = deps.runPipeline ?? runPipelineDefault;
  }

  getStatus(): RefreshStatus {
    return this.status;
  }

  /** Port of `RefreshRuntime.refresh`: runs the pipeline, saves the snapshot, applies retention,
   * and records the outcome. Returns the current status unchanged (state forced to "running") if
   * a refresh is already in flight, instead of starting a second one. */
  async refresh(reason: string): Promise<RefreshStatus> {
    if (this.busy) {
      return { ...this.status, state: 'running' } as RefreshStatus;
    }
    this.busy = true;
    const startedAt = new Date();
    this.status = {
      state: 'running',
      reason,
      started_at: isoSecondsUtc(startedAt),
    };
    try {
      const config = this.loadRuntimeConfig();
      const { payload, paths } = await this.runPipelineFn(config, this.settings.reportDir, {
        save: true,
        writeReportFiles: false,
      });
      const retention =
        this.settings.retainRuns > 0 ? pruneOldRuns(this.db, this.settings.retainRuns) : null;
      const finishedAt = new Date();
      this.status = {
        state: 'ok',
        reason,
        run_id: payload.run_id,
        generated_at: payload.generated_at,
        finished_at: isoSecondsUtc(finishedAt),
        duration_seconds: pyRound((finishedAt.getTime() - startedAt.getTime()) / 1000, 2),
        paths,
        retention,
      };
    } catch (error) {
      this.status = {
        state: 'error',
        reason,
        error: error instanceof Error ? error.message : String(error),
        finished_at: isoSecondsUtc(new Date()),
      };
    } finally {
      this.busy = false;
    }
    return this.status;
  }

  /** Port of `RefreshRuntime.refresh_async`: fires the refresh in the background (never awaited
   * here, matching Python's daemon thread) and returns immediately. */
  refreshAsync(reason: string): RefreshAsyncResult {
    if (this.busy) {
      return { ...this.status, state: 'running' } as RefreshAsyncResult;
    }
    void this.refresh(reason);
    return { state: 'queued', reason };
  }

  /** Port of `dashboard.py::_load_runtime_config`: reload the config file fresh on every refresh
   * (in case it changed on disk) and override `storage_path` with the runtime DB path. */
  private loadRuntimeConfig(): AppConfig {
    const config = this.loadConfigFn(this.settings.configPath);
    return { ...config, storage_path: this.settings.dbPath };
  }
}
