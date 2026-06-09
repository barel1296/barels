"""Typed impact estimators (docs/09 §9.7). Deterministic, per action kind,
with the basis evidence attached. v1 estimators are deliberately conservative
and labeled: ranges reflect redeployed/at-risk spend, not promised revenue.
"""

from __future__ import annotations

from typing import Any


def estimate_budget_change(
    daily_budget_usd: float,
    change_pct: float,
    horizon_days: int = 30,
    basis_evidence_ids: list[str] | None = None,
) -> dict[str, Any]:
    moved_daily = abs(daily_budget_usd * change_pct / 100.0)
    mid = round(moved_daily * horizon_days, 2)
    return {
        "metric": "usd_redeployed_over_horizon",
        "low": round(mid * 0.6, 2),
        "mid": mid,
        "high": round(mid * 1.4, 2),
        "horizonDays": horizon_days,
        "basisEvidenceIds": basis_evidence_ids or [],
        "estimator": "budget_change.v1",
    }


def estimate_pause(
    daily_budget_usd: float,
    horizon_days: int = 30,
    basis_evidence_ids: list[str] | None = None,
) -> dict[str, Any]:
    mid = round(daily_budget_usd * horizon_days, 2)
    return {
        "metric": "usd_spend_stopped_over_horizon",
        "low": mid,
        "mid": mid,
        "high": mid,
        "horizonDays": horizon_days,
        "basisEvidenceIds": basis_evidence_ids or [],
        "estimator": "pause_entity.v1",
    }


def estimate_creative_rotation(
    affected_daily_spend_usd: float,
    total_decline_pct: float,
    horizon_days: int = 30,
    basis_evidence_ids: list[str] | None = None,
) -> dict[str, Any]:
    # Spend currently riding a decayed asset, weighted by observed decline.
    mid = round(affected_daily_spend_usd * (total_decline_pct / 100.0) * horizon_days, 2)
    return {
        "metric": "usd_spend_at_risk_over_horizon",
        "low": round(mid * 0.5, 2),
        "mid": mid,
        "high": round(mid * 1.5, 2),
        "horizonDays": horizon_days,
        "basisEvidenceIds": basis_evidence_ids or [],
        "estimator": "creative_rotation.v1",
    }
