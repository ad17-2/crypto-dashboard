import unittest

from crypto_screener.coinglass_enrichment import append_coinglass_long_short_ratio


class FakeCoinGlassClient:
    def __init__(self) -> None:
        self.global_calls: list[tuple[str, str]] = []
        self.top_calls: list[tuple[str, str]] = []

    def global_long_short_account_ratio_history(
        self, exchange, symbol, interval, limit, start_time=None, end_time=None
    ):
        self.global_calls.append((exchange, symbol))
        return [{"global_account_long_short_ratio": 1.8}]

    def top_long_short_account_ratio_history(self, exchange, symbol, interval, limit, start_time=None, end_time=None):
        self.top_calls.append((exchange, symbol))
        return [{"top_account_long_short_ratio": 2.4}]


class CoinGlassEnrichmentTests(unittest.TestCase):
    def test_append_long_short_account_ratio(self):
        rows = [
            {
                "symbol": "BTC",
                "base_asset": "BTC",
                "quote_asset": "USDT",
                "primary_exchange": "Binance",
            }
        ]
        client = FakeCoinGlassClient()
        status: dict = {}
        provider_cfg = {
            "request_delay_seconds": 0,
            "long_short_ratio": {
                "enabled": True,
                "interval": "4h",
                "limit": 30,
                "max_symbols": 0,
                "ratio_exchange": "Binance",
                "include_top_trader": True,
                "request_delay_seconds": 0,
            },
        }

        append_coinglass_long_short_ratio(rows, client, provider_cfg, status)

        self.assertAlmostEqual(rows[0]["long_short_account_ratio"], 1.8)
        self.assertAlmostEqual(rows[0]["top_trader_long_short_ratio"], 2.4)
        self.assertEqual(status["long_short_ratio"]["status"], "ok")
        self.assertEqual(client.global_calls, [("Binance", "BTCUSDT")])
        self.assertEqual(client.top_calls, [("Binance", "BTCUSDT")])


if __name__ == "__main__":
    unittest.main()
