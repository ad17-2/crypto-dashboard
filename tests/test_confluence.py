import unittest

from crypto_screener.confluence import confluence_summary
from crypto_screener.dashboard_rows import dashboard_row, history_percentile


def _long_tilted_row() -> dict:
    return {
        "symbol": "BTC",
        "scores": {"factor_score": 1.2},
        "factors": {
            "technical_trend_4h": 2.0,
            "momentum_24h": 2.0,
            "technical_momentum_4h": 1.8,
            "btc_relative_strength": 1.5,
            "reversal_1d": 1.2,
            "oi_price_signal": 2.0,
            "oi_acceleration_signal": 1.6,
            "taker_flow_24h": 1.4,
            "liquidation_imbalance": 1.1,
            "liquidation_pressure_24h": 0.9,
            "funding_rate_contrarian": 1.7,
            "funding_persistence_contrarian": 1.3,
            "ls_ratio_contrarian": 1.0,
        },
        "regime_alignment_score": 0.8,
        "breadth_alignment_score": 0.6,
    }


class ConfluenceTests(unittest.TestCase):
    def test_long_tilted_factors_align_with_long_thesis(self):
        summary = confluence_summary(_long_tilted_row(), "long")
        self.assertGreater(summary["aligned"], summary["against"])
        self.assertEqual(summary["direction"], "long")
        self.assertEqual(summary["net_score"], summary["aligned"] - summary["against"])

    def test_long_tilted_factors_flip_against_short_thesis(self):
        summary = confluence_summary(_long_tilted_row(), "short")
        self.assertGreater(summary["against"], summary["aligned"])
        self.assertEqual(summary["direction"], "short")

    def test_all_none_family_is_neutral(self):
        row = {
            "scores": {"factor_score": 0.5},
            "factors": {
                "technical_trend_4h": 1.5,
                "momentum_24h": 1.5,
            },
            "regime_alignment_score": None,
            "breadth_alignment_score": None,
        }
        summary = confluence_summary(row, "long")
        regime = summary["families"][5]
        self.assertEqual(regime["key"], "regime")
        self.assertEqual(regime["tone"], "neutral")
        self.assertIsNone(regime["value"])

    def test_families_fixed_order_and_length(self):
        summary = confluence_summary(_long_tilted_row(), "long")
        self.assertEqual(len(summary["families"]), 6)
        self.assertEqual(
            [family["key"] for family in summary["families"]],
            ["trend", "momentum", "oi_flow", "funding", "crowding", "regime"],
        )
        self.assertEqual(summary["total"], 6)

    def test_dashboard_row_includes_confluence_fields(self):
        row = dashboard_row(_long_tilted_row(), "long_score", "long")
        self.assertIn("confluence", row)
        self.assertIn("confluence_score", row)
        self.assertEqual(row["confluence_score"], row["confluence"]["net_score"])

    def test_history_percentile_requires_six_points(self):
        history = [{"funding_rate_pct": value} for value in (0.01, 0.02, 0.03, 0.04, 0.05)]
        self.assertIsNone(history_percentile(history, "funding_rate_pct", 0.03))

    def test_history_percentile_basic_calculation(self):
        history = [{"funding_rate_pct": value} for value in (0.01, 0.02, 0.03, 0.04, 0.05, 0.06)]
        self.assertEqual(history_percentile(history, "funding_rate_pct", 0.03), 50.0)
        self.assertEqual(history_percentile(history, "funding_rate_pct", 0.06), 100.0)

    def test_history_percentile_positioning_fallback_key(self):
        history = [
            {"long_short_ratio": 1.0 + index * 0.1}
            for index in range(6)
        ]
        self.assertEqual(
            history_percentile(history, "long_short_account_ratio", 1.3, fallback_key="long_short_ratio"),
            67.0,
        )


if __name__ == "__main__":
    unittest.main()
