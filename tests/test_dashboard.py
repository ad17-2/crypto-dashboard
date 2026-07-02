import copy
import tempfile
import unittest
from pathlib import Path

from crypto_screener.dashboard import DASHBOARD_HTML, build_dashboard_payload
from crypto_screener.storage import connect, save_snapshot


class DashboardTests(unittest.TestCase):
    def test_dashboard_reads_latest_run_from_sqlite(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "screener.sqlite3"
            config = {"storage_path": str(db_path)}
            payload = {
                "run_id": "run-1",
                "generated_at": "2026-07-02T09:00:00+07:00",
                "market_context": {
                    "market_cap_change_24h_pct": 1.2,
                    "btc_dominance_pct": 55.5,
                    "categories": {"leaders": [], "laggards": []},
                },
                "provider_status": {"binance": {"status": "ok", "rows": 2}},
                "regime": {"bias": "risk-on", "label": "momentum"},
                "factor_weights": {"mode": "prior"},
                "rows": [
                    {
                        "symbol": "BTC",
                        "price_usd": 100,
                        "price_change_24h_pct": 1,
                        "oi_change_24h_pct": 2,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "binance",
                        "is_trusted": True,
                        "data_quality_score": 100,
                        "factor_score": 0.2,
                        "long_score": 30,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "scores": {"factor_score": 0.2, "long_score": 30},
                        "factors": {"momentum_24h": 1.0},
                    },
                    {
                        "symbol": "ODD",
                        "price_usd": 1,
                        "price_change_24h_pct": 400,
                        "oi_change_24h_pct": 10,
                        "funding_rate_pct": 0.01,
                        "quote_volume_usd": 100_000_000,
                        "data_source": "binance",
                        "is_trusted": False,
                        "data_quality_score": 75,
                        "data_quality_flags": ["extreme_24h_price_change:+400.00%"],
                        "factor_score": 0,
                        "long_score": 0,
                        "short_score": 0,
                        "crowded_long_score": 0,
                        "squeeze_risk_score": 0,
                        "scores": {},
                        "factors": {},
                    },
                ],
            }

            save_snapshot(payload, config)
            next_payload = copy.deepcopy(payload)
            next_payload["run_id"] = "run-2"
            next_payload["generated_at"] = "2026-07-02T12:00:00+07:00"
            next_payload["rows"][0]["price_usd"] = 105
            next_payload["rows"][0]["long_score"] = 35
            next_payload["rows"][0]["scores"]["long_score"] = 35
            save_snapshot(next_payload, config)
            dashboard = build_dashboard_payload(db_path, limit=5)

        self.assertEqual(dashboard["status"], "ok")
        self.assertEqual(dashboard["regime"]["bias"], "risk-on")
        self.assertEqual(dashboard["quality"]["trusted_count"], 1)
        self.assertEqual(dashboard["quality"]["excluded_count"], 1)
        self.assertEqual(dashboard["sections"]["long"][0]["symbol"], "BTC")
        self.assertTrue(dashboard["sections"]["long"][0]["reason_parts"])
        self.assertEqual(dashboard["sections"]["long"][0]["reason_parts"][0]["label"], "24h")
        self.assertEqual(dashboard["watchlists"][0]["id"], "chart_next")
        self.assertEqual(dashboard["watchlists"][1]["id"], "long")
        self.assertEqual(dashboard["watchlists"][1]["rows"][0]["setup"], "OI Momentum Long")
        self.assertGreater(dashboard["watchlists"][1]["rows"][0]["priority"], 0)
        self.assertTrue(dashboard["watchlists"][1]["rows"][0]["factor_parts"])
        self.assertEqual(len(dashboard["watchlists"][1]["rows"][0]["history"]), 2)
        self.assertEqual(dashboard["runs"][0]["coinglass_status"], "-")

    def test_dashboard_reason_has_help_tooltip(self):
        self.assertIn("reasonTooltip", DASHBOARD_HTML)
        self.assertIn("help-tip", DASHBOARD_HTML)
        self.assertIn("tooltip-popover", DASHBOARD_HTML)
        self.assertIn("reason_parts", DASHBOARD_HTML)
        self.assertIn("watchTabs", DASHBOARD_HTML)
        self.assertIn("watchTable", DASHBOARD_HTML)
        self.assertIn("detailPanel", DASHBOARD_HTML)
        self.assertIn("sparkline", DASHBOARD_HTML)
        self.assertIn("filterValues", DASHBOARD_HTML)
        self.assertIn("factorBars", DASHBOARD_HTML)
        self.assertIn("module-panel", DASHBOARD_HTML)
        self.assertIn('class="watch-row', DASHBOARD_HTML)
        self.assertIn('class="watch-cell', DASHBOARD_HTML)
        self.assertIn('class="detail-rail"', DASHBOARD_HTML)
        self.assertIn("sourceTags(row.data_source)", DASHBOARD_HTML)
        self.assertIn("tradingViewSymbol", DASHBOARD_HTML)
        self.assertIn("BINANCE:${base}USDT.P", DASHBOARD_HTML)
        self.assertIn("https://www.tradingview.com/chart/?symbol=", DASHBOARD_HTML)
        self.assertIn("rel=\"noopener noreferrer\"", DASHBOARD_HTML)
        self.assertIn("qualityFlagChip", DASHBOARD_HTML)
        self.assertNotIn("table-wrap", DASHBOARD_HTML)
        self.assertNotIn("<table>", DASHBOARD_HTML)
        self.assertNotIn('class="row-cell"', DASHBOARD_HTML)
        self.assertNotIn('colspan="9"', DASHBOARD_HTML)
        self.assertNotIn("function rowsTable", DASHBOARD_HTML)
        self.assertNotIn("<th class=\"reason\">", DASHBOARD_HTML)
        self.assertNotIn('class="reason-row"', DASHBOARD_HTML)

    def test_existing_runs_table_gets_dashboard_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "legacy.sqlite3"
            raw = connect(db_path)
            raw.execute("DROP TABLE runs")
            raw.execute(
                """
                CREATE TABLE runs (
                    run_id TEXT PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    provider_status_json TEXT NOT NULL
                )
                """
            )
            raw.commit()
            raw.close()

            with connect(db_path) as conn:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}

        self.assertIn("regime_json", columns)
        self.assertIn("factor_weights_json", columns)


if __name__ == "__main__":
    unittest.main()
