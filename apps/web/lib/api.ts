import type { DashboardPayload } from '@crypto-screener/contracts';
import { DashboardPayloadSchema } from '@crypto-screener/contracts';

/**
 * Express API origin. Must match next.config.ts's rewrite target — this module talks to the API
 * directly (server-side fetch during render), the rewrite exists for external clients hitting the
 * public origin (curl /api/dashboard, curl /health).
 */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export type DashboardResult =
  | { ok: true; payload: DashboardPayload }
  | { ok: false; error: string };

/**
 * Fetches GET /api/dashboard from the Express API, server-side, and validates the response
 * through the shared contracts schema. Never throws — callers get a typed ok/error result instead
 * of having to wrap every call site in try/catch.
 */
export async function getDashboard(runId?: string): Promise<DashboardResult> {
  const url = new URL('/api/dashboard', API_BASE_URL);
  if (runId) {
    url.searchParams.set('run_id', runId);
  }

  let response: Response;
  try {
    // Dashboard reads live DB state; never let Next.js cache this fetch.
    response = await fetch(url, { cache: 'no-store' });
  } catch (cause) {
    return {
      ok: false,
      error: `Could not reach the dashboard API at ${API_BASE_URL}: ${errorMessage(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Dashboard API responded with ${response.status} ${response.statusText}`,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (cause) {
    return { ok: false, error: `Dashboard API returned invalid JSON: ${errorMessage(cause)}` };
  }

  const parsed = DashboardPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `Dashboard payload failed validation: ${parsed.error.message}` };
  }

  return { ok: true, payload: parsed.data };
}

// triggerRefresh() (the Reload button's server action) lives in lib/actions.ts, not here — see
// that file's header comment for why it can't share a module with getDashboard().

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
