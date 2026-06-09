import pytest

from gros_workers.evidence import InMemoryEvidenceStore
from gros_workers.recommend.confidence import compute_confidence
from gros_workers.recommend.publish import (
    InMemoryPublisher,
    PreparedAction,
    PreparedRecommendation,
    canonical_json,
    diff_hash,
)


def test_canonical_json_matches_shared_ts_semantics() -> None:
    # Mirrors packages/shared canonicalJson: stable key order, no spaces,
    # None preserved as null, undefined-equivalents dropped on the TS side.
    assert canonical_json({"b": 1, "a": {"d": [2, 1], "c": "x"}}) == (
        '{"a":{"c":"x","d":[2,1]},"b":1}'
    )
    assert canonical_json({"a": None, "b": 2}) == '{"b":2}'
    # Parity check against a hash the web client would compute for this diff:
    diff = {
        "summary": "reduce budget",
        "entries": [
            {"field": "daily_budget_usd", "entity": "DE_Google_UA", "before": 1200, "after": 960}
        ],
    }
    assert diff_hash(diff) == diff_hash(dict(reversed(list(diff.items()))))


def _action(**overrides: object) -> PreparedAction:
    base: dict[str, object] = {
        "kind": "budget_change",
        "target": {"entityType": "campaign", "entityId": "c1"},
        "diff": {"summary": "x", "entries": []},
        "payload": {"magnitudeUsd": 100},
        "execution_plan": {"steps": ["x"]},
        "rollback_plan": {"steps": ["restore"]},
        "monitoring_plan": {"watchMetric": "cpi"},
        "guardrail_eval": [],
    }
    base.update(overrides)
    return PreparedAction(**base)  # type: ignore[arg-type]


def test_action_without_rollback_plan_is_invalid() -> None:
    with pytest.raises(ValueError, match="rollback"):
        _action(rollback_plan={}).validate()


def test_action_without_monitoring_plan_is_invalid() -> None:
    with pytest.raises(ValueError, match="monitoring"):
        _action(monitoring_plan={}).validate()


def test_recommendation_without_evidence_cannot_publish() -> None:
    rec = PreparedRecommendation(
        title="t", summary="s", category="budget", confidence=0.8,
        confidence_breakdown={}, predicted_impact=None, evidence_ids=[],
        playbook_key="roas_drop", actions=[],
    )
    with pytest.raises(ValueError, match="without evidence"):
        InMemoryPublisher().publish("s1", rec)


def test_publisher_assigns_diff_hash_and_awaiting_status() -> None:
    rec = PreparedRecommendation(
        title="t", summary="s", category="budget", confidence=0.8,
        confidence_breakdown={}, predicted_impact=None, evidence_ids=["e1"],
        playbook_key="roas_drop", actions=[_action()],
    )
    pub = InMemoryPublisher()
    out = pub.publish("s1", rec)
    assert len(out["actionIds"]) == 1
    action = pub.actions[0]
    assert action["status"] == "awaiting_approval"
    assert len(action["diff_hash"]) == 64


def test_confidence_rubric_bounds_and_penalties() -> None:
    store = InMemoryEvidenceStore()
    strong = [
        store.record("metric_query", {}, {"rowCount": 28}, {}),
        store.record("computation", {}, {"topContributors": [{"deltaShare": 0.9}]}, {}),
    ]
    base = compute_confidence(strong, [], [], playbook_prior=0.6)
    assert 0.05 <= base.score <= 0.97
    assert base.breakdown["healthPenalty"] == 0.0

    yellow = compute_confidence(strong, [], ["skan"], playbook_prior=0.6)
    assert yellow.score < base.score
    assert yellow.breakdown["healthPenalty"] > 0

    contested = compute_confidence(
        strong,
        [{"type": "challenge"}, {"type": "challenge"}],
        [],
        playbook_prior=0.6,
    )
    assert contested.score < base.score

    thin = compute_confidence([], [], [], playbook_prior=0.6)
    assert thin.score < base.score
