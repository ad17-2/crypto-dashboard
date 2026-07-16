import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoinGeckoClientOptions } from '../../src/providers/coingecko.js';
import { CoinGeckoHttpClient } from '../../src/providers/coingecko.js';

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  };
}

describe('CoinGeckoHttpClient 429 retry', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function buildClient(overrides: Partial<CoinGeckoClientOptions> = {}): CoinGeckoHttpClient {
    return new CoinGeckoHttpClient({
      // Near-zero so retry delays never block the test run for real.
      retry429InitialDelaySeconds: 0,
      retry429MaxDelaySeconds: 0,
      retry429JitterSeconds: 0,
      ...overrides,
    });
  }

  it('retries once on 429 then succeeds on 200', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, {}))
      .mockResolvedValueOnce(fakeResponse(200, { data: { active_cryptocurrencies: 1 } }));

    const client = buildClient();
    const result = await client.globalData();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ active_cryptocurrencies: 1 });
  });

  it('caps a Retry-After larger than retry429MaxDelaySeconds at the configured max', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(fakeResponse(429, {}, { 'Retry-After': '500' }))
      .mockResolvedValueOnce(fakeResponse(200, { data: {} }));

    const client = buildClient({ retry429InitialDelaySeconds: 0, retry429MaxDelaySeconds: 20 });
    const promise = client.globalData();

    await vi.advanceTimersByTimeAsync(19999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({});
  });

  it('honors an HTTP-date Retry-After, waiting until that time instead of the configured delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    fetchMock
      .mockResolvedValueOnce(
        fakeResponse(429, {}, { 'Retry-After': new Date('2026-07-16T00:00:09Z').toUTCString() }),
      )
      .mockResolvedValueOnce(fakeResponse(200, { data: {} }));

    // Configured initial/max delay is deliberately huge so the assertion below only passes if
    // the HTTP-date header (9s from "now"), not the configured delay, drove the wait.
    const client = buildClient({ retry429InitialDelaySeconds: 999, retry429MaxDelaySeconds: 999 });
    const promise = client.globalData();

    await vi.advanceTimersByTimeAsync(8999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({});
  });
});
