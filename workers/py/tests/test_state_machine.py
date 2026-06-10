import pytest

from gros_workers.orchestrator.state import (
    IllegalTransition,
    InMemorySessionRepo,
    SessionData,
)


def make_repo(phase: str = "triage") -> tuple[InMemorySessionRepo, str]:
    sid = "s1"
    repo = InMemorySessionRepo(
        {
            sid: SessionData(
                id=sid,
                tenant_id="t1",
                playbook_key="roas_drop",
                title="test",
                scope={},
                phase=phase,
                status="running",
                budgets={},
            )
        }
    )
    return repo, sid


def test_legal_path_walks_through() -> None:
    repo, sid = make_repo()
    for phase in ["health_gate", "investigation", "debate", "synthesis",
                  "action_prep", "review", "published"]:
        repo.transition(sid, phase)
    assert repo.load(sid).phase == "published"


def test_illegal_jump_is_rejected() -> None:
    repo, sid = make_repo()
    with pytest.raises(IllegalTransition):
        repo.transition(sid, "review")


def test_cannot_go_backwards_from_synthesis_to_investigation() -> None:
    repo, sid = make_repo("synthesis")
    with pytest.raises(IllegalTransition):
        repo.transition(sid, "investigation")


def test_parking_at_health_gate_is_legal() -> None:
    repo, sid = make_repo("health_gate")
    repo.transition(sid, "parked", status="parked")
    s = repo.load(sid)
    assert (s.phase, s.status) == ("parked", "parked")
