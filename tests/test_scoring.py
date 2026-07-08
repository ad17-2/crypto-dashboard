import math
import unittest

from crypto_screener.factors import _raw_factors, factor_weights, score_snapshot
from crypto_screener.scoring import pct_change, robust_zscore_by_key, spearman_corr, spread_bps, zscore_by_key


class ScoringTests(unittest.TestCase):
    def test_pct_change(self):
        self.assertEqual(pct_change(100, 110), 10.0)
        self.assertEqual(pct_change(100, 90), -10.0)
        self.assertIsNone(pct_change(0, 90))

    def test_spread_bps(self):
        self.assertAlmostEqual(spread_bps(99.95, 100.05), 10.0, places=2)

    def test_zscore_by_key(self):
        rows = [{"value": 10}, {"value": 20}, {"value": 30}]
        zscores = zscore_by_key(rows, "value")
        self.assertAlmostEqual(sum(zscores), 0.0, places=7)
        self.assertLess(zscores[0], zscores[1])
        self.assertLess(zscores[1], zscores[2])

    def test_spearman_corr(self):
        self.assertAlmostEqual(spearman_corr([1, 2, 3], [10, 20, 30]), 1.0)
        self.assertAlmostEqual(spearman_corr([1, 2, 3], [30, 20, 10]), -1.0)

    def test_prior_weights_without_history(self):
        config = {"factors": {"min_observations": 30}}
        weights = factor_weights([], config)
        self.assertEqual(weights["mode"], "prior")
        self.assertGreater(weights["directional"]["momentum_24h"], 0)
        self.assertEqual(weights["validation"]["status"], "insufficient")

    def test_factor_weights_include_validation_metrics(self):
        records = [
            {
                "forward_return_pct": 2,
                "factors": {"momentum_24h": 1, "reversal_1d": -1},
                "scores": {"factor_score": 0.4},
            },
            {
                "forward_return_pct": -3,
                "factors": {"momentum_24h": -1, "reversal_1d": 1},
                "scores": {"factor_score": -0.5},
            },
            {
                "forward_return_pct": 1,
                "factors": {"momentum_24h": -1, "reversal_1d": 1},
                "scores": {"factor_score": -0.2},
            },
        ]
        weights = factor_weights(records, {"factors": {"min_observations": 3, "min_abs_ic": 0.0}})

        self.assertEqual(weights["validation"]["observations"], 3)
        self.assertAlmostEqual(weights["validation"]["model"]["hit_rate"], 66.67)
        self.assertIn("momentum_24h", weights["validation"]["factors"])

    def test_score_snapshot_ranks_long_and_short(self):
        rows = [
            {
                "symbol": "LONG",
                "price_usd": 10,
                "price_change_24h_pct": 5,
                "oi_change_24h_pct": 4,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 100_000_000,
                "long_liquidation_usd_24h": 1_000_000,
                "short_liquidation_usd_24h": 2_000_000,
                "technical_trend_score": 0.8,
                "technical_momentum_score": 0.6,
                "oi_acceleration_4h_pct": 3,
                "funding_avg_24h_pct": 0.01,
                "taker_imbalance_24h_pct": 8,
                "liquidation_imbalance_24h_pct": 12,
            },
            {
                "symbol": "SHORT",
                "price_usd": 10,
                "price_change_24h_pct": -5,
                "oi_change_24h_pct": 5,
                "funding_rate_pct": 0.04,
                "quote_volume_usd": 100_000_000,
                "long_liquidation_usd_24h": 3_000_000,
                "short_liquidation_usd_24h": 500_000,
                "technical_trend_score": -0.7,
                "technical_momentum_score": -0.5,
                "oi_acceleration_4h_pct": 4,
                "funding_avg_24h_pct": 0.04,
                "taker_imbalance_24h_pct": -10,
                "liquidation_imbalance_24h_pct": -20,
            },
            {
                "symbol": "BTC",
                "price_usd": 100,
                "price_change_24h_pct": 1,
                "oi_change_24h_pct": 1,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 200_000_000,
            },
        ]
        scored = score_snapshot(rows, {}, [], {"factors": {}})["rows"]
        long_row = next(row for row in scored if row["symbol"] == "LONG")
        short_row = next(row for row in scored if row["symbol"] == "SHORT")
        self.assertGreater(long_row["long_score"], long_row["short_score"])
        self.assertGreater(short_row["short_score"], short_row["long_score"])
        self.assertIn("technical_trend_4h", long_row["factors"])
        self.assertIn("oi_acceleration_signal", long_row["factors"])
        self.assertIn("taker_flow_24h", long_row["factors"])
        self.assertGreater(long_row["confidence_score"], 0)
        self.assertIn("breadth", score_snapshot(rows, {}, [], {"factors": {}})["market_context"])

    def test_score_snapshot_adds_regime_adjustments_and_conflict_labels(self):
        rows = [
            {
                "symbol": "BTC",
                "price_usd": 100,
                "price_change_24h_pct": 3,
                "oi_change_24h_pct": 2,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 200_000_000,
                "technical_trend_score": 0.8,
                "technical_momentum_score": 0.7,
                "derivatives_confirmation_score": 0.8,
            },
            {
                "symbol": "ALT",
                "price_usd": 10,
                "price_change_24h_pct": 5,
                "oi_change_24h_pct": 4,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 100_000_000,
                "technical_trend_score": -0.8,
                "technical_momentum_score": -0.7,
                "derivatives_confirmation_score": -0.8,
                "taker_imbalance_24h_pct": -8,
            },
            {
                "symbol": "WEAK",
                "price_usd": 10,
                "price_change_24h_pct": -4,
                "oi_change_24h_pct": 3,
                "funding_rate_pct": 0.03,
                "quote_volume_usd": 80_000_000,
                "technical_trend_score": 0.5,
                "technical_momentum_score": 0.4,
                "derivatives_confirmation_score": 0.5,
                "taker_imbalance_24h_pct": 6,
            },
        ]
        context = {
            "market_cap_change_24h_pct": 2,
            "categories": {
                "leaders": [{"name": "Layer 1", "market_cap_change_24h_pct": 3}],
                "laggards": [{"name": "Meme", "market_cap_change_24h_pct": -1}],
            },
        }

        scored = score_snapshot(rows, context, [], {"factors": {}})
        alt = next(row for row in scored["rows"] if row["symbol"] == "ALT")

        self.assertTrue(scored["factor_weights"]["regime_adjusted"])
        self.assertIn("base_directional", scored["factor_weights"])
        self.assertEqual(scored["market_context"]["breadth"]["status"], "ok")
        self.assertIn(scored["regime"]["breadth_label"], {"selective-risk-on", "broad-risk-on", "mixed"})
        self.assertEqual(alt["signal_conflict_label"], "high-conflict")
        self.assertGreater(alt["signal_conflict_score"], 0)
        self.assertTrue(alt["signal_conflicts"])

    def test_robust_zscore_resists_single_outlier(self):
        rows = [{"value": 1.0}, {"value": 2.0}, {"value": 3.0}, {"value": 100.0}]
        plain = zscore_by_key(rows, "value")
        robust = robust_zscore_by_key(rows, "value")
        plain_spread = plain[2] - plain[0]
        robust_spread = robust[2] - robust[0]
        self.assertLess(abs(plain_spread), abs(robust_spread))

    def test_reversal_is_volatility_normalized(self):
        rows = [
            {"symbol": "LOWVOL", "price_change_24h_pct": 10.0, "atr_14_pct": 2.0, "quote_volume_usd": 1},
            {"symbol": "HIGHVOL", "price_change_24h_pct": 10.0, "atr_14_pct": 5.0, "quote_volume_usd": 1},
        ]
        context = {"median_atr_pct": 3.5}
        low = _raw_factors(rows[0], rows, context)
        high = _raw_factors(rows[1], rows, context)
        self.assertNotAlmostEqual(low["reversal_1d"], high["reversal_1d"])
        self.assertAlmostEqual(low["reversal_1d"], -5.0)
        self.assertAlmostEqual(high["reversal_1d"], -2.0)

    def test_cross_sectional_ic_weighting(self):
        records = []
        symbols = ["A", "B", "C", "D", "E", "F"]
        for period in range(12):
            generated_at = f"2026-01-{period + 1:02d}T00:00:00"
            for index, symbol in enumerate(symbols):
                rank = float(index + 1)
                forward = rank
                if period % 2 == 1 and index == 2:
                    forward = 4.0
                elif period % 2 == 1 and index == 3:
                    forward = 3.0
                records.append(
                    {
                        "symbol": symbol,
                        "generated_at": generated_at,
                        "forward_return_pct": forward,
                        "factors": {
                            "momentum_24h": rank,
                            "reversal_1d": rank if period % 2 == 0 else -rank,
                        },
                    }
                )
        config = {
            "factors": {
                "ic_min_periods": 10,
                "min_abs_t": 2.0,
                "min_abs_ic": 0.02,
                "ic_prior_strength": 10,
                "ic_min_cross_section": 5,
            }
        }
        weights = factor_weights(records, config)
        self.assertEqual(weights["stats"]["momentum_24h"]["mode"], "ic")
        self.assertEqual(weights["stats"]["reversal_1d"]["mode"], "prior")

    def test_account_ratio_drives_ls_contrarian(self):
        row = {
            "long_short_account_ratio": 2.0,
            "long_short_ratio": 1.1,
            "quote_volume_usd": 1_000_000,
        }
        raw = _raw_factors(row, [row], {})
        self.assertAlmostEqual(raw["ls_ratio_contrarian"], -math.log(2.0))


if __name__ == "__main__":
    unittest.main()
