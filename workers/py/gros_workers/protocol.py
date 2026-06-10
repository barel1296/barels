"""Agent message protocol with hard evidence enforcement (docs/05 §5.0).

The validator here is the first line of the anti-hallucination spine; the
database trigger (migrations/003) is the second. A claim-bearing message that
does not reference resolvable evidence is REJECTED — not warned about.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator

AGENTS = ("growth_director", "intelligence", "operations", "creative", "tracking")

EVIDENCE_REQUIRED_TYPES = {"finding", "hypothesis", "challenge"}

_BINDING_TOKEN_RE = re.compile(r"\{ev:[0-9a-fA-F-]{36}:[a-zA-Z0-9_.\[\]]+\}")
_RAW_NUMBER_RE = re.compile(r"\$\s?\d|\d+(?:\.\d+)?\s?%|\b\d+\.\d+\b")


def claim_has_raw_numbers(claim: str) -> bool:
    """True when a claim asserts metric-shaped literals ($x, x%, decimals)
    outside evidence-binding tokens. Such claims are protocol violations for
    claim-bearing message types: numbers must be rendered from evidence."""
    stripped = _BINDING_TOKEN_RE.sub("", claim)
    return bool(_RAW_NUMBER_RE.search(stripped))


class MessageType(StrEnum):
    finding = "finding"
    hypothesis = "hypothesis"
    challenge = "challenge"
    concession = "concession"
    proposal = "proposal"
    vote = "vote"
    request = "request"
    directive = "directive"
    resolution = "resolution"


class MessageDraft(BaseModel):
    """A message an agent wants to post to the blackboard."""

    agent: str
    type: MessageType
    claim: str = Field(min_length=3, max_length=4000)
    payload: dict[str, Any] = Field(default_factory=dict)
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    directed_to: list[str] = Field(default_factory=list)
    in_reply_to: str | None = None

    @field_validator("agent")
    @classmethod
    def _agent_known(cls, v: str) -> str:
        if v not in AGENTS and v not in ("user", "orchestrator"):
            raise ValueError(f"unknown agent: {v}")
        return v


class ProtocolViolation(Exception):
    """Raised when a message breaks the protocol. Never downgraded to a log."""


class ProtocolValidator:
    """Validates drafts against the evidence rule and structural rules.

    `known_evidence_ids` must be the set of evidence artifact ids that exist
    for the current tenant/session — drafts referencing anything else are
    rejected (evidence forgery attempt or hallucinated reference).
    """

    def __init__(self, known_evidence_ids: set[str]):
        self.known_evidence_ids = known_evidence_ids

    def validate(self, draft: MessageDraft) -> MessageDraft:
        if draft.type.value in EVIDENCE_REQUIRED_TYPES:
            if not draft.evidence_ids:
                raise ProtocolViolation(
                    f"{draft.type.value} from {draft.agent} carries no evidence_ids"
                )
            unknown = [e for e in draft.evidence_ids if e not in self.known_evidence_ids]
            if unknown:
                raise ProtocolViolation(
                    f"{draft.type.value} from {draft.agent} references unknown evidence: {unknown}"
                )
            if claim_has_raw_numbers(draft.claim):
                raise ProtocolViolation(
                    f"{draft.type.value} from {draft.agent} asserts raw numeric literals "
                    f"outside evidence bindings: {draft.claim!r}"
                )
        if draft.type is MessageType.hypothesis and not str(
            draft.payload.get("falsification", "")
        ).strip():
            raise ProtocolViolation(
                f"hypothesis from {draft.agent} lacks payload.falsification"
            )
        if draft.type is MessageType.challenge and not draft.in_reply_to:
            raise ProtocolViolation(
                f"challenge from {draft.agent} must reply to a message (in_reply_to)"
            )
        return draft
