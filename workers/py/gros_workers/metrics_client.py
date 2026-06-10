"""Metrics access for the worker plane.

Agents and detectors read metrics EXCLUSIVELY through the API's semantic
layer (/v1/metrics/*) — the same governed read path the UI uses, so agent
numbers and dashboard numbers can never diverge (docs/04 §4.6).
"""

from __future__ import annotations

from typing import Any, Protocol

import httpx

from .settings import get_settings


class MetricsClient(Protocol):
    def query(
        self,
        tenant_id: str,
        metric_key: str,
        range_: dict[str, str],
        dimensions: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        grain: str = "day",
    ) -> dict[str, Any]: ...

    def decompose(
        self,
        tenant_id: str,
        metric_key: str,
        window_a: dict[str, str],
        window_b: dict[str, str],
        dimensions: list[str],
        filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class ApiMetricsClient:
    def __init__(self, base_url: str | None = None, service_token: str | None = None):
        s = get_settings()
        self.base_url = (base_url or s.worker_api_url).rstrip("/")
        self.token = service_token or s.service_token

    def _headers(self, tenant_id: str) -> dict[str, str]:
        return {"x-service-token": self.token, "x-tenant-id": tenant_id}

    def query(
        self,
        tenant_id: str,
        metric_key: str,
        range_: dict[str, str],
        dimensions: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        grain: str = "day",
    ) -> dict[str, Any]:
        resp = httpx.post(
            f"{self.base_url}/v1/metrics/query",
            headers=self._headers(tenant_id),
            json={
                "metricKey": metric_key,
                "grain": grain,
                "dimensions": dimensions or [],
                "filters": filters or {},
                "range": range_,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data

    def decompose(
        self,
        tenant_id: str,
        metric_key: str,
        window_a: dict[str, str],
        window_b: dict[str, str],
        dimensions: list[str],
        filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        resp = httpx.post(
            f"{self.base_url}/v1/metrics/decompose",
            headers=self._headers(tenant_id),
            json={
                "metricKey": metric_key,
                "windowA": window_a,
                "windowB": window_b,
                "dimensions": dimensions,
                "filters": filters or {},
            },
            timeout=120,
        )
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data


class FixtureMetricsClient:
    """Deterministic metrics source for tests and golden incidents.

    Fixtures are keyed by (metric_key, frozenset of salient params). Lookup
    falls back to metric_key alone. Raises KeyError for unknown metrics —
    a fixture gap must fail the test, never fabricate data.
    """

    def __init__(self, fixtures: dict[str, Any]):
        self.fixtures = fixtures
        self.calls: list[dict[str, Any]] = []

    def query(
        self,
        tenant_id: str,
        metric_key: str,
        range_: dict[str, str],
        dimensions: list[str] | None = None,
        filters: dict[str, Any] | None = None,
        grain: str = "day",
    ) -> dict[str, Any]:
        self.calls.append({"op": "query", "metric": metric_key, "filters": filters})
        key = f"query:{metric_key}"
        if key not in self.fixtures:
            raise KeyError(f"no fixture for {key}")
        return dict(self.fixtures[key])

    def decompose(
        self,
        tenant_id: str,
        metric_key: str,
        window_a: dict[str, str],
        window_b: dict[str, str],
        dimensions: list[str],
        filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append({"op": "decompose", "metric": metric_key})
        key = f"decompose:{metric_key}"
        if key not in self.fixtures:
            raise KeyError(f"no fixture for {key}")
        return dict(self.fixtures[key])
