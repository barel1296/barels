"""Postgres-backed job queue: FOR UPDATE SKIP LOCKED claim semantics.

Deliberate deviation from BullMQ (docs spec): one fewer moving part, jobs are
transactional with the rows they produce, and Redis remains available for
caching. Revisit if queue volume demands it (documented in docs/dev/).
"""

from __future__ import annotations

from typing import Any

from .db import worker_conn
from .settings import get_settings


def claim_job(kinds: list[str]) -> dict[str, Any] | None:
    with worker_conn() as conn:
        row = conn.execute(
            """UPDATE jobs SET status = 'running', locked_by = %s, locked_at = now(),
                      attempts = attempts + 1
                WHERE id = (
                  SELECT id FROM jobs
                   WHERE status = 'queued' AND run_after <= now() AND kind = ANY(%s)
                   ORDER BY priority, created_at
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1)
                RETURNING id, tenant_id, kind, payload, attempts, max_attempts""",
            (get_settings().worker_id, kinds),
        ).fetchone()
        return dict(row) if row else None


def complete_job(job_id: str) -> None:
    with worker_conn() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = %s",
            (job_id,),
        )


def fail_job(job_id: str, error: str, retry_in_seconds: int = 30) -> None:
    with worker_conn() as conn:
        conn.execute(
            """UPDATE jobs SET
                 status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                 run_after = now() + make_interval(secs => %s * attempts),
                 last_error = %s,
                 finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
               WHERE id = %s""",
            (retry_in_seconds, error[:2000], job_id),
        )
