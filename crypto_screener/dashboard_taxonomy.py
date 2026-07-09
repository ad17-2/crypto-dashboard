from __future__ import annotations

FACTOR_LABELS = {
    "momentum_24h": "Momentum",
    "reversal_3d": "Reversal 3d",
    "oi_price_signal": "OI/Price",
    "funding_rate_contrarian": "Funding",
    "ls_ratio_contrarian": "L/S",
    "liquidation_imbalance": "Liquidations",
    "technical_trend_4h": "4h Trend",
    "technical_momentum_4h": "4h Momentum",
    "oi_acceleration_signal": "OI Acceleration",
    "funding_persistence_contrarian": "Funding Persistence",
    "taker_flow_24h": "Taker Flow",
    "liquidation_pressure_24h": "Liq Pressure",
}


def factor_label(name: str) -> str:
    return FACTOR_LABELS.get(name, name.replace("_", " ").title())
