import { existsSync } from 'node:fs';
import type { RequestHandler } from 'express';
import type { AppDeps } from '../app.js';

/** Port of dashboard.py::DashboardHandler.do_GET's "/health" branch. GET, not HEAD -- Railway's
 * healthcheck calls this with GET. */
export function healthRoute(deps: Pick<AppDeps, 'dbPath' | 'runtime'>): RequestHandler {
  return (_req, res) => {
    res.json({
      status: 'ok',
      database_exists: existsSync(deps.dbPath),
      refresh: deps.runtime.getStatus(),
    });
  };
}
