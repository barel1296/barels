from gros_workers.recommend.guardrails import GuardrailContext, evaluate_guardrails

POLICIES = [
    {"key": "max_budget_change_pct_per_day", "description": "",
     "params": {"maxPct": 25}, "enabled": True},
    {"key": "max_budget_change_usd", "description": "",
     "params": {"maxUsd": 5000}, "enabled": True},
    {"key": "blast_radius_pct", "description": "", "params": {"maxPct": 10}, "enabled": True},
    {"key": "entity_change_cooldown_hours", "description": "",
     "params": {"hours": 24}, "enabled": True},
    {"key": "data_health_gate", "description": "", "params": {}, "enabled": True},
]


def ctx(**overrides: object) -> GuardrailContext:
    base = {
        "entity_daily_budget_usd": 1200.0,
        "tenant_daily_spend_usd": 16000.0,
        "health_domains": {"spend": "green"},
        "hours_since_last_entity_change": None,
        "entity_managed_state": "observed",
    }
    base.update(overrides)
    return GuardrailContext(**base)  # type: ignore[arg-type]


def by_key(results: list[dict[str, object]]) -> dict[str, bool]:
    return {str(r["key"]): bool(r["passed"]) for r in results}


def test_all_pass_within_limits() -> None:
    results = evaluate_guardrails("budget_change", -20.0, 240.0, POLICIES, ctx())
    assert all(by_key(results).values())


def test_pct_change_boundary() -> None:
    ok = evaluate_guardrails("budget_change", 25.0, 300.0, POLICIES, ctx())
    assert by_key(ok)["max_budget_change_pct_per_day"]
    over = evaluate_guardrails("budget_change", 25.1, 300.0, POLICIES, ctx())
    assert not by_key(over)["max_budget_change_pct_per_day"]


def test_absolute_magnitude_boundary() -> None:
    over = evaluate_guardrails("budget_change", -10.0, 5001.0, POLICIES, ctx())
    assert not by_key(over)["max_budget_change_usd"]


def test_blast_radius() -> None:
    over = evaluate_guardrails("budget_change", -10.0, 1601.0, POLICIES, ctx())
    assert not by_key(over)["blast_radius_pct"]  # >10% of 16k
    edge = evaluate_guardrails("budget_change", -10.0, 1600.0, POLICIES, ctx())
    assert by_key(edge)["blast_radius_pct"]


def test_cooldown() -> None:
    recent = evaluate_guardrails(
        "budget_change", -10.0, 100.0, POLICIES, ctx(hours_since_last_entity_change=3.0)
    )
    assert not by_key(recent)["entity_change_cooldown_hours"]


def test_health_gate_red_blocks() -> None:
    red = evaluate_guardrails(
        "budget_change", -10.0, 100.0, POLICIES, ctx(health_domains={"spend": "red"})
    )
    assert not by_key(red)["data_health_gate"]


def test_locked_entity_is_untouchable_even_with_no_policies() -> None:
    results = evaluate_guardrails(
        "budget_change", -10.0, 100.0, [], ctx(entity_managed_state="locked")
    )
    assert not by_key(results)["entity_lock"]
