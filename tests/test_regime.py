from __future__ import annotations

import unittest

from crypto_screener.factors import infer_regime, score_snapshot
from crypto_screener.market import market_sensing_summary
from crypto_screener.regime import classify_regime


class RegimeTests(unittest.TestCase):
    def _config(self) -> dict:
        return {"factors": {"regime": {}}}

    def _btc_eth_rows(self, btc_change: float, eth_change: float) -> list[dict]:
        return [
            {"symbol": "BTC", "price_change_24h_pct": btc_change, "is_trusted": True},
            {"symbol": "ETH", "price_change_24h_pct": eth_change, "is_trusted": True},
        ]

    def test_classify_btc_led(self):
        context = {
            "btc_dominance_delta_pct": 0.4,
            "eth_btc_performance_pct": -1.5,
            "return_dispersion_pct": 3.0,
            "breadth": {"score": -0.2},
        }
        result = classify_regime(context, None, self._config())
        self.assertEqual(result["state"], "btc-led")

    def test_classify_alts_strong(self):
        context = {
            "btc_dominance_delta_pct": -0.4,
            "eth_btc_performance_pct": 2.0,
            "return_dispersion_pct": 3.0,
            "breadth": {"score": 0.4},
        }
        result = classify_regime(context, None, self._config())
        self.assertEqual(result["state"], "alts-strong")

    def test_classify_chaos(self):
        context = {
            "btc_dominance_delta_pct": 0.0,
            "eth_btc_performance_pct": 0.0,
            "return_dispersion_pct": 12.0,
            "breadth": {"score": 0.05},
        }
        result = classify_regime(context, None, self._config())
        self.assertEqual(result["state"], "chaos")

    def test_classify_neutral(self):
        context = {
            "btc_dominance_delta_pct": 0.05,
            "eth_btc_performance_pct": 0.2,
            "return_dispersion_pct": 2.0,
            "breadth": {"score": 0.1},
        }
        result = classify_regime(context, None, self._config())
        self.assertEqual(result["state"], "neutral")

    def test_hysteresis_blocks_marginal_flip(self):
        context = {
            "btc_dominance_delta_pct": 0.15,
            "eth_btc_performance_pct": 0.25,
            "return_dispersion_pct": 2.0,
            "breadth": {"score": 0.26},
        }
        without = classify_regime(context, None, self._config())
        with_prior = classify_regime(context, "btc-led", self._config())
        self.assertEqual(without["raw_state"], "alts-strong")
        self.assertEqual(with_prior["state"], "btc-led")

    def test_hysteresis_allows_clear_flip(self):
        context = {
            "btc_dominance_delta_pct": -0.8,
            "eth_btc_performance_pct": 4.0,
            "return_dispersion_pct": 2.0,
            "breadth": {"score": 0.6},
        }
        result = classify_regime(context, "btc-led", self._config())
        self.assertEqual(result["state"], "alts-strong")

    def test_infer_regime_independent_of_weights(self):
        rows = self._btc_eth_rows(2.0, 1.0)
        context = {
            "market_cap_change_24h_pct": 1.0,
            "btc_dominance_delta_pct": 0.3,
            "eth_btc_performance_pct": -0.5,
            "return_dispersion_pct": 2.0,
            "breadth": {"score": -0.1, "label": "mixed"},
            "sector_rotation": {"label": "mixed"},
        }
        momentum_weights = {
            "directional": {
                "momentum_24h": 0.5,
                "reversal_1d": 0.01,
                "funding_rate_contrarian": 0.01,
                "ls_ratio_contrarian": 0.01,
            }
        }
        reversal_weights = {
            "directional": {
                "momentum_24h": 0.01,
                "reversal_1d": 0.5,
                "funding_rate_contrarian": 0.5,
                "ls_ratio_contrarian": 0.5,
            }
        }
        first = infer_regime(momentum_weights, rows, context, None, self._config())
        second = infer_regime(reversal_weights, rows, context, None, self._config())
        self.assertEqual(first["label"], second["label"])
        self.assertEqual(first["regime_state"], second["regime_state"])

    def test_market_sensing_first_run_delta_none(self):
        rows = self._btc_eth_rows(2.0, 3.0)
        context = {"btc_dominance_pct": 55.0}
        summary = market_sensing_summary(rows, context, None)
        self.assertIsNone(summary["btc_dominance_delta_pct"])
        self.assertAlmostEqual(summary["eth_btc_performance_pct"], 0.980392, places=5)

    def test_market_sensing_dispersion_guard(self):
        rows = [{"symbol": "BTC", "price_change_24h_pct": 1.0, "is_trusted": True}]
        summary = market_sensing_summary(rows, {"btc_dominance_pct": 55.0}, {"btc_dominance_pct": 54.0})
        self.assertIsNone(summary["return_dispersion_pct"])
        self.assertAlmostEqual(summary["btc_dominance_delta_pct"], 1.0)

    def test_score_snapshot_merges_sensing_fields(self):
        rows = self._btc_eth_rows(1.0, 2.0)
        scored = score_snapshot(
            rows,
            {"btc_dominance_pct": 56.0},
            [],
            self._config(),
            prior_market_state={"btc_dominance_pct": 55.0, "regime_state": "neutral"},
        )
        context = scored["market_context"]
        self.assertAlmostEqual(context["btc_dominance_delta_pct"], 1.0)
        self.assertIsNotNone(context["eth_btc_performance_pct"])
        self.assertIn(scored["regime"]["regime_state"], {"btc-led", "alts-strong", "neutral", "chaos"})


if __name__ == "__main__":
    unittest.main()
