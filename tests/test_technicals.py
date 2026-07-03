import unittest

from crypto_screener.technicals import technical_snapshot


class TechnicalsTests(unittest.TestCase):
    def test_technical_snapshot_scores_rising_series(self):
        candles = []
        for index in range(220):
            close = 100.0 + (index * 0.25)
            candles.append(
                {
                    "time": index,
                    "open": close - 0.1,
                    "high": close + 0.4,
                    "low": close - 0.4,
                    "close": close,
                }
            )

        snapshot = technical_snapshot(candles, "4h")

        self.assertEqual(snapshot["technical_interval"], "4h")
        self.assertEqual(snapshot["technical_candle_count"], 220)
        self.assertGreater(snapshot["ema_20"], snapshot["ema_50"])
        self.assertGreater(snapshot["technical_trend_score"], 0)
        self.assertGreater(snapshot["technical_momentum_score"], 0)
        self.assertIn(snapshot["technical_setup"], {"Trend Continuation", "Upside Exhaustion"})
        self.assertIsNotNone(snapshot["rsi_14"])

    def test_technical_snapshot_requires_enough_candles(self):
        self.assertEqual(technical_snapshot([], "4h"), {})


if __name__ == "__main__":
    unittest.main()
