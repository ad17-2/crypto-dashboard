'use server';

/**
 * Server Actions must live in their own "use server" file when they're called from Client
 * Components (Next.js forbids inline `'use server'` functions inside a module that also ends up
 * in a client bundle — see https://nextjs.org/docs/app/api-reference/directives/use-server). This
 * is why triggerRefresh() lives here rather than alongside getDashboard() in lib/api.ts: it's
 * called from ReloadButton.tsx (a 'use client' component), which pulled lib/api.ts into the
 * client graph and made the inline directive there illegal at build time.
 */

/** Same Express API origin lib/api.ts talks to; see that file for the rewrite-parity note. */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export type RefreshResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

/**
 * Server action backing the Reload button. POSTs /api/refresh with the refresh token forwarded as
 * `X-Refresh-Token` (parity with crypto_screener/dashboard.py::_refresh_allowed). The token is a
 * server-only secret — apps/web and apps/api run as sibling processes sharing one env (see
 * scripts/start.mjs), so CRYPTO_DASHBOARD_REFRESH_TOKEN is readable here without ever reaching the
 * browser.
 */
export async function triggerRefresh(): Promise<RefreshResult> {
  const token = process.env.CRYPTO_DASHBOARD_REFRESH_TOKEN;
  if (!token) {
    return { ok: false, error: 'CRYPTO_DASHBOARD_REFRESH_TOKEN is not configured' };
  }

  let response: Response;
  try {
    response = await fetch(new URL('/api/refresh', API_BASE_URL), {
      method: 'POST',
      headers: { 'X-Refresh-Token': token },
      cache: 'no-store',
    });
  } catch (cause) {
    return {
      ok: false,
      error: `Could not reach the dashboard API at ${API_BASE_URL}: ${errorMessage(cause)}`,
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Refresh acknowledgement is best-effort JSON; a non-JSON body still leaves status usable.
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Refresh request failed with ${response.status} ${response.statusText}`,
    };
  }

  return { ok: true, status: response.status, body };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
