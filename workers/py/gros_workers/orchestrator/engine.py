"""The deterministic orchestrator (docs/05 §5.6).

Code decides phase transitions, budgets, and termination; LLMs act only
inside phase steps. Every phase persists state before proceeding, so any
worker can resume a session after a crash.

Phases: triage → health_gate → investigation → debate → synthesis →
action_prep → review → published. Failure modes are honest terminal states:
parked (red data), budget_exceeded, failed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from ..agents.base import AgentEnv
from ..agents.roster import (
    DecisionOutput,
    GrowthDirectorAgent,
    OperationsAgent,
    TrackingAgent,
)
from ..evidence import EvidenceStore
from ..llm.gateway import BudgetExceeded, LLMGateway
from ..protocol import MessageDraft, MessageType, ProtocolValidator, ProtocolViolation
from ..recommend.confidence import compute_confidence
from ..recommend.guardrails import GuardrailContext, evaluate_guardrails
from ..recommend.impact import (
    estimate_budget_change,
    estimate_creative_rotation,
    estimate_pause,
)
from ..recommend.publish import PreparedAction, PreparedRecommendation, Publisher
from ..tools import ToolRegistry
from .state import MessageRepo, SessionData, SessionRepo

log = logging.getLogger(__name__)


@dataclass
class OrchestratorDeps:
    sessions: SessionRepo
    messages: MessageRepo
    evidence: EvidenceStore
    tools: ToolRegistry
    gateway: LLMGateway
    publisher: Publisher
    agents: dict[str, Any]
    playbook: dict[str, Any]
    tenant_memory: dict[str, Any]
    guardrail_policies: list[dict[str, Any]]


class Orchestrator:
    def __init__(self, deps: OrchestratorDeps):
        self.d = deps

    def validator(self) -> ProtocolValidator:
        return ProtocolValidator(self.d.evidence.known_ids())

    def _post(self, session: SessionData, draft: MessageDraft) -> dict[str, Any]:
        return self.d.messages.post(session.id, draft)

    def _orchestrator_note(self, session: SessionData, claim: str) -> None:
        self._post(
            session,
            MessageDraft(agent="orchestrator", type=MessageType.resolution, claim=claim),
        )

    def _env(self, session: SessionData) -> AgentEnv:
        budgets = session.budgets or {}
        return AgentEnv(
            tenant_id=session.tenant_id,
            session_id=session.id,
            title=session.title,
            scope=session.scope,
            tools=self.d.tools,
            gateway=self.d.gateway,
            evidence=self.d.evidence,
            label_map=getattr(self, "_label_map", {}),
            prior_messages=self.d.messages.list(session.id),
            tenant_memory=self.d.tenant_memory,
            max_tool_calls=int(budgets.get("maxToolCallsPerAgent", 12)),
        )

    # ── main entry ────────────────────────────────────────────────────────────

    def run(self, session_id: str) -> SessionData:
        self._label_map: dict[str, Any] = {}
        session = self.d.sessions.load(session_id)
        phases: list[str] = list(
            self.d.playbook.get(
                "phases",
                ["triage", "health_gate", "investigation", "debate", "synthesis",
                 "action_prep", "review"],
            )
        )
        try:
            decision: DecisionOutput | None = None
            for phase in phases:
                session = self.d.sessions.load(session_id)
                if session.status not in ("running",):
                    return session  # already terminal (resume-after-finish guard)
                if not self._phase_reached(session.phase, phase, phases):
                    continue  # resume: skip completed phases
                if phase == "triage":
                    self._phase_triage(session)
                elif phase == "health_gate":
                    if not self._phase_health_gate(session):
                        return self.d.sessions.load(session_id)
                elif phase == "investigation":
                    self._phase_investigation(session)
                elif phase == "debate":
                    self._phase_debate(session)
                elif phase == "synthesis":
                    decision = self._phase_synthesis(session)
                elif phase == "action_prep":
                    assert decision is not None, "action_prep before synthesis"
                    if decision.outcome != "action_proposed" or not decision.action_briefs:
                        self._orchestrator_note(
                            session,
                            "No actions to prepare: decision outcome is "
                            f"'{decision.outcome}'.",
                        )
                        continue
                    self._phase_action_prep(session, decision)
                elif phase == "review":
                    assert decision is not None, "review before synthesis"
                    self._phase_review(session, decision)
            return self.d.sessions.load(session_id)
        except BudgetExceeded as err:
            self._finish_honestly(
                session_id,
                "budget_exceeded",
                f"Session stopped at budget cap: {err}. Findings up to this point "
                "are preserved; nothing beyond them was examined.",
            )
            return self.d.sessions.load(session_id)
        except ProtocolViolation as err:
            # A fabrication attempt was caught. The session fails loudly and
            # the violation is preserved for agent QA.
            self._finish_honestly(
                session_id,
                "failed",
                f"Protocol violation caught by validator: {err}. "
                "No unverified claim was published.",
            )
            return self.d.sessions.load(session_id)
        except Exception as err:  # noqa: BLE001 — terminal error path
            log.exception("session %s failed", session_id)
            self._finish_honestly(session_id, "failed", f"Session failed: {err}")
            return self.d.sessions.load(session_id)

    def _phase_reached(self, current: str, target: str, phases: list[str]) -> bool:
        try:
            return phases.index(target) >= phases.index(current)
        except ValueError:
            return True

    def _next_phase(self, current: str) -> str:
        phases: list[str] = list(self.d.playbook.get("phases", []))
        try:
            idx = phases.index(current)
            return phases[idx + 1] if idx + 1 < len(phases) else "review"
        except ValueError:
            return "review"

    def _finish_honestly(self, session_id: str, status: str, note: str) -> None:
        try:
            session = self.d.sessions.load(session_id)
            self._orchestrator_note(session, note)
        except Exception:  # noqa: BLE001 — best-effort note
            log.exception("could not write final note for %s", session_id)
        self.d.sessions.finish(session_id, status, abstract=note)

    # ── phases ────────────────────────────────────────────────────────────────

    def _phase_triage(self, session: SessionData) -> None:
        self._orchestrator_note(
            session,
            f"Session opened (playbook: {session.playbook_key}). Scope: {session.scope}.",
        )
        self.d.sessions.transition(session.id, self._next_phase("triage"))

    def _phase_health_gate(self, session: SessionData) -> bool:
        tracking: TrackingAgent = self.d.agents["tracking"]
        env = self._env(session)
        ok, draft = tracking.gate(env)
        self._post(session, draft)
        if not ok:
            self.d.sessions.transition(session.id, "parked", status="parked")
            self.d.sessions.finish(
                session.id,
                "parked",
                abstract="Parked at the data health gate: the affected domain is red. "
                "Fix tracking or override the gate to continue.",
            )
            return False
        self.d.sessions.transition(session.id, "investigation")
        return True

    def _phase_investigation(self, session: SessionData) -> None:
        roster: list[str] = [
            a
            for a in self.d.playbook.get("roster", [])
            if a not in ("growth_director", "operations")
        ]
        gate_ran = "health_gate" in self.d.playbook.get("phases", [])
        posted = 0
        for agent_name in roster:
            agent = self.d.agents.get(agent_name)
            if agent is None:
                continue
            if agent_name == "tracking" and gate_ran:
                continue  # tracking already contributed at the gate
            env = self._env(session)
            drafts = agent.investigate(env)
            for draft in drafts:
                self._post(session, draft)
                posted += 1
        if posted == 0:
            self._orchestrator_note(
                session, "Investigation produced no findings; evidence was insufficient."
            )
        self.d.sessions.transition(session.id, self._next_phase("investigation"))

    def _phase_debate(self, session: SessionData) -> None:
        max_rounds = int(self.d.playbook.get("budgets", {}).get("maxDebateRounds", 2))
        debaters = [
            a
            for a in self.d.playbook.get("roster", [])
            if a not in ("operations", "growth_director")
        ]
        for round_idx in range(max_rounds):
            new_challenges = 0
            for agent_name in debaters:
                agent = self.d.agents.get(agent_name)
                if agent is None or agent_name == "tracking":
                    continue
                env = self._env(session)
                for draft in agent.debate(env):
                    msg = self._post(session, draft)
                    if msg["type"] == "challenge":
                        new_challenges += 1
            if new_challenges == 0:
                self._orchestrator_note(
                    session, f"Debate converged after round {round_idx + 1}."
                )
                break
        self.d.sessions.transition(session.id, self._next_phase("debate"))

    def _phase_synthesis(self, session: SessionData) -> DecisionOutput:
        director: GrowthDirectorAgent = self.d.agents["growth_director"]
        env = self._env(session)
        decision = director.synthesize(env)
        for res in decision.challenge_resolutions:
            seq_to_id = {m["seq"]: m["id"] for m in env.prior_messages}
            self._post(
                session,
                MessageDraft(
                    agent="growth_director",
                    type=MessageType.resolution,
                    claim=res.resolution,
                    in_reply_to=seq_to_id.get(res.challenge_seq),
                ),
            )
        for dres in decision.directive_responses:
            self._post(
                session,
                MessageDraft(
                    agent="growth_director",
                    type=MessageType.resolution,
                    claim=dres.response,
                ),
            )
        self._post(
            session,
            MessageDraft(
                agent="growth_director",
                type=MessageType.proposal,
                claim=f"DECISION ({decision.outcome}): {decision.chosen_option}",
                payload={"riskStatement": decision.risk_statement},
            ),
        )
        if decision.outcome == "action_proposed" and decision.action_briefs:
            self.d.sessions.transition(session.id, "action_prep")
        else:
            self.d.sessions.transition(session.id, "review")
        return decision

    def _phase_action_prep(self, session: SessionData, decision: DecisionOutput) -> None:
        ops: OperationsAgent = self.d.agents["operations"]
        env = self._env(session)
        out = ops.prepare(env, decision)
        for veto in out.feasibility_vetoes:
            self._post(
                session,
                MessageDraft(agent="operations", type=MessageType.proposal,
                             claim=f"Feasibility veto: {veto}"),
            )
        self._prepared_actions = out.actions
        self.d.sessions.transition(session.id, "review")

    def _phase_review(self, session: SessionData, decision: DecisionOutput) -> None:
        evidence_records = [self.d.evidence.get(eid) for eid in self.d.evidence.known_ids()]
        messages = self.d.messages.list(session.id)

        health = next(
            (r for r in evidence_records if r.kind == "recon_report"), None
        )
        yellow = list(health.result_digest.get("yellow", [])) if health else []
        health_domains = dict(health.result_digest.get("domains", {})) if health else {}

        conf = compute_confidence(evidence_records, messages, yellow)

        actions: list[PreparedAction] = []
        predicted_impact: dict[str, Any] | None = None
        drafts = getattr(self, "_prepared_actions", [])
        for a in drafts:
            entity = self.d.tools.ctx.data.campaign(a.entity_id) or {}
            daily_budget = float(entity.get("budget_amount") or 0)
            change_pct = a.budget_change_pct or 0.0
            magnitude = (
                abs(daily_budget * change_pct / 100.0)
                if a.kind == "budget_change"
                else daily_budget
            )
            tenant_daily_spend = float(
                self.d.tenant_memory.get("tenantDailySpendUsd", 0)
            ) or daily_budget * 10
            geval = evaluate_guardrails(
                kind=a.kind,
                change_pct=change_pct if a.kind == "budget_change" else None,
                magnitude_usd=magnitude,
                policies=self.d.guardrail_policies,
                ctx=GuardrailContext(
                    entity_daily_budget_usd=daily_budget,
                    tenant_daily_spend_usd=tenant_daily_spend,
                    health_domains={str(k): str(v) for k, v in health_domains.items()},
                    hours_since_last_entity_change=None,
                    entity_managed_state=str(entity.get("managed_state", "observed")),
                ),
            )
            new_budget = round(daily_budget * (1 + change_pct / 100.0), 2)
            if a.kind == "budget_change":
                diff = {
                    "summary": a.summary,
                    "entries": [
                        {
                            "field": "daily_budget_usd",
                            "entity": str(entity.get("name", a.entity_id)),
                            "before": daily_budget,
                            "after": new_budget,
                        }
                    ],
                }
                predicted_impact = estimate_budget_change(
                    daily_budget, change_pct,
                    basis_evidence_ids=[r.id for r in evidence_records[:3]],
                )
                rollback = {"steps": [f"Restore daily budget to {daily_budget}"],
                            "note": a.rollback_note}
            elif a.kind == "pause_entity":
                diff = {
                    "summary": a.summary,
                    "entries": [
                        {
                            "field": "status",
                            "entity": str(entity.get("name", a.entity_id)),
                            "before": str(entity.get("status", "active")),
                            "after": "paused",
                        }
                    ],
                }
                predicted_impact = estimate_pause(
                    daily_budget, basis_evidence_ids=[r.id for r in evidence_records[:3]]
                )
                rollback = {"steps": ["Resume entity with prior settings"],
                            "note": a.rollback_note}
            else:  # creative_rotation
                fatigue = next(
                    (r for r in evidence_records
                     if r.kind == "computation" and "totalDeclinePct" in r.result_digest),
                    None,
                )
                decline = float(
                    fatigue.result_digest.get("totalDeclinePct", 20) if fatigue else 20
                )
                diff = {
                    "summary": a.summary,
                    "entries": [
                        {
                            "field": "creative_rotation",
                            "entity": str(entity.get("name", a.entity_id)),
                            "before": "current asset mix",
                            "after": a.rotation_note or "rotate fatigued assets out",
                        }
                    ],
                }
                predicted_impact = estimate_creative_rotation(
                    daily_budget, decline,
                    basis_evidence_ids=[fatigue.id] if fatigue else [],
                )
                rollback = {"steps": ["Re-enable previous asset mix"], "note": a.rollback_note}

            actions.append(
                PreparedAction(
                    kind=a.kind,
                    target={"entityType": "campaign", "entityId": a.entity_id},
                    diff=diff,
                    payload={
                        "magnitudeUsd": magnitude,
                        "healthDomain": "spend",
                        "changePct": change_pct,
                        "platformPayload": {
                            "note": "platform adapter payload — execution not enabled at L2",
                            "entityExternalRef": a.entity_id,
                            "newDailyBudgetUsd": new_budget if a.kind == "budget_change" else None,
                        },
                    },
                    execution_plan={
                        "steps": [a.summary],
                        "mode": "prepared_only_L2",
                    },
                    rollback_plan=rollback,
                    monitoring_plan={
                        "watchMetric": a.monitoring_metric,
                        "revertThresholdPct": a.revert_threshold_pct,
                        "windowDays": 7,
                    },
                    guardrail_eval=geval,
                )
            )

        rec = PreparedRecommendation(
            title=session.title,
            summary=decision.summary,
            category=self._category_for(decision),
            confidence=conf.score,
            confidence_breakdown=conf.breakdown,
            predicted_impact=predicted_impact,
            evidence_ids=[r.id for r in evidence_records],
            playbook_key=session.playbook_key,
            actions=actions,
        )
        result = self.d.publisher.publish(session.id, rec)
        self._orchestrator_note(
            session,
            f"Published recommendation {result['recommendationId']} with "
            f"{len(result['actionIds'])} prepared action(s) awaiting approval. "
            f"Confidence {conf.score} ({conf.breakdown}).",
        )
        decision_record = {
            "outcome": decision.outcome,
            "chosenOption": decision.chosen_option,
            "rejectedAlternatives": [r.model_dump() for r in decision.rejected_alternatives],
            "confidence": conf.score,
            "confidenceBreakdown": conf.breakdown,
            "predictedImpact": predicted_impact,
            "riskStatement": decision.risk_statement,
            "reEvaluationConditions": decision.re_evaluation_conditions,
        }
        self.d.sessions.transition(session.id, "published", status="published")
        self.d.sessions.finish(
            session.id,
            "published",
            decision=decision_record,
            abstract=decision.summary,
        )

    def _category_for(self, decision: DecisionOutput) -> str:
        kinds = {b.kind for b in decision.action_briefs}
        if "creative_rotation" in kinds:
            return "creative"
        if kinds:
            return "budget"
        return "product"
