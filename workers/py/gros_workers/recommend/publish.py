"""Publish gate (docs/09 §9.8): the last line of code between agent output
and humans. Builds recommendation + action rows; refuses anything that lacks
evidence, plans, or passing structure. Diff hashes use the same canonical
JSON as the web client's approve echo.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from uuid import uuid4


def canonical_json(value: Any) -> str:
    """Mirror of packages/shared canonicalJson (kept in sync by test
    tests/test_publish.py::test_canonical_json_parity)."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted((k, v) for k, v in value.items() if v is not None)
        return "{" + ",".join(f"{json.dumps(k)}:{canonical_json(v)}" for k, v in items) + "}"
    return json.dumps(str(value))


def diff_hash(diff: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(diff).encode()).hexdigest()


@dataclass
class PreparedAction:
    kind: str
    target: dict[str, Any]
    diff: dict[str, Any]
    payload: dict[str, Any]
    execution_plan: dict[str, Any]
    rollback_plan: dict[str, Any]
    monitoring_plan: dict[str, Any]
    guardrail_eval: list[dict[str, Any]]
    expires_hours: int = 72
    idempotency_key: str = field(default_factory=lambda: str(uuid4()))

    def validate(self) -> None:
        if not self.rollback_plan:
            raise ValueError(f"{self.kind} action has no rollback plan")
        if not self.monitoring_plan:
            raise ValueError(f"{self.kind} action has no monitoring plan")
        if not self.diff:
            raise ValueError(f"{self.kind} action has no diff")


@dataclass
class PreparedRecommendation:
    title: str
    summary: str
    category: str
    confidence: float
    confidence_breakdown: dict[str, Any]
    predicted_impact: dict[str, Any] | None
    evidence_ids: list[str]
    playbook_key: str
    actions: list[PreparedAction]

    def validate(self) -> None:
        if not self.evidence_ids:
            raise ValueError("recommendation without evidence cannot be published")
        if not (0 <= self.confidence <= 1):
            raise ValueError("confidence out of range")
        for a in self.actions:
            a.validate()


class Publisher(Protocol):
    def publish(self, session_id: str, rec: PreparedRecommendation) -> dict[str, Any]: ...


class InMemoryPublisher:
    def __init__(self) -> None:
        self.recommendations: list[dict[str, Any]] = []
        self.actions: list[dict[str, Any]] = []

    def publish(self, session_id: str, rec: PreparedRecommendation) -> dict[str, Any]:
        rec.validate()
        rec_id = str(uuid4())
        self.recommendations.append(
            {"id": rec_id, "session_id": session_id, **rec.__dict__}
        )
        action_ids = []
        for a in rec.actions:
            aid = str(uuid4())
            self.actions.append(
                {
                    "id": aid,
                    "recommendation_id": rec_id,
                    "status": "awaiting_approval",
                    "diff_hash": diff_hash(a.diff),
                    **a.__dict__,
                }
            )
            action_ids.append(aid)
        return {"recommendationId": rec_id, "actionIds": action_ids}


class PgPublisher:
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id

    def publish(self, session_id: str, rec: PreparedRecommendation) -> dict[str, Any]:
        from ..db import worker_conn

        rec.validate()
        with worker_conn(self.tenant_id) as conn:
            row = conn.execute(
                """INSERT INTO recommendations
                   (tenant_id, session_id, playbook_key, title, summary, category,
                    confidence, confidence_breakdown, predicted_impact, evidence_ids,
                    status, expires_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'proposed',
                           now() + interval '72 hours')
                   RETURNING id""",
                (
                    self.tenant_id,
                    session_id,
                    rec.playbook_key,
                    rec.title,
                    rec.summary,
                    rec.category,
                    rec.confidence,
                    json.dumps(rec.confidence_breakdown, default=str),
                    json.dumps(rec.predicted_impact, default=str)
                    if rec.predicted_impact
                    else None,
                    rec.evidence_ids,
                ),
            ).fetchone()
            assert row is not None
            rec_id = str(row["id"])
            action_ids: list[str] = []
            for a in rec.actions:
                expires = datetime.now(UTC) + timedelta(hours=a.expires_hours)
                arow = conn.execute(
                    """INSERT INTO actions
                       (tenant_id, recommendation_id, session_id, kind, target, diff,
                        diff_hash, payload, execution_plan, rollback_plan,
                        monitoring_plan, guardrail_eval, autonomy_level, status,
                        idempotency_key, expires_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 2,
                               'awaiting_approval', %s, %s)
                       RETURNING id""",
                    (
                        self.tenant_id,
                        rec_id,
                        session_id,
                        a.kind,
                        json.dumps(a.target, default=str),
                        json.dumps(a.diff, default=str),
                        diff_hash(a.diff),
                        json.dumps(a.payload, default=str),
                        json.dumps(a.execution_plan, default=str),
                        json.dumps(a.rollback_plan, default=str),
                        json.dumps(a.monitoring_plan, default=str),
                        json.dumps(a.guardrail_eval, default=str),
                        a.idempotency_key,
                        expires,
                    ),
                ).fetchone()
                assert arow is not None
                action_ids.append(str(arow["id"]))
            return {"recommendationId": rec_id, "actionIds": action_ids}
