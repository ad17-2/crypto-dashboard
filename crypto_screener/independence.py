from __future__ import annotations

from typing import Any

from .scoring import spearman_corr, to_float

DUPLICATE_THRESHOLD = 0.95
REDUNDANT_THRESHOLD = 0.80
FLAG_THRESHOLD = 0.60


def factor_correlations(
    rows: list[dict[str, Any]],
    factor_names: list[str],
    min_pairs: int = 10,
) -> list[dict[str, Any]]:
    flagged: list[dict[str, Any]] = []
    for index, factor_a in enumerate(factor_names):
        for factor_b in factor_names[index + 1 :]:
            pairs = _joint_pairs(rows, factor_a, factor_b)
            if len(pairs) < min_pairs:
                continue
            rho = spearman_corr([pair[0] for pair in pairs], [pair[1] for pair in pairs])
            if rho is None or abs(rho) < FLAG_THRESHOLD:
                continue
            abs_rho = abs(rho)
            if abs_rho >= DUPLICATE_THRESHOLD:
                verdict = "duplicate"
            elif abs_rho >= REDUNDANT_THRESHOLD:
                verdict = "redundant"
            else:
                verdict = "correlated"
            flagged.append(
                {
                    "a": factor_a,
                    "b": factor_b,
                    "rho": round(rho, 4),
                    "verdict": verdict,
                }
            )
    flagged.sort(key=lambda item: abs(item["rho"]), reverse=True)
    return flagged


def _joint_pairs(
    rows: list[dict[str, Any]],
    factor_a: str,
    factor_b: str,
) -> list[tuple[float, float]]:
    pairs: list[tuple[float, float]] = []
    for row in rows:
        value_a = _factor_value(row, factor_a)
        value_b = _factor_value(row, factor_b)
        if value_a is None or value_b is None:
            continue
        pairs.append((value_a, value_b))
    return pairs


def _factor_value(row: dict[str, Any], factor: str) -> float | None:
    factors = row.get("factors")
    if isinstance(factors, dict):
        return to_float(factors.get(factor))
    return to_float(row.get(factor))
