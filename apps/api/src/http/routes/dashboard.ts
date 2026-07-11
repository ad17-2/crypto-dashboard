import type { RequestHandler } from 'express';
import { buildDashboardPayload } from '../../dashboard/payload.js';
import type { AppDeps } from '../app.js';

/** The first value of a possibly repeated `run_id` query param, or `undefined` if it was never
 * supplied. */
function firstQueryValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Builds the payload, then injects `refresh_status` at the top level AFTER the builder runs --
 * buildDashboardPayload itself never sets that key (see dashboardPayload.test.ts's parity gate).
 */
export function dashboardRoute(
  deps: Pick<AppDeps, 'db' | 'config' | 'limit' | 'runtime'>,
): RequestHandler {
  return (req, res) => {
    const runId = firstQueryValue(req.query.run_id);
    const payload = buildDashboardPayload(
      deps.db,
      deps.config,
      runId !== undefined ? { runId, limit: deps.limit } : { limit: deps.limit },
    );
    res.json({ ...payload, refresh_status: deps.runtime.getStatus() });
  };
}
