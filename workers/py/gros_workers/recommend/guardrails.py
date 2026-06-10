"""Guardrail engine (docs/10 §10.3): deterministic policy evaluation over
action drafts. Evaluated at draft time here, and re-checked at approval by
the API (TOCTOU-safe pairing). Every policy produces an explained result;
nothing is silently skipped.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class GuardrailContext:
    entity_daily_budget_usd: float
    tenant_daily_spend_usd: float
    health_domains: dict[str, str]  # domain -> green|yellow|red
    hours_since_last_entity_change: float | None
    entity_managed_state: str = "observed"


def evaluate_guardrails(
    kind: str,
    change_pct: float | None,
    magnitude_usd: float,
    policies: list[dict[str, Any]],
    ctx: GuardrailContext,
    health_domain: str = "spend",
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    def add(key: str, description: str, passed: bool,
            observed: dict[str, Any], limit: dict[str, Any]) -> None:
        results.append(
            {
                "key": key,
                "description": description,
                "passed": passed,
                "observed": observed,
                "limit": limit,
            }
        )

    by_key = {p["key"]: p for p in policies if p.get("enabled", True)}

    # Entity lock is absolute, independent of configured policies.
    add(
        "entity_lock",
        "Locked entities are untouchable by agents",
        ctx.entity_managed_state != "locked",
        {"managedState": ctx.entity_managed_state},
        {"required": "not locked"},
    )

    if (p := by_key.get("max_budget_change_pct_per_day")) and change_pct is not None:
        max_pct = float(p["params"].get("maxPct", 25))
        add(
            "max_budget_change_pct_per_day",
            str(p.get("description", "")),
            abs(change_pct) <= max_pct,
            {"changePct": change_pct},
            {"maxPct": max_pct},
        )

    if p := by_key.get("max_budget_change_usd"):
        max_usd = float(p["params"].get("maxUsd", 5000))
        add(
            "max_budget_change_usd",
            str(p.get("description", "")),
            magnitude_usd <= max_usd,
            {"magnitudeUsd": magnitude_usd},
            {"maxUsd": max_usd},
        )

    if p := by_key.get("blast_radius_pct"):
        max_pct = float(p["params"].get("maxPct", 10))
        observed_pct = (
            magnitude_usd / ctx.tenant_daily_spend_usd * 100
            if ctx.tenant_daily_spend_usd > 0
            else 100.0
        )
        add(
            "blast_radius_pct",
            str(p.get("description", "")),
            observed_pct <= max_pct,
            {"blastRadiusPct": round(observed_pct, 2)},
            {"maxPct": max_pct},
        )

    if p := by_key.get("entity_change_cooldown_hours"):
        hours = float(p["params"].get("hours", 24))
        since = ctx.hours_since_last_entity_change
        add(
            "entity_change_cooldown_hours",
            str(p.get("description", "")),
            since is None or since >= hours,
            {"hoursSinceLastChange": since},
            {"minHours": hours},
        )

    if by_key.get("data_health_gate"):
        status = ctx.health_domains.get(health_domain, "green")
        add(
            "data_health_gate",
            "Block actions while the relevant health domain is red",
            status != "red",
            {"domain": health_domain, "status": status},
            {"required": "not red"},
        )

    return results
