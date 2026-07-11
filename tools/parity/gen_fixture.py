"""Golden parity fixture generator for the TS rewrite.

THROWAWAY harness: not part of the shipped codebase, will be deleted once the
TypeScript port is verified against apps/api/tests/fixtures/parity-run.json.

Why this exists
----------------
data/crypto_screener.sqlite3 contains exactly one stored run (run_id
20260708-191000-200254d8) whose persisted `factors`/`raw_factors`/`scores`
were produced by an OLD version of crypto_screener that still had the
retired `btc_relative_strength` / `reversal_1d` factors (collinearity bug,
fixed in commit 91308c5). Those persisted values are STALE and must not be
used as the TS-port oracle.

This script re-derives the oracle by feeding the run's RAW collected inputs
(row_json with every scoring-stage-derived field stripped) through the
CURRENT crypto_screener.factors.score_snapshot / factor_decay, mirroring
crypto_screener/pipeline.py:run_pipeline's call path exactly (see the
docstring on main() for the file:line mapping). No network calls are made;
the only I/O is a READ-ONLY open of the sqlite DB.

Determinism note
-----------------
storage.load_labeled_factor_records / load_price_lookback / (indirectly)
load_latest_regime_state key their lookback windows off datetime.now().
Left unpinned, this script would produce a different fixture depending on
the wall-clock time it happens to be run at (factor_history only has data
around the source run's window, so "now" drifting away from that window
changes which historical rows are visible for IC weighting and the 72h
reversal price lookback). We freeze storage.datetime.now() to the source
run's own generated_at, i.e. exactly what run_pipeline would have observed
had it called datetime.now() at that historical moment.
"""

from __future__ import annotations

import copy
import json
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from crypto_screener import storage as storage_module  # noqa: E402
from crypto_screener.config import load_config_dict  # noqa: E402
from crypto_screener.factors import factor_decay, score_snapshot  # noqa: E402
from crypto_screener.scoring import pct_change, to_float  # noqa: E402

DB_PATH = REPO_ROOT / "data" / "crypto_screener.sqlite3"
CONFIG_PATH = REPO_ROOT / "config" / "default.json"
OUTPUT_PATH = REPO_ROOT / "apps" / "api" / "tests" / "fixtures" / "parity-run.json"
SOURCE_RUN_ID = "20260708-191000-200254d8"

# Keys crypto_screener.factors._apply_scores / _apply_excluded_scores flatten
# onto each row (factors.py:653-666, 669-684): the nested "scores" dict
# itself, plus every one of its keys and the signal-conflict keys, all
# copied onto the row top level via row.update(row["scores"]) /
# row.update(conflicts). All of it is scoring-stage OUTPUT from the OLD
# stale run, not raw collected input, so it must be stripped alongside
# "factors" / "raw_factors" / "scores" or it would leak stale values into
# what the fixture claims are "raw collected inputs".
STALE_ROW_KEYS = (
    "factors",
    "raw_factors",
    "scores",
    "factor_score",
    "liquidity_quality",
    "long_score",
    "short_score",
    "crowded_long_score",
    "squeeze_risk_score",
    "confidence_score",
    "signal_conflict_score",
    "signal_conflict_label",
    "signal_conflicts",
    "regime_alignment_score",
    "breadth_alignment_score",
)


def _readonly_connect(path: Path | str) -> sqlite3.Connection:
    """Drop-in replacement for storage.connect that never writes to the DB.

    storage.connect() (storage.py:15-20) opens a normal read-write
    connection and always runs ensure_schema(). Since every crypto_screener
    storage loader (load_labeled_factor_records, load_price_lookback,
    load_latest_regime_state, ...) calls the module-level `connect` by
    name, monkeypatching crypto_screener.storage.connect below routes all
    of them through this read-only URI connection instead, without having
    to reimplement their query logic.
    """
    uri = f"file:{Path(path)}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    # Verified harmless on this DB: ensure_schema's CREATE TABLE IF NOT
    # EXISTS / ALTER TABLE ADD COLUMN are no-ops when the schema already
    # matches, so this succeeds on a mode=ro connection without writing.
    storage_module.ensure_schema(conn)
    return conn


def _freeze_now(frozen_at: datetime) -> None:
    """Pin crypto_screener.storage's datetime.now() to frozen_at."""

    class _FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return frozen_at.astimezone(tz) if tz is not None else frozen_at

    storage_module.datetime = _FrozenDateTime  # type: ignore[attr-defined]


def _load_source_run(conn: sqlite3.Connection) -> tuple[datetime, dict[str, Any], list[dict[str, Any]]]:
    run_row = conn.execute(
        "SELECT generated_at, context_json FROM runs WHERE run_id = ?",
        (SOURCE_RUN_ID,),
    ).fetchone()
    if run_row is None:
        raise SystemExit(f"run {SOURCE_RUN_ID} not found in {DB_PATH}")
    generated_at = datetime.fromisoformat(run_row["generated_at"])
    market_context = json.loads(run_row["context_json"])

    db_rows = conn.execute(
        "SELECT row_json FROM market_rows WHERE run_id = ? ORDER BY symbol",
        (SOURCE_RUN_ID,),
    ).fetchall()
    rows: list[dict[str, Any]] = []
    for db_row in db_rows:
        row = json.loads(db_row["row_json"])
        for key in STALE_ROW_KEYS:
            row.pop(key, None)
        rows.append(row)
    return generated_at, market_context, rows


def main() -> None:
    """Mirror crypto_screener/pipeline.py:run_pipeline (lines 30-52).

    collected = collect_market(config)                          -> replaced by DB rows (no network)
    history_records = load_labeled_factor_records(config)        -> pipeline.py:31
    lookback_prices = load_price_lookback(config, lookback_hours) -> pipeline.py:32-33
    row["price_change_72h_pct"] = pct_change(...)                -> pipeline.py:34-40
    prior_market_state = load_latest_regime_state(...)            -> pipeline.py:42
    scored = score_snapshot(rows, market_context, history_records,
                             config, prior_market_state=...)      -> pipeline.py:43-49
    records_by_horizon = load_labeled_records_by_horizon(...)     -> pipeline.py:50-51
    scored["factor_weights"]["factor_decay"] = factor_decay(...)  -> pipeline.py:52
    """
    config = load_config_dict(CONFIG_PATH)

    # Route every crypto_screener.storage DB connection through a
    # read-only URI so the golden source DB is never written to.
    storage_module.connect = _readonly_connect

    ro_conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    ro_conn.row_factory = sqlite3.Row
    try:
        generated_at, market_context, input_rows = _load_source_run(ro_conn)
    finally:
        ro_conn.close()

    # Deterministic reproduction: pin "now" to the source run's own
    # timestamp (see module docstring).
    _freeze_now(generated_at)

    history_records = storage_module.load_labeled_factor_records(config)

    lookback_hours = float(config.get("factors", {}).get("reversal_lookback_hours", 72))
    lookback_prices = storage_module.load_price_lookback(config, lookback_hours)
    for row in input_rows:
        current_price = to_float(row.get("price_usd"))
        past_price = lookback_prices.get(str(row.get("symbol") or ""))
        if current_price is not None and past_price is not None and past_price > 0:
            row["price_change_72h_pct"] = pct_change(past_price, current_price)
        else:
            row["price_change_72h_pct"] = None

    prior_market_state = storage_module.load_latest_regime_state(
        config.get("storage_path", "data/crypto_screener.sqlite3")
    )

    # score_snapshot mutates each row dict in place (it sets row["factors"],
    # row["raw_factors"], and _apply_scores/_apply_excluded_scores flatten
    # row["scores"] onto the row top level). Snapshot the pre-scoring rows
    # now so the fixture's "input_rows" reflects what was actually fed into
    # scoring, not the post-scoring state of the same objects.
    fixture_input_rows = copy.deepcopy(input_rows)

    scored = score_snapshot(
        input_rows,
        market_context,
        history_records,
        config,
        prior_market_state=prior_market_state,
    )

    decay_horizons = config.get("factors", {}).get("decay_horizons", [4, 8, 12, 24, 48, 72])
    records_by_horizon = storage_module.load_labeled_records_by_horizon(config, decay_horizons)
    scored["factor_weights"]["factor_decay"] = factor_decay(records_by_horizon, config)

    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    fixture = {
        "_meta": {
            "generated_from_commit": commit,
            "generated_by": "tools/parity/gen_fixture.py",
            "python_version": sys.version,
            "source_run_id": SOURCE_RUN_ID,
            "note": (
                "Oracle produced by the CURRENT Python implementation; stored DB "
                "factors/scores were stale and were stripped."
            ),
        },
        "config": config,
        "market_context": market_context,
        "input_rows": fixture_input_rows,
        "factor_history": history_records,
        "expected": {
            "factor_weights": scored["factor_weights"],
            "regime": scored["regime"],
            "rows": [
                {
                    "symbol": row.get("symbol"),
                    "factors": row.get("factors"),
                    "raw_factors": row.get("raw_factors"),
                    "scores": row.get("scores"),
                }
                for row in scored["rows"]
            ],
        },
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=2, sort_keys=False)

    print(f"wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
