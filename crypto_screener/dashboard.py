from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .cli import load_config
from .factors import DIRECTIONAL_FACTORS, reason_for
from .pipeline import run_pipeline
from .report import top_by
from .scoring import to_float
from .storage import connect


DEFAULT_CONFIG_PATH = Path("config/default.json")

FACTOR_LABELS = {
    "momentum_24h": "Momentum",
    "reversal_1d": "Reversal",
    "oi_price_signal": "OI/Price",
    "funding_rate_contrarian": "Funding",
    "ls_ratio_contrarian": "L/S",
    "liquidation_imbalance": "Liquidations",
    "btc_relative_strength": "BTC Relative",
}

WATCHLIST_LABELS = {
    "chart_next": "Chart Next",
    "long": "Longs",
    "short": "Shorts",
    "squeeze_risks": "Squeeze Risk",
    "crowded_longs": "Long Fades",
    "core": "Core",
}


@dataclass(frozen=True)
class DashboardSettings:
    config_path: Path
    db_path: Path
    report_dir: Path
    host: str
    port: int
    limit: int
    auto_refresh_seconds: int
    refresh_token: str | None


class RefreshRuntime:
    def __init__(self, settings: DashboardSettings) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self.status: dict[str, Any] = {"state": "idle"}

    def refresh(self, reason: str) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            return self.status | {"state": "running"}
        try:
            started_at = datetime.now(timezone.utc)
            self.status = {
                "state": "running",
                "reason": reason,
                "started_at": started_at.isoformat(timespec="seconds"),
            }
            config = _load_runtime_config(self.settings)
            payload, paths = run_pipeline(config, self.settings.report_dir, save=True)
            finished_at = datetime.now(timezone.utc)
            self.status = {
                "state": "ok",
                "reason": reason,
                "run_id": payload.get("run_id"),
                "generated_at": payload.get("generated_at"),
                "finished_at": finished_at.isoformat(timespec="seconds"),
                "duration_seconds": round((finished_at - started_at).total_seconds(), 2),
                "paths": {key: str(path) for key, path in paths.items()},
            }
            return self.status
        except Exception as exc:  # pragma: no cover - exercised in deployed runtime
            self.status = {
                "state": "error",
                "reason": reason,
                "error": str(exc),
                "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            return self.status
        finally:
            self.lock.release()

    def refresh_async(self, reason: str) -> dict[str, Any]:
        if self.lock.locked():
            return self.status | {"state": "running"}
        thread = threading.Thread(target=self.refresh, args=(reason,), daemon=True)
        thread.start()
        return {"state": "queued", "reason": reason}


def settings_from_env() -> DashboardSettings:
    config_path = Path(os.environ.get("CRYPTO_SCREENER_CONFIG", DEFAULT_CONFIG_PATH))
    config = load_config(config_path)
    db_path = Path(os.environ.get("CRYPTO_SCREENER_DB_PATH", config.get("storage_path", "data/crypto_screener.sqlite3")))
    report_dir = Path(os.environ.get("CRYPTO_SCREENER_REPORT_DIR", "reports"))
    return DashboardSettings(
        config_path=config_path,
        db_path=db_path,
        report_dir=report_dir,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
        limit=int(os.environ.get("CRYPTO_DASHBOARD_LIMIT", config.get("report", {}).get("limit", 12))),
        auto_refresh_seconds=int(os.environ.get("CRYPTO_DASHBOARD_AUTO_REFRESH_SECONDS", "0")),
        refresh_token=os.environ.get("CRYPTO_DASHBOARD_REFRESH_TOKEN") or None,
    )


def _load_runtime_config(settings: DashboardSettings) -> dict[str, Any]:
    config = load_config(settings.config_path)
    config["storage_path"] = str(settings.db_path)
    return config


def build_dashboard_payload(db_path: Path, run_id: str | None = None, limit: int = 12) -> dict[str, Any]:
    if not db_path.exists():
        return {
            "status": "empty",
            "database": str(db_path),
            "runs": [],
            "refresh_status": None,
        }

    with connect(db_path) as conn:
        runs = _recent_runs(conn)
        selected = _selected_run(conn, run_id)
        if selected is None:
            return {
                "status": "empty",
                "database": str(db_path),
                "runs": runs,
                "refresh_status": None,
            }

        rows = [
            _loads_json(row["row_json"], {})
            for row in conn.execute(
                """
                SELECT row_json
                FROM market_rows
                WHERE run_id = ?
                """,
                (selected["run_id"],),
            ).fetchall()
        ]
        history = _history_by_symbol(
            conn,
            [str(row.get("symbol")) for row in rows if row.get("symbol")],
            selected["generated_at"],
        )

    context = _loads_json(selected["context_json"], {})
    provider_status = _loads_json(selected["provider_status_json"], {})
    regime = _loads_json(selected["regime_json"], {})
    factor_weights = _loads_json(selected["factor_weights_json"], {})
    sections = _sections(rows, limit, history)

    return {
        "status": "ok",
        "database": str(db_path),
        "run": {
            "run_id": selected["run_id"],
            "generated_at": selected["generated_at"],
            "row_count": len(rows),
        },
        "runs": runs,
        "regime": regime,
        "market_context": context,
        "provider_status": provider_status,
        "factor_weights": factor_weights,
        "quality": _quality_summary(rows),
        "sections": sections,
        "watchlists": _watchlists(sections, limit),
    }


def _recent_runs(conn, limit: int = 30) -> list[dict[str, Any]]:
    db_rows = conn.execute(
        """
        SELECT run_id, generated_at, provider_status_json, regime_json
        FROM runs
        ORDER BY generated_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    if not db_rows:
        return []

    run_ids = [row["run_id"] for row in db_rows]
    placeholders = ",".join("?" for _ in run_ids)
    counts = {
        row["run_id"]: row["row_count"]
        for row in conn.execute(
            f"""
            SELECT run_id, COUNT(*) AS row_count
            FROM market_rows
            WHERE run_id IN ({placeholders})
            GROUP BY run_id
            """,
            run_ids,
        ).fetchall()
    }
    flagged: dict[str, int] = {run_id: 0 for run_id in run_ids}
    for row in conn.execute(
        f"""
        SELECT run_id, row_json
        FROM market_rows
        WHERE run_id IN ({placeholders})
        """,
        run_ids,
    ).fetchall():
        item = _loads_json(row["row_json"], {})
        if item.get("data_quality_flags"):
            flagged[row["run_id"]] = flagged.get(row["run_id"], 0) + 1

    runs: list[dict[str, Any]] = []
    for row in db_rows:
        regime = _loads_json(row["regime_json"], {})
        providers = _loads_json(row["provider_status_json"], {})
        runs.append(
            {
                "run_id": row["run_id"],
                "generated_at": row["generated_at"],
                "row_count": counts.get(row["run_id"], 0),
                "excluded_count": flagged.get(row["run_id"], 0),
                "bias": regime.get("bias", "unknown"),
                "factor_regime": regime.get("label", "unknown"),
                "coinglass_status": providers.get("coinglass", {}).get("status", "-"),
            }
        )
    return runs


def _selected_run(conn, run_id: str | None):
    if run_id:
        return conn.execute(
            """
            SELECT run_id, generated_at, context_json, provider_status_json, regime_json, factor_weights_json
            FROM runs
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
    return conn.execute(
        """
        SELECT run_id, generated_at, context_json, provider_status_json, regime_json, factor_weights_json
        FROM runs
        ORDER BY generated_at DESC
        LIMIT 1
        """
    ).fetchone()


def _sections(
    rows: list[dict[str, Any]],
    limit: int,
    history: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    history = history or {}
    core_symbols = ["BTC", "ETH", "SOL"]
    core_by_symbol = {row.get("symbol"): row for row in rows if row.get("symbol") in core_symbols}
    return {
        "core": [
            _dashboard_row(core_by_symbol[symbol], "factor_score", "core", history.get(symbol, []))
            for symbol in core_symbols
            if symbol in core_by_symbol
        ],
        "long": [
            _dashboard_row(row, "long_score", "long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "long_score", limit, predicate=lambda item: (item.get("factor_score") or 0) > 0)
        ],
        "short": [
            _dashboard_row(row, "short_score", "short", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "short_score", limit, predicate=lambda item: (item.get("factor_score") or 0) < 0)
        ],
        "crowded_longs": [
            _dashboard_row(row, "crowded_long_score", "fade-long", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "crowded_long_score", limit, predicate=_is_crowded_long)
        ],
        "squeeze_risks": [
            _dashboard_row(row, "squeeze_risk_score", "squeeze-risk", history.get(str(row.get("symbol")), []))
            for row in top_by(rows, "squeeze_risk_score", limit, predicate=_is_crowded_short)
        ],
    }


def _watchlists(sections: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    chart_next = _chart_next_rows(sections, limit)
    ordered = [
        ("chart_next", chart_next),
        ("long", sections.get("long", [])),
        ("short", sections.get("short", [])),
        ("squeeze_risks", sections.get("squeeze_risks", [])),
        ("crowded_longs", sections.get("crowded_longs", [])),
        ("core", sections.get("core", [])),
    ]
    return [
        {
            "id": key,
            "label": WATCHLIST_LABELS[key],
            "rows": rows,
        }
        for key, rows in ordered
    ]


def _chart_next_rows(sections: dict[str, list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for key in ("long", "short", "squeeze_risks", "crowded_longs", "core"):
        for row in sections.get(key, []):
            symbol = str(row.get("symbol") or "")
            current = candidates.get(symbol)
            if current is None or (row.get("priority") or 0) > (current.get("priority") or 0):
                candidates[symbol] = row
    return sorted(candidates.values(), key=lambda item: item.get("priority") or 0, reverse=True)[: max(limit, 12)]


def _dashboard_row(row: dict[str, Any], score_field: str, side: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    scores = row.get("scores", {})
    factors = row.get("factors", {})
    score = row.get(score_field)
    setup = _setup_label(row, side)
    priority = _chart_priority(row, score_field, score)
    return {
        "symbol": row.get("symbol"),
        "side": side,
        "setup": setup,
        "setup_tone": _setup_tone(side),
        "score_field": score_field,
        "score": score,
        "priority": priority,
        "quality": row.get("data_quality_score", 100),
        "price_usd": row.get("price_usd"),
        "price_change_24h_pct": row.get("price_change_24h_pct"),
        "oi_change_24h_pct": row.get("oi_change_24h_pct"),
        "funding_rate_pct": row.get("funding_rate_pct"),
        "long_short_ratio": row.get("long_short_ratio"),
        "quote_volume_usd": row.get("quote_volume_usd"),
        "open_interest_usd": row.get("open_interest_usd"),
        "data_source": row.get("data_source"),
        "is_trusted": row.get("is_trusted", True),
        "data_quality_flags": row.get("data_quality_flags", []),
        "scores": {
            key: scores.get(key)
            for key in ("factor_score", "long_score", "short_score", "crowded_long_score", "squeeze_risk_score")
        },
        "factor_parts": _factor_parts(factors),
        "primary_driver": _primary_driver(factors),
        "history": history or [],
        "reason": reason_for(row, side),
        "reason_parts": _reason_parts(row, side),
    }


def _history_by_symbol(conn, symbols: list[str], generated_at: str, limit: int = 16) -> dict[str, list[dict[str, Any]]]:
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols:
        return {}
    placeholders = ",".join("?" for _ in unique_symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, row_json
        FROM market_rows
        WHERE symbol IN ({placeholders})
          AND generated_at <= ?
        ORDER BY symbol ASC, generated_at DESC
        """,
        [*unique_symbols, generated_at],
    ).fetchall()

    by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in unique_symbols}
    for db_row in rows:
        symbol = db_row["symbol"]
        if len(by_symbol.get(symbol, [])) >= limit:
            continue
        item = _loads_json(db_row["row_json"], {})
        scores = item.get("scores", {})
        by_symbol.setdefault(symbol, []).append(
            {
                "generated_at": db_row["generated_at"],
                "price_usd": item.get("price_usd"),
                "price_change_24h_pct": item.get("price_change_24h_pct"),
                "oi_change_24h_pct": item.get("oi_change_24h_pct"),
                "funding_rate_pct": item.get("funding_rate_pct"),
                "long_short_ratio": item.get("long_short_ratio"),
                "quote_volume_usd": item.get("quote_volume_usd"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
            }
        )
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


def _setup_label(row: dict[str, Any], side: str) -> str:
    price_change = to_float(row.get("price_change_24h_pct")) or 0.0
    oi_change = to_float(row.get("oi_change_24h_pct")) or 0.0
    funding = to_float(row.get("funding_rate_pct")) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    if side == "core":
        return "Core Regime Read"
    if side == "fade-long":
        return "Crowded Long Fade"
    if side == "squeeze-risk":
        return "Short Squeeze Risk"
    if side == "long":
        if price_change > 0 and oi_change > 0:
            return "OI Momentum Long"
        if price_change < 0 and oi_change <= 0:
            return "Reversal Long"
        if funding < 0:
            return "Funding Tailwind Long"
        return "Long Candidate"
    if side == "short":
        if price_change < 0 and oi_change > 0:
            return "OI Breakdown Short"
        if price_change > 0 and oi_change <= 0:
            return "Reversal Short"
        if funding > 0.01 or (ls_ratio is not None and ls_ratio > 1.2):
            return "Crowding Short"
        return "Short Candidate"
    return "Watchlist"


def _setup_tone(side: str) -> str:
    if side == "long":
        return "pos"
    if side == "short":
        return "neg"
    if side in {"fade-long", "squeeze-risk"}:
        return "warn"
    return "neutral"


def _chart_priority(row: dict[str, Any], score_field: str, score: Any) -> float:
    numeric_score = abs(to_float(score) or 0.0) * (100.0 if score_field == "factor_score" else 1.0)
    quality = to_float(row.get("data_quality_score"))
    quality_multiplier = max(0.0, min(1.0, (100.0 if quality is None else quality) / 100.0))
    if row.get("is_trusted", True) is False:
        quality_multiplier *= 0.35
    return round(numeric_score * quality_multiplier, 2)


def _factor_parts(factors: dict[str, Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for name in DIRECTIONAL_FACTORS:
        value = to_float(factors.get(name))
        if value is None:
            continue
        parts.append(
            {
                "name": name,
                "label": FACTOR_LABELS.get(name, name.replace("_", " ").title()),
                "value": round(value, 4),
                "tone": _reason_tone(value),
            }
        )
    return sorted(parts, key=lambda item: abs(item["value"]), reverse=True)


def _primary_driver(factors: dict[str, Any]) -> dict[str, Any] | None:
    parts = _factor_parts(factors)
    return parts[0] if parts else None


def _reason_parts(row: dict[str, Any], side: str) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    scores = row.get("scores", {})
    factors = row.get("factors", {})

    _append_reason_metric(
        parts,
        "24h",
        row.get("price_change_24h_pct"),
        "{:+.2f}%",
        "Spot or mark price change over the last 24 hours.",
    )
    _append_reason_metric(
        parts,
        "OI 24h",
        row.get("oi_change_24h_pct"),
        "{:+.2f}%",
        "Open-interest change over the last 24 hours; rising OI means more futures positioning.",
    )
    _append_reason_metric(
        parts,
        "Funding",
        row.get("funding_rate_pct"),
        "{:+.4f}%",
        "Perpetual funding rate; positive usually means longs pay shorts, negative means shorts pay longs.",
    )
    if row.get("long_short_ratio") is not None:
        _append_reason_metric(
            parts,
            "L/S",
            row.get("long_short_ratio"),
            "{:.2f}",
            "Long/short volume ratio; above 1 leans long, below 1 leans short.",
            neutral_value=1.0,
        )
    if scores.get("factor_score") is not None:
        _append_reason_metric(
            parts,
            "Factor",
            scores.get("factor_score"),
            "{:+.2f}",
            "Weighted directional model score before watchlist-specific ranking.",
        )

    strongest = sorted(
        ((name, value) for name, value in factors.items() if name in DIRECTIONAL_FACTORS),
        key=lambda item: abs(item[1]),
        reverse=True,
    )[:2]
    for name, value in strongest:
        if abs(value) >= 0.5:
            parts.append(
                {
                    "kind": "driver",
                    "label": FACTOR_LABELS.get(name, name.replace("_", " ").title()),
                    "value": f"{float(value):+.2f}",
                    "tone": _reason_tone(float(value)),
                    "help": "Normalized factor driver. Larger absolute values contributed more to the setup read.",
                }
            )

    if side == "fade-long":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "long fade",
                "tone": "warn",
                "help": "Crowded-long watchlist: useful for fade ideas, not automatic shorts.",
            }
        )
    if side == "squeeze-risk":
        parts.append(
            {
                "kind": "context",
                "label": "Crowding",
                "value": "short squeeze",
                "tone": "warn",
                "help": "Crowded-short watchlist: useful for squeeze-risk review, not automatic longs.",
            }
        )

    quality_flags = row.get("data_quality_flags") or []
    if quality_flags:
        parts.append(
            {
                "kind": "quality",
                "label": "Excluded",
                "value": ", ".join(str(flag) for flag in quality_flags),
                "tone": "bad",
                "help": "This row failed sanity checks and is excluded from ranking.",
            }
        )

    return parts


def _append_reason_metric(
    parts: list[dict[str, Any]],
    label: str,
    value: Any,
    template: str,
    help_text: str,
    neutral_value: float = 0.0,
) -> None:
    numeric = to_float(value)
    if numeric is None:
        return
    parts.append(
        {
            "kind": "metric",
            "label": label,
            "value": template.format(numeric),
            "tone": _reason_tone(numeric - neutral_value),
            "help": help_text,
        }
    )


def _reason_tone(value: float) -> str:
    if value > 0:
        return "pos"
    if value < 0:
        return "neg"
    return "neutral"


def _quality_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    flagged = [row for row in rows if row.get("data_quality_flags")]
    trusted = sum(1 for row in rows if row.get("is_trusted", True))
    return {
        "trusted_count": trusted,
        "excluded_count": len(rows) - trusted,
        "flagged_count": len(flagged),
        "flagged_rows": [
            {
                "symbol": row.get("symbol"),
                "data_source": row.get("data_source"),
                "price_change_24h_pct": row.get("price_change_24h_pct"),
                "oi_change_24h_pct": row.get("oi_change_24h_pct"),
                "flags": row.get("data_quality_flags", []),
            }
            for row in flagged[:20]
        ],
    }


def _is_crowded_long(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3)


def _is_crowded_short(row: dict[str, Any]) -> bool:
    funding = row.get("funding_rate_pct") or 0.0
    ls_ratio = row.get("long_short_ratio")
    return funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8)


def _loads_json(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def latest_run_age_seconds(db_path: Path) -> float | None:
    if not db_path.exists():
        return None
    with connect(db_path) as conn:
        row = conn.execute("SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1").fetchone()
    if row is None:
        return None
    try:
        generated_at = datetime.fromisoformat(row["generated_at"])
    except ValueError:
        return None
    if generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(generated_at.tzinfo) - generated_at).total_seconds())


def start_auto_refresh(runtime: RefreshRuntime) -> None:
    seconds = runtime.settings.auto_refresh_seconds
    if seconds <= 0:
        return

    def loop() -> None:
        while True:
            age = latest_run_age_seconds(runtime.settings.db_path)
            if age is None or age >= seconds:
                runtime.refresh("auto")
            time.sleep(max(60, min(seconds, 1800)))

    threading.Thread(target=loop, daemon=True).start()


class DashboardHandler(BaseHTTPRequestHandler):
    settings: DashboardSettings
    runtime: RefreshRuntime

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(DASHBOARD_HTML)
            return
        if parsed.path == "/health":
            self._send_json(
                {
                    "status": "ok",
                    "database_exists": self.settings.db_path.exists(),
                    "refresh": self.runtime.status,
                }
            )
            return
        if parsed.path == "/api/dashboard":
            params = parse_qs(parsed.query)
            run_id = params.get("run_id", [None])[0]
            payload = build_dashboard_payload(self.settings.db_path, run_id=run_id, limit=self.settings.limit)
            payload["refresh_status"] = self.runtime.status
            self._send_json(payload)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/refresh":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self._refresh_allowed():
            self._send_json({"status": "forbidden", "reason": "refresh token required"}, HTTPStatus.FORBIDDEN)
            return
        self._send_json(self.runtime.refresh_async("manual"), HTTPStatus.ACCEPTED)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        print("%s - %s" % (self.address_string(), format % args))

    def _refresh_allowed(self) -> bool:
        token = self.settings.refresh_token
        if not token:
            return False
        supplied = self.headers.get("X-Refresh-Token", "")
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            supplied = auth.removeprefix("Bearer ").strip()
        return supplied == token

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class DashboardServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def server_bind(self) -> None:
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        self.server_name = str(self.server_address[0])
        self.server_port = int(self.server_address[1])


def serve() -> None:
    settings = settings_from_env()
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    settings.report_dir.mkdir(parents=True, exist_ok=True)
    runtime = RefreshRuntime(settings)
    start_auto_refresh(runtime)

    handler = type(
        "ConfiguredDashboardHandler",
        (DashboardHandler,),
        {"settings": settings, "runtime": runtime},
    )
    server = DashboardServer((settings.host, settings.port), handler)
    print(f"crypto dashboard listening on {settings.host}:{settings.port}", flush=True)
    server.serve_forever()


DASHBOARD_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crypto Dashboard</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --ink: #171a1f;
      --muted: #657084;
      --line: #dbe1ea;
      --teal: #0f766e;
      --green: #15803d;
      --red: #b42318;
      --amber: #b7791f;
      --blue: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .shell {
      width: min(1480px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 22px 0 34px;
    }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.1; }
    .subline { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    select, button {
      height: 36px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 8px;
      padding: 0 10px;
      font: inherit;
      font-size: 13px;
    }
    button { cursor: pointer; font-weight: 650; }
    button:hover { border-color: #aeb8c7; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { min-height: 86px; padding: 12px; }
    .label { color: var(--muted); font-size: 12px; line-height: 1.2; }
    .value { font-size: 23px; font-weight: 760; margin-top: 8px; line-height: 1.15; word-break: break-word; }
    .value.small { font-size: 18px; }
    .good { color: var(--green); }
    .bad { color: var(--red); }
    .warn { color: var(--amber); }
    .accent { color: var(--teal); }
    .panel { overflow: hidden; margin-bottom: 12px; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 42px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    h2 { margin: 0; font-size: 14px; }
    .count { color: var(--muted); font-size: 12px; }
    .symbol-link {
      color: var(--ink);
      font-size: 13px;
      font-weight: 760;
      text-decoration: none;
    }
    .symbol-link:hover { color: var(--blue); text-decoration: underline; text-underline-offset: 3px; }
    .tag, .source-tag, .status-pill, .quality-flag-chip {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 700;
    }
    .tag {
      background: #edf7f5;
      color: var(--teal);
    }
    .source-stack { display: flex; justify-content: flex-end; gap: 4px; flex-wrap: wrap; }
    .source-tag { max-width: 100%; background: #eef4ff; color: var(--blue); }
    .source-tag:nth-child(2n) { background: #edf7f5; color: var(--teal); }
    .reason-head { display: inline-flex; align-items: center; gap: 6px; }
    .help-tip {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border: 1px solid #b8c2d1;
      border-radius: 999px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
      cursor: help;
      outline: none;
    }
    .tooltip-popover {
      position: fixed;
      z-index: 1000;
      max-width: min(360px, calc(100vw - 32px));
      padding: 10px 11px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      background: #111827;
      color: #f8fafc;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.45;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.22);
      pointer-events: none;
    }
    .reason-stack { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; max-width: 100%; }
    .reason-part {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      max-width: 100%;
      min-height: 23px;
      padding: 2px 7px;
      border: 1px solid #d9e2ec;
      border-radius: 6px;
      background: #f8fafc;
      line-height: 1.35;
    }
    .reason-part span { color: var(--muted); font-size: 11px; }
    .reason-part strong { min-width: 0; overflow-wrap: anywhere; color: #253044; font-size: 12px; font-weight: 760; }
    .reason-part.pos strong { color: var(--green); }
    .reason-part.neg strong { color: var(--red); }
    .reason-part.warn strong { color: var(--amber); }
    .reason-part.bad strong { color: var(--red); }
    .reason-part.quality { flex-basis: 100%; border-style: dashed; background: #fff7ed; }
    .provider-list { padding: 10px 12px 12px; display: grid; gap: 8px; }
    .provider-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      min-height: 30px;
      font-size: 13px;
    }
    .provider-row strong { min-width: 0; overflow-wrap: anywhere; }
    .status-pill { height: 24px; background: #ecfdf3; color: var(--green); }
    .status-pill.warn { background: #fff7ed; color: var(--amber); }
    .status-pill.bad { background: #fef3f2; color: var(--red); }
    .provider-count { color: var(--muted); font-size: 12px; text-align: right; min-width: 38px; }
    .list { padding: 10px 12px 12px; display: grid; gap: 8px; }
    .list-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
    .list-row span:last-child { color: var(--muted); text-align: right; }
    .quality-flags { padding: 10px 12px 12px; display: grid; gap: 10px; }
    .quality-card {
      display: grid;
      gap: 7px;
      padding: 9px;
      border: 1px solid #f2d6c4;
      border-radius: 8px;
      background: #fffaf5;
    }
    .quality-card-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      font-size: 13px;
    }
    .quality-card-head span { color: var(--muted); font-size: 12px; text-align: right; }
    .quality-flag-list { display: flex; flex-wrap: wrap; gap: 5px; }
    .quality-flag-chip {
      height: auto;
      min-height: 24px;
      border-radius: 6px;
      background: #fff;
      border: 1px solid #f0c9b2;
      color: #7c2d12;
      line-height: 1.25;
      white-space: normal;
    }
    .quality-flag-chip.bad { border-color: #f3b6b0; color: var(--red); }
    .quality-flag-chip.warn { border-color: #f2d08d; color: var(--amber); }
    .empty { padding: 28px 12px; color: var(--muted); text-align: center; }
    .dashboard-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      gap: 12px;
      align-items: start;
    }
    .watch-panel { overflow: visible; }
    .watch-controls {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    .watch-tabs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      padding: 10px 12px 0;
    }
    .tab-btn {
      height: 30px;
      border-radius: 999px;
      padding: 0 10px;
      border-color: #d8e0eb;
      background: #f8fafc;
      color: #344054;
      font-size: 12px;
    }
    .tab-btn.active { background: #eaf1ff; border-color: #b8cdfc; color: var(--blue); }
    .filter-input, .filter-select {
      height: 32px;
      min-width: 132px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 0 9px;
      font: inherit;
      font-size: 12px;
    }
    .filter-input { min-width: 180px; }
    .filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 32px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: #344054;
      background: #fff;
      font-size: 12px;
      white-space: nowrap;
    }
    .filter-toggle input { margin: 0; }
    .watch-table { width: 100%; overflow: hidden; }
    .watch-head, .watch-row {
      display: grid;
      grid-template-columns: minmax(96px, 1.05fr) minmax(130px, 1.25fr) minmax(74px, .65fr) minmax(44px, .4fr) minmax(62px, .55fr) minmax(70px, .6fr) minmax(76px, .68fr) minmax(50px, .45fr) minmax(84px, .78fr) minmax(96px, .82fr) minmax(84px, .78fr);
      gap: 8px;
      align-items: center;
    }
    .watch-head {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 9px 12px;
      border-bottom: 1px solid #edf1f6;
      background: #fbfcfe;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-align: right;
    }
    .watch-head div:first-child, .watch-head div:nth-child(2) { text-align: left; }
    .watch-row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid #edf1f6;
      background: #fff;
      padding: 10px 12px;
      color: var(--ink);
      font: inherit;
      text-align: right;
      cursor: pointer;
    }
    .watch-row:hover, .watch-row.active { background: #f8fafc; }
    .watch-row.active { box-shadow: inset 3px 0 0 var(--blue); }
    .watch-cell { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
    .watch-cell.left { text-align: left; }
    .watch-symbol { display: grid; gap: 2px; }
    .driver-line { color: var(--muted); font-size: 11px; }
    .setup-badge {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid #d9e2ec;
      background: #f8fafc;
      color: #344054;
      font-size: 11px;
      font-weight: 760;
      line-height: 1.25;
      text-align: left;
    }
    .setup-badge.pos { border-color: #bbf7d0; background: #f0fdf4; color: var(--green); }
    .setup-badge.neg { border-color: #fecaca; background: #fff1f2; color: var(--red); }
    .setup-badge.warn { border-color: #fde68a; background: #fffbeb; color: var(--amber); }
    .quality-badge {
      display: inline-flex;
      justify-content: center;
      min-width: 36px;
      border-radius: 999px;
      padding: 3px 7px;
      background: #ecfdf3;
      color: var(--green);
      font-size: 11px;
      font-weight: 800;
    }
    .quality-badge.warn { background: #fff7ed; color: var(--amber); }
    .quality-badge.bad { background: #fef3f2; color: var(--red); }
    .sparkline {
      display: block;
      width: 92px;
      height: 28px;
      margin-left: auto;
    }
    .sparkline polyline { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .sparkline polyline.good { stroke: var(--green); }
    .sparkline polyline.bad { stroke: var(--red); }
    .sparkline polyline.neutral { stroke: #64748b; }
    .sparkline .axis { stroke: #dbe1ea; stroke-width: 1; }
    .detail-rail {
      display: grid;
      gap: 12px;
      position: sticky;
      top: 12px;
    }
    .detail-body { padding: 12px; display: grid; gap: 12px; }
    .detail-title {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }
    .detail-symbol { font-size: 20px; font-weight: 800; line-height: 1.1; }
    .detail-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .detail-link {
      display: inline-flex;
      align-items: center;
      height: 28px;
      border: 1px solid #cbd5e1;
      border-radius: 7px;
      padding: 0 8px;
      color: var(--blue);
      text-decoration: none;
      font-size: 12px;
      font-weight: 760;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .detail-metric {
      min-width: 0;
      border: 1px solid #edf1f6;
      border-radius: 8px;
      padding: 8px;
      background: #fbfcfe;
    }
    .detail-metric strong {
      display: block;
      margin-top: 4px;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .factor-list { display: grid; gap: 8px; }
    .factor-row {
      display: grid;
      grid-template-columns: minmax(90px, 1fr) minmax(0, 1.2fr) 48px;
      gap: 8px;
      align-items: center;
      font-size: 12px;
    }
    .factor-track {
      height: 8px;
      border-radius: 999px;
      background: #eef2f7;
      overflow: hidden;
    }
    .factor-fill { height: 100%; border-radius: 999px; background: #94a3b8; }
    .factor-fill.pos { background: var(--green); }
    .factor-fill.neg { background: var(--red); }
    .module-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .module-panel summary {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
      list-style: none;
      font-size: 13px;
      font-weight: 760;
      background: #fbfcfe;
    }
    .module-panel summary::-webkit-details-marker { display: none; }
    .module-panel summary span { color: var(--muted); font-size: 12px; font-weight: 650; }
    .provider-dots { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
    .provider-dot {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 22px;
      border-radius: 999px;
      padding: 0 7px;
      background: #ecfdf3;
      color: var(--green);
      font-size: 11px;
      font-weight: 760;
    }
    .provider-dot.warn { background: #fff7ed; color: var(--amber); }
    .provider-dot.bad { background: #fef3f2; color: var(--red); }
    .history-block { display: grid; gap: 8px; }
    .history-line {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    @media (max-width: 1100px) {
      .metrics { grid-template-columns: repeat(3, minmax(130px, 1fr)); }
      .dashboard-grid { grid-template-columns: 1fr; }
      .detail-rail { position: static; }
    }
    @media (max-width: 900px) {
      .source-stack { justify-content: flex-start; }
      .watch-head { display: none; }
      .watch-row {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        text-align: left;
      }
      .watch-cell::before {
        content: attr(data-label);
        display: block;
        margin-bottom: 2px;
        color: var(--muted);
        font-size: 11px;
      }
      .sparkline { margin-left: 0; }
    }
    @media (max-width: 680px) {
      .shell { width: min(100vw - 20px, 1480px); padding-top: 14px; }
      .topbar { flex-direction: column; align-items: stretch; }
      .actions { justify-content: stretch; }
      select, button { width: 100%; }
      .filter-input, .filter-select, .filter-toggle { width: 100%; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .value { font-size: 19px; }
      .detail-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div>
        <h1>Crypto Dashboard</h1>
        <div class="subline" id="generated">Loading latest run</div>
      </div>
      <div class="actions">
        <select id="runSelect" aria-label="Run"></select>
        <button id="reload" type="button">Reload</button>
      </div>
    </div>
    <section class="metrics" id="metrics"></section>
    <section class="dashboard-grid">
      <section class="panel watch-panel" aria-label="Watchlist workbench">
        <div class="panel-head">
          <h2>Watchlist</h2>
          <span class="count" id="watchCount">-</span>
        </div>
        <div class="watch-tabs" id="watchTabs"></div>
        <div class="watch-controls">
          <input class="filter-input" id="symbolFilter" type="search" placeholder="Filter symbol or setup" aria-label="Filter symbol or setup">
          <select class="filter-select" id="qualityFilter" aria-label="Minimum quality">
            <option value="0">Q 0+</option>
            <option value="50">Q 50+</option>
            <option value="75">Q 75+</option>
            <option value="90">Q 90+</option>
          </select>
          <select class="filter-select" id="sourceFilter" aria-label="Source">
            <option value="all">All sources</option>
          </select>
          <select class="filter-select" id="volumeFilter" aria-label="Minimum volume">
            <option value="0">Any volume</option>
            <option value="20000000">$20M+</option>
            <option value="100000000">$100M+</option>
            <option value="1000000000">$1B+</option>
          </select>
          <label class="filter-toggle"><input id="positiveOiFilter" type="checkbox"> OI &gt; 0</label>
          <label class="filter-toggle"><input id="negativeFundingFilter" type="checkbox"> Funding &lt; 0</label>
        </div>
        <div class="watch-table" id="watchTable"></div>
      </section>
      <aside class="detail-rail">
        <div class="panel" id="detailPanel"></div>
        <div id="providerPanel"></div>
        <div id="qualityPanel"></div>
        <div id="sectorPanel"></div>
        <div id="runsPanel"></div>
      </aside>
    </section>
  </main>
  <script>
    const state = { selectedRun: null, data: null, activeWatchlist: "chart_next", selectedKey: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "-").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const clsFor = (value) => Number(value || 0) > 0 ? "good" : Number(value || 0) < 0 ? "bad" : "";
    const reasonTooltip = "Read left to right: 24h price move, OI positioning change, funding, L/S crowding, weighted factor score, then the strongest normalized factor drivers. Green is positive, red is negative. Crowding and excluded notes are context flags, not automatic trade instructions.";

    function fmtNum(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toFixed(digits);
    }
    function fmtPct(value, digits = 2) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
    }
    function fmtUsd(value) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      const n = Number(value);
      const a = Math.abs(n);
      if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
      if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
      if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
      if (a >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
      return `$${n.toFixed(2)}`;
    }
    function metric(label, value, klass = "") {
      return `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${klass}">${esc(value)}</div></article>`;
    }
    function panel(title, count, body) {
      return `<div class="panel-head"><h2>${esc(title)}</h2><span class="count">${esc(count)}</span></div>${body}`;
    }
    function reasonHelp() {
      return `<span class="help-tip" tabindex="0" aria-label="${esc(reasonTooltip)}" data-tooltip="${esc(reasonTooltip)}">?</span>`;
    }
    let tooltipEl = null;
    function ensureTooltip() {
      if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "tooltip-popover";
        tooltipEl.setAttribute("role", "tooltip");
        tooltipEl.hidden = true;
        document.body.appendChild(tooltipEl);
      }
      return tooltipEl;
    }
    function showTooltip(target) {
      const text = target?.getAttribute("data-tooltip");
      if (!text) return;
      const tip = ensureTooltip();
      tip.textContent = text;
      tip.hidden = false;
      tip.style.visibility = "hidden";
      tip.style.left = "0px";
      tip.style.top = "0px";
      requestAnimationFrame(() => {
        const margin = 12;
        const targetRect = target.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const left = Math.min(
          window.innerWidth - tipRect.width - margin,
          Math.max(margin, targetRect.left + (targetRect.width / 2) - (tipRect.width / 2))
        );
        let top = targetRect.bottom + 8;
        if (top + tipRect.height + margin > window.innerHeight) {
          top = targetRect.top - tipRect.height - 8;
        }
        tip.style.left = `${Math.max(margin, left)}px`;
        tip.style.top = `${Math.max(margin, top)}px`;
        tip.style.visibility = "visible";
      });
    }
    function hideTooltip() {
      if (tooltipEl) {
        tooltipEl.style.visibility = "hidden";
        tooltipEl.hidden = true;
      }
    }
    function tooltipTarget(event) {
      return event.target instanceof Element ? event.target.closest(".help-tip") : null;
    }
    document.addEventListener("pointerover", (event) => {
      const target = tooltipTarget(event);
      if (target) showTooltip(target);
    });
    document.addEventListener("pointerout", (event) => {
      const target = tooltipTarget(event);
      if (target && !target.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener("focusin", (event) => {
      const target = tooltipTarget(event);
      if (target) showTooltip(target);
    });
    document.addEventListener("focusout", (event) => {
      if (tooltipTarget(event)) hideTooltip();
    });
    document.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);
    function fallbackReasonParts(reason) {
      return String(reason || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => ({
        label: "Note",
        value: part,
        tone: "neutral",
        kind: "metric",
      }));
    }
    function reasonView(row) {
      const parts = Array.isArray(row.reason_parts) && row.reason_parts.length ? row.reason_parts : fallbackReasonParts(row.reason);
      if (!parts.length) return "-";
      return `<div class="reason-stack" title="${esc(row.reason || "")}">${parts.map((part) => `
        <span class="reason-part ${esc(part.kind || "metric")} ${esc(part.tone || "neutral")}" title="${esc(part.help || "")}">
          <span>${esc(part.label)}</span><strong>${esc(part.value)}</strong>
        </span>
      `).join("")}</div>`;
    }
    function sourceTags(source) {
      return String(source || "-").split("+").map((part) => part.trim()).filter(Boolean).map((part) => (
        `<span class="source-tag">${esc(part)}</span>`
      )).join("");
    }
    function tradingViewSymbol(symbol) {
      const base = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return base ? `BINANCE:${base}USDT.P` : "";
    }
    function tradingViewUrl(symbol) {
      const tvSymbol = tradingViewSymbol(symbol);
      return tvSymbol ? `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}` : "#";
    }
    function symbolLink(symbol) {
      const tvSymbol = tradingViewSymbol(symbol);
      if (!tvSymbol) return esc(symbol || "-");
      return `<a class="symbol-link" href="${tradingViewUrl(symbol)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(tvSymbol)} on TradingView">${esc(symbol)}</a>`;
    }
    function rowKey(row) {
      return `${row.symbol || "-"}:${row.side || "-"}:${row.score_field || "-"}`;
    }
    function numeric(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    function qualityTone(value) {
      const q = numeric(value);
      if (q === null || q < 75) return "bad";
      if (q < 90) return "warn";
      return "";
    }
    function setupBadge(row) {
      return `<span class="setup-badge ${esc(row.setup_tone || "neutral")}">${esc(row.setup || "Watchlist")}</span>`;
    }
    function scoreText(row) {
      return `<strong>${fmtNum(row.score)}</strong><div class="driver-line">P ${fmtNum(row.priority)}</div>`;
    }
    function sourceParts(source) {
      return String(source || "-").split("+").map((part) => part.trim()).filter(Boolean);
    }
    function watchlistsFrom(data) {
      if (Array.isArray(data.watchlists) && data.watchlists.length) return data.watchlists;
      return [
        { id: "long", label: "Longs", rows: data.sections?.long || [] },
        { id: "short", label: "Shorts", rows: data.sections?.short || [] },
        { id: "squeeze_risks", label: "Squeeze Risk", rows: data.sections?.squeeze_risks || [] },
        { id: "crowded_longs", label: "Long Fades", rows: data.sections?.crowded_longs || [] },
        { id: "core", label: "Core", rows: data.sections?.core || [] },
      ];
    }
    function activeWatchlist(data) {
      const lists = watchlistsFrom(data);
      return lists.find((list) => list.id === state.activeWatchlist) || lists[0] || { id: "-", label: "Watchlist", rows: [] };
    }
    function filterValues() {
      return {
        query: ($("symbolFilter")?.value || "").trim().toLowerCase(),
        quality: Number($("qualityFilter")?.value || 0),
        source: $("sourceFilter")?.value || "all",
        volume: Number($("volumeFilter")?.value || 0),
        positiveOi: Boolean($("positiveOiFilter")?.checked),
        negativeFunding: Boolean($("negativeFundingFilter")?.checked),
      };
    }
    function rowMatches(row, filters) {
      if ((Number(row.quality || 0)) < filters.quality) return false;
      if ((Number(row.quote_volume_usd || 0)) < filters.volume) return false;
      if (filters.positiveOi && !(Number(row.oi_change_24h_pct || 0) > 0)) return false;
      if (filters.negativeFunding && !(Number(row.funding_rate_pct || 0) < 0)) return false;
      if (filters.source !== "all" && !sourceParts(row.data_source).map((part) => part.toLowerCase()).includes(filters.source)) return false;
      if (filters.query) {
        const haystack = [
          row.symbol,
          row.setup,
          row.primary_driver?.label,
          row.reason,
          row.data_source,
        ].join(" ").toLowerCase();
        if (!haystack.includes(filters.query)) return false;
      }
      return true;
    }
    function filteredRows(rows) {
      const filters = filterValues();
      return (rows || []).filter((row) => rowMatches(row, filters));
    }
    function updateSourceOptions(data) {
      const select = $("sourceFilter");
      if (!select) return;
      const current = select.value || "all";
      const sources = new Set();
      watchlistsFrom(data).forEach((list) => list.rows.forEach((row) => {
        sourceParts(row.data_source).forEach((source) => sources.add(source.toLowerCase()));
      }));
      select.innerHTML = `<option value="all">All sources</option>${Array.from(sources).sort().map((source) => (
        `<option value="${esc(source)}">${esc(source)}</option>`
      )).join("")}`;
      select.value = sources.has(current) ? current : "all";
    }
    function providerDots(providers) {
      const entries = Object.entries(providers || {});
      if (!entries.length) return "-";
      return `<div class="provider-dots">${entries.map(([name, details]) => {
        const status = String(details.status || "-");
        const tone = status === "ok" ? "" : status === "skipped" || status === "disabled" ? "warn" : "bad";
        return `<span class="provider-dot ${tone}" title="${esc(status)}${details.rows === undefined ? "" : ` / ${esc(details.rows)} rows`}">${esc(name)}</span>`;
      }).join("")}</div>`;
    }
    function metricCard(label, body, klass = "") {
      return `<article class="metric"><div class="label">${esc(label)}</div><div class="value ${klass}">${body}</div></article>`;
    }
    function renderTabs(data) {
      const lists = watchlistsFrom(data);
      if (!lists.some((list) => list.id === state.activeWatchlist)) {
        state.activeWatchlist = lists[0]?.id || "chart_next";
      }
      $("watchTabs").innerHTML = lists.map((list) => {
        const active = list.id === state.activeWatchlist ? " active" : "";
        return `<button class="tab-btn${active}" type="button" data-tab="${esc(list.id)}">${esc(list.label)} <span>${esc(list.rows.length)}</span></button>`;
      }).join("");
    }
    function sparkline(points, key) {
      const values = (points || []).map((point) => numeric(point[key])).filter((value) => value !== null);
      if (values.length < 2) return `<span class="driver-line">Need history</span>`;
      const width = 92;
      const height = 28;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const span = max - min || 1;
      const coords = values.map((value, index) => {
        const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
        const y = height - ((value - min) / span) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const tone = values[values.length - 1] > values[0] ? "good" : values[values.length - 1] < values[0] ? "bad" : "neutral";
      return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="axis" x1="0" y1="${height - 2}" x2="${width}" y2="${height - 2}"></line><polyline class="${tone}" points="${coords}"></polyline></svg>`;
    }
    function renderWatchTable(data) {
      const list = activeWatchlist(data);
      const rows = filteredRows(list.rows);
      const selectedStillVisible = rows.some((row) => rowKey(row) === state.selectedKey);
      if (!selectedStillVisible) state.selectedKey = rows[0] ? rowKey(rows[0]) : null;
      $("watchCount").textContent = `${rows.length} / ${list.rows.length}`;
      if (!rows.length) {
        $("watchTable").innerHTML = `<div class="empty">No rows match the current filters</div>`;
        renderDetail(null);
        return;
      }
      $("watchTable").innerHTML = `<div class="watch-head">
        <div>Symbol</div><div>Setup</div><div>Score</div><div>Q</div><div>24h</div><div>OI 24h</div><div>Funding</div><div>L/S</div><div>Volume</div><div>Trend</div><div>Source</div>
      </div>${rows.map((row) => {
        const key = rowKey(row);
        const active = key === state.selectedKey ? " active" : "";
        return `<div class="watch-row${active}" role="button" tabindex="0" data-key="${esc(key)}">
          <div class="watch-cell left watch-symbol" data-label="Symbol">${symbolLink(row.symbol)}<span class="driver-line">${esc(row.primary_driver?.label || row.side || "-")}</span></div>
          <div class="watch-cell left" data-label="Setup">${setupBadge(row)}</div>
          <div class="watch-cell" data-label="Score">${scoreText(row)}</div>
          <div class="watch-cell" data-label="Q"><span class="quality-badge ${qualityTone(row.quality)}">${esc(row.quality ?? "-")}</span></div>
          <div class="watch-cell ${clsFor(row.price_change_24h_pct)}" data-label="24h">${fmtPct(row.price_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.oi_change_24h_pct)}" data-label="OI 24h">${fmtPct(row.oi_change_24h_pct)}</div>
          <div class="watch-cell ${clsFor(row.funding_rate_pct)}" data-label="Funding">${fmtPct(row.funding_rate_pct, 4)}</div>
          <div class="watch-cell" data-label="L/S">${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</div>
          <div class="watch-cell" data-label="Volume">${fmtUsd(row.quote_volume_usd)}</div>
          <div class="watch-cell" data-label="Trend">${sparkline(row.history, row.score_field || "factor_score")}</div>
          <div class="watch-cell" data-label="Source"><div class="source-stack">${sourceTags(row.data_source)}</div></div>
        </div>`;
      }).join("")}`;
      renderDetail(rows.find((row) => rowKey(row) === state.selectedKey) || rows[0]);
    }
    function factorBars(row) {
      const parts = row?.factor_parts || [];
      if (!parts.length) return `<div class="empty">No factor data</div>`;
      const maxAbs = Math.max(...parts.map((part) => Math.abs(Number(part.value || 0))), 1);
      return `<div class="factor-list">${parts.map((part) => {
        const width = Math.round((Math.abs(Number(part.value || 0)) / maxAbs) * 100);
        return `<div class="factor-row">
          <span>${esc(part.label)}</span>
          <span class="factor-track"><span class="factor-fill ${esc(part.tone || "neutral")}" style="width:${width}%"></span></span>
          <strong class="${part.value > 0 ? "good" : part.value < 0 ? "bad" : ""}">${fmtNum(part.value, 2)}</strong>
        </div>`;
      }).join("")}</div>`;
    }
    function historyBlock(row) {
      if (!row || !Array.isArray(row.history) || row.history.length < 2) {
        return `<div class="driver-line">More saved runs needed for multi-point trend lines.</div>`;
      }
      return `<div class="history-block">
        <div class="history-line"><span>Score</span>${sparkline(row.history, row.score_field || "factor_score")}</div>
        <div class="history-line"><span>OI 24h</span>${sparkline(row.history, "oi_change_24h_pct")}</div>
        <div class="history-line"><span>Funding</span>${sparkline(row.history, "funding_rate_pct")}</div>
      </div>`;
    }
    function renderDetail(row) {
      if (!row) {
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="empty">Select a watchlist row</div>`);
        return;
      }
      const flags = row.data_quality_flags || [];
      $("detailPanel").innerHTML = panel("Selected Coin", esc(row.setup || ""), `<div class="detail-body">
        <div class="detail-title">
          <div>
            <div class="detail-symbol">${symbolLink(row.symbol)}</div>
            <div class="driver-line">${esc(row.primary_driver?.label || "No dominant driver")} / ${esc(row.side || "-")}</div>
          </div>
          <div class="detail-actions">
            <a class="detail-link" href="${tradingViewUrl(row.symbol)}" target="_blank" rel="noopener noreferrer">TradingView</a>
          </div>
        </div>
        <div>${setupBadge(row)}</div>
        <div class="detail-grid">
          <div class="detail-metric"><span class="label">Score / Priority</span><strong>${fmtNum(row.score)} / ${fmtNum(row.priority)}</strong></div>
          <div class="detail-metric"><span class="label">Quality</span><strong class="${qualityTone(row.quality)}">${esc(row.quality ?? "-")}</strong></div>
          <div class="detail-metric"><span class="label">24h / OI</span><strong><span class="${clsFor(row.price_change_24h_pct)}">${fmtPct(row.price_change_24h_pct)}</span> / <span class="${clsFor(row.oi_change_24h_pct)}">${fmtPct(row.oi_change_24h_pct)}</span></strong></div>
          <div class="detail-metric"><span class="label">Funding / L/S</span><strong><span class="${clsFor(row.funding_rate_pct)}">${fmtPct(row.funding_rate_pct, 4)}</span> / ${row.long_short_ratio == null ? "-" : fmtNum(row.long_short_ratio)}</strong></div>
          <div class="detail-metric"><span class="label">Volume</span><strong>${fmtUsd(row.quote_volume_usd)}</strong></div>
          <div class="detail-metric"><span class="label">Open Interest</span><strong>${fmtUsd(row.open_interest_usd)}</strong></div>
        </div>
        <div class="label">Reason ${reasonHelp()}</div>
        ${reasonView(row)}
        <div class="label">Factor Breakdown</div>
        ${factorBars(row)}
        <div class="label">History</div>
        ${historyBlock(row)}
        ${flags.length ? `<div class="quality-flag-list">${qualityFlagView(flags)}</div>` : ""}
      </div>`);
    }
    function providerList(providers) {
      const entries = Object.entries(providers || {});
      if (entries.length === 0) return `<div class="empty">No providers</div>`;
      return `<div class="provider-list">${entries.map(([name, details]) => {
        const providerStatus = String(details.status || "-");
        const tone = providerStatus === "ok" ? "" : providerStatus === "skipped" || providerStatus === "disabled" ? "warn" : "bad";
        return `
        <div class="provider-row">
          <strong>${esc(name)}</strong>
          <span class="status-pill ${tone}">${esc(providerStatus)}</span>
          <span class="provider-count">${details.rows === undefined ? "-" : esc(details.rows)}</span>
        </div>`;
      }).join("")}</div>`;
    }
    function qualityFlagChip(flag) {
      const [rawLabel, rawValue = ""] = String(flag || "").split(":");
      const labels = {
        extreme_24h_price_change: "Price 24h",
        extreme_24h_oi_change: "OI 24h",
        extreme_24h_volume_change: "Volume 24h",
        extreme_funding_rate: "Funding",
        thin_coinglass_exchange_coverage: "Thin coverage",
        price_deviates_from_binance: "Price vs Binance",
        price_deviates_from_index: "Price vs Index",
        stale_low_quote_volume: "Low volume",
        invalid_price: "Invalid price",
        invalid_open_interest: "Invalid OI",
        weird_symbol: "Symbol",
        weird_contract_symbol: "Contract",
      };
      const label = labels[rawLabel] || rawLabel.replace(/_/g, " ");
      const tone = rawLabel.includes("extreme") || rawLabel.includes("invalid") || rawLabel.includes("deviates") ? "bad" : "warn";
      return `<span class="quality-flag-chip ${tone}" title="${esc(flag)}">${esc(label)}${rawValue ? ` <strong>${esc(rawValue)}</strong>` : ""}</span>`;
    }
    function qualityFlagView(flags) {
      return (flags || []).map(qualityFlagChip).join("");
    }
    function qualityBlock(quality) {
      const flags = quality?.flagged_rows || [];
      if (flags.length === 0) return `<div class="quality-flags"><div class="quality-card"><div class="quality-card-head"><strong>All clear</strong><span>sanity checks passed</span></div></div></div>`;
      return `<div class="quality-flags">${flags.map((row) => `
        <div class="quality-card">
          <div class="quality-card-head">
            <strong>${esc(row.symbol)}</strong>
            <span>${fmtPct(row.price_change_24h_pct)} / OI ${fmtPct(row.oi_change_24h_pct)}</span>
          </div>
          <div class="quality-flag-list">${qualityFlagView(row.flags)}</div>
        </div>
      `).join("")}</div>`;
    }
    function modulePanel(title, subtitle, body, open = false) {
      return `<details class="module-panel" ${open ? "open" : ""}>
        <summary><strong>${esc(title)}</strong><span>${esc(subtitle || "")}</span></summary>
        ${body}
      </details>`;
    }
    function providerHasIssue(providers) {
      return Object.values(providers || {}).some((details) => {
        const status = String(details.status || "-");
        return status !== "ok";
      });
    }
    function renderSideModules(data) {
      const providerIssue = providerHasIssue(data.provider_status);
      const providerEntries = Object.keys(data.provider_status || {}).length;
      $("providerPanel").innerHTML = modulePanel(
        "Providers",
        providerIssue ? "needs attention" : `${providerEntries} ok`,
        providerList(data.provider_status),
        providerIssue
      );
      const excluded = data.quality?.excluded_count || 0;
      $("qualityPanel").innerHTML = modulePanel(
        "Data Quality",
        `${excluded} excluded`,
        qualityBlock(data.quality),
        excluded > 0
      );
      $("sectorPanel").innerHTML = modulePanel("Sector Rotation", "leaders / laggards", sectorList(data.market_context || {}), true);
      $("runsPanel").innerHTML = modulePanel("Recent Runs", `${(data.runs || []).length} loaded`, runsBlock(data.runs), false);
    }
    function sectorList(context) {
      const leaders = context?.categories?.leaders || [];
      const laggards = context?.categories?.laggards || [];
      const line = (item) => `<div class="list-row"><strong>${esc(item.name || item.id)}</strong><span class="${clsFor(item.market_cap_change_24h_pct)}">${fmtPct(item.market_cap_change_24h_pct)}</span></div>`;
      return `<div class="list">
        <div class="label">Leaders</div>${leaders.slice(0, 5).map(line).join("") || `<div class="empty">No leaders</div>`}
        <div class="label">Laggards</div>${laggards.slice(0, 5).map(line).join("") || `<div class="empty">No laggards</div>`}
      </div>`;
    }
    function runsBlock(runs) {
      if (!runs || runs.length === 0) return `<div class="empty">No runs</div>`;
      return `<div class="list">${runs.slice(0, 12).map((run) => `
        <div class="list-row"><strong>${esc(run.generated_at)}</strong><span>${esc(run.bias)} / ${esc(run.coinglass_status)} / ${esc(run.row_count)} rows</span></div>
      `).join("")}</div>`;
    }
    function runOptions(runs, selected) {
      $("runSelect").innerHTML = (runs || []).map((run) => `<option value="${esc(run.run_id)}" ${run.run_id === selected ? "selected" : ""}>${esc(run.generated_at)}</option>`).join("");
    }
    async function load(runId = null) {
      const url = runId ? `/api/dashboard?run_id=${encodeURIComponent(runId)}` : "/api/dashboard";
      const data = await fetch(url, { cache: "no-store" }).then((res) => res.json());
      if (data.status !== "ok") {
        $("generated").textContent = "No saved screener runs";
        $("metrics").innerHTML = metric("Database", data.database || "-");
        $("watchTabs").innerHTML = "";
        $("watchCount").textContent = "-";
        $("watchTable").innerHTML = `<div class="empty">No data</div>`;
        $("detailPanel").innerHTML = panel("Selected Coin", "", `<div class="empty">No data</div>`);
        ["providerPanel","qualityPanel","sectorPanel","runsPanel"].forEach((id) => $(id).innerHTML = modulePanel(id, "", `<div class="empty">No data</div>`));
        return;
      }
      state.selectedRun = data.run.run_id;
      state.data = data;
      runOptions(data.runs, data.run.run_id);
      updateSourceOptions(data);
      const c = data.market_context || {};
      const r = data.regime || {};
      $("generated").textContent = `${data.run.generated_at} / ${data.run.row_count} symbols`;
      $("metrics").innerHTML = [
        metric("Bias", r.bias || "unknown", "accent"),
        metric("Factor Regime", r.label || "unknown", "small"),
        metric("Market Cap 24h", fmtPct(c.market_cap_change_24h_pct), clsFor(c.market_cap_change_24h_pct)),
        metric("BTC Dominance", fmtPct(c.btc_dominance_pct, 2).replace("+", "")),
        metric("Trusted / Excluded", `${data.quality.trusted_count} / ${data.quality.excluded_count}`, data.quality.excluded_count ? "warn" : "good"),
        metricCard("Providers", providerDots(data.provider_status), "small"),
      ].join("");
      renderTabs(data);
      renderWatchTable(data);
      renderSideModules(data);
    }
    $("reload").addEventListener("click", () => load(state.selectedRun));
    $("runSelect").addEventListener("change", (event) => {
      state.selectedKey = null;
      load(event.target.value);
    });
    $("watchTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (!button || !state.data) return;
      state.activeWatchlist = button.dataset.tab;
      state.selectedKey = null;
      renderTabs(state.data);
      renderWatchTable(state.data);
    });
    $("watchTable").addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      const row = event.target.closest("[data-key]");
      if (!row || !state.data) return;
      state.selectedKey = row.dataset.key;
      renderWatchTable(state.data);
    });
    $("watchTable").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-key]");
      if (!row || !state.data) return;
      event.preventDefault();
      state.selectedKey = row.dataset.key;
      renderWatchTable(state.data);
    });
    ["symbolFilter", "qualityFilter", "sourceFilter", "volumeFilter", "positiveOiFilter", "negativeFundingFilter"].forEach((id) => {
      $(id).addEventListener("input", () => {
        if (state.data) renderWatchTable(state.data);
      });
      $(id).addEventListener("change", () => {
        if (state.data) renderWatchTable(state.data);
      });
    });
    load().catch((error) => {
      $("generated").textContent = "Dashboard error";
      $("metrics").innerHTML = metric("Error", error.message || String(error), "bad");
    });
  </script>
</body>
</html>
"""


def main() -> int:
    serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
