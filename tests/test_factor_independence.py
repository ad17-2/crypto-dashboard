from __future__ import annotations

import unittest

from crypto_screener.confluence import FAMILY_DEFINITIONS
from crypto_screener.factor_definitions import DEFAULT_PRIORS, DIRECTIONAL_FACTORS
from crypto_screener.factors import _normalize_factors, _raw_factors
from crypto_screener.independence import factor_correlations


def _synthetic_row(
    symbol: str,
    price_change_24h: float,
    price_change_72h: float | None,
    *,
    atr_pct: float | None = 2.0,
    funding: float = 0.01,
    oi_change: float = 5.0,
    ls: float = 1.2,
    technical_trend: float = 0.5,
    technical_momentum: float = 0.4,
) -> dict:
    return {
        "symbol": symbol,
        "is_trusted": True,
        "price_usd": 100.0,
        "price_change_24h_pct": price_change_24h,
        "price_change_72h_pct": price_change_72h,
        "atr_14_pct": atr_pct,
        "oi_change_24h_pct": oi_change,
        "funding_rate_pct": funding,
        "long_short_account_ratio": ls,
        "quote_volume_usd": 50_000_000,
        "volume_change_percent_24h": 10.0,
        "technical_trend_score": technical_trend,
        "technical_momentum_score": technical_momentum,
        "oi_acceleration_4h_pct": 1.0,
        "funding_avg_24h_pct": funding,
        "taker_imbalance_24h_pct": 0.5,
        "liquidation_imbalance_24h_pct": 0.2,
        "long_liquidation_usd_24h": 1000.0,
        "short_liquidation_usd_24h": 1200.0,
        "spread_bps": 2.0,
        "depth_0_5pct_usd": 1_000_000.0,
    }


class FactorIndependenceTests(unittest.TestCase):
    def test_factor_correlations_flags_duplicate_pair(self):
        rows = [{"factors": {"alpha": float(index), "beta": float(index)}} for index in range(12)]
        flagged = factor_correlations(rows, ["alpha", "beta"], min_pairs=10)
        self.assertEqual(len(flagged), 1)
        self.assertEqual(flagged[0]["verdict"], "duplicate")
        self.assertAlmostEqual(flagged[0]["rho"], 1.0)

    def test_factor_correlations_flags_correlated_pair(self):
        alpha = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        beta = [3, 4, 5, 2, 1, 8, 8, 4, 5, 12, 7, 11]
        rows = [{"factors": {"alpha": float(a), "beta": float(b)}} for a, b in zip(alpha, beta, strict=True)]
        flagged = factor_correlations(rows, ["alpha", "beta"], min_pairs=10)
        self.assertEqual(len(flagged), 1)
        self.assertEqual(flagged[0]["verdict"], "correlated")
        self.assertGreaterEqual(abs(flagged[0]["rho"]), 0.60)
        self.assertLess(abs(flagged[0]["rho"]), 0.80)

    def test_factor_correlations_skips_low_pair_count(self):
        rows = [{"factors": {"alpha": 1.0, "beta": 1.0}} for _ in range(5)]
        self.assertEqual(factor_correlations(rows, ["alpha", "beta"], min_pairs=10), [])

    def test_factor_correlations_ignores_uncorrelated_pair(self):
        import random

        random.seed(7)
        rows = [{"factors": {"alpha": random.random(), "beta": random.random()}} for _ in range(20)]
        flagged = factor_correlations(rows, ["alpha", "beta"], min_pairs=10)
        self.assertEqual(flagged, [])

    def test_no_duplicate_pairs_in_synthetic_cross_section(self):
        rows = [
            {
                "symbol": "S0",
                "is_trusted": True,
                "price_usd": 100.0,
                "price_change_24h_pct": -4.0,
                "price_change_72h_pct": 6.0,
                "atr_14_pct": 1.8,
                "oi_change_24h_pct": 8.0,
                "oi_acceleration_4h_pct": 1.0,
                "funding_rate_pct": 0.012,
                "funding_avg_24h_pct": 0.008,
                "long_short_account_ratio": 1.05,
                "technical_trend_score": 0.4,
                "technical_momentum_score": -0.2,
                "taker_imbalance_24h_pct": 0.15,
                "liquidation_imbalance_24h_pct": 0.05,
                "quote_volume_usd": 50_000_000,
                "volume_change_percent_24h": 12.0,
                "long_liquidation_usd_24h": 900.0,
                "short_liquidation_usd_24h": 1100.0,
                "spread_bps": 2.0,
                "depth_0_5pct_usd": 1_000_000.0,
            },
            {
                "symbol": "S1",
                "is_trusted": True,
                "price_usd": 101.0,
                "price_change_24h_pct": -2.0,
                "price_change_72h_pct": 3.0,
                "atr_14_pct": 2.2,
                "oi_change_24h_pct": -3.0,
                "oi_acceleration_4h_pct": 2.5,
                "funding_rate_pct": 0.018,
                "funding_avg_24h_pct": 0.004,
                "long_short_account_ratio": 1.40,
                "technical_trend_score": -0.6,
                "technical_momentum_score": 0.7,
                "taker_imbalance_24h_pct": -0.25,
                "liquidation_imbalance_24h_pct": 0.35,
                "quote_volume_usd": 51_000_000,
                "volume_change_percent_24h": 8.0,
                "long_liquidation_usd_24h": 1200.0,
                "short_liquidation_usd_24h": 800.0,
                "spread_bps": 2.5,
                "depth_0_5pct_usd": 1_100_000.0,
            },
            {
                "symbol": "S2",
                "is_trusted": True,
                "price_usd": 102.0,
                "price_change_24h_pct": 1.0,
                "price_change_72h_pct": -1.0,
                "atr_14_pct": 1.5,
                "oi_change_24h_pct": 5.0,
                "oi_acceleration_4h_pct": -1.0,
                "funding_rate_pct": -0.005,
                "funding_avg_24h_pct": 0.011,
                "long_short_account_ratio": 0.85,
                "technical_trend_score": 0.2,
                "technical_momentum_score": 0.1,
                "taker_imbalance_24h_pct": 0.05,
                "liquidation_imbalance_24h_pct": -0.15,
                "quote_volume_usd": 52_000_000,
                "volume_change_percent_24h": 15.0,
                "long_liquidation_usd_24h": 700.0,
                "short_liquidation_usd_24h": 1300.0,
                "spread_bps": 1.8,
                "depth_0_5pct_usd": 900_000.0,
            },
            {
                "symbol": "S3",
                "is_trusted": True,
                "price_usd": 103.0,
                "price_change_24h_pct": 3.0,
                "price_change_72h_pct": -4.0,
                "atr_14_pct": 3.0,
                "oi_change_24h_pct": -1.0,
                "oi_acceleration_4h_pct": 0.5,
                "funding_rate_pct": 0.009,
                "funding_avg_24h_pct": 0.015,
                "long_short_account_ratio": 1.15,
                "technical_trend_score": 0.8,
                "technical_momentum_score": -0.5,
                "taker_imbalance_24h_pct": 0.40,
                "liquidation_imbalance_24h_pct": 0.10,
                "quote_volume_usd": 53_000_000,
                "volume_change_percent_24h": 6.0,
                "long_liquidation_usd_24h": 1000.0,
                "short_liquidation_usd_24h": 900.0,
                "spread_bps": 3.0,
                "depth_0_5pct_usd": 1_200_000.0,
            },
            {
                "symbol": "S4",
                "is_trusted": True,
                "price_usd": 104.0,
                "price_change_24h_pct": 5.0,
                "price_change_72h_pct": 2.0,
                "atr_14_pct": 2.5,
                "oi_change_24h_pct": 12.0,
                "oi_acceleration_4h_pct": 3.0,
                "funding_rate_pct": 0.021,
                "funding_avg_24h_pct": 0.006,
                "long_short_account_ratio": 1.55,
                "technical_trend_score": -0.3,
                "technical_momentum_score": 0.9,
                "taker_imbalance_24h_pct": -0.10,
                "liquidation_imbalance_24h_pct": 0.25,
                "quote_volume_usd": 54_000_000,
                "volume_change_percent_24h": 20.0,
                "long_liquidation_usd_24h": 1500.0,
                "short_liquidation_usd_24h": 700.0,
                "spread_bps": 2.2,
                "depth_0_5pct_usd": 1_300_000.0,
            },
            {
                "symbol": "S5",
                "is_trusted": True,
                "price_usd": 105.0,
                "price_change_24h_pct": -1.0,
                "price_change_72h_pct": -6.0,
                "atr_14_pct": 1.2,
                "oi_change_24h_pct": -8.0,
                "oi_acceleration_4h_pct": -2.0,
                "funding_rate_pct": -0.011,
                "funding_avg_24h_pct": -0.002,
                "long_short_account_ratio": 0.95,
                "technical_trend_score": 0.5,
                "technical_momentum_score": -0.8,
                "taker_imbalance_24h_pct": 0.30,
                "liquidation_imbalance_24h_pct": -0.05,
                "quote_volume_usd": 55_000_000,
                "volume_change_percent_24h": 4.0,
                "long_liquidation_usd_24h": 600.0,
                "short_liquidation_usd_24h": 1400.0,
                "spread_bps": 2.8,
                "depth_0_5pct_usd": 800_000.0,
            },
            {
                "symbol": "S6",
                "is_trusted": True,
                "price_usd": 106.0,
                "price_change_24h_pct": 2.0,
                "price_change_72h_pct": 5.0,
                "atr_14_pct": 2.8,
                "oi_change_24h_pct": 2.0,
                "oi_acceleration_4h_pct": 4.0,
                "funding_rate_pct": 0.014,
                "funding_avg_24h_pct": 0.019,
                "long_short_account_ratio": 1.25,
                "technical_trend_score": -0.1,
                "technical_momentum_score": 0.3,
                "taker_imbalance_24h_pct": -0.35,
                "liquidation_imbalance_24h_pct": 0.18,
                "quote_volume_usd": 56_000_000,
                "volume_change_percent_24h": 11.0,
                "long_liquidation_usd_24h": 1100.0,
                "short_liquidation_usd_24h": 950.0,
                "spread_bps": 2.1,
                "depth_0_5pct_usd": 950_000.0,
            },
            {
                "symbol": "S7",
                "is_trusted": True,
                "price_usd": 107.0,
                "price_change_24h_pct": -3.0,
                "price_change_72h_pct": 1.0,
                "atr_14_pct": 1.9,
                "oi_change_24h_pct": -5.0,
                "oi_acceleration_4h_pct": 1.5,
                "funding_rate_pct": 0.007,
                "funding_avg_24h_pct": 0.003,
                "long_short_account_ratio": 1.10,
                "technical_trend_score": 0.6,
                "technical_momentum_score": -0.4,
                "taker_imbalance_24h_pct": 0.22,
                "liquidation_imbalance_24h_pct": -0.22,
                "quote_volume_usd": 57_000_000,
                "volume_change_percent_24h": 9.0,
                "long_liquidation_usd_24h": 850.0,
                "short_liquidation_usd_24h": 1150.0,
                "spread_bps": 2.4,
                "depth_0_5pct_usd": 1_050_000.0,
            },
            {
                "symbol": "S8",
                "is_trusted": True,
                "price_usd": 108.0,
                "price_change_24h_pct": 4.0,
                "price_change_72h_pct": -2.0,
                "atr_14_pct": 3.5,
                "oi_change_24h_pct": 9.0,
                "oi_acceleration_4h_pct": -0.5,
                "funding_rate_pct": -0.003,
                "funding_avg_24h_pct": 0.010,
                "long_short_account_ratio": 0.75,
                "technical_trend_score": -0.7,
                "technical_momentum_score": 0.6,
                "taker_imbalance_24h_pct": -0.05,
                "liquidation_imbalance_24h_pct": 0.30,
                "quote_volume_usd": 58_000_000,
                "volume_change_percent_24h": 18.0,
                "long_liquidation_usd_24h": 1300.0,
                "short_liquidation_usd_24h": 750.0,
                "spread_bps": 3.2,
                "depth_0_5pct_usd": 1_400_000.0,
            },
            {
                "symbol": "S9",
                "is_trusted": True,
                "price_usd": 109.0,
                "price_change_24h_pct": 0.0,
                "price_change_72h_pct": 4.0,
                "atr_14_pct": 2.1,
                "oi_change_24h_pct": -2.0,
                "oi_acceleration_4h_pct": 2.0,
                "funding_rate_pct": 0.016,
                "funding_avg_24h_pct": 0.009,
                "long_short_account_ratio": 1.35,
                "technical_trend_score": 0.1,
                "technical_momentum_score": -0.1,
                "taker_imbalance_24h_pct": 0.18,
                "liquidation_imbalance_24h_pct": -0.12,
                "quote_volume_usd": 59_000_000,
                "volume_change_percent_24h": 7.0,
                "long_liquidation_usd_24h": 950.0,
                "short_liquidation_usd_24h": 1050.0,
                "spread_bps": 2.0,
                "depth_0_5pct_usd": 1_000_000.0,
            },
            {
                "symbol": "S10",
                "is_trusted": True,
                "price_usd": 110.0,
                "price_change_24h_pct": 6.0,
                "price_change_72h_pct": -5.0,
                "atr_14_pct": 1.7,
                "oi_change_24h_pct": 6.0,
                "oi_acceleration_4h_pct": 0.0,
                "funding_rate_pct": 0.010,
                "funding_avg_24h_pct": 0.017,
                "long_short_account_ratio": 1.05,
                "technical_trend_score": 0.9,
                "technical_momentum_score": 0.2,
                "taker_imbalance_24h_pct": -0.28,
                "liquidation_imbalance_24h_pct": 0.08,
                "quote_volume_usd": 60_000_000,
                "volume_change_percent_24h": 22.0,
                "long_liquidation_usd_24h": 1400.0,
                "short_liquidation_usd_24h": 650.0,
                "spread_bps": 2.6,
                "depth_0_5pct_usd": 1_250_000.0,
            },
            {
                "symbol": "S11",
                "is_trusted": True,
                "price_usd": 111.0,
                "price_change_24h_pct": -5.0,
                "price_change_72h_pct": 0.0,
                "atr_14_pct": 2.4,
                "oi_change_24h_pct": -6.0,
                "oi_acceleration_4h_pct": -3.0,
                "funding_rate_pct": -0.008,
                "funding_avg_24h_pct": 0.013,
                "long_short_account_ratio": 0.90,
                "technical_trend_score": -0.4,
                "technical_momentum_score": 0.4,
                "taker_imbalance_24h_pct": 0.12,
                "liquidation_imbalance_24h_pct": -0.28,
                "quote_volume_usd": 61_000_000,
                "volume_change_percent_24h": 5.0,
                "long_liquidation_usd_24h": 800.0,
                "short_liquidation_usd_24h": 1250.0,
                "spread_bps": 2.3,
                "depth_0_5pct_usd": 850_000.0,
            },
        ]
        context = {"median_atr_pct": 2.5}
        raw = [_raw_factors(row, rows, context) for row in rows]
        normalized = _normalize_factors(raw)
        correlation_rows = [{"factors": factors} for factors in normalized]
        flagged = factor_correlations(correlation_rows, DIRECTIONAL_FACTORS, min_pairs=10)
        duplicates = [item for item in flagged if abs(item["rho"]) >= 0.95]
        self.assertEqual(duplicates, [])

    def test_reversal_none_without_72h_change(self):
        row = _synthetic_row("BTC", 5.0, None)
        raw = _raw_factors(row, [row], {"median_atr_pct": 2.0})
        self.assertIsNone(raw["reversal_3d"])

    def test_btc_relative_strength_removed_from_definitions(self):
        self.assertNotIn("btc_relative_strength", DIRECTIONAL_FACTORS)
        self.assertNotIn("btc_relative_strength", DEFAULT_PRIORS)
        momentum_family = next(item for item in FAMILY_DEFINITIONS if item[0] == "momentum")
        self.assertNotIn("btc_relative_strength", momentum_family[2])


if __name__ == "__main__":
    unittest.main()
