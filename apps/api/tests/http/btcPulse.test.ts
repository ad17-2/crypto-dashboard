import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { btcPulseRoute, fetchBtcPrice } from '../../src/http/routes/btcPulse.js';

// Only Date is faked -- supertest/superagent rely on real timers for the underlying HTTP call.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function buildApp(fetchPrice: () => Promise<{ price: number; source: 'binance' | 'coinbase' }>) {
  const app = express();
  app.get('/api/btc-pulse', btcPulseRoute(fetchPrice));
  return app;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function httpErrorResponse(status: number): Response {
  return { ok: false, status, json: () => Promise.resolve(undefined) } as unknown as Response;
}

describe('GET /api/btc-pulse', () => {
  it('returns a fresh price on first fetch', async () => {
    const fetchPrice = vi.fn().mockResolvedValue({ price: 64709.99, source: 'binance' });
    const app = buildApp(fetchPrice);

    const response = await request(app).get('/api/btc-pulse');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      price_usd: 64709.99,
      fetched_at: '2026-07-16T00:00:00.000Z',
      source: 'binance',
    });
    expect(fetchPrice).toHaveBeenCalledOnce();
  });

  it('serves the cached price without refetching within 30s', async () => {
    const fetchPrice = vi.fn().mockResolvedValue({ price: 64709.99, source: 'binance' });
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:00:20.000Z')); // +20s, still under the 30s window
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(200);
    expect(second.body.fetched_at).toBe('2026-07-16T00:00:00.000Z');
    expect(fetchPrice).toHaveBeenCalledOnce();
  });

  it('serves the stale cached price on fetch failure if the cache is under 5min old', async () => {
    const fetchPrice = vi
      .fn()
      .mockResolvedValueOnce({ price: 64709.99, source: 'binance' })
      .mockRejectedValueOnce(new Error('boom'));
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:02:00.000Z')); // +2min: past 30s, under the 5min ceiling
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      price_usd: 64709.99,
      fetched_at: '2026-07-16T00:00:00.000Z',
      source: 'binance',
    });
    expect(fetchPrice).toHaveBeenCalledTimes(2);
  });

  it('503s on fetch failure with no cache yet', async () => {
    const fetchPrice = vi.fn().mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchPrice);

    const response = await request(app).get('/api/btc-pulse');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'btc_pulse_unavailable' });
  });

  it('503s on fetch failure once the cache has passed the 5min ceiling', async () => {
    const fetchPrice = vi
      .fn()
      .mockResolvedValueOnce({ price: 64709.99, source: 'binance' })
      .mockRejectedValue(new Error('boom'));
    const app = buildApp(fetchPrice);

    await request(app).get('/api/btc-pulse');
    vi.setSystemTime(new Date('2026-07-16T00:06:00.000Z')); // +6min: past the 5min ceiling
    const second = await request(app).get('/api/btc-pulse');

    expect(second.status).toBe(503);
    expect(second.body).toEqual({ error: 'btc_pulse_unavailable' });
  });
});

describe('fetchBtcPrice source chain', () => {
  it('uses the first source (binance.vision) when it succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ price: '64506.34' }));

    const result = await fetchBtcPrice(fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ price: 64506.34, source: 'binance' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT',
    );
  });

  it('falls to the second source (api.binance.com) when the first rejects', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('geo-blocked'))
      .mockResolvedValueOnce(jsonResponse({ price: '64500.00' }));

    const result = await fetchBtcPrice(fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ price: 64500, source: 'binance' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    );
  });

  it('falls to coinbase and parses data.amount when both binance URLs fail', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(httpErrorResponse(451))
      .mockResolvedValueOnce(httpErrorResponse(451))
      .mockResolvedValueOnce(jsonResponse({ data: { amount: '64464.195' } }));

    const result = await fetchBtcPrice(fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ price: 64464.195, source: 'coinbase' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2][0]).toBe('https://api.coinbase.com/v2/prices/BTC-USD/spot');
  });

  it('treats a non-finite parsed price as a failed attempt and falls through', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ price: 'not-a-number' }))
      .mockResolvedValueOnce(jsonResponse({ price: '64500.00' }));

    const result = await fetchBtcPrice(fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ price: 64500, source: 'binance' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when all three sources fail', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(httpErrorResponse(451))
      .mockResolvedValueOnce(httpErrorResponse(451))
      .mockResolvedValueOnce(httpErrorResponse(500));

    await expect(fetchBtcPrice(fetchImpl as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
