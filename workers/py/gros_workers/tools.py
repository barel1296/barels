"""Agent tool registry.

Tools are the ONLY way agents touch data. Every tool execution freezes its
result as an evidence artifact and hands the agent an evidence_id + digest.
Each agent has an allowlist; calls are budget-counted by the orchestrator.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from .detection.detectors import fit_fatigue_curve
from .evidence import EvidenceRecord, EvidenceStore
from .metrics_client import MetricsClient


class DataAccess(Protocol):
    """Governed Postgres reads used by tools (health, experiments, entities)."""

    def health_status(self) -> list[dict[str, Any]]: ...

    def experiments(self, window_from: str, window_to: str) -> list[dict[str, Any]]: ...

    def campaign(self, campaign_id: str) -> dict[str, Any] | None: ...

    def campaigns(self) -> list[dict[str, Any]]: ...


class InMemoryDataAccess:
    def __init__(
        self,
        health: list[dict[str, Any]] | None = None,
        experiments: list[dict[str, Any]] | None = None,
        campaigns: list[dict[str, Any]] | None = None,
    ):
        self._health = health or []
        self._experiments = experiments or []
        self._campaigns = campaigns or []

    def health_status(self) -> list[dict[str, Any]]:
        return list(self._health)

    def experiments(self, window_from: str, window_to: str) -> list[dict[str, Any]]:
        return [
            e
            for e in self._experiments
            if str(e.get("starts_at", ""))[:10] <= window_to
            and (e.get("ends_at") is None or str(e.get("ends_at"))[:10] >= window_from)
        ]

    def campaign(self, campaign_id: str) -> dict[str, Any] | None:
        return next((c for c in self._campaigns if c["id"] == campaign_id), None)

    def campaigns(self) -> list[dict[str, Any]]:
        return list(self._campaigns)


class PgDataAccess:
    def __init__(self, tenant_id: str):
        self.tenant_id = tenant_id

    def health_status(self) -> list[dict[str, Any]]:
        from .db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            return list(
                conn.execute(
                    "SELECT domain, status, reasons, declared_at FROM health_status "
                    "WHERE tenant_id = %s ORDER BY domain",
                    (self.tenant_id,),
                ).fetchall()
            )

    def experiments(self, window_from: str, window_to: str) -> list[dict[str, Any]]:
        from .db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            return list(
                conn.execute(
                    """SELECT id, kind, name, scope, starts_at, ends_at FROM experiments
                       WHERE tenant_id = %s AND starts_at::date <= %s
                         AND (ends_at IS NULL OR ends_at::date >= %s)""",
                    (self.tenant_id, window_to, window_from),
                ).fetchall()
            )

    def campaign(self, campaign_id: str) -> dict[str, Any] | None:
        from .db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            return conn.execute(
                """SELECT id, name, channel, status, budget_amount, budget_type,
                          currency, managed_state, geo_targets
                     FROM campaigns WHERE tenant_id = %s AND id = %s""",
                (self.tenant_id, campaign_id),
            ).fetchone()

    def campaigns(self) -> list[dict[str, Any]]:
        from .db import worker_conn

        with worker_conn(self.tenant_id) as conn:
            return list(
                conn.execute(
                    """SELECT id, name, channel, status, budget_amount, budget_type,
                              managed_state FROM campaigns WHERE tenant_id = %s""",
                    (self.tenant_id,),
                ).fetchall()
            )


@dataclass
class ToolContext:
    tenant_id: str
    scope: dict[str, Any]
    metrics: MetricsClient
    data: DataAccess
    evidence: EvidenceStore


@dataclass
class ToolRegistry:
    ctx: ToolContext
    calls: list[dict[str, Any]] = field(default_factory=list)

    AGENT_ALLOWLIST = {
        "tracking": {"get_data_health", "query_metrics", "get_experiments"},
        "intelligence": {
            "query_metrics",
            "decompose_metric_change",
            "correlate_events",
            "get_experiments",
            "get_data_health",
        },
        "creative": {"query_metrics", "fatigue_check", "get_data_health"},
        "growth_director": {"query_metrics", "get_data_health"},
        "operations": {"get_entity", "list_entities", "query_metrics"},
    }

    def execute(self, agent: str, tool: str, **kwargs: Any) -> EvidenceRecord:
        allowed = self.AGENT_ALLOWLIST.get(agent, set())
        if tool not in allowed:
            raise PermissionError(f"agent {agent} may not call tool {tool}")
        handler = getattr(self, f"_tool_{tool}", None)
        if handler is None:
            raise ValueError(f"unknown tool: {tool}")
        self.calls.append({"agent": agent, "tool": tool, "kwargs": kwargs})
        result: EvidenceRecord = handler(**kwargs)
        return result

    # ── tools ────────────────────────────────────────────────────────────────

    def _tool_query_metrics(
        self,
        metric_key: str,
        range_: dict[str, str],
        dimensions: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        grain: str = "day",
    ) -> EvidenceRecord:
        res = self.ctx.metrics.query(
            self.ctx.tenant_id, metric_key, range_, dimensions, filters, grain
        )
        rows = res.get("rows", [])
        values = [float(r.get("value") or 0) for r in rows if r.get("value") is not None]
        digest = {
            "metric": metric_key,
            "rows": rows[:30],
            "rowCount": len(rows),
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "mean": (sum(values) / len(values)) if values else None,
            "first": values[0] if values else None,
            "last": values[-1] if values else None,
            "caveats": res.get("caveats", []),
        }
        return self.ctx.evidence.record(
            kind="metric_query",
            metric_key=metric_key,
            metric_version=int(res.get("metricVersion", 1)),
            params={"range": range_, "dimensions": dimensions, "filters": filters, "grain": grain},
            sql_hash=str(res.get("sqlHash", "")),
            digest=digest,
            snapshot=res,
            freshness_at=res.get("freshnessAt"),
        )

    def _tool_decompose_metric_change(
        self,
        metric_key: str,
        window_a: dict[str, str],
        window_b: dict[str, str],
        dimensions: list[str],
        filters: dict[str, Any] | None = None,
    ) -> EvidenceRecord:
        res = self.ctx.metrics.decompose(
            self.ctx.tenant_id, metric_key, window_a, window_b, dimensions, filters
        )
        digest = {
            "metric": metric_key,
            "totalDelta": res.get("totalDelta"),
            "topContributors": res.get("contributors", [])[:5],
            "caveats": res.get("caveats", []),
        }
        return self.ctx.evidence.record(
            kind="computation",
            metric_key=metric_key,
            params={"windowA": window_a, "windowB": window_b, "dimensions": dimensions},
            digest=digest,
            snapshot=res,
        )

    def _tool_get_data_health(self) -> EvidenceRecord:
        rows = self.ctx.data.health_status()
        digest = {
            "domains": {str(r["domain"]): str(r["status"]) for r in rows},
            "red": [str(r["domain"]) for r in rows if r["status"] == "red"],
            "yellow": [str(r["domain"]) for r in rows if r["status"] == "yellow"],
        }
        return self.ctx.evidence.record(
            kind="recon_report", params={}, digest=digest, snapshot={"rows": rows}
        )

    def _tool_get_experiments(self, window_from: str, window_to: str) -> EvidenceRecord:
        rows = self.ctx.data.experiments(window_from, window_to)
        digest = {
            "count": len(rows),
            "experiments": [
                {"kind": str(r["kind"]), "name": str(r["name"]), "startsAt": str(r["starts_at"])}
                for r in rows[:10]
            ],
        }
        return self.ctx.evidence.record(
            kind="external",
            params={"from": window_from, "to": window_to},
            digest=digest,
            snapshot={"rows": rows},
        )

    def _tool_correlate_events(
        self, metric_evidence_id: str, window_from: str, window_to: str
    ) -> EvidenceRecord:
        """Aligns a metric series breakpoint against known change events
        (experiments, releases, LiveOps). Deterministic timeline math."""
        metric_ev = self.ctx.evidence.get(metric_evidence_id)
        rows = metric_ev.result_digest.get("rows", [])
        series = [
            (str(r.get("bucket", "")), float(r.get("value") or 0))
            for r in rows
            if r.get("value") is not None
        ]
        breakpoint_date = _largest_drop_date(series)
        events = self.ctx.data.experiments(window_from, window_to)
        coincident = [
            {"kind": str(e["kind"]), "name": str(e["name"]), "startsAt": str(e["starts_at"])[:10]}
            for e in events
            if breakpoint_date
            and abs(_days_between(str(e["starts_at"])[:10], breakpoint_date)) <= 2
        ]
        digest = {
            "breakpointDate": breakpoint_date,
            "coincidentEvents": coincident,
            "eventCountInWindow": len(events),
        }
        return self.ctx.evidence.record(
            kind="computation",
            params={"metricEvidenceId": metric_evidence_id, "from": window_from, "to": window_to},
            digest=digest,
            snapshot={"series": series, "events": [dict(e) for e in events]},
        )

    def _tool_fatigue_check(
        self, creative_filters: dict[str, Any], range_: dict[str, str]
    ) -> EvidenceRecord:
        res = self.ctx.metrics.query(
            self.ctx.tenant_id, "creative_ipm", range_, [], creative_filters
        )
        series = [
            float(r.get("value") or 0)
            for r in res.get("rows", [])
            if r.get("value") is not None
        ]
        fit = fit_fatigue_curve(series)
        digest = {
            "filters": creative_filters,
            "points": len(series),
            "decayPctPerDay": fit.decay_pct_per_day,
            "totalDeclinePct": fit.total_decline_pct,
            "isFatigued": fit.is_fatigued,
            "peakIndex": fit.peak_index,
        }
        return self.ctx.evidence.record(
            kind="computation",
            metric_key="creative_ipm",
            params={"filters": creative_filters, "range": range_},
            digest=digest,
            snapshot={"series": series, "fit": digest},
        )

    def _tool_get_entity(self, entity_id: str) -> EvidenceRecord:
        row = self.ctx.data.campaign(entity_id)
        digest = dict(row) if row else {"missing": True, "entityId": entity_id}
        return self.ctx.evidence.record(
            kind="external",
            params={"entityId": entity_id},
            digest={k: str(v) for k, v in digest.items()},
            snapshot={"entity": digest},
        )

    def _tool_list_entities(self) -> EvidenceRecord:
        rows = self.ctx.data.campaigns()
        digest = {
            "count": len(rows),
            "campaigns": [
                {
                    "id": str(r["id"]),
                    "name": str(r["name"]),
                    "channel": str(r["channel"]),
                    "budget": str(r.get("budget_amount")),
                    "managedState": str(r.get("managed_state")),
                }
                for r in rows[:25]
            ],
        }
        return self.ctx.evidence.record(
            kind="external", params={}, digest=digest, snapshot={"rows": rows}
        )


def _largest_drop_date(series: list[tuple[str, float]]) -> str | None:
    if len(series) < 3:
        return None
    worst_idx, worst_delta = None, 0.0
    for i in range(1, len(series)):
        prev, cur = series[i - 1][1], series[i][1]
        if prev > 0:
            delta = (cur - prev) / prev
            if delta < worst_delta:
                worst_delta, worst_idx = delta, i
    return series[worst_idx][0] if worst_idx is not None else None


def _days_between(a: str, b: str) -> int:
    from datetime import date

    return (date.fromisoformat(a) - date.fromisoformat(b)).days
