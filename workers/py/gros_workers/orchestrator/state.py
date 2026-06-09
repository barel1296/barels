"""Session state persistence: protocols + Postgres and in-memory repos.

The orchestrator is resumable: state lives in these repos, never in process
memory alone. The message repo applies the ProtocolValidator on EVERY post —
there is no unvalidated write path to the blackboard.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import uuid4

from ..protocol import MessageDraft, ProtocolValidator

LEGAL_TRANSITIONS: dict[str, set[str]] = {
    "triage": {"health_gate", "investigation", "parked", "failed"},
    "health_gate": {"investigation", "parked", "failed"},
    "investigation": {"debate", "synthesis", "failed", "parked"},
    "debate": {"synthesis", "failed"},
    "synthesis": {"action_prep", "review", "failed"},
    "action_prep": {"review", "failed"},
    "review": {"published", "failed"},
    "published": {"monitoring", "closed"},
    "monitoring": {"closed"},
}


class IllegalTransition(Exception):
    pass


@dataclass
class SessionData:
    id: str
    tenant_id: str
    playbook_key: str
    title: str
    scope: dict[str, Any]
    phase: str
    status: str
    budgets: dict[str, Any]
    trigger_ref: dict[str, Any] = field(default_factory=dict)
    decision: dict[str, Any] | None = None
    abstract: str | None = None


class SessionRepo(Protocol):
    def load(self, session_id: str) -> SessionData: ...

    def transition(self, session_id: str, phase: str, status: str | None = None) -> None: ...

    def finish(
        self,
        session_id: str,
        status: str,
        decision: dict[str, Any] | None = None,
        abstract: str | None = None,
    ) -> None: ...


class MessageRepo(Protocol):
    def post(self, session_id: str, draft: MessageDraft) -> dict[str, Any]: ...

    def list(self, session_id: str) -> list[dict[str, Any]]: ...


class InMemorySessionRepo:
    def __init__(self, sessions: dict[str, SessionData] | None = None):
        self.sessions = sessions or {}

    def load(self, session_id: str) -> SessionData:
        return self.sessions[session_id]

    def transition(self, session_id: str, phase: str, status: str | None = None) -> None:
        s = self.sessions[session_id]
        allowed = LEGAL_TRANSITIONS.get(s.phase, set())
        if phase != s.phase and phase not in allowed:
            raise IllegalTransition(f"{s.phase} -> {phase}")
        s.phase = phase
        if status:
            s.status = status

    def finish(
        self,
        session_id: str,
        status: str,
        decision: dict[str, Any] | None = None,
        abstract: str | None = None,
    ) -> None:
        s = self.sessions[session_id]
        s.status = status
        if decision is not None:
            s.decision = decision
        if abstract is not None:
            s.abstract = abstract


class InMemoryMessageRepo:
    def __init__(self, validator_factory: Any):
        # validator_factory: Callable[[], ProtocolValidator]
        self.validator_factory = validator_factory
        self.messages: list[dict[str, Any]] = []
        self._seq = 0

    def post(self, session_id: str, draft: MessageDraft) -> dict[str, Any]:
        validator: ProtocolValidator = self.validator_factory()
        validator.validate(draft)
        self._seq += 1
        msg = {
            "id": str(uuid4()),
            "session_id": session_id,
            "agent": draft.agent,
            "type": draft.type.value,
            "claim": draft.claim,
            "payload": draft.payload,
            "evidence_ids": draft.evidence_ids,
            "confidence": draft.confidence,
            "directed_to": draft.directed_to,
            "in_reply_to": draft.in_reply_to,
            "seq": self._seq,
        }
        self.messages.append(msg)
        return msg

    def list(self, session_id: str) -> list[dict[str, Any]]:
        return [m for m in self.messages if m["session_id"] == session_id]


class PgSessionRepo:
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id

    def load(self, session_id: str) -> SessionData:
        from ..db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            row = conn.execute(
                """SELECT id, tenant_id, playbook_key, title, scope, phase, status,
                          budgets, trigger_ref, decision, abstract
                     FROM agent_sessions WHERE id = %s""",
                (session_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"session not found: {session_id}")
            return SessionData(
                id=str(row["id"]),
                tenant_id=str(row["tenant_id"]),
                playbook_key=str(row["playbook_key"]),
                title=str(row["title"]),
                scope=row["scope"] or {},
                phase=str(row["phase"]),
                status=str(row["status"]),
                budgets=row["budgets"] or {},
                trigger_ref=row["trigger_ref"] or {},
                decision=row["decision"],
                abstract=row["abstract"],
            )

    def transition(self, session_id: str, phase: str, status: str | None = None) -> None:
        from ..db import worker_conn

        current = self.load(session_id)
        allowed = LEGAL_TRANSITIONS.get(current.phase, set())
        if phase != current.phase and phase not in allowed:
            raise IllegalTransition(f"{current.phase} -> {phase}")
        with worker_conn(self.tenant_id) as conn:
            if status:
                conn.execute(
                    "UPDATE agent_sessions SET phase = %s, status = %s, updated_at = now() "
                    "WHERE id = %s",
                    (phase, status, session_id),
                )
            else:
                conn.execute(
                    "UPDATE agent_sessions SET phase = %s, updated_at = now() WHERE id = %s",
                    (phase, session_id),
                )

    def finish(
        self,
        session_id: str,
        status: str,
        decision: dict[str, Any] | None = None,
        abstract: str | None = None,
    ) -> None:
        from ..db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            conn.execute(
                """UPDATE agent_sessions
                      SET status = %s,
                          decision = COALESCE(%s, decision),
                          abstract = COALESCE(%s, abstract),
                          closed_at = CASE WHEN %s IN ('closed','failed','parked')
                                           THEN now() ELSE closed_at END,
                          updated_at = now()
                    WHERE id = %s""",
                (
                    status,
                    json.dumps(decision, default=str) if decision is not None else None,
                    abstract,
                    status,
                    session_id,
                ),
            )


class PgMessageRepo:
    def __init__(self, tenant_id: str, validator_factory: Any):
        self.tenant_id = tenant_id
        self.validator_factory = validator_factory

    def post(self, session_id: str, draft: MessageDraft) -> dict[str, Any]:
        from ..db import worker_conn

        validator: ProtocolValidator = self.validator_factory()
        validator.validate(draft)
        with worker_conn(self.tenant_id) as conn:
            row = conn.execute(
                """INSERT INTO agent_messages
                   (tenant_id, session_id, agent, type, claim, payload, evidence_ids,
                    confidence, directed_to, in_reply_to)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING id, seq""",
                (
                    self.tenant_id,
                    session_id,
                    draft.agent,
                    draft.type.value,
                    draft.claim,
                    json.dumps(draft.payload, default=str),
                    draft.evidence_ids,
                    draft.confidence,
                    draft.directed_to,
                    draft.in_reply_to,
                ),
            ).fetchone()
            assert row is not None
            return {
                "id": str(row["id"]),
                "seq": int(row["seq"]),
                "agent": draft.agent,
                "type": draft.type.value,
                "claim": draft.claim,
                "payload": draft.payload,
                "evidence_ids": draft.evidence_ids,
                "confidence": draft.confidence,
                "in_reply_to": draft.in_reply_to,
                "session_id": session_id,
            }

    def list(self, session_id: str) -> list[dict[str, Any]]:
        from ..db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            # seq exposed to agents is SESSION-RELATIVE (the thread is
            # append-only, so row_number over the global identity is stable);
            # the global identity column only provides ordering.
            rows = conn.execute(
                """SELECT id, agent, type, claim, payload, evidence_ids, confidence,
                          directed_to, in_reply_to,
                          row_number() OVER (ORDER BY seq) AS seq
                     FROM agent_messages WHERE session_id = %s ORDER BY seq""",
                (session_id,),
            ).fetchall()
            out: list[dict[str, Any]] = []
            for r in rows:
                m = dict(r)
                # psycopg returns uuid.UUID objects; the protocol layer and
                # pydantic models work with strings.
                m["id"] = str(m["id"])
                m["in_reply_to"] = str(m["in_reply_to"]) if m["in_reply_to"] else None
                m["evidence_ids"] = [str(e) for e in (m["evidence_ids"] or [])]
                m["seq"] = int(m["seq"])
                out.append(m)
            return out
