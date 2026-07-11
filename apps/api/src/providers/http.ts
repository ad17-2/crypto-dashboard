import { ProviderError } from './errors.js';

/**
 * Non-blocking throttle delay used by every provider client and pipeline enrichment pass between
 * requests. Implemented as a real `setTimeout`-based await (not a blocking sleep) so the event
 * loop keeps serving other requests while a pipeline run is rate-limiting itself between symbols.
 */
export function sleep(seconds: number): Promise<void> {
  if (seconds <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * Fetches `url` with a hard timeout, returning the raw status/headers/body without interpreting
 * them -- each provider client maps this to its own `ProviderError` messages, and CoinGecko
 * additionally layers 429 retry behavior on top.
 */
export async function fetchWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutSeconds: number },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (options.headers) {
      init.headers = options.headers;
    }
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ProviderError(`${url} timed out after ${options.timeoutSeconds}s`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`${url} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Appends query params to the URL, dropping any that are undefined or null. */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  if (!params) {
    return url;
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      query.set(key, String(value));
    }
  }
  const search = query.toString();
  return search ? `${url}?${search}` : url;
}
