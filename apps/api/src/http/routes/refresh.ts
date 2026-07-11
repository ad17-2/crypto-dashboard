import type { Request, RequestHandler } from 'express';
import { isRefreshAllowed } from '../../env.js';
import type { AppDeps } from '../app.js';

/**
 * Reads X-Refresh-Token first, then OVERWRITES with the Authorization Bearer value if present --
 * Bearer wins when both headers are supplied; this is not an "either" fallback.
 */
function suppliedToken(req: Request): string {
  let supplied = req.get('X-Refresh-Token') ?? '';
  const auth = req.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    supplied = auth.slice('Bearer '.length).trim();
  }
  return supplied;
}

/**
 * Default-deny: with no CRYPTO_DASHBOARD_REFRESH_TOKEN configured, `isRefreshAllowed` always
 * returns false, so this always answers 403 -- there is no open mode.
 */
export function refreshRoute(deps: Pick<AppDeps, 'refreshToken' | 'runtime'>): RequestHandler {
  return (req, res) => {
    if (!isRefreshAllowed(deps.refreshToken, suppliedToken(req))) {
      res.status(403).json({ status: 'forbidden', reason: 'refresh token required' });
      return;
    }
    // Always 202, even when a refresh is already in flight -- the body then reports
    // {"state": "running", ...} instead of {"state": "queued", ...}.
    res.status(202).json(deps.runtime.refreshAsync('manual'));
  };
}
