"""Periodic job scheduler: enqueues per-tenant work with dedupe.

Runs inside the worker loop (single-process v1; the SKIP LOCKED queue makes
multiple workers safe, and the dedupe guard makes multiple schedulers safe).
"""

from __future__ import annotations

import json

from .db import worker_conn

# job kind -> minimum minutes between runs per tenant
INTERVALS_MIN: dict[str, int] = {
    "run_detection": 60,
    "run_triage": 5,
    "run_maintenance": 15,
}


def schedule_tick() -> int:
    """Enqueues due per-tenant jobs. Returns the number enqueued."""
    enqueued = 0
    with worker_conn() as conn:
        tenants = conn.execute(
            "SELECT id FROM tenants WHERE status = 'active'"
        ).fetchall()
        for t in tenants:
            tenant_id = str(t["id"])
            for kind, interval_min in INTERVALS_MIN.items():
                due = conn.execute(
                    """SELECT NOT EXISTS (
                         SELECT 1 FROM jobs
                          WHERE tenant_id = %s AND kind = %s
                            AND (status IN ('queued', 'running')
                                 OR finished_at > now() - make_interval(mins => %s))
                       ) AS due""",
                    (tenant_id, kind, interval_min),
                ).fetchone()
                if due and due["due"]:
                    conn.execute(
                        "INSERT INTO jobs (tenant_id, kind, payload) VALUES (%s, %s, '{}')",
                        (tenant_id, kind),
                    )
                    enqueued += 1

        # Connector syncs: one incremental per healthy integration per its
        # configured interval.
        integrations = conn.execute(
            """SELECT i.id, i.tenant_id, ds.min_sync_interval_min
                 FROM integrations i
                 JOIN data_sources ds ON ds.key = i.source_key
                WHERE i.status IN ('healthy', 'pending')
                  AND i.credentials_enc IS NOT NULL
                  AND ds.min_sync_interval_min > 0"""
        ).fetchall()
        for i in integrations:
            due = conn.execute(
                """SELECT NOT EXISTS (
                     SELECT 1 FROM jobs
                      WHERE tenant_id = %s AND kind = 'run_sync'
                        AND payload ->> 'integrationId' = %s
                        AND (status IN ('queued', 'running')
                             OR finished_at > now() - make_interval(mins => %s))
                   ) AS due""",
                (str(i["tenant_id"]), str(i["id"]), int(i["min_sync_interval_min"])),
            ).fetchone()
            if due and due["due"]:
                conn.execute(
                    "INSERT INTO jobs (tenant_id, kind, payload) VALUES (%s, 'run_sync', %s)",
                    (
                        str(i["tenant_id"]),
                        json.dumps({"integrationId": str(i["id"]), "kind": "incremental"}),
                    ),
                )
                enqueued += 1
    return enqueued
