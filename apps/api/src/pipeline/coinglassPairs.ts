import type { CoinGlassPair } from '../providers/coinglass.js';

/** Port of crypto_screener/coinglass_pairs.py. */

/** Port of coinglass_pairs.py::quote_matches. */
export function quoteMatches(pair: CoinGlassPair, quoteAsset: string): boolean {
  const expected = quoteAsset.toUpperCase();
  return (
    String(pair.quote_asset ?? '').toUpperCase() === expected ||
    String(pair.settlement_currency ?? '').toUpperCase() === expected
  );
}

/** Port of coinglass_pairs.py::pair_symbol_matches_quote. */
export function pairSymbolMatchesQuote(pair: CoinGlassPair, quoteAsset: string): boolean {
  const expected = quoteAsset.toUpperCase();
  const symbol = String(pair.symbol ?? '').toUpperCase();
  const instrumentId = String(pair.instrument_id ?? '').toUpperCase();
  return symbol.endsWith(`/${expected}`) || instrumentId.includes(expected);
}

/** Port of coinglass_pairs.py::is_likely_perpetual_instrument. */
export function isLikelyPerpetualInstrument(instrumentId: string): boolean {
  const lowered = instrumentId.toLowerCase();
  if (lowered.includes('perp') || lowered.includes('swap')) {
    return true;
  }
  return !/[_-]\d{6,8}$/.test(instrumentId);
}

/** Port of coinglass_pairs.py::is_likely_perpetual_pair. */
export function isLikelyPerpetualPair(pair: CoinGlassPair): boolean {
  return isLikelyPerpetualInstrument(String(pair.instrument_id ?? ''));
}

/** Port of coinglass_pairs.py::base_from_pair. */
export function baseFromPair(pair: CoinGlassPair, quoteAsset = 'USDT'): string {
  const symbol = String(pair.symbol ?? '');
  if (symbol.includes('/')) {
    return (symbol.split('/', 1)[0] as string).toUpperCase();
  }
  const instrumentId = String(pair.instrument_id ?? '').toUpperCase();
  const stripped = instrumentId.replace(/[^A-Z0-9].*$/, '');
  return stripped.split(quoteAsset.toUpperCase()).join('');
}

/**
 * Port of coinglass_pairs.py::select_price_pair. Used only by backfill.ts: picks the first
 * configured exchange (in caller-supplied preference order) that supports a likely-perpetual
 * `symbol/quoteAsset` pair, mirroring the nested-loop preference scan exactly.
 */
export function selectPricePair(
  supportedPairs: Record<string, CoinGlassPair[]>,
  exchanges: string[],
  symbol: string,
  quoteAsset: string,
): [exchange: string, contractSymbol: string] {
  const expectedSymbol = symbol.toUpperCase();
  for (const exchange of exchanges) {
    for (const pair of supportedPairs[exchange] ?? []) {
      const base = String(pair.base_asset ?? '').toUpperCase();
      const instrumentId = String(pair.instrument_id ?? '');
      if (base !== expectedSymbol) {
        continue;
      }
      if (!quoteMatches(pair, quoteAsset)) {
        continue;
      }
      if (!isLikelyPerpetualInstrument(instrumentId)) {
        continue;
      }
      return [exchange, instrumentId || `${expectedSymbol}${quoteAsset.toUpperCase()}`];
    }
  }
  throw new Error('no supported configured price pair');
}
