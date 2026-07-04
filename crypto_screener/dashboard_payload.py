from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .factors import DIRECTIONAL_FACTORS, reason_for
from .report import top_by
from .scoring import clamp, to_float
from .storage import connect


FACTOR_LABELS = {
    "momentum_24h": "Momentum",
    "reversal_1d": "Reversal",
    "oi_price_signal": "OI/Price",
    "funding_rate_contrarian": "Funding",
    "ls_ratio_contrarian": "L/S",
    "liquidation_imbalance": "Liquidations",
    "btc_relative_strength": "BTC Relative",
    "technical_trend_4h": "4h Trend",
    "technical_momentum_4h": "4h Momentum",
    "oi_acceleration_signal": "OI Acceleration",
    "funding_persistence_contrarian": "Funding Persistence",
    "taker_flow_24h": "Taker Flow",
    "liquidation_pressure_24h": "Liq Pressure",
}

WATCHLIST_LABELS = {
    "chart_next": "Top Setups",
    "regime_fit": "Regime Fit",
    "long": "Longs",
    "short": "Shorts",
    "squeeze_risks": "Squeeze Risk",
    "crowded_longs": "Long Fades",
    "core": "Core",
}

SYMBOL_SECTORS = {
    "BTC": "BTC / Store of Value",
    "ETH": "Majors / Smart Contract",
    "SOL": "Majors / Smart Contract",
    "BNB": "Exchange / L1",
    "XRP": "Payments",
    "BCH": "Payments",
    "LTC": "Payments",
    "XLM": "Payments",
    "ADA": "L1 / L0",
    "AVAX": "L1 / L0",
    "DOT": "L1 / L0",
    "ATOM": "L1 / L0",
    "NEAR": "L1 / L0",
    "APT": "L1 / L0",
    "SUI": "L1 / L0",
    "SEI": "L1 / L0",
    "TON": "L1 / L0",
    "ICP": "L1 / L0",
    "KAS": "L1 / L0",
    "ARB": "Layer 2",
    "OP": "Layer 2",
    "STRK": "Layer 2",
    "ZK": "Layer 2",
    "MANTA": "Layer 2",
    "METIS": "Layer 2",
    "MATIC": "Layer 2",
    "POL": "Layer 2",
    "LINK": "Oracle / Data",
    "PYTH": "Oracle / Data",
    "API3": "Oracle / Data",
    "AAVE": "DeFi",
    "UNI": "DeFi",
    "CRV": "DeFi",
    "COMP": "DeFi",
    "MKR": "DeFi",
    "ENA": "DeFi",
    "PENDLE": "DeFi",
    "LDO": "DeFi",
    "RUNE": "DeFi",
    "INJ": "DeFi",
    "JUP": "DeFi",
    "DYDX": "Exchange / Perps",
    "HYPE": "Exchange / Perps",
    "OKB": "Exchange / Perps",
    "BGB": "Exchange / Perps",
    "TAO": "AI / Compute",
    "RENDER": "AI / Compute",
    "RNDR": "AI / Compute",
    "FET": "AI / Compute",
    "OCEAN": "AI / Compute",
    "AGIX": "AI / Compute",
    "WLD": "AI / Compute",
    "ARKM": "AI / Compute",
    "AI": "AI / Compute",
    "GRT": "AI / Compute",
    "AIOZ": "AI / Compute",
    "DOGE": "Meme",
    "SHIB": "Meme",
    "PEPE": "Meme",
    "WIF": "Meme",
    "BONK": "Meme",
    "FLOKI": "Meme",
    "MEME": "Meme",
    "BOME": "Meme",
    "TURBO": "Meme",
    "MOG": "Meme",
    "POPCAT": "Meme",
    "FARTCOIN": "Meme",
    "PENGU": "Meme",
    "IMX": "Gaming / Metaverse",
    "SAND": "Gaming / Metaverse",
    "MANA": "Gaming / Metaverse",
    "AXS": "Gaming / Metaverse",
    "GALA": "Gaming / Metaverse",
    "PIXEL": "Gaming / Metaverse",
    "APE": "Gaming / Metaverse",
    "YGG": "Gaming / Metaverse",
    "ONDO": "RWA",
    "OM": "RWA",
    "CFG": "RWA",
    "HNT": "DePIN",
    "IOTX": "DePIN",
    "AKT": "DePIN",
    "FIL": "DePIN / Storage",
    "AR": "DePIN / Storage",
    "STX": "BTC Ecosystem",
    "ORDI": "BTC Ecosystem",
    "SATS": "BTC Ecosystem",
}


def build_dashboard_payload(db_path: Path, run_id: str | None = None, limit: int = 12) -> dict[str, Any]:
    if not db_path.exists():
        return {
            "status": "empty",
            "database": str(db_path),
            "runs": [],
            "refresh_status": None,
        }

    conn = connect(db_path)
    try:
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
    finally:
        conn.close()

    context = _loads_json(selected["context_json"], {})
    provider_status = _loads_json(selected["provider_status_json"], {})
    regime = _loads_json(selected["regime_json"], {})
    factor_weights = _loads_json(selected["factor_weights_json"], {})
    sections = _sections(rows, limit, history, regime)
    sector_breadth = _sector_breadth(rows)
    freshness = _freshness_summary(selected["generated_at"])

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
        "validation": _validation_summary(factor_weights.get("validation", {}), rows, sections),
        "freshness": freshness,
        "sector_breadth": sector_breadth,
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
    regime: dict[str, Any] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    history = history or {}
    regime = regime or {}
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
        "regime_fit": _regime_fit_rows(rows, limit, history, regime),
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
        ("regime_fit", sections.get("regime_fit", [])),
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
    for key in ("regime_fit", "long", "short", "squeeze_risks", "crowded_longs", "core"):
        for row in sections.get(key, []):
            symbol = str(row.get("symbol") or "")
            current = candidates.get(symbol)
            if current is None or (row.get("priority") or 0) > (current.get("priority") or 0):
                candidates[symbol] = row
    return sorted(candidates.values(), key=lambda item: item.get("priority") or 0, reverse=True)[: max(limit, 12)]


def _regime_fit_rows(
    rows: list[dict[str, Any]],
    limit: int,
    history: dict[str, list[dict[str, Any]]],
    regime: dict[str, Any],
) -> list[dict[str, Any]]:
    ranked: list[tuple[float, dict[str, Any], str]] = []
    for row in rows:
        if row.get("is_trusted", True) is False:
            continue
        score_field, side = _regime_fit_score_field(row, regime)
        factor_score = to_float(row.get("factor_score"), 0.0) or 0.0
        if side == "long" and factor_score <= 0:
            continue
        if side == "short" and factor_score >= 0:
            continue
        base_score = to_float(row.get(score_field), 0.0) or 0.0
        if base_score <= 0:
            continue
        conflict_score = to_float(row.get("signal_conflict_score"), 0.0) or 0.0
        if str(row.get("signal_conflict_label") or "") == "high-conflict" and conflict_score >= 70:
            continue
        confidence = to_float(row.get("confidence_score"), 0.0) or 0.0
        quality = to_float(row.get("data_quality_score"), 100.0) or 100.0
        regime_alignment = to_float(row.get("regime_alignment_score"), 0.0) or 0.0
        breadth_alignment = to_float(row.get("breadth_alignment_score"), 0.0) or 0.0
        fit_score = (
            base_score
            + max(0.0, regime_alignment) * 8.0
            + max(0.0, breadth_alignment) * 6.0
            + confidence * 0.18
            + quality * 0.05
            - conflict_score * 0.22
        )
        ranked.append((fit_score, row, side))

    selected: list[dict[str, Any]] = []
    for fit_score, row, side in sorted(ranked, key=lambda item: item[0], reverse=True)[:limit]:
        item = dict(row)
        item["regime_fit_score"] = round(max(0.0, fit_score), 2)
        selected.append(
            _dashboard_row(
                item,
                "regime_fit_score",
                side,
                history.get(str(row.get("symbol")), []),
            )
        )
    return selected


def _regime_fit_score_field(row: dict[str, Any], regime: dict[str, Any]) -> tuple[str, str]:
    bias = str(regime.get("bias") or "mixed")
    label = str(regime.get("label") or "mixed")
    factor_score = to_float(row.get("factor_score"), 0.0) or 0.0
    if label == "crowding-contrarian":
        crowded_score = to_float(row.get("crowded_long_score"), 0.0) or 0.0
        squeeze_score = to_float(row.get("squeeze_risk_score"), 0.0) or 0.0
        if crowded_score >= squeeze_score:
            return "crowded_long_score", "fade-long"
        return "squeeze_risk_score", "squeeze-risk"
    if bias == "risk-off":
        return "short_score", "short"
    if bias == "risk-on":
        return "long_score", "long"
    if factor_score < 0:
        return "short_score", "short"
    return "long_score", "long"


def _dashboard_row(row: dict[str, Any], score_field: str, side: str, history: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    scores = row.get("scores", {})
    factors = row.get("factors", {})
    score = row.get(score_field)
    setup = _setup_label(row, side)
    priority = _chart_priority(row, score_field, score)
    sector = _sector_for_symbol(row.get("symbol"))
    return {
        "symbol": row.get("symbol"),
        "sector": sector,
        "side": side,
        "setup": setup,
        "setup_tone": _setup_tone(side),
        "score_field": score_field,
        "score": score,
        "priority": priority,
        "confidence_score": row.get("confidence_score"),
        "quality": row.get("data_quality_score", 100),
        "primary_exchange": row.get("primary_exchange"),
        "contract_symbol": row.get("contract_symbol"),
        "price_usd": row.get("price_usd"),
        "price_change_24h_pct": row.get("price_change_24h_pct"),
        "oi_change_24h_pct": row.get("oi_change_24h_pct"),
        "funding_rate_pct": row.get("funding_rate_pct"),
        "long_short_ratio": row.get("long_short_ratio"),
        "quote_volume_usd": row.get("quote_volume_usd"),
        "open_interest_usd": row.get("open_interest_usd"),
        "technical_setup": row.get("technical_setup"),
        "technical_state": _technical_state(row),
        "signal_conflict_label": row.get("signal_conflict_label"),
        "signal_conflict_score": row.get("signal_conflict_score"),
        "signal_conflicts": row.get("signal_conflicts", []),
        "regime_alignment_score": row.get("regime_alignment_score"),
        "breadth_alignment_score": row.get("breadth_alignment_score"),
        "data_source": row.get("data_source"),
        "is_trusted": row.get("is_trusted", True),
        "data_quality_flags": row.get("data_quality_flags", []),
        "scores": {
            key: scores.get(key)
            for key in (
                "factor_score",
                "long_score",
                "short_score",
                "crowded_long_score",
                "squeeze_risk_score",
                "confidence_score",
                "signal_conflict_score",
                "regime_alignment_score",
                "breadth_alignment_score",
            )
        },
        "factor_parts": _factor_parts(factors),
        "primary_driver": _primary_driver(factors),
        "history": history or [],
        "reason": reason_for(row, side),
        "reason_parts": _reason_parts(row, side),
        "explanation": _token_explanation(row, side, setup, sector),
    }


def _token_explanation(row: dict[str, Any], side: str, setup: str, sector: str) -> dict[str, Any]:
    symbol = str(row.get("symbol") or "-")
    driver = _primary_driver(row.get("factors", {}))
    driver_text = f"{driver['label']} {driver['value']:+.2f}" if driver else "mixed factors"
    conflict_label = str(row.get("signal_conflict_label") or "unknown")
    quality_flags = row.get("data_quality_flags") or []
    funding = to_float(row.get("funding_rate_pct"), 0.0) or 0.0
    ls_ratio = to_float(row.get("long_short_ratio"))
    direction = "long" if side in {"long", "squeeze-risk"} else "short" if side in {"short", "fade-long"} else "neutral"

    read = (
        f"{symbol} is grouped as {setup} in {sector} because {driver_text} is the strongest driver, "
        f"with {conflict_label} signal conflict."
    )
    confirm = [
        "Check the TradingView chart for entry location, invalidation, and nearby liquidity.",
        "Prefer the setup only if 4h trend and momentum agree with the intended direction.",
        "Confirm BTC, market breadth, and sector tape have not flipped against the setup.",
    ]
    if direction == "long":
        confirm.append("For longs, avoid chasing after an extended impulse unless pullback structure is clean.")
    elif direction == "short":
        confirm.append("For shorts or fades, avoid pressing into obvious squeeze conditions without confirmation.")

    risks: list[str] = []
    if conflict_label not in {"aligned", "neutral", "unknown"}:
        risks.append(f"Signal conflict is {conflict_label}; size the idea as a chart-review candidate, not a blind signal.")
    if funding > 0.015 or (ls_ratio is not None and ls_ratio >= 1.3):
        risks.append("Long crowding is elevated; late longs can unwind quickly.")
    if funding < -0.015 or (ls_ratio is not None and ls_ratio <= 0.8):
        risks.append("Short crowding is elevated; squeeze risk can dominate clean bearish reads.")
    if quality_flags:
        risks.append("Data-quality flags are present; ignore the setup until the bad data clears.")
    if not risks:
        risks.append("Main risk is chart invalidation after manual review.")

    return {
        "read": read,
        "confirm": confirm[:4],
        "risk": risks[:4],
        "sector": sector,
    }


def _validation_summary(
    validation: dict[str, Any],
    rows: list[dict[str, Any]],
    sections: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    summary = dict(validation or {})
    model = dict(summary.get("model") or {})
    factors = dict(summary.get("factors") or {})
    hit_rate = to_float(model.get("hit_rate"))
    observations = int(to_float(summary.get("observations"), 0.0) or 0)
    summary["model"] = model
    summary["factors"] = factors
    summary["model_hit_rate"] = hit_rate
    summary["model_avg_forward_return_pct"] = to_float(model.get("avg_forward_return_pct"))
    summary["calibration_label"] = _calibration_label(hit_rate, observations)
    summary["best_factors"] = _rank_validation_factors(factors, reverse=True)
    summary["weakest_factors"] = _rank_validation_factors(factors, reverse=False)
    summary["conflict_buckets"] = _conflict_buckets(rows)
    summary["watchlist_counts"] = {
        key: len(value)
        for key, value in sections.items()
        if key in {"regime_fit", "long", "short", "squeeze_risks", "crowded_longs", "core"}
    }
    return summary


def _calibration_label(hit_rate: float | None, observations: int) -> str:
    if observations < 20 or hit_rate is None:
        return "learning"
    if hit_rate >= 58.0:
        return "useful"
    if hit_rate >= 50.0:
        return "neutral"
    return "weak"


def _rank_validation_factors(factors: dict[str, Any], reverse: bool) -> list[dict[str, Any]]:
    ranked: list[dict[str, Any]] = []
    for name, details in factors.items():
        if not isinstance(details, dict):
            continue
        hit_rate = to_float(details.get("hit_rate"))
        observations = int(to_float(details.get("observations"), 0.0) or 0)
        if hit_rate is None or observations <= 0:
            continue
        ranked.append(
            {
                "name": name,
                "label": FACTOR_LABELS.get(name, name.replace("_", " ").title()),
                "hit_rate": round(hit_rate, 2),
                "observations": observations,
                "avg_forward_return_pct": to_float(details.get("avg_forward_return_pct")),
            }
        )
    return sorted(ranked, key=lambda item: (item["hit_rate"], item["observations"]), reverse=reverse)[:3]


def _conflict_buckets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in rows:
        label = str(row.get("signal_conflict_label") or "unknown")
        bucket = buckets.setdefault(label, {"label": label, "count": 0, "avg_confidence": 0.0})
        bucket["count"] += 1
        bucket["avg_confidence"] += to_float(row.get("confidence_score"), 0.0) or 0.0
    result: list[dict[str, Any]] = []
    for bucket in buckets.values():
        count = bucket["count"]
        result.append(
            {
                "label": bucket["label"],
                "count": count,
                "avg_confidence": round(bucket["avg_confidence"] / count, 1) if count else None,
            }
        )
    return sorted(result, key=lambda item: item["count"], reverse=True)


def _freshness_summary(generated_at: str | None) -> dict[str, Any]:
    if not generated_at:
        return {"status": "unknown", "label": "unknown", "age_seconds": None, "age_minutes": None}
    try:
        parsed = datetime.fromisoformat(generated_at)
    except ValueError:
        return {"status": "unknown", "label": "unknown", "generated_at": generated_at, "age_seconds": None, "age_minutes": None}
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_seconds = max(0.0, (datetime.now(parsed.tzinfo) - parsed).total_seconds())
    if age_seconds <= 4 * 60 * 60:
        label = "fresh"
    elif age_seconds <= 12 * 60 * 60:
        label = "aging"
    elif age_seconds <= 24 * 60 * 60:
        label = "stale"
    else:
        label = "old"
    return {
        "status": "ok",
        "label": label,
        "generated_at": generated_at,
        "age_seconds": round(age_seconds, 0),
        "age_minutes": round(age_seconds / 60.0, 1),
        "help": "Freshness is based on the selected saved run, not live tick data.",
    }


def _sector_for_symbol(symbol: Any) -> str:
    raw = str(symbol or "").upper().replace("-", "").replace("_", "")
    if raw.startswith("1000") and len(raw) > 4:
        raw = raw[4:]
    return SYMBOL_SECTORS.get(raw, "Other")


def _sector_breadth(rows: list[dict[str, Any]]) -> dict[str, Any]:
    trusted = [row for row in rows if row.get("is_trusted", True)]
    groups: dict[str, dict[str, Any]] = {}
    for row in trusted:
        sector = _sector_for_symbol(row.get("symbol"))
        group = groups.setdefault(
            sector,
            {
                "sector": sector,
                "count": 0,
                "advancers": 0,
                "decliners": 0,
                "return_sum": 0.0,
                "return_count": 0,
                "factor_sum": 0.0,
                "factor_count": 0,
                "oi_sum": 0.0,
                "oi_count": 0,
                "symbols": [],
            },
        )
        group["count"] += 1
        symbol = row.get("symbol")
        if symbol:
            group["symbols"].append(str(symbol))
        price_change = to_float(row.get("price_change_24h_pct"))
        if price_change is not None:
            group["return_sum"] += price_change
            group["return_count"] += 1
            if price_change > 0:
                group["advancers"] += 1
            elif price_change < 0:
                group["decliners"] += 1
        factor_score = to_float(row.get("factor_score"))
        if factor_score is not None:
            group["factor_sum"] += factor_score
            group["factor_count"] += 1
        oi_change = to_float(row.get("oi_change_24h_pct"))
        if oi_change is not None:
            group["oi_sum"] += oi_change
            group["oi_count"] += 1

    if not groups:
        return {"status": "empty", "label": "unknown", "groups": []}

    formatted: list[dict[str, Any]] = []
    for group in groups.values():
        return_count = group["return_count"]
        count = group["count"]
        formatted.append(
            {
                "sector": group["sector"],
                "count": count,
                "advancer_pct": round((group["advancers"] / return_count) * 100.0, 1) if return_count else None,
                "avg_return_24h_pct": round(group["return_sum"] / return_count, 3) if return_count else None,
                "avg_factor_score": round(group["factor_sum"] / group["factor_count"], 3) if group["factor_count"] else None,
                "avg_oi_change_24h_pct": round(group["oi_sum"] / group["oi_count"], 3) if group["oi_count"] else None,
                "symbols": sorted(group["symbols"])[:8],
            }
        )
    formatted.sort(key=lambda item: (item["count"], item.get("avg_return_24h_pct") or 0.0), reverse=True)
    positive_groups = sum(1 for item in formatted if (item.get("avg_return_24h_pct") or 0.0) > 0)
    return {
        "status": "ok",
        "label": _sector_breadth_label(positive_groups, len(formatted)),
        "sample_size": len(trusted),
        "groups": formatted,
        "leaders": sorted(formatted, key=lambda item: item.get("avg_return_24h_pct") or -999.0, reverse=True)[:5],
        "laggards": sorted(formatted, key=lambda item: item.get("avg_return_24h_pct") or 999.0)[:5],
    }


def _sector_breadth_label(positive_groups: int, total_groups: int) -> str:
    if total_groups <= 0:
        return "unknown"
    ratio = positive_groups / total_groups
    if ratio >= 0.70:
        return "broad-sector-bid"
    if ratio <= 0.30:
        return "broad-sector-offer"
    return "mixed-sector-rotation"


def _history_by_symbol(conn, symbols: list[str], generated_at: str, limit: int = 16) -> dict[str, list[dict[str, Any]]]:
    unique_symbols = sorted({symbol for symbol in symbols if symbol})
    if not unique_symbols:
        return {}
    placeholders = ",".join("?" for _ in unique_symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, price_usd, factors_json, scores_json, metrics_json
        FROM factor_history
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
        item = _loads_json(db_row["metrics_json"], {})
        factors = _loads_json(db_row["factors_json"], {})
        scores = _loads_json(db_row["scores_json"], {})
        by_symbol.setdefault(symbol, []).append(
            {
                "generated_at": db_row["generated_at"],
                "price_usd": db_row["price_usd"],
                "price_change_24h_pct": item.get("price_change_24h_pct"),
                "oi_change_24h_pct": item.get("oi_change_24h_pct"),
                "funding_rate_pct": item.get("funding_rate_pct"),
                "long_short_ratio": item.get("long_short_ratio"),
                "quote_volume_usd": item.get("quote_volume_usd"),
                "confidence_score": scores.get("confidence_score") or item.get("confidence_score"),
                "technical_trend_4h": factors.get("technical_trend_4h"),
                "technical_momentum_4h": factors.get("technical_momentum_4h"),
                "rsi_14": item.get("rsi_14"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
                "signal_conflict_score": scores.get("signal_conflict_score") or item.get("signal_conflict_score"),
            }
        )
    if not any(by_symbol.values()):
        return _legacy_history_by_symbol(conn, unique_symbols, generated_at, limit)
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


def _setup_label(row: dict[str, Any], side: str) -> str:
    technical_setup = str(row.get("technical_setup") or "")
    if technical_setup and side in {"long", "short"}:
        suffix = "Long" if side == "long" else "Short"
        return f"{technical_setup} {suffix}"
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
    confidence = to_float(row.get("confidence_score"))
    confidence_multiplier = 1.0 if confidence is None else 0.65 + (clamp(confidence / 100.0) * 0.35)
    return round(numeric_score * quality_multiplier * confidence_multiplier, 2)


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
    if scores.get("confidence_score") is not None:
        _append_reason_metric(
            parts,
            "Confidence",
            scores.get("confidence_score"),
            "{:.0f}",
            "Composite setup confidence using factor strength, data quality, liquidity, and 4h technical alignment.",
            neutral_value=50.0,
        )
    if row.get("technical_setup"):
        parts.append(
            {
                "kind": "context",
                "label": "Tech",
                "value": row.get("technical_setup"),
                "tone": _technical_tone(row),
                "help": "4h CoinGlass OHLC technical state used as confirmation context.",
            }
        )
    if row.get("signal_conflict_label") and row.get("signal_conflict_label") not in {"aligned", "neutral"}:
        parts.append(
            {
                "kind": "context",
                "label": "Signals",
                "value": row.get("signal_conflict_label"),
                "tone": "warn" if row.get("signal_conflict_label") != "high-conflict" else "bad",
                "help": "Signal conflict label: highlights when technicals, derivatives, breadth, or regime disagree with the model direction.",
            }
        )
    if row.get("rsi_14") is not None:
        _append_reason_metric(
            parts,
            "RSI",
            row.get("rsi_14"),
            "{:.1f}",
            "14-period RSI on the configured CoinGlass candle interval.",
            neutral_value=50.0,
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


def _technical_state(row: dict[str, Any]) -> dict[str, Any]:
    keys = [
        "technical_interval",
        "technical_candle_count",
        "technical_close",
        "ema_20",
        "ema_50",
        "ema_200",
        "distance_ema20_pct",
        "rsi_14",
        "macd_histogram_pct",
        "atr_14_pct",
        "bb_position",
        "bb_width_pct",
        "technical_trend_score",
        "technical_momentum_score",
    ]
    state = {key: row.get(key) for key in keys if row.get(key) is not None}
    return state


def _technical_tone(row: dict[str, Any]) -> str:
    trend = to_float(row.get("technical_trend_score"))
    momentum = to_float(row.get("technical_momentum_score"))
    values = [value for value in (trend, momentum) if value is not None]
    if not values:
        return "neutral"
    avg = sum(values) / len(values)
    return _reason_tone(avg)


def _legacy_history_by_symbol(
    conn,
    symbols: list[str],
    generated_at: str,
    limit: int,
) -> dict[str, list[dict[str, Any]]]:
    placeholders = ",".join("?" for _ in symbols)
    rows = conn.execute(
        f"""
        SELECT symbol, generated_at, row_json
        FROM market_rows
        WHERE symbol IN ({placeholders})
          AND generated_at <= ?
        ORDER BY symbol ASC, generated_at DESC
        """,
        [*symbols, generated_at],
    ).fetchall()

    by_symbol: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in symbols}
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
                "confidence_score": scores.get("confidence_score"),
                "factor_score": scores.get("factor_score"),
                "long_score": scores.get("long_score"),
                "short_score": scores.get("short_score"),
                "crowded_long_score": scores.get("crowded_long_score"),
                "squeeze_risk_score": scores.get("squeeze_risk_score"),
            }
        )
    return {symbol: list(reversed(points)) for symbol, points in by_symbol.items()}


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


def latest_run_generated_at(db_path: Path) -> datetime | None:
    if not db_path.exists():
        return None
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT generated_at FROM runs ORDER BY generated_at DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    try:
        generated_at = datetime.fromisoformat(row["generated_at"])
    except ValueError:
        return None
    if generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=timezone.utc)
    return generated_at


def latest_run_age_seconds(db_path: Path) -> float | None:
    generated_at = latest_run_generated_at(db_path)
    if generated_at is None:
        return None
    return max(0.0, (datetime.now(generated_at.tzinfo) - generated_at).total_seconds())
