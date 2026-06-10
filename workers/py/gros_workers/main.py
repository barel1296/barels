"""Worker loop: schedules periodic work and consumes the Postgres job queue.

Run: python -m gros_workers.main
"""

from __future__ import annotations

import logging
import signal
import time
from types import FrameType

from .queue import claim_job, complete_job, fail_job

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("gros.worker")

JOB_KINDS = [
    "run_session",
    "run_detection",
    "run_triage",
    "run_maintenance",
    "run_sync",
]

SCHEDULE_EVERY_SEC = 60

_running = True


def _stop(_sig: int, _frame: FrameType | None) -> None:
    global _running
    log.info("shutdown requested")
    _running = False


def handle_job(job: dict[str, object]) -> None:
    kind = str(job["kind"])
    tenant_id = str(job["tenant_id"])
    payload = job["payload"] if isinstance(job["payload"], dict) else {}
    if kind == "run_session":
        from .session_runner import run_session_job

        session_id = str(payload.get("sessionId"))
        result = run_session_job(tenant_id, session_id)
        log.info("session %s finished: %s/%s", session_id, result.phase, result.status)
    elif kind == "run_detection":
        from .detection.runner import run_detection_for_tenant

        n = run_detection_for_tenant(tenant_id)
        log.info("detection for %s: %d anomalies", tenant_id, n)
    elif kind == "run_triage":
        from .triage import triage_tenant

        n = triage_tenant(tenant_id)
        log.info("triage for %s: %d sessions opened", tenant_id, n)
    elif kind == "run_maintenance":
        from .maintenance import run_maintenance

        maint = run_maintenance(tenant_id)
        log.info("maintenance for %s: %s", tenant_id, maint)
    elif kind == "run_sync":
        from .connectors import meta_ads  # noqa: F401 — registers connectors
        from .connectors.sync import run_sync_job

        out = run_sync_job(
            tenant_id,
            str(payload.get("integrationId")),
            kind=str(payload.get("kind", "incremental")),
            window=payload.get("window") if isinstance(payload.get("window"), dict) else None,
        )
        log.info("sync for %s: %s", tenant_id, out)
    else:
        raise ValueError(f"unknown job kind: {kind}")


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    log.info("worker started")
    last_schedule = 0.0
    while _running:
        if time.monotonic() - last_schedule > SCHEDULE_EVERY_SEC:
            try:
                from .scheduler import schedule_tick

                enqueued = schedule_tick()
                if enqueued:
                    log.info("scheduler enqueued %d jobs", enqueued)
            except Exception:  # noqa: BLE001 — scheduler must not kill the loop
                log.exception("scheduler tick failed")
            last_schedule = time.monotonic()

        job = claim_job(JOB_KINDS)
        if job is None:
            time.sleep(2)
            continue
        job_id = str(job["id"])
        try:
            handle_job(job)
            complete_job(job_id)
        except Exception as err:  # noqa: BLE001 — job boundary
            log.exception("job %s failed", job_id)
            fail_job(job_id, str(err))
    log.info("worker stopped")


if __name__ == "__main__":
    main()
