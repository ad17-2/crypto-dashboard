import type { PriceBar } from './correlation.js';
import { pctChange, pyRound } from './scoring.js';
import type { MarketContext, Row } from './types.js';
import { asRecord } from './types.js';

/**
 * Enriches recently-printed macro events with the market's reaction, since the free ForexFactory
 * feed carries a forecast/previous but never an actual printed value (live-verified against this
 * week's already-printed CPI m/m and CPI y/y prints -- no <actual> tag anywhere in the feed). BTC's
 * move since the print is used as a stand-in "did the market care" signal instead.
 *
 * Display-only: nothing here feeds scoring or watchlist membership. See runPipeline.ts for the
 * wiring, which calls annotateMacroReactions before attachBriefing so the briefing payload -- and
 * pipeline/briefing.ts's macro_events digest -- can see the enriched value too.
 */

const MS_PER_HOUR = 60 * 60 * 1000;
// "within the last 12h of the run's own generated_at" -- mirrors briefing.ts's own MACRO_LOOKBACK_HOURS.
const LOOKBACK_HOURS = 12;

// Mirrors correlation.ts's resolveStep(): CoinGlass candle timestamps are epoch ms or epoch
// seconds depending on provider/endpoint, and only the magnitude tells them apart (not verified
// live -- see correlation.ts's own doc comment). Below 1e8 isn't a plausible epoch at all (ms or
// s); left as-is, matching resolveStep's synthetic/test-fixture fallback, so a real event's
// millisecond epoch simply never matches such a bar rather than guessing a unit.
const MIN_PLAUSIBLE_EPOCH = 1e8;
const MS_EPOCH_THRESHOLD = 1e11;

function barTimeMs(time: number): number {
  if (time < MIN_PLAUSIBLE_EPOCH) {
    return time;
  }
  return time >= MS_EPOCH_THRESHOLD ? time : time * 1000;
}

/**
 * Percent change from `bars`' close at-or-after `eventTimeMs` to its latest close, rounded to 2dp.
 * `bars` must already be sorted ascending by time (the same convention correlation.ts's own
 * PriceBar[] consumers assume -- closeSeries() already sorts before returning). Null when `bars`
 * is empty, the event predates the whole history window (no bar covers it), or no bar has closed
 * at-or-after the event yet.
 */
export function btcChangeSincePrint(bars: PriceBar[], eventTimeMs: number): number | null {
  const first = bars[0];
  if (first === undefined || barTimeMs(first.time) > eventTimeMs) {
    return null;
  }
  const atOrAfter = bars.find((bar) => barTimeMs(bar.time) >= eventTimeMs);
  if (atOrAfter === undefined) {
    return null;
  }
  const latest = bars[bars.length - 1] as PriceBar;
  const change = pctChange(atOrAfter.close, latest.close);
  return change === null ? null : pyRound(change, 2);
}

/** enrichment.ts's appendCoinglassTechnicals stamps this only onto the BTC row (see its own doc comment). */
function btcPriceHistory(rows: Row[]): PriceBar[] | null {
  for (const row of rows) {
    if (row.symbol === 'BTC') {
      const bars = row.price_history_bars;
      return Array.isArray(bars) ? (bars as PriceBar[]) : null;
    }
  }
  return null;
}

/**
 * Mutates market_context.macro_events in place, adding btc_change_since_print_pct to each entry
 * printed within the last 12h of `nowIso`. Skips silently (leaves the field off) whenever the BTC
 * row, its price history, or the event's own timestamps are missing or unusable. Never throws --
 * a malformed history/timestamp must never abort the refresh.
 */
export function annotateMacroReactions(
  rows: Row[],
  marketContext: MarketContext,
  nowIso: string,
): void {
  try {
    const nowMs = Date.parse(nowIso);
    const events = Array.isArray(marketContext.macro_events) ? marketContext.macro_events : [];
    if (Number.isNaN(nowMs) || events.length === 0) {
      return;
    }
    const bars = btcPriceHistory(rows);
    if (bars === null || bars.length === 0) {
      return;
    }
    for (const raw of events) {
      const record = asRecord(raw);
      // Mirrors briefing.ts's macroEventsInWindow() and the web's parseMacroEvents(): an entry
      // without a usable title isn't a real event to either of those, so it shouldn't be one here.
      if (typeof record.title !== 'string') {
        continue;
      }
      const timeUtc = record.time_utc;
      if (typeof timeUtc !== 'string') {
        continue;
      }
      const eventMs = Date.parse(timeUtc);
      if (Number.isNaN(eventMs)) {
        continue;
      }
      const hoursAgo = (nowMs - eventMs) / MS_PER_HOUR;
      if (hoursAgo < 0 || hoursAgo > LOOKBACK_HOURS) {
        continue;
      }
      const change = btcChangeSincePrint(bars, eventMs);
      if (change !== null) {
        record.btc_change_since_print_pct = change;
      }
    }
  } catch {
    // Display-only enrichment: never let a malformed history/timestamp abort the refresh.
  }
}
