"""Golden incidents: frozen scenarios with ground truth (docs/12 §12.3).

Each incident exercises the full orchestrator + protocol + publish pipeline.
Scripted agent outputs simulate LLM responses deterministically; everything
else (tools, evidence, guardrails, confidence, diff hashing) is real code.
"""

from __future__ import annotations

from typing import Any

from .harness import GoldenIncident

PLAYBOOK = {
    "key": "roas_drop",
    "phases": [
        "triage", "health_gate", "investigation", "debate",
        "synthesis", "action_prep", "review",
    ],
    "roster": ["tracking", "intelligence", "creative", "growth_director", "operations"],
    "budgets": {"maxToolCallsPerAgent": 12, "maxDebateRounds": 2, "maxCostUsd": 10},
}

GREEN_HEALTH = [
    {"domain": d, "status": "green", "reasons": [], "declared_at": "2026-06-08"}
    for d in ("attribution", "spend", "revenue", "events", "skan")
]

CAMPAIGNS = [
    {
        "id": "c-de-google",
        "name": "DE_Google_UA",
        "channel": "google",
        "status": "active",
        "budget_amount": 1200,
        "budget_type": "daily",
        "currency": "USD",
        "managed_state": "observed",
    },
    {
        "id": "c-us-meta",
        "name": "US_Meta_Value",
        "channel": "meta",
        "status": "active",
        "budget_amount": 3000,
        "budget_type": "daily",
        "currency": "USD",
        "managed_state": "observed",
    },
]


def _series(values: list[float], start_day: int = 1) -> list[dict[str, Any]]:
    return [
        {"bucket": f"2026-05-{day:02d}", "value": v}
        for day, v in enumerate(values, start=start_day)
    ]


def _metric_response(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    return {
        "metricKey": key,
        "metricVersion": 1,
        "rows": rows,
        "freshnessAt": "2026-06-08",
        "caveats": [],
        "sqlHash": "golden-fixture",
    }


# Declining ROAS: stable ~1.6 then sliding to ~1.05.
ROAS_DECLINE = [1.62, 1.58, 1.61, 1.6, 1.57, 1.63, 1.59, 1.6, 1.58, 1.61,
                1.55, 1.5, 1.44, 1.39, 1.33, 1.3, 1.27, 1.22, 1.18, 1.15,
                1.12, 1.1, 1.08, 1.07, 1.05, 1.06, 1.04, 1.05]

# Creative IPM: ramp to a peak, then steep sustained decay (fatigue signature).
IPM_FATIGUE = [4.0, 4.4, 4.7, 4.9, 5.0, 4.85, 4.7, 4.5, 4.3, 4.15,
               4.0, 3.85, 3.7, 3.5, 3.35, 3.2, 3.1, 2.95, 2.85, 2.75,
               2.65, 2.6, 2.55, 2.5, 2.5, 2.45, 2.5, 2.5]

STABLE = [1.5, 1.52, 1.49, 1.51, 1.5, 1.53, 1.48, 1.5, 1.51, 1.49,
          1.5, 1.52, 1.5, 1.49, 1.51, 1.5, 1.5, 1.52, 1.49, 1.5,
          1.51, 1.5, 1.49, 1.5, 1.52, 1.5, 1.51, 1.5]

IPM_STABLE = [4.0, 4.1, 3.9, 4.0, 4.05, 3.95, 4.0, 4.1, 4.0, 3.9,
              4.0, 4.05, 4.0, 3.95, 4.0, 4.1, 4.0, 3.9, 4.0, 4.0,
              4.05, 4.0, 3.95, 4.0, 4.0, 4.1, 3.95, 4.0]


FATIGUE_DE = GoldenIncident(
    key="fatigue_de_google",
    title="ROAS drop — Germany / Google",
    playbook=PLAYBOOK,
    scope={
        "metricKey": "roas_d7",
        "decomposeDimensions": ["country", "campaign_id"],
        "healthDomains": ["spend", "attribution"],
        "channel": "google",
    },
    metric_fixtures={
        "query:roas_d7": _metric_response(_series(ROAS_DECLINE), "roas_d7"),
        "decompose:roas_d7": {
            "metricKey": "roas_d7",
            "metricVersion": 1,
            "method": "group_delta_share",
            "totalDelta": -0.55,
            "contributors": [
                {
                    "group": {"country": "DE", "campaign_id": "c-de-google"},
                    "valueA": 1.31,
                    "valueB": 0.74,
                    "delta": -0.57,
                    "deltaShare": 1.04,
                },
                {
                    "group": {"country": "US", "campaign_id": "c-us-meta"},
                    "valueA": 1.7,
                    "valueB": 1.72,
                    "delta": 0.02,
                    "deltaShare": -0.04,
                },
            ],
            "caveats": [
                "Metric is a ratio; group_delta_share reflects group-level ratio deltas."
            ],
        },
        "query:creative_ipm": _metric_response(_series(IPM_FATIGUE), "creative_ipm"),
        "query:creative_ctr": _metric_response(
            _series([0.9, 0.92, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.66, 0.62,
                     0.6, 0.55, 0.52, 0.5]),
            "creative_ctr",
        ),
        "query:creative_spend": _metric_response(_series([800.0] * 28), "creative_spend"),
    },
    health=GREEN_HEALTH,
    experiments=[],
    campaigns=CAMPAIGNS,
    tenant_memory={"tenantDailySpendUsd": 16000,
                   "targets.roas_d7": {"value": 1.4, "geo": "all"}},
    script={
        "intelligence:investigation": [
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": (
                            "D7 ROAS declined from {E2:first} at the start of the window "
                            "to {E2:last} at the end. The dimensional decomposition isolates "
                            "the drop almost entirely to country "
                            "{E3:topContributors[0].group.country} on campaign "
                            "{E3:topContributors[0].group.campaign_id} with delta share "
                            "{E3:topContributors[0].deltaShare}."
                        ),
                        "evidence_labels": ["E2", "E3"],
                        "confidence": 0.82,
                    },
                    {
                        "type": "hypothesis",
                        "claim": (
                            "The mechanism is demand-side decay on the dominant DE campaign "
                            "rather than auction pressure or a product change: the change "
                            "registry shows {E5:eventCountInWindow} coincident experiments/"
                            "releases at the breakpoint."
                        ),
                        "evidence_labels": ["E3", "E5"],
                        "confidence": 0.6,
                        "falsification": (
                            "A coincident CPM rise, paywall test or release at the breakpoint "
                            "would refute this. correlate_events found none in the window."
                        ),
                    },
                ]
            }
        ],
        "creative:investigation": [
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": (
                            "The dominant DE asset shows a fitted decay of "
                            "{E6:decayPctPerDay} pct/day and a total decline of "
                            "{E6:totalDeclinePct} pct from peak (fatigued="
                            "{E6:isFatigued}) — a classic fatigue signature, while spend "
                            "on the asset held steady at {E8:last} per day."
                        ),
                        "evidence_labels": ["E6", "E8"],
                        "confidence": 0.86,
                    },
                    {
                        "type": "challenge",
                        "claim": (
                            "Sharpening the intelligence hypothesis: this is specifically "
                            "creative fatigue, not generic demand decay — the IPM decay fit "
                            "({E6:decayPctPerDay} pct/day) starts at the asset's exposure "
                            "peak and tracks the ROAS slide in {E2:last}."
                        ),
                        "evidence_labels": ["E6", "E2"],
                        "confidence": 0.8,
                        "reply_to_seq": 4,
                    },
                ]
            }
        ],
        "intelligence:debate": [
            {
                "messages": [
                    {
                        "type": "concession",
                        "claim": (
                            "Conceded: the fatigue fit explains the breakpoint better than "
                            "generic demand decay; no coincident events compete with it."
                        ),
                        "evidence_labels": ["E6"],
                    }
                ]
            }
        ],
        "creative:debate": [{"messages": []}],
        "growth_director:synthesis": [
            {
                "outcome": "action_proposed",
                "chosen_option": (
                    "Treat the DE decline as creative fatigue on DE_Google_UA: rotate the "
                    "fatigued asset out and reduce the campaign budget while replacements ramp"
                ),
                "rejected_alternatives": [
                    {
                        "option": "Increase DE budget to compensate for lower ROAS",
                        "reason": "Buying more impressions of a decayed asset compounds the waste",
                    },
                    {
                        "option": "Pause DE_Google_UA outright",
                        "reason": "Disproportionate: the campaign still converts above breakeven",
                    },
                ],
                "risk_statement": (
                    "Bounded: the budget reduction is within daily-change guardrails, the "
                    "rotation is reversible, and monitoring arms an auto-revert proposal if "
                    "ROAS worsens after the change."
                ),
                "re_evaluation_conditions": [
                    "D7 ROAS in DE not stabilizing within 7 days of rotation",
                    "Replacement creatives underperform the fatigued asset's floor",
                ],
                "challenge_resolutions": [
                    {
                        "challenge_seq": 6,
                        "resolution": (
                            "Challenge accepted: evidence favors creative fatigue as the "
                            "primary mechanism; the decision builds on it."
                        ),
                    }
                ],
                "directive_responses": [],
                "action_briefs": [
                    {
                        "kind": "budget_change",
                        "entity_id": "c-de-google",
                        "objective": "Reduce budget on the fatigued campaign "
                                     "while creatives rotate",
                        "budget_change_pct": -20,
                    },
                    {
                        "kind": "creative_rotation",
                        "entity_id": "c-de-google",
                        "objective": "Rotate the fatigued hero asset out and brief replacements",
                    },
                ],
                "summary": (
                    "DE ROAS decline traced to creative fatigue on DE_Google_UA. Prepared a "
                    "guarded budget reduction and a creative rotation, both reversible, "
                    "awaiting approval."
                ),
            }
        ],
        "operations:action_prep": [
            {
                "actions": [
                    {
                        "kind": "budget_change",
                        "entity_id": "c-de-google",
                        "summary": "Reduce DE_Google_UA daily budget by twenty "
                                   "percent while creatives rotate",
                        "budget_change_pct": -20,
                        "rollback_note": "Restore the previous daily budget value",
                        "monitoring_metric": "roas_d7",
                        "revert_threshold_pct": 15,
                    },
                    {
                        "kind": "creative_rotation",
                        "entity_id": "c-de-google",
                        "summary": "Rotate the fatigued hero asset out; introduce variation briefs",
                        "rotation_note": "Pause hero asset; launch replacement "
                                         "variations from briefs",
                        "rollback_note": "Re-enable the previous asset mix",
                        "monitoring_metric": "creative_ipm",
                        "revert_threshold_pct": 20,
                    },
                ],
                "feasibility_vetoes": [],
            }
        ],
    },
    ground_truth={
        "root_cause_keyword": "fatigue",
        "expect_status": "published",
        "expected_action_kinds": ["budget_change", "creative_rotation"],
    },
)


TRACKING_BREAK = GoldenIncident(
    key="tracking_break_attribution_red",
    title="ROAS drop — but attribution is red",
    playbook=PLAYBOOK,
    scope={"metricKey": "roas_d7", "healthDomains": ["spend", "attribution"]},
    metric_fixtures={"query:roas_d7": _metric_response(_series(ROAS_DECLINE), "roas_d7")},
    health=[
        {"domain": "attribution", "status": "red",
         "reasons": [{"check": "mmp_recon", "delta": "beyond tolerance"}],
         "declared_at": "2026-06-08"},
        *[h for h in GREEN_HEALTH if h["domain"] != "attribution"],
    ],
    experiments=[],
    campaigns=CAMPAIGNS,
    script={},  # the health gate is deterministic — no LLM involvement
    ground_truth={
        "root_cause_keyword": "red",
        "expect_status": "parked",
        "expect_no_actions": True,
    },
)


NOISE_NEGATIVE = GoldenIncident(
    key="noise_stable_metrics",
    title="Suspected ROAS drop — turns out to be noise",
    playbook=PLAYBOOK,
    scope={"metricKey": "roas_d7", "healthDomains": ["spend"]},
    metric_fixtures={
        "query:roas_d7": _metric_response(_series(STABLE), "roas_d7"),
        "decompose:roas_d7": {
            "metricKey": "roas_d7", "metricVersion": 1, "method": "group_delta_share",
            "totalDelta": -0.01,
            "contributors": [
                {"group": {"country": "DE", "campaign_id": "c-de-google"},
                 "valueA": 1.5, "valueB": 1.49, "delta": -0.01, "deltaShare": 1.0}
            ],
            "caveats": [],
        },
        "query:creative_ipm": _metric_response(_series(IPM_STABLE), "creative_ipm"),
        "query:creative_ctr": _metric_response(_series(IPM_STABLE), "creative_ctr"),
        "query:creative_spend": _metric_response(_series([800.0] * 28), "creative_spend"),
    },
    health=GREEN_HEALTH,
    experiments=[],
    campaigns=CAMPAIGNS,
    tenant_memory={"tenantDailySpendUsd": 16000},
    script={
        "intelligence:investigation": [
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": (
                            "The series is flat within noise: first {E2:first}, last "
                            "{E2:last}, and the largest decomposition contributor moved by "
                            "{E3:topContributors[0].delta} — no material change to explain."
                        ),
                        "evidence_labels": ["E2", "E3"],
                        "confidence": 0.85,
                    }
                ]
            }
        ],
        "creative:investigation": [
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": (
                            "No fatigue signature: fitted decay {E6:decayPctPerDay} pct/day, "
                            "total decline {E6:totalDeclinePct} pct, fatigued={E6:isFatigued}."
                        ),
                        "evidence_labels": ["E6"],
                        "confidence": 0.85,
                    }
                ]
            }
        ],
        "intelligence:debate": [{"messages": []}],
        "creative:debate": [{"messages": []}],
        "growth_director:synthesis": [
            {
                "outcome": "monitor",
                "chosen_option": "No action: the movement is within normal variance; monitor",
                "rejected_alternatives": [
                    {"option": "Preemptive budget shift",
                     "reason": "No evidence of a real performance change to respond to"}
                ],
                "risk_statement": "No action taken; the only risk is a missed slow "
                                  "drift, covered by re-check conditions.",
                "re_evaluation_conditions": [
                    "Re-open if the CUSUM drift detector fires on this scope",
                ],
                "challenge_resolutions": [],
                "directive_responses": [],
                "action_briefs": [],
                "summary": (
                    "Investigated the suspected ROAS drop: metrics are flat within noise and "
                    "no fatigue signature exists. Decision: monitor with explicit re-check "
                    "conditions; acting here would be theater."
                ),
            }
        ],
    },
    ground_truth={
        "root_cause_keyword": "monitor",
        "expect_status": "published",
        "expect_no_actions": True,
    },
)


FABRICATION_ATTEMPT = GoldenIncident(
    key="fabrication_attempt",
    title="ROAS drop — agent tries to assert unverified numbers",
    playbook=PLAYBOOK,
    scope={"metricKey": "roas_d7", "healthDomains": ["spend"]},
    metric_fixtures={
        "query:roas_d7": _metric_response(_series(ROAS_DECLINE), "roas_d7"),
        "decompose:roas_d7": {
            "metricKey": "roas_d7", "metricVersion": 1, "method": "group_delta_share",
            "totalDelta": -0.55, "contributors": [], "caveats": [],
        },
        "query:creative_ipm": _metric_response(_series(IPM_FATIGUE), "creative_ipm"),
        "query:creative_ctr": _metric_response(_series(IPM_FATIGUE), "creative_ctr"),
        "query:creative_spend": _metric_response(_series([800.0] * 28), "creative_spend"),
    },
    health=GREEN_HEALTH,
    experiments=[],
    campaigns=CAMPAIGNS,
    script={
        # The "model" asserts a raw dollar figure that exists in no evidence.
        "intelligence:investigation": [
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": "ROAS dropped 31.5% and we are wasting $12,400 per week in DE.",
                        "evidence_labels": ["E2"],
                        "confidence": 0.9,
                    }
                ]
            },
            # complete_structured does not retry protocol violations, but keep
            # a second canned response to prove the validator (not script
            # exhaustion) is what stops the session.
            {
                "messages": [
                    {
                        "type": "finding",
                        "claim": "ROAS dropped 31.5% and we are wasting $12,400 per week in DE.",
                        "evidence_labels": ["E2"],
                        "confidence": 0.9,
                    }
                ]
            },
        ],
    },
    ground_truth={
        "root_cause_keyword": "protocol violation",
        "expect_status": "failed",
        "expect_no_actions": True,
    },
)


ALL_INCIDENTS = [FATIGUE_DE, TRACKING_BREAK, NOISE_NEGATIVE, FABRICATION_ATTEMPT]
