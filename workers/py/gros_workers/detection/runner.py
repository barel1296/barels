"""Detection runner: applies the statistical detector suite to a tenant's
core metrics through the semantic layer and writes anomaly records.

Noise control: materiality filter (USD at stake) + per-scope dedupe against
open anomalies. No LLM involvement (docs/02 P7).
"""

from __future__ import annotations

import json
from datetime import date, timedelta

from ..db import worker_conn
from ..metrics_client import ApiMetricsClient, MetricsClient
from .detectors import DETECTOR_VERSION, AnomalySignal, cusum, robust_zscore

WATCHED_METRICS = [
    ("spend", "spend"),
    ("cpi", "spend"),
    ("roas_d7", "revenue"),
    ("installs", "spend"),
]


def detect_for_series(series: list[float]) -> list[AnomalySignal]:
    signals = robust_zscore(series) + cusum(series)
    # keep the latest signal per detector only — older ones are history
    latest: dict[str, AnomalySignal] = {}
    for s in signals:
        cur = latest.get(s.detector)
        if cur is None or s.index > cur.index:
            latest[s.detector] = s
    return list(latest.values())


def materiality_usd(metric_key: str, magnitude: float, daily_spend: float) -> float:
    # Conservative proxy: relative move × monthly spend at the affected scope.
    return round(abs(magnitude) * daily_spend * 30, 2)


def run_detection_for_tenant(
    tenant_id: str,
    metrics: MetricsClient | None = None,
    min_materiality_usd: float = 500.0,
) -> int:
    client = metrics or ApiMetricsClient()
    to = date.today().isoformat()
    frm = (date.today() - timedelta(days=42)).isoformat()
    created = 0

    spend_res = client.query(tenant_id, "spend", {"from": frm, "to": to})
    spend_values = [float(r.get("value") or 0) for r in spend_res.get("rows", [])]
    daily_spend = (
        sum(spend_values[-7:]) / max(1, len(spend_values[-7:])) if spend_values else 0.0
    )

    for metric_key, domain in WATCHED_METRICS:
        res = client.query(tenant_id, metric_key, {"from": frm, "to": to})
        rows = res.get("rows", [])
        series = [float(r.get("value") or 0) for r in rows if r.get("value") is not None]
        if len(series) < 15:
            continue
        for sig in detect_for_series(series):
            mat = materiality_usd(metric_key, sig.magnitude, daily_spend)
            if mat < min_materiality_usd:
                continue
            bucket = str(rows[sig.index].get("bucket", to)) if sig.index < len(rows) else to
            with worker_conn(tenant_id) as conn:
                dup = conn.execute(
                    """SELECT 1 FROM anomalies
                        WHERE tenant_id = %s AND metric_key = %s AND detector = %s
                          AND status IN ('new', 'triaged', 'in_session')""",
                    (tenant_id, metric_key, sig.detector),
                ).fetchone()
                if dup:
                    continue
                conn.execute(
                    """INSERT INTO anomalies
                       (tenant_id, metric_key, scope, direction, magnitude, zscore,
                        detector, detector_version, window_start, window_end,
                        materiality_usd)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        tenant_id,
                        metric_key,
                        json.dumps({"domain": domain}),
                        sig.direction,
                        round(sig.magnitude, 4),
                        sig.score,
                        sig.detector,
                        DETECTOR_VERSION,
                        bucket,
                        bucket,
                        mat,
                    ),
                )
                created += 1
    return created
