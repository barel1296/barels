"""Worker loop: claims jobs from the Postgres queue and dispatches them.

Run: python -m gros_workers.main
"""

from __future__ import annotations

import logging
import signal
import time
from types import FrameType

from .queue import claim_job, complete_job, fail_job
from .session_runner import run_session_job

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("gros.worker")

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
        session_id = str(payload.get("sessionId"))
        result = run_session_job(tenant_id, session_id)
        log.info("session %s finished: %s/%s", session_id, result.phase, result.status)
    elif kind == "run_detection":
        from .detection.runner import run_detection_for_tenant

        n = run_detection_for_tenant(tenant_id)
        log.info("detection for %s: %d anomalies", tenant_id, n)
    else:
        raise ValueError(f"unknown job kind: {kind}")


def main() -> None:
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    log.info("worker started")
    while _running:
        job = claim_job(["run_session", "run_detection"])
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
