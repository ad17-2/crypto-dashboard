// btc_relative_strength and reversal_1d are RETIRED (collinear with momentum_24h / -momentum_24h) -- never re-add.
export const DIRECTIONAL_FACTORS: string[] = [
  'momentum_24h',
  'reversal_3d',
  'oi_price_signal',
  'funding_rate_contrarian',
  'ls_ratio_contrarian',
  'liquidation_imbalance',
  'technical_trend_4h',
  'technical_momentum_4h',
  'oi_acceleration_signal',
  'funding_persistence_contrarian',
  'taker_flow_24h',
  'liquidation_pressure_24h',
];

export const QUALITY_FACTORS: string[] = [
  'liquidity_30d',
  'volume_expansion_24h',
  'volatility_expansion_4h',
];
