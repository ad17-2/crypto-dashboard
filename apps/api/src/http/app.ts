import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import type { AppConfig } from '../config/index.js';
import type { RefreshRuntime } from '../refresh/runtime.js';
import { dashboardRoute } from './routes/dashboard.js';
import { healthRoute } from './routes/health.js';
import { refreshRoute } from './routes/refresh.js';

/**
 * Port of crypto_screener/dashboard.py::DashboardHandler as an Express 5 app. Pure and injectable
 * (no `listen()` call here -- see server.ts) so tests can drive it directly with supertest.
 *
 * The static routes ("/", "/assets/dashboard.css", "/assets/dashboard.js") are intentionally not
 * ported: apps/web now owns the UI.
 */
export interface AppDeps {
  db: Database.Database;
  config: AppConfig;
  dbPath: string;
  limit: number;
  runtime: RefreshRuntime;
  /** `null` means POST /api/refresh is default-deny -- see `isRefreshAllowed` in env.ts. */
  refreshToken: string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Every JSON response in dashboard.py's `_send_json` sets this; carried over so the Next.js
  // proxy / any intermediary never caches a stale refresh_status or run.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/health', healthRoute(deps));
  app.get('/api/dashboard', dashboardRoute(deps));
  app.post('/api/refresh', refreshRoute(deps));

  return app;
}
