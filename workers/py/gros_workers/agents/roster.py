"""The five super-agents (docs/05 §5.1–5.5).

Each agent = identity prompt + deterministic tool plan + structured outputs.
Internal specialist capabilities live in the prompt packs; tool access is
enforced by the registry allowlist, not by prompt politeness.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..llm.gateway import GatewayCall
from ..protocol import MessageDraft, MessageType
from .base import Agent, AgentEnv


def _default_window(scope: dict[str, Any], days: int = 28) -> dict[str, str]:
    to = str(scope.get("dateTo") or date.today().isoformat())
    frm = str(
        scope.get("dateFrom")
        or (date.fromisoformat(to) - timedelta(days=days)).isoformat()
    )
    return {"from": frm, "to": to}


def _scope_filters(scope: dict[str, Any]) -> dict[str, Any]:
    filters: dict[str, Any] = {}
    for k_scope, k_dim in (
        ("country", "country"),
        ("channel", "channel"),
        ("campaignId", "campaign_id"),
    ):
        if scope.get(k_scope):
            filters[k_dim] = scope[k_scope]
    return filters


# ── Tracking / Data Agent ─────────────────────────────────────────────────────


class TrackingAgent(Agent):
    name = "tracking"
    tier = "fast"
    prompt_file = "tracking.md"

    def tool_plan(self, env: AgentEnv) -> list[tuple[str, dict[str, Any]]]:
        return [("get_data_health", {})]

    def gate(self, env: AgentEnv) -> tuple[bool, MessageDraft]:
        """Health gate: deterministic verdict from the health evidence; the
        agent's authority is structural (docs/05 §5.5), no LLM needed here."""
        rec = env.tools.execute(self.name, "get_data_health")
        label = f"E{len(env.label_map) + 1}"
        env.label_map[label] = rec
        red = rec.result_digest.get("red", [])
        relevant = set(env.scope.get("healthDomains", ["spend", "attribution"]))
        blocking = sorted(relevant.intersection(red))
        if blocking:
            draft = MessageDraft(
                agent=self.name,
                type=MessageType.finding,
                claim=(
                    f"Data health gate FAILED: domain(s) {', '.join(blocking)} are red "
                    f"({{ev:{rec.id}:domains}}). Conclusions on this scope would stand on "
                    "broken data; the investigation is parked until tracking is fixed "
                    "or a human overrides the gate."
                ),
                evidence_ids=[rec.id],
                confidence=0.95,
            )
            return False, draft
        yellow = rec.result_digest.get("yellow", [])
        draft = MessageDraft(
            agent=self.name,
            type=MessageType.finding,
            claim=(
                "Data health gate passed: no red domains in scope "
                + (f"(yellow: {', '.join(yellow)} — confidence will be penalized). "
                   if yellow else ". ")
                + f"Domain status: {{ev:{rec.id}:domains}}."
            ),
            evidence_ids=[rec.id],
            confidence=0.9,
        )
        return True, draft


# ── Intelligence Agent ────────────────────────────────────────────────────────


class IntelligenceAgent(Agent):
    name = "intelligence"
    tier = "frontier"
    prompt_file = "intelligence.md"

    def tool_plan(self, env: AgentEnv) -> list[tuple[str, dict[str, Any]]]:
        scope = env.scope
        metric = str(scope.get("metricKey", "roas_d7"))
        window = _default_window(scope)
        mid = (
            date.fromisoformat(window["from"])
            + (date.fromisoformat(window["to"]) - date.fromisoformat(window["from"])) / 2
        ).isoformat()
        filters = _scope_filters(scope)
        plan: list[tuple[str, dict[str, Any]]] = [
            (
                "query_metrics",
                {"metric_key": metric, "range_": window, "filters": filters},
            ),
            (
                "decompose_metric_change",
                {
                    "metric_key": metric,
                    "window_a": {"from": window["from"], "to": mid},
                    "window_b": {"from": mid, "to": window["to"]},
                    "dimensions": [str(d) for d in scope.get(
                        "decomposeDimensions", ["country", "campaign_id"]
                    )],
                    "filters": filters,
                },
            ),
            ("get_experiments", {"window_from": window["from"], "window_to": window["to"]}),
        ]
        return plan

    def investigate(self, env: AgentEnv) -> list[MessageDraft]:
        records = self.run_tools(env)
        # correlate_events runs on the primary metric series evidence.
        metric_ev = next((r for r in records if r.kind == "metric_query"), None)
        if metric_ev is not None:
            window = _default_window(env.scope)
            rec = env.tools.execute(
                self.name,
                "correlate_events",
                metric_evidence_id=metric_ev.id,
                window_from=window["from"],
                window_to=window["to"],
            )
            env.label_map[f"E{len(env.label_map) + 1}"] = rec
        return self._reason(env)

    def _reason(self, env: AgentEnv) -> list[MessageDraft]:
        from .base import InvestigationOutput

        out = env.gateway.complete_structured(
            GatewayCall(
                tenant_id=env.tenant_id,
                purpose="intelligence.investigate",
                tier=self.tier,
                system=self.system_prompt("investigation"),
                user_content=(
                    f"INVESTIGATION: {env.title}\nScope: {env.scope}\n"
                    f"Tenant context: {env.tenant_memory}\n\n"
                    f"EVIDENCE:\n{self.evidence_brief(env)}\n\n"
                    f"PRIOR MESSAGES:\n{self.messages_brief(env)}\n\n"
                    "Diagnose: what moved, where (dimensional decomposition), and what "
                    "known events coincide. Distinguish demand-side (IPM/CTR) from "
                    "auction-side (CPM) mechanisms when the evidence allows."
                ),
                session_id=env.session_id,
                agent=self.name,
            ),
            InvestigationOutput,
        )
        return self.to_drafts(env, out.messages)


# ── Creative Agent ────────────────────────────────────────────────────────────


class CreativeAgent(Agent):
    name = "creative"
    tier = "frontier"
    prompt_file = "creative.md"

    def tool_plan(self, env: AgentEnv) -> list[tuple[str, dict[str, Any]]]:
        scope = env.scope
        window = _default_window(scope)
        filters = _scope_filters(scope)
        creative_filters: dict[str, Any] = {}
        if scope.get("creativeId"):
            creative_filters["creative_id"] = scope["creativeId"]
        if scope.get("channel"):
            creative_filters["channel"] = scope["channel"]
        if scope.get("country"):
            creative_filters["country"] = scope["country"]
        return [
            ("fatigue_check", {"creative_filters": creative_filters, "range_": window}),
            (
                "query_metrics",
                {"metric_key": "creative_ctr", "range_": window,
                 "filters": creative_filters or filters},
            ),
            (
                "query_metrics",
                {"metric_key": "creative_spend", "range_": window,
                 "filters": creative_filters or filters},
            ),
        ]


class CreativeBrief(BaseModel):
    concept: str
    hook_line: str
    first_3_seconds: str
    format: Literal["video", "image", "playable"]
    variation_axes: list[str]
    rationale: str
    rationale_evidence_labels: list[str] = Field(min_length=1)


class BriefSet(BaseModel):
    briefs: list[CreativeBrief] = Field(min_length=1, max_length=5)


# ── Growth Director Agent ─────────────────────────────────────────────────────


class RejectedAlternative(BaseModel):
    option: str
    reason: str


class ChallengeResolution(BaseModel):
    challenge_seq: int
    resolution: str


class DirectiveResponse(BaseModel):
    directive_seq: int
    response: str


class ActionBrief(BaseModel):
    kind: Literal["budget_change", "pause_entity", "creative_rotation"]
    entity_id: str
    objective: str
    budget_change_pct: float | None = Field(default=None, ge=-90, le=200)


class DecisionOutput(BaseModel):
    outcome: Literal["action_proposed", "monitor", "escalated"]
    chosen_option: str
    rejected_alternatives: list[RejectedAlternative] = Field(default_factory=list)
    risk_statement: str
    re_evaluation_conditions: list[str] = Field(default_factory=list)
    challenge_resolutions: list[ChallengeResolution] = Field(default_factory=list)
    directive_responses: list[DirectiveResponse] = Field(default_factory=list)
    action_briefs: list[ActionBrief] = Field(default_factory=list)
    summary: str


class GrowthDirectorAgent(Agent):
    name = "growth_director"
    tier = "frontier"
    prompt_file = "growth_director.md"

    def synthesize(self, env: AgentEnv) -> DecisionOutput:
        open_challenges = [
            m for m in env.prior_messages if m["type"] == "challenge"
        ]
        directives = [m for m in env.prior_messages if m["type"] == "directive"]
        out = env.gateway.complete_structured(
            GatewayCall(
                tenant_id=env.tenant_id,
                purpose="growth_director.synthesize",
                tier=self.tier,
                system=self.system_prompt("synthesis"),
                user_content=(
                    f"SYNTHESIS: {env.title}\nScope: {env.scope}\n"
                    f"Tenant context: {env.tenant_memory}\n\n"
                    f"EVIDENCE:\n{self.evidence_brief(env)}\n\n"
                    f"FULL THREAD:\n{self.messages_brief(env)}\n\n"
                    f"OPEN CHALLENGES (every one MUST be resolved): "
                    f"{[m['seq'] for m in open_challenges]}\n"
                    f"USER DIRECTIVES (every one MUST be addressed): "
                    f"{[m['seq'] for m in directives]}\n\n"
                    "Run your Devil's Advocate pass before deciding. If evidence is "
                    "thin, the honest outcome is 'monitor' with re-evaluation "
                    "conditions — a forced action is a failure."
                ),
                session_id=env.session_id,
                agent=self.name,
            ),
            DecisionOutput,
        )
        # Orchestrator-enforced: unresolved challenges void the decision.
        resolved = {r.challenge_seq for r in out.challenge_resolutions}
        missing = [m["seq"] for m in open_challenges if m["seq"] not in resolved]
        if missing:
            raise ValueError(f"decision left challenges unresolved: {missing}")
        addressed = {r.directive_seq for r in out.directive_responses}
        missing_dir = [m["seq"] for m in directives if m["seq"] not in addressed]
        if missing_dir:
            raise ValueError(f"decision ignored user directives: {missing_dir}")
        return out


# ── Operations Agent ──────────────────────────────────────────────────────────


class ActionDraftOut(BaseModel):
    kind: Literal["budget_change", "pause_entity", "creative_rotation"]
    entity_id: str
    summary: str
    budget_change_pct: float | None = Field(default=None, ge=-90, le=200)
    rotation_note: str | None = None
    rollback_note: str
    monitoring_metric: str = "cpi"
    revert_threshold_pct: float = Field(default=20, ge=1, le=100)


class OperationsOutput(BaseModel):
    actions: list[ActionDraftOut] = Field(default_factory=list)
    feasibility_vetoes: list[str] = Field(default_factory=list)


class OperationsAgent(Agent):
    name = "operations"
    tier = "frontier"
    prompt_file = "operations.md"

    def prepare(self, env: AgentEnv, decision: DecisionOutput) -> OperationsOutput:
        # Ground the entity registry before preparing anything.
        rec = env.tools.execute(self.name, "list_entities")
        env.label_map[f"E{len(env.label_map) + 1}"] = rec
        entity_ids = {
            str(c["id"]) for c in rec.result_digest.get("campaigns", [])
        }
        out = env.gateway.complete_structured(
            GatewayCall(
                tenant_id=env.tenant_id,
                purpose="operations.prepare",
                tier=self.tier,
                system=self.system_prompt("action_prep"),
                user_content=(
                    f"ACTION PREPARATION for decision: {decision.chosen_option}\n"
                    f"Action briefs from Growth Director: "
                    f"{[b.model_dump() for b in decision.action_briefs]}\n\n"
                    f"ENTITY REGISTRY:\n{rec.result_digest}\n\n"
                    "Prepare platform-shaped action drafts. Every action MUST have a "
                    "rollback note and a monitoring metric with a revert threshold. "
                    "Use ONLY entity ids from the registry. Veto on feasibility if a "
                    "brief cannot be safely executed; never veto on strategy."
                ),
                session_id=env.session_id,
                agent=self.name,
            ),
            OperationsOutput,
        )
        bad = [a.entity_id for a in out.actions if a.entity_id not in entity_ids]
        if bad:
            raise ValueError(f"operations referenced unknown entities: {bad}")
        return out


ROSTER: dict[str, type[Agent]] = {
    "tracking": TrackingAgent,
    "intelligence": IntelligenceAgent,
    "creative": CreativeAgent,
    "growth_director": GrowthDirectorAgent,
    "operations": OperationsAgent,
}
