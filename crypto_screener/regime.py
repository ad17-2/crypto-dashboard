from __future__ import annotations

from typing import Any

from .scoring import clamp, to_float

REGIME_STATES = ("btc-led", "alts-strong", "neutral", "chaos")


def classify_regime(context: dict[str, Any], prior_state: str | None, config: dict[str, Any]) -> dict[str, Any]:
    regime_cfg = config.get("factors", {}).get("regime", {})
    dispersion_threshold = float(regime_cfg.get("dispersion_threshold_pct", 8.0))
    hysteresis_margin = float(regime_cfg.get("hysteresis_margin", 0.15))
    breadth_weak = float(regime_cfg.get("breadth_weak_threshold", 0.15))
    breadth_strong = float(regime_cfg.get("breadth_strong_threshold", 0.25))
    dominance_delta_scale = float(regime_cfg.get("dominance_delta_scale_pct", 0.5))
    eth_btc_scale = float(regime_cfg.get("eth_btc_scale_pct", 2.0))

    btc_dom_delta = to_float(context.get("btc_dominance_delta_pct"))
    eth_btc = to_float(context.get("eth_btc_performance_pct"))
    breadth_score = to_float(context.get("breadth", {}).get("score"))
    dispersion = to_float(context.get("return_dispersion_pct"))
    avg_funding = to_float(context.get("breadth", {}).get("avg_funding_rate_pct"))

    scores = {state: 0.0 for state in REGIME_STATES}

    if dispersion is not None and dispersion >= dispersion_threshold:
        chaos_score = (dispersion - dispersion_threshold) / max(dispersion_threshold, 1.0)
        if breadth_score is not None and abs(breadth_score) <= breadth_weak:
            chaos_score += 0.75
        if avg_funding is not None:
            chaos_score += clamp(abs(avg_funding) / 0.06, 0.0, 0.35)
        scores["chaos"] = chaos_score

    btc_led_score = 0.0
    if btc_dom_delta is not None and btc_dom_delta > 0:
        btc_led_score += clamp(btc_dom_delta / dominance_delta_scale, 0.0, 1.0)
    if eth_btc is not None and eth_btc <= 0:
        btc_led_score += clamp(-eth_btc / eth_btc_scale, 0.0, 1.0)
    if breadth_score is not None and breadth_score <= 0:
        btc_led_score += clamp(-breadth_score, 0.0, 0.5)
    scores["btc-led"] = btc_led_score

    alts_score = 0.0
    if btc_dom_delta is not None and btc_dom_delta < 0:
        alts_score += clamp(-btc_dom_delta / dominance_delta_scale, 0.0, 1.0)
    if eth_btc is not None and eth_btc > 0:
        alts_score += clamp(eth_btc / eth_btc_scale, 0.0, 1.0)
    if breadth_score is not None and breadth_score >= breadth_strong:
        alts_score += clamp(breadth_score, 0.0, 0.5)
    scores["alts-strong"] = alts_score

    scores["neutral"] = 0.2

    raw_state = max(scores, key=lambda state: scores[state])
    state = raw_state
    # Full transition-matrix / HMM smoothing is deferred to Phase 5.
    if (
        prior_state in scores
        and raw_state != prior_state
        and scores[raw_state] <= scores[prior_state] + hysteresis_margin
    ):
        state = prior_state

    return {
        "state": state,
        "raw_state": raw_state,
        "scores": {name: round(value, 3) for name, value in scores.items()},
    }
