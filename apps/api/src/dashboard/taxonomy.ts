const FACTOR_LABELS: Record<string, string> = {
  momentum_24h: 'Momentum',
  reversal_3d: 'Reversal 3d',
  oi_price_signal: 'OI/Price',
  funding_rate_contrarian: 'Funding',
  ls_ratio_contrarian: 'L/S',
  liquidation_imbalance: 'Liquidations',
  technical_trend_4h: '4h Trend',
  technical_momentum_4h: '4h Momentum',
  oi_acceleration_signal: 'OI Acceleration',
  funding_persistence_contrarian: 'Funding Persistence',
  taker_flow_24h: 'Taker Flow',
  liquidation_pressure_24h: 'Liq Pressure',
};

/**
 * A "word" starts wherever the previous character was not a cased letter, so digits and
 * punctuation also reset capitalization (e.g. "reversal_1d" -> "reversal 1d" -> "Reversal 1D",
 * with the D capitalized because it follows the digit "1"). A naive "capitalize first letter of
 * each space-split word" implementation would miss that digit case.
 */
function titleCase(text: string): string {
  let result = '';
  let previousWasCased = false;
  for (const char of text) {
    if (/[a-zA-Z]/.test(char)) {
      result += previousWasCased ? char.toLowerCase() : char.toUpperCase();
      previousWasCased = true;
    } else {
      result += char;
      previousWasCased = false;
    }
  }
  return result;
}

export function factorLabel(name: string): string {
  return FACTOR_LABELS[name] ?? titleCase(name.replace(/_/g, ' '));
}
