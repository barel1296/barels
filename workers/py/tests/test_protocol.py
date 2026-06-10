import pytest

from gros_workers.protocol import (
    MessageDraft,
    MessageType,
    ProtocolValidator,
    ProtocolViolation,
    claim_has_raw_numbers,
)

EV = "11111111-1111-4111-8111-111111111111"


def make_validator() -> ProtocolValidator:
    return ProtocolValidator(known_evidence_ids={EV})


def test_finding_without_evidence_is_rejected() -> None:
    draft = MessageDraft(agent="intelligence", type=MessageType.finding, claim="ROAS moved")
    with pytest.raises(ProtocolViolation, match="no evidence_ids"):
        make_validator().validate(draft)


def test_finding_with_forged_evidence_is_rejected() -> None:
    draft = MessageDraft(
        agent="intelligence",
        type=MessageType.finding,
        claim="ROAS moved",
        evidence_ids=["99999999-9999-4999-8999-999999999999"],
    )
    with pytest.raises(ProtocolViolation, match="unknown evidence"):
        make_validator().validate(draft)


def test_hypothesis_requires_falsification() -> None:
    draft = MessageDraft(
        agent="intelligence",
        type=MessageType.hypothesis,
        claim="It is fatigue",
        evidence_ids=[EV],
    )
    with pytest.raises(ProtocolViolation, match="falsification"):
        make_validator().validate(draft)
    ok = MessageDraft(
        agent="intelligence",
        type=MessageType.hypothesis,
        claim="It is fatigue",
        evidence_ids=[EV],
        payload={"falsification": "a CPM rise at the breakpoint would refute this"},
    )
    make_validator().validate(ok)


def test_challenge_requires_reply_target() -> None:
    draft = MessageDraft(
        agent="creative",
        type=MessageType.challenge,
        claim="Disagree",
        evidence_ids=[EV],
    )
    with pytest.raises(ProtocolViolation, match="in_reply_to"):
        make_validator().validate(draft)


def test_raw_numeric_literals_are_rejected_in_claims() -> None:
    for bad in (
        "ROAS dropped 31.5% in DE",
        "we are wasting $12,400 per week",
        "CPI rose to 2.41 yesterday",
    ):
        draft = MessageDraft(
            agent="intelligence",
            type=MessageType.finding,
            claim=bad,
            evidence_ids=[EV],
        )
        with pytest.raises(ProtocolViolation, match="raw numeric"):
            make_validator().validate(draft)


def test_evidence_bound_tokens_are_allowed() -> None:
    claim = f"ROAS fell from {{ev:{EV}:first}} to {{ev:{EV}:last}} over the window"
    assert not claim_has_raw_numbers(claim)
    draft = MessageDraft(
        agent="intelligence", type=MessageType.finding, claim=claim, evidence_ids=[EV]
    )
    make_validator().validate(draft)


def test_directives_and_resolutions_are_exempt_from_evidence_rule() -> None:
    draft = MessageDraft(
        agent="user", type=MessageType.directive, claim="Cap any move at $500/day please"
    )
    make_validator().validate(draft)
