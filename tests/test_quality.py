import unittest

from crypto_screener.factors import score_snapshot
from crypto_screener.quality import apply_data_quality, data_quality_flags


class DataQualityTests(unittest.TestCase):
    def test_extreme_price_and_oi_changes_are_flagged(self):
        row = {
            "symbol": "TAIKO",
            "contract_symbol": "TAIKOUSDT",
            "quote_asset": "USDT",
            "data_source": "coinglass",
            "price_usd": 10,
            "price_change_24h_pct": 11508.53,
            "oi_change_24h_pct": 465.43,
            "quote_volume_usd": 50_000_000,
            "coinglass_exchange_count": 4,
        }

        flags = data_quality_flags(
            row,
            {
                "max_abs_price_change_24h_pct": 300,
                "max_abs_oi_change_24h_pct": 300,
                "max_abs_volume_change_24h_pct": 1000,
                "max_abs_funding_rate_pct": 2,
                "max_price_deviation_from_index_pct": 25,
                "min_quote_volume_usd": 10_000_000,
                "min_coinglass_exchange_count": 2,
            },
        )

        self.assertTrue(any(flag.startswith("extreme_24h_price_change") for flag in flags))
        self.assertTrue(any(flag.startswith("extreme_24h_oi_change") for flag in flags))

    def test_untrusted_rows_are_not_ranked(self):
        rows = [
            {
                "symbol": "NORMAL",
                "contract_symbol": "NORMALUSDT",
                "quote_asset": "USDT",
                "data_source": "coinglass",
                "price_usd": 10,
                "price_change_24h_pct": 5,
                "oi_change_24h_pct": 4,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 100_000_000,
                "coinglass_exchange_count": 4,
            },
            {
                "symbol": "EXTREME",
                "contract_symbol": "EXTREMEUSDT",
                "quote_asset": "USDT",
                "data_source": "coinglass",
                "price_usd": 10,
                "price_change_24h_pct": 1200,
                "oi_change_24h_pct": 500,
                "funding_rate_pct": 0.01,
                "quote_volume_usd": 100_000_000,
                "coinglass_exchange_count": 4,
            },
        ]

        apply_data_quality(rows, {"data_quality": {}})
        scored = score_snapshot(rows, {}, [], {"factors": {}})["rows"]
        extreme = next(row for row in scored if row["symbol"] == "EXTREME")
        normal = next(row for row in scored if row["symbol"] == "NORMAL")

        self.assertFalse(extreme["is_trusted"])
        self.assertEqual(extreme["long_score"], 0.0)
        self.assertEqual(extreme["short_score"], 0.0)
        self.assertTrue(normal["is_trusted"])

    def test_stale_and_weird_rows_are_flagged(self):
        row = {
            "symbol": "BAD/PAIR",
            "contract_symbol": "BADPAIRUSD",
            "quote_asset": "USDT",
            "data_source": "coinglass",
            "price_usd": 0,
            "quote_volume_usd": 250_000,
            "open_interest_usd": -1,
        }

        status = apply_data_quality([row], {"data_quality": {}})

        self.assertEqual(status["excluded"], 1)
        self.assertIn("weird_symbol:BAD/PAIR", row["data_quality_flags"])
        self.assertIn("weird_contract_symbol:BADPAIRUSD", row["data_quality_flags"])
        self.assertIn("invalid_price:0.00", row["data_quality_flags"])
        self.assertTrue(any(flag.startswith("stale_low_quote_volume") for flag in row["data_quality_flags"]))
        self.assertTrue(any(flag.startswith("invalid_open_interest") for flag in row["data_quality_flags"]))

    def test_index_price_deviation_and_thin_coinglass_coverage_are_flagged(self):
        row = {
            "symbol": "TAIKO",
            "contract_symbol": "TAIKOUSDT",
            "quote_asset": "USDT",
            "data_source": "coinglass",
            "price_usd": 50,
            "index_price": 10,
            "price_change_24h_pct": 5,
            "quote_volume_usd": 50_000_000,
            "coinglass_exchange_count": 1,
        }

        apply_data_quality([row], {"data_quality": {}})

        self.assertTrue(any(flag.startswith("price_deviates_from_index") for flag in row["data_quality_flags"]))
        self.assertTrue(any(flag.startswith("thin_coinglass_exchange_coverage") for flag in row["data_quality_flags"]))


if __name__ == "__main__":
    unittest.main()
