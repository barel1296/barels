"""Anomaly triage: converts material anomalies into War Room sessions
(docs/09 §9.2). Deterministic v1 — playbook routing by metric, dedupe by
open-session scope, and a hard cap on concurrent sessions per tenant. The
cheap-LLM classification pass arrives once live playbooks broaden.
"""

from __future__ import annotations

import json
from typing import Any

from .db import worker_conn

# metric -> playbook routing (deterministic v1)
PLAYBOOK_FOR_METRIC: dict[str, str] = {
    "roas_d7": "roas_drop",
    "roas_d30": "roas_drop",
    "roas_d0": "roas_drop",
    "cpi": "cpi_spike",
    "cpm": "cpi_spike",
    "spend": "roas_drop",
    "installs": "roas_drop",
    "creative_ipm": "creative_fatigue",
    "creative_ctr": "creative_fatigue",
}

MAX_CONCURRENT_SESSIONS = 3
MIN_MATERIALITY_USD = 500.0


def playbook_for(metric_key: str, direction: str) -> str:
    # Upward spend/CPI moves are cost problems; downward ROAS moves are the
    # classic investigation. Unknown metrics fall back to roas_drop.
    if metric_key == "cpi" and direction == "up":
        return "cpi_spike"
    return PLAYBOOK_FOR_METRIC.get(metric_key, "roas_drop")


def triage_tenant(tenant_id: str) -> int:
    """Groups new material anomalies per metric and opens sessions for them.
    Returns the number of sessions created."""
    created = 0
    with worker_conn(tenant_id) as conn:
        running = conn.execute(
            """SELECT count(*) AS n FROM agent_sessions
                WHERE tenant_id = %s AND status = 'running'""",
            (tenant_id,),
        ).fetchone()
        capacity = MAX_CONCURRENT_SESSIONS - int(running["n"] if running else 0)
        if capacity <= 0:
            return 0

        groups = conn.execute(
            """SELECT metric_key,
                      (array_agg(direction ORDER BY materiality_usd DESC NULLS LAST))[1]
                        AS direction,
                      array_agg(id) AS anomaly_ids,
                      max(materiality_usd) AS materiality,
                      max(window_end) AS window_end
                 FROM anomalies
                WHERE tenant_id = %s AND status = 'new'
                  AND coalesce(materiality_usd, 0) >= %s
                GROUP BY metric_key
                ORDER BY max(materiality_usd) DESC NULLS LAST
                LIMIT %s""",
            (tenant_id, MIN_MATERIALITY_USD, capacity),
        ).fetchall()

        for g in groups:
            metric = str(g["metric_key"])
            # Dedupe: skip when an open session already covers this metric.
            dup = conn.execute(
                """SELECT 1 FROM agent_sessions
                    WHERE tenant_id = %s AND status IN ('running', 'published')
                      AND scope ->> 'metricKey' = %s
                      AND created_at > now() - interval '48 hours'""",
                (tenant_id, metric),
            ).fetchone()
            if dup:
                conn.execute(
                    """UPDATE anomalies SET status = 'merged'
                        WHERE id = ANY(%s) AND tenant_id = %s""",
                    (g["anomaly_ids"], tenant_id),
                )
                continue

            playbook_key = playbook_for(metric, str(g["direction"]))
            playbook = conn.execute(
                """SELECT definition FROM playbooks
                    WHERE key = %s AND status = 'active'
                    ORDER BY version DESC LIMIT 1""",
                (playbook_key,),
            ).fetchone()
            budgets: dict[str, Any] = (
                dict(playbook["definition"]).get("budgets", {}) if playbook else {}
            )
            direction_word = "drop" if g["direction"] == "down" else "spike"
            session = conn.execute(
                """INSERT INTO agent_sessions
                   (tenant_id, playbook_key, trigger_type, trigger_ref, title,
                    scope, money_at_stake_usd, budgets)
                   VALUES (%s, %s, 'anomaly', %s, %s, %s, %s, %s)
                   RETURNING id""",
                (
                    tenant_id,
                    playbook_key,
                    json.dumps({"anomalyIds": [str(a) for a in g["anomaly_ids"]]}),
                    f"{metric} {direction_word} — automated triage",
                    json.dumps({"metricKey": metric}),
                    g["materiality"],
                    json.dumps(budgets),
                ),
            ).fetchone()
            assert session is not None
            conn.execute(
                """UPDATE anomalies
                      SET status = 'in_session', session_id = %s
                    WHERE id = ANY(%s) AND tenant_id = %s""",
                (session["id"], g["anomaly_ids"], tenant_id),
            )
            conn.execute(
                """INSERT INTO jobs (tenant_id, kind, payload)
                   VALUES (%s, 'run_session', %s)""",
                (tenant_id, json.dumps({"sessionId": str(session["id"])})),
            )
            conn.execute(
                """INSERT INTO audit_logs
                   (tenant_id, actor_type, actor_id, event, object_type, object_id, after_ref)
                   VALUES (%s, 'agent', 'triage', 'session.auto_created',
                           'agent_session', %s, %s)""",
                (tenant_id, str(session["id"]),
                 json.dumps({"metric": metric, "playbook": playbook_key})),
            )
            created += 1
    return created
