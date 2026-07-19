import { describe, expect, it } from 'vitest';
import type { PriceBar } from '../../src/pipeline/correlation.js';
import { annotateMacroReactions, btcChangeSincePrint } from '../../src/pipeline/macroReaction.js';
import type { MarketContext, Row } from '../../src/pipeline/types.js';

const HOUR_MS = 60 * 60 * 1000;
// A real epoch-ms base (>= 1e11), so the epoch-unit detection below takes the "already ms" branch.
const T0 = Date.parse('2026-07-18T00:00:00.000Z');

const BARS: PriceBar[] = [
  { time: T0, close: 100 },
  { time: T0 + 4 * HOUR_MS, close: 105 },
  { time: T0 + 8 * HOUR_MS, close: 110 },
  { time: T0 + 12 * HOUR_MS, close: 90 },
];

describe('btcChangeSincePrint', () => {
  it('event mid-window: pairs with the first bar at-or-after the event, not the nearest bar', () => {
    // 5h after T0 -- between the 4h (105) and 8h (110) bars, so the 8h bar is "at-or-after".
    const eventMs = T0 + 5 * HOUR_MS;

    // (latest 90 - 110) / 110 * 100 = -18.1818...
    expect(btcChangeSincePrint(BARS, eventMs)).toBeCloseTo(-18.18, 2);
  });

  it('event exactly on a bar time is inclusive (uses that bar, not the next one)', () => {
    const eventMs = T0 + 4 * HOUR_MS;

    // (90 - 105) / 105 * 100 = -14.2857...
    expect(btcChangeSincePrint(BARS, eventMs)).toBeCloseTo(-14.29, 2);
  });

  it('event before history starts: no bar covers it, returns null', () => {
    const eventMs = T0 - HOUR_MS;

    expect(btcChangeSincePrint(BARS, eventMs)).toBeNull();
  });

  it('event newer than the latest bar: no bar has closed since print yet, returns null', () => {
    const eventMs = T0 + 13 * HOUR_MS;

    expect(btcChangeSincePrint(BARS, eventMs)).toBeNull();
  });

  it('event exactly at the latest bar: 0% change (nothing to compare against yet)', () => {
    const eventMs = T0 + 12 * HOUR_MS;

    expect(btcChangeSincePrint(BARS, eventMs)).toBe(0);
  });

  it('missing history: an empty bar array returns null', () => {
    expect(btcChangeSincePrint([], T0 + 5 * HOUR_MS)).toBeNull();
  });

  it('epoch-seconds bars (magnitude in [1e8, 1e11)) are converted before comparing', () => {
    const secondsBars: PriceBar[] = BARS.map((bar) => ({
      time: bar.time / 1000,
      close: bar.close,
    }));

    expect(btcChangeSincePrint(secondsBars, T0 + 5 * HOUR_MS)).toBeCloseTo(-18.18, 2);
  });

  it('synthetic/sub-1e8 timestamps never match a real event epoch, degrading to null', () => {
    const syntheticBars: PriceBar[] = [
      { time: 0, close: 100 },
      { time: 1, close: 110 },
    ];

    expect(btcChangeSincePrint(syntheticBars, T0)).toBeNull();
  });
});

describe('annotateMacroReactions', () => {
  const NOW_ISO = '2026-07-18T12:30:00.000Z'; // T0 + 12.5h
  const btcRow = (): Row => ({ symbol: 'BTC', price_history_bars: BARS });

  function macroContext(events: Array<Record<string, unknown>>): MarketContext {
    return { macro_events: events };
  }

  it('stamps btc_change_since_print_pct onto an event printed within the last 12h', () => {
    const marketContext = macroContext([
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);

    annotateMacroReactions([btcRow()], marketContext, NOW_ISO);

    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]?.btc_change_since_print_pct).toBeCloseTo(-18.18, 2);
  });

  it('leaves an event older than the 12h lookback untouched (no field added)', () => {
    const marketContext = macroContext([
      { title: 'Earlier', time_utc: new Date(T0 - HOUR_MS).toISOString() },
    ]);

    annotateMacroReactions([btcRow()], marketContext, NOW_ISO);

    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
  });

  it('leaves a future event untouched (no field added)', () => {
    const marketContext = macroContext([
      { title: 'Not Yet', time_utc: new Date(Date.parse(NOW_ISO) + HOUR_MS).toISOString() },
    ]);

    annotateMacroReactions([btcRow()], marketContext, NOW_ISO);

    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
  });

  it('skips silently when no BTC row is present', () => {
    const marketContext = macroContext([
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);

    expect(() => annotateMacroReactions([{ symbol: 'ETH' }], marketContext, NOW_ISO)).not.toThrow();
    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
  });

  it('skips silently when the BTC row has no price_history_bars', () => {
    const marketContext = macroContext([
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);

    annotateMacroReactions([{ symbol: 'BTC' }], marketContext, NOW_ISO);

    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
  });

  it('skips silently when an event is missing a title/time_utc, without aborting the others', () => {
    const marketContext = macroContext([
      { time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
      { title: 'Bad time', time_utc: 'not-a-date' },
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);

    annotateMacroReactions([btcRow()], marketContext, NOW_ISO);

    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
    expect(events[1]).not.toHaveProperty('btc_change_since_print_pct');
    expect(events[2]?.btc_change_since_print_pct).toBeCloseTo(-18.18, 2);
  });

  it('never throws when market_context.macro_events is malformed', () => {
    expect(() =>
      annotateMacroReactions([btcRow()], { macro_events: 'not-an-array' }, NOW_ISO),
    ).not.toThrow();
    expect(() => annotateMacroReactions([btcRow()], {}, NOW_ISO)).not.toThrow();
  });

  it('never throws on an unparseable generated_at (nowIso)', () => {
    const marketContext = macroContext([
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);

    expect(() => annotateMacroReactions([btcRow()], marketContext, 'not-a-date')).not.toThrow();
    const events = marketContext.macro_events as Array<Record<string, unknown>>;
    expect(events[0]).not.toHaveProperty('btc_change_since_print_pct');
  });

  it('never throws when price_history_bars is garbage-shaped', () => {
    const marketContext = macroContext([
      { title: 'CPI m/m', time_utc: new Date(T0 + 5 * HOUR_MS).toISOString() },
    ]);
    const garbageRow: Row = { symbol: 'BTC', price_history_bars: [{ not: 'a bar' }] };

    expect(() => annotateMacroReactions([garbageRow], marketContext, NOW_ISO)).not.toThrow();
  });
});
