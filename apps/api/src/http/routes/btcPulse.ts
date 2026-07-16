import type { BtcPulse } from '@crypto-screener/contracts';
import type { RequestHandler } from 'express';

const FETCH_TIMEOUT_MS = 5_000;
const FRESH_CACHE_MS = 30_000;
const STALE_CACHE_MAX_MS = 5 * 60_000;

export interface BtcPriceResult {
  price: number;
  source: BtcPulse['source'];
}

interface PriceSource {
  source: BtcPulse['source'];
  url: string;
  parse: (body: unknown) => number;
}

function binancePrice(body: unknown): number {
  return Number((body as { price?: unknown } | null)?.price);
}

// Verified live from inside the Railway container (2026-07-16): api.binance.com returns HTTP 451
// "Service unavailable from a restricted location" for Railway's US IPs. data-api.binance.vision
// is Binance's own market-data mirror and isn't geo-blocked, so it's tried first; api.binance.com
// stays as a fallback in case the mirror ever breaks. Coinbase (USD spot, not USDT perp) is the
// last resort -- fine for a staleness delta even though it isn't the same instrument.
const PRICE_SOURCES: readonly PriceSource[] = [
  {
    source: 'binance',
    url: 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',
    parse: binancePrice,
  },
  {
    source: 'binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    parse: binancePrice,
  },
  {
    source: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    parse: (body) => Number((body as { data?: { amount?: unknown } } | null)?.data?.amount),
  },
];

// Same AbortController idiom as providers/http.ts's fetchWithTimeout, kept local since that
// module's error type (ProviderError) is provider-pipeline-coupled and doesn't belong here.
async function fetchFromSource(
  source: PriceSource,
  fetchImpl: typeof fetch,
): Promise<BtcPriceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(source.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${source.source} ticker returned HTTP ${response.status}`);
    }
    const body = await response.json();
    const price = source.parse(body);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`${source.source} ticker returned a non-numeric price`);
    }
    return { price, source: source.source };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${source.url} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ordered source chain: first success wins, each attempt keeping its own 5s timeout. Exported so
 * the fallthrough logic can be tested directly against an injected fetch-like function, separate
 * from the route's cache/stale/503 behavior.
 */
export async function fetchBtcPrice(fetchImpl: typeof fetch = fetch): Promise<BtcPriceResult> {
  let lastError: unknown;
  for (const source of PRICE_SOURCES) {
    try {
      return await fetchFromSource(source, fetchImpl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('all btc price sources failed');
}

/**
 * Near-live BTC spot price for dashboard staleness detection (batch runs land 4x/day).
 * In-memory cache: reused as-is if <30s old; on fetch failure, the stale value is still served
 * (200, with its original fetched_at) if <5min old, else 503 { error: 'btc_pulse_unavailable' }.
 * `fetchPrice` is injectable for tests -- defaults to the live source chain.
 */
export function btcPulseRoute(
  fetchPrice: () => Promise<BtcPriceResult> = () => fetchBtcPrice(),
): RequestHandler {
  let cached: BtcPulse | null = null;
  let cachedAtMs = 0;

  return async (_req, res) => {
    if (cached && Date.now() - cachedAtMs < FRESH_CACHE_MS) {
      res.json(cached);
      return;
    }

    try {
      const result = await fetchPrice();
      cachedAtMs = Date.now();
      cached = {
        price_usd: result.price,
        fetched_at: new Date(cachedAtMs).toISOString(),
        source: result.source,
      };
      res.json(cached);
    } catch {
      if (cached && Date.now() - cachedAtMs < STALE_CACHE_MAX_MS) {
        res.json(cached);
        return;
      }
      res.status(503).json({ error: 'btc_pulse_unavailable' });
    }
  };
}
