from __future__ import annotations

from typing import Any

from .scoring import clamp, to_float

SCALE = 1.5
SCALE_ALIGN = 1.0
TONE_POS_THRESHOLD = 0.15
TONE_NEG_THRESHOLD = -0.15
TOTAL_FAMILIES = 6

FAMILY_DEFINITIONS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("trend", "Trend", ("technical_trend_4h",)),
    (
        "momentum",
        "Momentum",
        ("momentum_24h", "technical_momentum_4h", "reversal_3d"),
    ),
    (
        "oi_flow",
        "OI / Flow",
        (
            "oi_price_signal",
            "oi_acceleration_signal",
            "taker_flow_24h",
            "liquidation_imbalance",
            "liquidation_pressure_24h",
        ),
    ),
    (
        "funding",
        "Funding",
        ("funding_rate_contrarian", "funding_persistence_contrarian"),
    ),
    ("crowding", "Crowding", ("ls_ratio_contrarian",)),
    ("regime", "Regime / Breadth", ()),
)


def thesis_sign(side: str, row: dict[str, Any]) -> int:
    if side in {"long", "squeeze-risk"}:
        return 1
    if side in {"short", "fade-long"}:
        return -1
    factor_score = to_float(row.get("scores", {}).get("factor_score"))
    if factor_score is None:
        factor_score = to_float(row.get("factor_score"))
    if factor_score is None:
        return 1
    return 1 if factor_score >= 0 else -1


def thesis_direction(sign: int) -> str:
    return "long" if sign >= 0 else "short"


def _present_values(factors: dict[str, Any], member_keys: tuple[str, ...]) -> list[float]:
    values: list[float] = []
    for key in member_keys:
        value = to_float(factors.get(key))
        if value is not None:
            values.append(value)
    return values


def _factor_contribution(values: list[float], thesis_sign: int) -> float | None:
    if not values:
        return None
    raw = sum(values) / len(values)
    return clamp((raw * thesis_sign) / SCALE, -1.0, 1.0)


def _regime_contribution(row: dict[str, Any]) -> float | None:
    values: list[float] = []
    for key in ("regime_alignment_score", "breadth_alignment_score"):
        value = to_float(row.get(key))
        if value is not None:
            values.append(value)
    if not values:
        return None
    raw = sum(values) / len(values)
    return clamp(raw / SCALE_ALIGN, -1.0, 1.0)


def contribution_tone(contribution: float | None) -> str:
    if contribution is None:
        return "neutral"
    if contribution > TONE_POS_THRESHOLD:
        return "pos"
    if contribution < TONE_NEG_THRESHOLD:
        return "neg"
    return "neutral"


def _family_entry(
    key: str,
    label: str,
    contribution: float | None,
) -> dict[str, Any]:
    rounded = None if contribution is None else round(contribution, 3)
    return {
        "key": key,
        "label": label,
        "tone": contribution_tone(contribution),
        "value": rounded,
    }


def confluence_summary(row: dict[str, Any], side: str) -> dict[str, Any]:
    sign = thesis_sign(side, row)
    direction = thesis_direction(sign)
    factors = row.get("factors", {})

    families: list[dict[str, Any]] = []
    for key, label, member_keys in FAMILY_DEFINITIONS:
        if key == "regime":
            contribution = _regime_contribution(row)
        else:
            contribution = _factor_contribution(_present_values(factors, member_keys), sign)
        families.append(_family_entry(key, label, contribution))

    aligned = sum(1 for family in families if family["tone"] == "pos")
    against = sum(1 for family in families if family["tone"] == "neg")
    neutral = sum(1 for family in families if family["tone"] == "neutral")

    return {
        "direction": direction,
        "aligned": aligned,
        "against": against,
        "neutral": neutral,
        "total": TOTAL_FAMILIES,
        "net_score": aligned - against,
        "families": families,
    }
