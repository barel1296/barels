"""Scheduled maintenance: action/recommendation expiry, stale-session
failure, and predicted-vs-realized outcome computation (docs/09 §9.9).

Every state change is audited; expiry is a safety feature — an approval
granted on Tuesday's evidence must not be actionable on Friday's reality.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from .db import worker_conn
from .metrics_client import ApiMetricsClient, MetricsClient

STALE_SESSION_HOURS = 2


def expire_stale(tenant_id: str) -> dict[str, int]:
    counts = {"actions": 0, "recommendations": 0, "sessions": 0}
    with worker_conn(tenant_id) as conn:
        rows = conn.execute(
            """UPDATE actions SET status = 'expired', updated_at = now()
                WHERE tenant_id = %s AND status = 'awaiting_approval'
                  AND expires_at IS NOT NULL AND expires_at < now()
                RETURNING id""",
            (tenant_id,),
        ).fetchall()
        counts["actions"] = len(rows)
        for r in rows:
            conn.execute(
                """INSERT INTO audit_logs
                   (tenant_id, actor_type, actor_id, event, object_type, object_id)
                   VALUES (%s, 'system', 'maintenance', 'action.expired', 'action', %s)""",
                (tenant_id, str(r["id"])),
            )

        recs = conn.execute(
            """UPDATE recommendations SET status = 'expired', updated_at = now()
                WHERE tenant_id = %s AND status = 'proposed'
                  AND expires_at IS NOT NULL AND expires_at < now()
                  AND NOT EXISTS (SELECT 1 FROM actions a
                                   WHERE a.recommendation_id = recommendations.id
                                     AND a.status IN ('awaiting_approval', 'approved'))
                RETURNING id""",
            (tenant_id,),
        ).fetchall()
        counts["recommendations"] = len(recs)

        # Sessions stuck in `running` past the wall-clock ceiling (worker
        # crash without resume) are failed honestly, never left zombied.
        sessions = conn.execute(
            """UPDATE agent_sessions
                  SET status = 'failed',
                      abstract = coalesce(abstract,
                        'Session timed out without completing; it can be re-opened.'),
                      closed_at = now(), updated_at = now()
                WHERE tenant_id = %s AND status = 'running'
                  AND updated_at < now() - make_interval(hours => %s)
                RETURNING id""",
            (tenant_id, STALE_SESSION_HOURS),
        ).fetchall()
        counts["sessions"] = len(sessions)
    return counts


def compute_outcomes(tenant_id: str, metrics: MetricsClient | None = None) -> int:
    """For approved budget_change recommendations past their horizon: compare
    the predicted redeployed spend against the realized spend delta on the
    target entity, via the semantic layer. Writes recommendations.outcome."""
    client = metrics or ApiMetricsClient()
    computed = 0
    with worker_conn(tenant_id) as conn:
        due = conn.execute(
            """SELECT r.id, r.predicted_impact, a.target, a.diff,
                      ap.decided_at::date AS approved_on
                 FROM recommendations r
                 JOIN actions a ON a.recommendation_id = r.id
                      AND a.kind = 'budget_change' AND a.status = 'approved'
                 JOIN approvals ap ON ap.action_id = a.id AND ap.decision = 'approve'
                WHERE r.tenant_id = %s AND r.status = 'approved' AND r.outcome IS NULL
                  AND r.predicted_impact IS NOT NULL
                  AND ap.decided_at < now() - make_interval(
                        days => coalesce((r.predicted_impact ->> 'horizonDays')::int, 30))
                """,
            (tenant_id,),
        ).fetchall()

        for row in due:
            predicted: dict[str, Any] = row["predicted_impact"]
            horizon = int(predicted.get("horizonDays", 30))
            approved_on: date = row["approved_on"]
            entity_id = (row["target"] or {}).get("entityId")
            if not entity_id:
                continue
            try:
                before = client.query(
                    tenant_id, "spend",
                    {"from": (approved_on - timedelta(days=horizon)).isoformat(),
                     "to": approved_on.isoformat()},
                    filters={"campaign_id": entity_id},
                )
                after = client.query(
                    tenant_id, "spend",
                    {"from": approved_on.isoformat(),
                     "to": (approved_on + timedelta(days=horizon)).isoformat()},
                    filters={"campaign_id": entity_id},
                )
            except Exception:  # noqa: BLE001 — data not ready; retry next run
                continue
            spend_before = sum(float(r.get("value") or 0) for r in before.get("rows", []))
            spend_after = sum(float(r.get("value") or 0) for r in after.get("rows", []))
            realized = abs(spend_before - spend_after)
            mid = float(predicted.get("mid", 0)) or 1.0
            outcome = {
                "predictedMidUsd": predicted.get("mid"),
                "realizedUsd": round(realized, 2),
                "ratio": round(realized / mid, 3),
                "withinRange": float(predicted.get("low", 0))
                <= realized
                <= float(predicted.get("high", float("inf"))),
                "method": "spend_delta.v1",
                "computedAt": date.today().isoformat(),
            }
            conn.execute(
                """UPDATE recommendations
                      SET outcome = %s, status = 'realized', updated_at = now()
                    WHERE id = %s AND tenant_id = %s""",
                (json.dumps(outcome), row["id"], tenant_id),
            )
            conn.execute(
                """INSERT INTO audit_logs
                   (tenant_id, actor_type, actor_id, event, object_type, object_id, after_ref)
                   VALUES (%s, 'system', 'maintenance', 'recommendation.outcome_computed',
                           'recommendation', %s, %s)""",
                (tenant_id, str(row["id"]), json.dumps(outcome)),
            )
            computed += 1
    return computed


def run_maintenance(tenant_id: str) -> dict[str, Any]:
    expired = expire_stale(tenant_id)
    outcomes = compute_outcomes(tenant_id)
    return {**expired, "outcomes": outcomes}
