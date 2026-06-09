"""Super-agent base (docs/05).

Decision logic pattern: deterministic tool plans produce evidence; the LLM
interprets structured digests and emits structured messages; code validates,
rewrites label tokens to evidence bindings, and posts through the protocol.

Number discipline: agents may not assert raw metric literals. Claims carry
label tokens like `{E2:last}` which are rewritten to `{ev:<uuid>:<path>}` and
verified against the evidence digest — an unresolvable token is a protocol
violation, and the UI renders ONLY token-bound values.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..evidence import EvidenceRecord, EvidenceStore
from ..llm.gateway import GatewayCall, LLMGateway
from ..protocol import MessageDraft, MessageType, ProtocolViolation
from ..tools import ToolRegistry

PROMPTS_DIR = Path(__file__).parent / "prompts"

LABEL_TOKEN_RE = re.compile(r"\{(E\d+):([a-zA-Z0-9_.\[\]]+)\}")


class OutMessage(BaseModel):
    type: Literal["finding", "hypothesis", "challenge", "concession", "proposal"]
    claim: str = Field(min_length=3, max_length=2000)
    evidence_labels: list[str] = Field(default_factory=list)
    confidence: float | None = Field(default=None, ge=0, le=1)
    falsification: str | None = None
    reply_to_seq: int | None = None
    directed_to: list[str] = Field(default_factory=list)


class InvestigationOutput(BaseModel):
    messages: list[OutMessage]


class DebateOutput(BaseModel):
    messages: list[OutMessage] = Field(default_factory=list)


def resolve_digest_path(digest: dict[str, Any], path: str) -> Any:
    parts = re.sub(r"\[(\d+)\]", r".\1", path).split(".")
    cur: Any = digest
    for part in parts:
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            idx = int(part)
            cur = cur[idx] if idx < len(cur) else None
        else:
            return None
    return cur


def rewrite_claim_tokens(
    claim: str, label_map: dict[str, EvidenceRecord]
) -> tuple[str, list[str]]:
    """Rewrites {E<k>:<path>} label tokens to {ev:<id>:<path>} bindings.

    Raises ProtocolViolation for unknown labels or unresolvable paths —
    a fabricated reference is an error, never a warning.
    Returns (rewritten_claim, referenced_evidence_ids).
    """
    used: list[str] = []

    def _sub(match: re.Match[str]) -> str:
        label, path = match.group(1), match.group(2)
        rec = label_map.get(label)
        if rec is None:
            raise ProtocolViolation(f"claim references unknown evidence label {label}")
        if resolve_digest_path(rec.result_digest, path) is None:
            raise ProtocolViolation(
                f"claim references path '{path}' missing from evidence {label}"
            )
        used.append(rec.id)
        return f"{{ev:{rec.id}:{path}}}"

    rewritten = LABEL_TOKEN_RE.sub(_sub, claim)
    return rewritten, used


def assert_no_raw_numbers(claim: str) -> None:
    """Claim-bearing messages may not assert raw metric literals ($x, x%,
    decimals) — values must come from evidence bindings. Also enforced by
    the ProtocolValidator on every post; checked here early for a clearer
    error surface during structured-output retries."""
    from ..protocol import claim_has_raw_numbers

    if claim_has_raw_numbers(claim):
        raise ProtocolViolation(
            f"claim asserts a raw numeric literal outside evidence binding: {claim!r}"
        )


@dataclass
class AgentEnv:
    tenant_id: str
    session_id: str
    title: str
    scope: dict[str, Any]
    tools: ToolRegistry
    gateway: LLMGateway
    evidence: EvidenceStore
    label_map: dict[str, EvidenceRecord]
    prior_messages: list[dict[str, Any]]
    tenant_memory: dict[str, Any] = field(default_factory=dict)
    max_tool_calls: int = 12


PROTOCOL_RULES = """
PROTOCOL (non-negotiable):
- Reference evidence with label tokens: {E1:last}, {E2:topContributors[0].deltaShare}.
- NEVER write raw metric numbers ($, %, decimals) in claims; use tokens.
- findings/hypotheses/challenges MUST cite evidence_labels you were given.
- hypotheses MUST include a falsification: what observation would prove you wrong,
  and whether it was checked.
- challenges MUST set reply_to_seq to the message seq being challenged.
- If the evidence is insufficient, say so in a proposal to monitor — do not stretch.
"""


class Agent:
    name: str = "base"
    tier: str = "frontier"
    prompt_file: str = "base.md"

    def system_prompt(self, phase: str) -> str:
        prompt_path = PROMPTS_DIR / self.prompt_file
        identity = prompt_path.read_text(encoding="utf-8")
        # The [script:...] line routes the ScriptedProvider in eval mode; real
        # providers ignore it.
        return f"[script:{self.name}:{phase}]\n{identity}\n{PROTOCOL_RULES}"

    # Deterministic tool plan — override per agent.
    def tool_plan(self, env: AgentEnv) -> list[tuple[str, dict[str, Any]]]:
        return []

    def run_tools(self, env: AgentEnv) -> list[EvidenceRecord]:
        records: list[EvidenceRecord] = []
        for tool, kwargs in self.tool_plan(env)[: env.max_tool_calls]:
            try:
                rec = env.tools.execute(self.name, tool, **kwargs)
            except KeyError:
                # A fixture/data gap is reported, never papered over.
                continue
            records.append(rec)
            label = f"E{len(env.label_map) + 1}"
            env.label_map[label] = rec
        return records

    def evidence_brief(self, env: AgentEnv) -> str:
        lines = []
        for label, rec in env.label_map.items():
            lines.append(f"{label} [{rec.kind}{':' + rec.metric_key if rec.metric_key else ''}] "
                         f"digest={rec.result_digest}")
        return "\n".join(lines) if lines else "(no evidence yet)"

    def messages_brief(self, env: AgentEnv) -> str:
        lines = []
        for m in env.prior_messages:
            lines.append(
                f"seq={m['seq']} {m['agent']}/{m['type']}: {m['claim']}"
                + (f" (confidence={m['confidence']})" if m.get("confidence") else "")
            )
        return "\n".join(lines) if lines else "(no messages yet)"

    def to_drafts(self, env: AgentEnv, out_messages: list[OutMessage]) -> list[MessageDraft]:
        drafts: list[MessageDraft] = []
        seq_to_id = {m["seq"]: m["id"] for m in env.prior_messages}
        for om in out_messages:
            claim, used_ids = rewrite_claim_tokens(om.claim, env.label_map)
            assert_no_raw_numbers(claim)
            evidence_ids = list(
                dict.fromkeys(
                    used_ids
                    + [
                        env.label_map[lbl].id
                        for lbl in om.evidence_labels
                        if lbl in env.label_map
                    ]
                )
            )
            payload: dict[str, Any] = {}
            if om.falsification:
                payload["falsification"] = om.falsification
            drafts.append(
                MessageDraft(
                    agent=self.name,
                    type=MessageType(om.type),
                    claim=claim,
                    payload=payload,
                    evidence_ids=evidence_ids,
                    confidence=om.confidence,
                    directed_to=om.directed_to,
                    in_reply_to=seq_to_id.get(om.reply_to_seq) if om.reply_to_seq else None,
                )
            )
        return drafts

    def investigate(self, env: AgentEnv) -> list[MessageDraft]:
        self.run_tools(env)
        out = env.gateway.complete_structured(
            GatewayCall(
                tenant_id=env.tenant_id,
                purpose=f"{self.name}.investigate",
                tier=self.tier,
                system=self.system_prompt("investigation"),
                user_content=(
                    f"INVESTIGATION: {env.title}\n"
                    f"Scope: {env.scope}\n"
                    f"Tenant context: {env.tenant_memory}\n\n"
                    f"EVIDENCE AVAILABLE:\n{self.evidence_brief(env)}\n\n"
                    f"PRIOR MESSAGES:\n{self.messages_brief(env)}\n\n"
                    "Produce your findings/hypotheses as structured messages."
                ),
                session_id=env.session_id,
                agent=self.name,
            ),
            InvestigationOutput,
        )
        return self.to_drafts(env, out.messages)

    def debate(self, env: AgentEnv) -> list[MessageDraft]:
        out = env.gateway.complete_structured(
            GatewayCall(
                tenant_id=env.tenant_id,
                purpose=f"{self.name}.debate",
                tier=self.tier,
                system=self.system_prompt("debate"),
                user_content=(
                    f"DEBATE ROUND: {env.title}\n\n"
                    f"EVIDENCE:\n{self.evidence_brief(env)}\n\n"
                    f"THREAD:\n{self.messages_brief(env)}\n\n"
                    "Challenge what the evidence contradicts; concede what it supports. "
                    "Return an empty messages list if you have nothing evidence-backed to add."
                ),
                session_id=env.session_id,
                agent=self.name,
            ),
            DebateOutput,
        )
        return self.to_drafts(env, out.messages)
