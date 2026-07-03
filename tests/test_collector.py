import unittest

from crypto_screener.collector import _aggregate_coinglass_pairs, _coinglass_candidate_stats, _rank_coinglass_candidates


class CollectorTests(unittest.TestCase):
    def test_coinglass_candidate_stats_filter_and_rank_supported_pairs(self):
        supported_pairs = {
            "MEXC": [
                {"base_asset": "BTC", "quote_asset": "USDT", "instrument_id": "BTCUSDT", "max_leverage": "125"},
                {"base_asset": "USDT", "quote_asset": "USDT", "instrument_id": "USDTUSDT", "max_leverage": "1"},
                {"base_asset": "OLD", "quote_asset": "USDT", "instrument_id": "OLD-USDT-260101", "max_leverage": "10"},
            ],
            "OKX": [
                {"base_asset": "BTC", "quote_asset": "USDT", "instrument_id": "BTC-USDT-SWAP", "max_leverage": "100"},
                {"base_asset": "ETH", "quote_asset": "USDT", "instrument_id": "ETH-USDT-SWAP", "max_leverage": "100"},
            ],
            "Bybit": [
                {"base_asset": "ETH", "quote_asset": "USDT", "instrument_id": "ETHUSDT", "max_leverage": "100"},
            ],
        }

        stats = _coinglass_candidate_stats(
            supported_pairs=supported_pairs,
            exchanges={"MEXC", "OKX", "Bybit"},
            quote_asset="USDT",
            min_exchange_count=2,
            excluded_bases={"USDT"},
        )
        ranked = _rank_coinglass_candidates(stats, ["ETH"], 2)

        self.assertEqual(set(stats), {"BTC", "ETH"})
        self.assertEqual(ranked, ["ETH", "BTC"])

    def test_aggregate_coinglass_pairs_builds_primary_row(self):
        pairs = [
            {
                "symbol": "BTC/USDT",
                "instrument_id": "BTC-USDT-SWAP",
                "exchange_name": "OKX",
                "current_price": 100,
                "index_price": 101,
                "price_change_percent_24h": 2,
                "volume_usd": 200,
                "volume_usd_change_percent_24h": 5,
                "open_interest_usd": 1000,
                "open_interest_change_percent_24h": 4,
                "funding_rate": 0.01,
                "long_volume_usd": 60,
                "short_volume_usd": 40,
                "long_liquidation_usd_24h": 10,
                "short_liquidation_usd_24h": 20,
            },
            {
                "symbol": "BTC/USDT",
                "instrument_id": "BTCUSDT",
                "exchange_name": "Bybit",
                "current_price": 110,
                "index_price": 109,
                "price_change_percent_24h": 3,
                "volume_usd": 100,
                "volume_usd_change_percent_24h": 7,
                "open_interest_usd": 500,
                "open_interest_change_percent_24h": 6,
                "funding_rate": 0.02,
                "long_volume_usd": 90,
                "short_volume_usd": 60,
                "long_liquidation_usd_24h": 30,
                "short_liquidation_usd_24h": 40,
            },
        ]

        row = _aggregate_coinglass_pairs(
            pairs,
            {"OKX", "Bybit"},
            {"instrument_count": 2, "exchanges": {"OKX", "Bybit"}},
            "USDT",
        )

        self.assertEqual(row["symbol"], "BTC")
        self.assertEqual(row["data_source"], "coinglass")
        self.assertEqual(row["primary_exchange"], "OKX")
        self.assertEqual(row["quote_volume_usd"], 300)
        self.assertEqual(row["open_interest_usd"], 1500)
        self.assertAlmostEqual(row["long_short_ratio"], 1.5)
        self.assertEqual(row["coinglass_exchange_count"], 2)


if __name__ == "__main__":
    unittest.main()
