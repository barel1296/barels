"""Wires a production Orchestrator for a Postgres-backed session and runs it.

This is the path the worker loop takes for `run_session` jobs. It requires a
configured LLM provider — there is no scripted/demo fallback in this path.
"""

from __future__ import annotations

from typing import Any

from .agents.roster import ROSTER
from .artifacts import ArtifactStore
from .db import worker_conn
from .evidence import PgEvidenceStore
from .llm.gateway import LLMGateway
from .metrics_client import ApiMetricsClient
from .orchestrator.engine import Orchestrator, OrchestratorDeps
from .orchestrator.state import PgMessageRepo, PgSessionRepo, SessionData
from .protocol import ProtocolValidator
from .recommend.publish import PgPublisher
from .tools import PgDataAccess, ToolContext, ToolRegistry


def load_playbook(playbook_key: str) -> dict[str, Any]:
    with worker_conn() as conn:
        row = conn.execute(
            """SELECT definition FROM playbooks
                WHERE key = %s AND status = 'active'
                ORDER BY version DESC LIMIT 1""",
            (playbook_key,),
        ).fetchone()
        if row is None:
            raise KeyError(f"playbook not found: {playbook_key}")
        return dict(row["definition"])


def load_tenant_memory(tenant_id: str) -> dict[str, Any]:
    with worker_conn(tenant_id) as conn:
        rows = conn.execute(
            """SELECT category, key, value FROM tenant_memory
                WHERE tenant_id = %s AND active ORDER BY category, key""",
            (tenant_id,),
        ).fetchall()
        return {f"{r['category']}.{r['key']}": r["value"] for r in rows}


def load_guardrail_policies(tenant_id: str) -> list[dict[str, Any]]:
    with worker_conn(tenant_id) as conn:
        rows = conn.execute(
            """SELECT key, description, params, enabled FROM guardrail_policies
                WHERE tenant_id = %s""",
            (tenant_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def run_session_job(tenant_id: str, session_id: str) -> SessionData:
    sessions = PgSessionRepo(tenant_id)
    session = sessions.load(session_id)

    artifacts = ArtifactStore()
    evidence = PgEvidenceStore(tenant_id, session_id, artifacts)
    messages = PgMessageRepo(
        tenant_id, validator_factory=lambda: ProtocolValidator(evidence.known_ids())
    )
    tools = ToolRegistry(
        ctx=ToolContext(
            tenant_id=tenant_id,
            scope=session.scope,
            metrics=ApiMetricsClient(),
            data=PgDataAccess(tenant_id),
            evidence=evidence,
        )
    )
    deps = OrchestratorDeps(
        sessions=sessions,
        messages=messages,
        evidence=evidence,
        tools=tools,
        gateway=LLMGateway.from_settings(),
        publisher=PgPublisher(tenant_id),
        agents={name: cls() for name, cls in ROSTER.items()},
        playbook=load_playbook(session.playbook_key),
        tenant_memory=load_tenant_memory(tenant_id),
        guardrail_policies=load_guardrail_policies(tenant_id),
    )
    return Orchestrator(deps).run(session_id)
