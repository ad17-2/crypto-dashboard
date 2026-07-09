from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from .collector import collect_market
from .factors import score_snapshot
from .models import RunPayload
from .report import now_jakarta, write_reports
from .scoring import pct_change, to_float
from .storage import load_labeled_factor_records, load_latest_regime_state, load_price_lookback, save_snapshot


def run_pipeline(
    config: dict[str, Any],
    out_dir: Path,
    save: bool = True,
    write_report_files: bool = True,
) -> tuple[dict[str, Any], dict[str, Path]]:
    generated_at = now_jakarta()
    run_id = generated_at.strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8]

    collected = collect_market(config)
    history_records = load_labeled_factor_records(config)
    lookback_hours = float(config.get("factors", {}).get("reversal_lookback_hours", 72))
    lookback_prices = load_price_lookback(config, lookback_hours)
    for row in collected["rows"]:
        current_price = to_float(row.get("price_usd"))
        past_price = lookback_prices.get(str(row.get("symbol") or ""))
        if current_price is not None and past_price is not None and past_price > 0:
            row["price_change_72h_pct"] = pct_change(past_price, current_price)
        else:
            row["price_change_72h_pct"] = None

    prior_market_state = load_latest_regime_state(config.get("storage_path", "data/crypto_screener.sqlite3"))
    scored = score_snapshot(
        collected["rows"],
        collected.get("market_context", {}),
        history_records,
        config,
        prior_market_state=prior_market_state,
    )

    payload = RunPayload(
        run_id=run_id,
        generated_at=generated_at.isoformat(timespec="seconds"),
        rows=scored["rows"],
        market_context=scored.get("market_context", collected.get("market_context", {})),
        provider_status=collected.get("provider_status", {}),
        factor_weights=scored["factor_weights"],
        regime=scored["regime"],
    ).to_runtime_dict()
    if save:
        save_snapshot(payload, config)
    paths = write_reports(payload, config, out_dir) if write_report_files else {}
    return payload, paths
