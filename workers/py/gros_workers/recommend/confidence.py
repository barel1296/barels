"""Confidence rubric (docs/09 §9.6): computed in code from session state,
never free-formed by an LLM. Returns the score and its breakdown — the
breakdown is displayed to users and feeds calibration tracking.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..evidence import EvidenceRecord

WEIGHTS = {
    "evidence_strength": 0.35,
    "cross_agent_agreement": 0.20,
    "playbook_prior": 0.25,
    "mechanism_clarity": 0.20,
}
HEALTH_PENALTY = 0.15
DEFAULT_PLAYBOOK_PRIOR = 0.6


@dataclass
class ConfidenceResult:
    score: float
    breakdown: dict[str, float]


def evidence_score(rec: EvidenceRecord) -> float:
    """Per-artifact quality: sample adequacy proxy + kind prior."""
    digest = rec.result_digest
    base = 0.8 if rec.kind in ("metric_query", "computation") else 0.7
    rows = digest.get("rowCount") or digest.get("points") or 0
    try:
        n = int(rows)
    except (TypeError, ValueError):
        n = 0
    sample = min(1.0, n / 14) if n else 0.5
    return round(base * (0.5 + 0.5 * sample), 3)


def compute_confidence(
    evidence: list[EvidenceRecord],
    messages: list[dict[str, Any]],
    yellow_domains: list[str],
    playbook_prior: float = DEFAULT_PLAYBOOK_PRIOR,
) -> ConfidenceResult:
    ev_strength = (
        sum(evidence_score(e) for e in evidence) / len(evidence) if evidence else 0.2
    )

    challenges = [m for m in messages if m["type"] == "challenge"]
    resolutions = [m for m in messages if m["type"] in ("resolution", "concession")]
    if challenges:
        agreement = max(0.0, 1.0 - max(0, len(challenges) - len(resolutions)) / len(challenges))
    else:
        agreement = 1.0

    # Mechanism clarity: did a decomposition isolate a dominant driver?
    clarity = 0.4
    for e in evidence:
        top = e.result_digest.get("topContributors") or []
        if top:
            share = abs(float(top[0].get("deltaShare", 0)))
            clarity = max(clarity, min(1.0, share))

    raw = (
        WEIGHTS["evidence_strength"] * ev_strength
        + WEIGHTS["cross_agent_agreement"] * agreement
        + WEIGHTS["playbook_prior"] * playbook_prior
        + WEIGHTS["mechanism_clarity"] * clarity
        - (HEALTH_PENALTY if yellow_domains else 0.0)
    )
    score = max(0.05, min(0.97, raw))
    return ConfidenceResult(
        score=round(score, 2),
        breakdown={
            "evidenceStrength": round(ev_strength, 3),
            "crossAgentAgreement": round(agreement, 3),
            "playbookPrior": playbook_prior,
            "mechanismClarity": round(clarity, 3),
            "healthPenalty": HEALTH_PENALTY if yellow_domains else 0.0,
        },
    )
