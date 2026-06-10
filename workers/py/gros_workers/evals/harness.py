"""Golden-incident evaluation harness (docs/12 §12.3).

Runs a full orchestrated session against frozen fixtures with a scripted LLM
provider (eval mode only) and scores:
  - root-cause accuracy (ground-truth keyword in the decision)
  - false-action rate (actions proposed on a 'noise' incident = severe fail)
  - fabrication rate (MUST be 0: a published unverified claim fails the build;
    a validator catch counts as a pass)

This harness is test/eval infrastructure. It exercises the REAL orchestrator,
REAL protocol validator, REAL guardrail/confidence/publish code — only the
LLM and external data are substituted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from ..agents.roster import ROSTER
from ..evidence import InMemoryEvidenceStore
from ..llm.gateway import CostLedger, LLMGateway
from ..llm.providers import ScriptedProvider
from ..metrics_client import FixtureMetricsClient
from ..orchestrator.engine import Orchestrator, OrchestratorDeps
from ..orchestrator.state import (
    InMemoryMessageRepo,
    InMemorySessionRepo,
    SessionData,
)
from ..protocol import ProtocolValidator, claim_has_raw_numbers
from ..recommend.publish import InMemoryPublisher
from ..tools import InMemoryDataAccess, ToolContext, ToolRegistry


class InMemoryLedger(CostLedger):
    def __init__(self, monthly_usd: float = 100.0):
        self.monthly_usd = monthly_usd
        self.entries: list[dict[str, Any]] = []

    def month_spend_usd(self, tenant_id: str) -> float:
        return sum(float(e["cost_usd"]) for e in self.entries)

    def budget(self, tenant_id: str) -> tuple[float, bool]:
        return (self.monthly_usd, True)

    def record(self, tenant_id: str, model: str, purpose: str, tokens_in: int,
               tokens_out: int, cost_usd: float, session_id: str | None,
               run_id: str | None, agent: str | None) -> None:
        self.entries.append({"purpose": purpose, "cost_usd": cost_usd, "agent": agent})


@dataclass
class GoldenIncident:
    key: str
    title: str
    playbook: dict[str, Any]
    scope: dict[str, Any]
    metric_fixtures: dict[str, Any]
    health: list[dict[str, Any]]
    experiments: list[dict[str, Any]]
    campaigns: list[dict[str, Any]]
    script: dict[str, list[dict[str, Any]]]
    ground_truth: dict[str, Any]
    tenant_memory: dict[str, Any] = field(default_factory=dict)
    guardrail_policies: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class IncidentResult:
    incident_key: str
    session: SessionData
    messages: list[dict[str, Any]]
    recommendations: list[dict[str, Any]]
    actions: list[dict[str, Any]]
    fabrications_published: int
    root_cause_hit: bool
    false_action: bool

    @property
    def passed(self) -> bool:
        return (
            self.fabrications_published == 0
            and self.root_cause_hit
            and not self.false_action
        )


DEFAULT_GUARDRAILS = [
    {"key": "max_budget_change_pct_per_day", "description": "max % change/day",
     "params": {"maxPct": 25}, "enabled": True},
    {"key": "max_budget_change_usd", "description": "max abs change",
     "params": {"maxUsd": 5000}, "enabled": True},
    {"key": "blast_radius_pct", "description": "blast radius",
     "params": {"maxPct": 10}, "enabled": True},
    {"key": "data_health_gate", "description": "health gate", "params": {}, "enabled": True},
]


def run_incident(
    incident: GoldenIncident, ledger: CostLedger | None = None
) -> IncidentResult:
    tenant_id = str(uuid4())
    session_id = str(uuid4())

    evidence = InMemoryEvidenceStore()
    sessions = InMemorySessionRepo(
        {
            session_id: SessionData(
                id=session_id,
                tenant_id=tenant_id,
                playbook_key=str(incident.playbook.get("key", incident.key)),
                title=incident.title,
                scope=incident.scope,
                phase="triage",
                status="running",
                budgets=dict(incident.playbook.get("budgets", {})),
            )
        }
    )
    messages = InMemoryMessageRepo(
        validator_factory=lambda: ProtocolValidator(evidence.known_ids())
    )
    tools = ToolRegistry(
        ctx=ToolContext(
            tenant_id=tenant_id,
            scope=incident.scope,
            metrics=FixtureMetricsClient(incident.metric_fixtures),
            data=InMemoryDataAccess(
                health=incident.health,
                experiments=incident.experiments,
                campaigns=incident.campaigns,
            ),
            evidence=evidence,
        )
    )
    publisher = InMemoryPublisher()
    # Scripts are consumed destructively; deep-copy so incidents are reusable.
    import copy

    gateway = LLMGateway(
        providers=[ScriptedProvider(copy.deepcopy(incident.script))],
        ledger=ledger or InMemoryLedger(),
        eval_mode=True,
    )
    deps = OrchestratorDeps(
        sessions=sessions,
        messages=messages,
        evidence=evidence,
        tools=tools,
        gateway=gateway,
        publisher=publisher,
        agents={name: cls() for name, cls in ROSTER.items()},
        playbook=incident.playbook,
        tenant_memory=incident.tenant_memory,
        guardrail_policies=incident.guardrail_policies or DEFAULT_GUARDRAILS,
    )
    session = Orchestrator(deps).run(session_id)

    posted = messages.list(session_id)
    # Fabrication scan over PUBLISHED state: claim-bearing messages must be
    # fully evidence-bound; recommendations must carry evidence.
    fabrications = 0
    known = evidence.known_ids()
    for m in posted:
        if m["type"] in ("finding", "hypothesis", "challenge"):
            if not m["evidence_ids"] or any(e not in known for e in m["evidence_ids"]):
                fabrications += 1
            if claim_has_raw_numbers(m["claim"]):
                fabrications += 1
    for rec in publisher.recommendations:
        if not rec["evidence_ids"]:
            fabrications += 1

    truth = incident.ground_truth
    decision_text = " ".join(
        [
            str((session.decision or {}).get("chosenOption", "")),
            str(session.abstract or ""),
        ]
    ).lower()
    expected_status = truth.get("expect_status")
    status_ok = expected_status is None or session.status == expected_status
    keyword = str(truth.get("root_cause_keyword", "")).lower()
    keyword_ok = (not keyword) or keyword in decision_text
    root_cause_hit = status_ok and keyword_ok

    false_action = bool(truth.get("expect_no_actions")) and len(publisher.actions) > 0

    return IncidentResult(
        incident_key=incident.key,
        session=session,
        messages=posted,
        recommendations=publisher.recommendations,
        actions=publisher.actions,
        fabrications_published=fabrications,
        root_cause_hit=root_cause_hit,
        false_action=false_action,
    )
