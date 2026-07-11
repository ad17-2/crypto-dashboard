import { ProviderError } from './errors.js';
import { buildUrl, fetchWithTimeout } from './http.js';

/**
 * Port of crypto_screener/coinglass.py::CoinGlassClient.
 *
 * Every payload coming back from CoinGlass is treated as a loosely-typed JSON object (mirrors
 * Python's `dict[str, Any]`) -- the pipeline reads individual fields defensively via `toFloat`,
 * so these are intentionally left as open index signatures rather than exhaustively modeled.
 */
export type CoinGlassPair = Record<string, unknown>;
export type CoinGlassHistoryRow = Record<string, unknown>;

export interface CoinGlassClient {
  supportedExchangePairs(exchange?: string): Promise<Record<string, CoinGlassPair[]>>;
  futuresPairsMarkets(symbol: string): Promise<CoinGlassPair[]>;
  priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  openInterestAggregatedHistory(
    symbol: string,
    interval: string,
    limit: number,
    unit?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  fundingOiWeightHistory(
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  liquidationAggregatedHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  aggregatedTakerBuySellHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    unit?: string,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
  topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]>;
}

export interface CoinGlassClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  userAgent?: string;
}

type QueryParams = Record<string, string | number | boolean | undefined>;

/** Real HTTP implementation of {@link CoinGlassClient}, ported field-for-field from coinglass.py. */
export class CoinGlassHttpClient implements CoinGlassClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly userAgent: string;

  constructor(options: CoinGlassClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://open-api-v4.coinglass.com';
    this.timeoutSeconds = options.timeoutSeconds ?? 12;
    this.userAgent = options.userAgent ?? 'codex-crypto-screener/0.2';
  }

  private async getJson(path: string, params?: QueryParams): Promise<unknown> {
    if (!this.apiKey) {
      throw new ProviderError('CoinGlass API key is not set');
    }

    const url = buildUrl(this.baseUrl, path, params);
    const response = await fetchWithTimeout(url, {
      timeoutSeconds: this.timeoutSeconds,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'CG-API-KEY': this.apiKey,
        'User-Agent': this.userAgent,
      },
    });

    if (response.status >= 400) {
      throw new ProviderError(
        `${path} returned HTTP ${response.status}: ${response.text.slice(0, 500)}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new ProviderError(`${path} returned invalid JSON`);
    }

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new ProviderError(`${path} returned non-object JSON payload`);
    }

    const record = payload as Record<string, unknown>;
    const code = String(record.code ?? '0');
    if (code !== '0' && code !== '200') {
      throw new ProviderError(`${path} returned code ${code}: ${String(record.msg)}`);
    }
    return record.data;
  }

  async supportedExchangePairs(exchange?: string): Promise<Record<string, CoinGlassPair[]>> {
    const data = await this.getJson(
      '/api/futures/supported-exchange-pairs',
      exchange ? { exchange } : undefined,
    );
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return {};
    }
    const result: Record<string, CoinGlassPair[]> = {};
    for (const [exchangeName, pairs] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(pairs)) {
        result[exchangeName] = pairs as CoinGlassPair[];
      }
    }
    return result;
  }

  async futuresPairsMarkets(symbol: string): Promise<CoinGlassPair[]> {
    const data = await this.getJson('/api/futures/pairs-markets', { symbol });
    return Array.isArray(data) ? (data as CoinGlassPair[]) : [];
  }

  async priceHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/price/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async openInterestAggregatedHistory(
    symbol: string,
    interval: string,
    limit: number,
    unit = 'usd',
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/open-interest/aggregated-history', {
      symbol,
      interval,
      limit,
      unit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async fundingOiWeightHistory(
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/funding-rate/oi-weight-history', {
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async liquidationAggregatedHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/liquidation/aggregated-history', {
      exchange_list: exchangeList.join(','),
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async aggregatedTakerBuySellHistory(
    exchangeList: string[],
    symbol: string,
    interval: string,
    limit: number,
    unit = 'usd',
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/aggregated-taker-buy-sell-volume/history', {
      exchange_list: exchangeList.join(','),
      symbol,
      interval,
      limit,
      unit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async globalLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/global-long-short-account-ratio/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }

  async topLongShortAccountRatioHistory(
    exchange: string,
    symbol: string,
    interval: string,
    limit: number,
    startTime?: number,
    endTime?: number,
  ): Promise<CoinGlassHistoryRow[]> {
    const data = await this.getJson('/api/futures/top-long-short-account-ratio/history', {
      exchange,
      symbol,
      interval,
      limit,
      start_time: startTime,
      end_time: endTime,
    });
    return Array.isArray(data) ? (data as CoinGlassHistoryRow[]) : [];
  }
}
