"""Meta Marketing API connector: campaign entities + daily insights.

READ-ONLY by construction: every request is a GET against the Graph API; the
connector has no code path that mutates anything on Meta. Insights are pulled
with a 3-day lookback on incremental syncs because networks restate recent
days (docs/04 §4.4); the ReplacingMergeTree mart converges on re-insert.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, datetime, timedelta
from typing import Any

import httpx

from .base import HealthReport, RawBatch, register

GRAPH = "https://graph.facebook.com/v21.0"
INSIGHT_FIELDS = "campaign_id,impressions,clicks,spend,actions,date_start"
LOOKBACK_DAYS = 3
PAGE_LIMIT = 500


class MetaAdsConnector:
    source_key = "meta_ads"

    def __init__(self, transport: httpx.BaseTransport | None = None):
        # A custom transport is injected by tests (MockTransport with recorded
        # fixtures); production uses the default HTTP transport.
        self._transport = transport

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=GRAPH, timeout=60, transport=self._transport)

    def _get(self, client: httpx.Client, path: str, token: str,
             params: dict[str, Any]) -> dict[str, Any]:
        resp = client.get(path, params={**params, "access_token": token})
        if resp.status_code == 429 or (
            resp.status_code == 400 and "rate limit" in resp.text.lower()
        ):
            raise RuntimeError("meta rate limited; sync will retry with backoff")
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
        return data

    def _paged(self, client: httpx.Client, path: str, token: str,
               params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        after: str | None = None
        while True:
            page_params = {**params, "limit": PAGE_LIMIT}
            if after:
                page_params["after"] = after
            data = self._get(client, path, token, page_params)
            yield from data.get("data", [])
            after = data.get("paging", {}).get("cursors", {}).get("after")
            if not after or not data.get("paging", {}).get("next"):
                break

    # ── contract ─────────────────────────────────────────────────────────────

    def check(self, credentials: dict[str, str], config: dict[str, Any]) -> HealthReport:
        token = credentials.get("access_token", "")
        account = str(config.get("ad_account_id", ""))
        if not token or not account:
            return HealthReport(ok=False, detail="access_token and ad_account_id required")
        with self._client() as client:
            try:
                me = self._get(client, "/me/permissions", token, {})
                granted = [
                    p["permission"] for p in me.get("data", [])
                    if p.get("status") == "granted"
                ]
                # Structural safety at autonomy L2: refuse write-capable tokens.
                writey = [p for p in granted if p in ("ads_management",)]
                if writey:
                    return HealthReport(
                        ok=False,
                        detail=f"token carries write scopes {writey}; connect a read-only "
                        "token (ads_read) — execution scopes are a later, gated upgrade",
                        scopes=granted,
                    )
                if "ads_read" not in granted:
                    return HealthReport(ok=False, detail="token lacks ads_read", scopes=granted)
                acct = self._get(client, f"/{account}", token, {"fields": "name,account_status"})
                return HealthReport(
                    ok=True, scopes=granted, account_name=str(acct.get("name", account))
                )
            except httpx.HTTPStatusError as err:
                return HealthReport(ok=False, detail=f"meta api {err.response.status_code}")

    def backfill(self, credentials: dict[str, str], config: dict[str, Any],
                 window_from: str, window_to: str, tenant_id: str) -> Iterator[RawBatch]:
        yield from self._pull(credentials, config, window_from, window_to, tenant_id)

    def sync_incremental(self, credentials: dict[str, str], config: dict[str, Any],
                         cursor: dict[str, Any], tenant_id: str) -> Iterator[RawBatch]:
        last = str(cursor.get("lastDate", "")) or (
            date.today() - timedelta(days=LOOKBACK_DAYS)
        ).isoformat()
        window_from = (
            date.fromisoformat(last) - timedelta(days=LOOKBACK_DAYS)
        ).isoformat()
        yield from self._pull(
            credentials, config, window_from, date.today().isoformat(), tenant_id
        )

    # ── pull + normalize ─────────────────────────────────────────────────────

    def _pull(self, credentials: dict[str, str], config: dict[str, Any],
              window_from: str, window_to: str, tenant_id: str) -> Iterator[RawBatch]:
        token = credentials["access_token"]
        account = str(config["ad_account_id"])
        with self._client() as client:
            # 1. Campaign entities (registry upserts).
            campaigns = list(
                self._paged(
                    client, f"/{account}/campaigns", token,
                    {"fields": "id,name,status,objective,daily_budget,lifetime_budget"},
                )
            )
            yield RawBatch(
                entity_kind="entity_snapshot",
                raw_payloads=campaigns,
                normalized={"campaigns": [normalize_campaign(c) for c in campaigns]},
            )

            # 2. Daily insights at campaign grain.
            insights = list(
                self._paged(
                    client, f"/{account}/insights", token,
                    {
                        "level": "campaign",
                        "fields": INSIGHT_FIELDS,
                        "time_increment": 1,
                        "time_range": (
                            f'{{"since":"{window_from}","until":"{window_to}"}}'
                        ),
                    },
                )
            )
            rows = [normalize_insight(i) for i in insights]
            last_date = max((r["date"] for r in rows), default=window_to)
            yield RawBatch(
                entity_kind="spend_row",
                raw_payloads=insights,
                normalized={"spend_metrics_daily": rows},
                cursor={"lastDate": last_date},
            )


def normalize_campaign(payload: dict[str, Any]) -> dict[str, Any]:
    """Meta campaign -> canonical registry upsert. Budgets arrive in minor
    currency units (cents)."""
    daily = payload.get("daily_budget")
    lifetime = payload.get("lifetime_budget")
    budget_amount = None
    budget_type = None
    if daily is not None:
        budget_amount = round(int(daily) / 100, 2)
        budget_type = "daily"
    elif lifetime is not None:
        budget_amount = round(int(lifetime) / 100, 2)
        budget_type = "lifetime"
    status = str(payload.get("status", "ACTIVE")).lower()
    return {
        "external_id": str(payload["id"]),
        "name": str(payload.get("name", payload["id"])),
        "channel": "meta",
        "objective": payload.get("objective"),
        "status": "active" if status == "active" else
                  "paused" if status == "paused" else "archived",
        "budget_amount": budget_amount,
        "budget_type": budget_type,
    }


def normalize_insight(payload: dict[str, Any]) -> dict[str, Any]:
    """Meta daily insight row -> canonical spend mart row. Installs come from
    the actions array (mobile_app_install); absent action types are zero, and
    malformed numerics fail loudly rather than coercing to garbage."""
    installs = 0
    for action in payload.get("actions", []) or []:
        if action.get("action_type") == "mobile_app_install":
            installs = int(float(action.get("value", 0)))
    day = str(payload["date_start"])
    datetime.strptime(day, "%Y-%m-%d")  # validate, raise on garbage
    return {
        "campaign_external": str(payload["campaign_id"]),
        "date": day,
        "impressions": int(payload.get("impressions", 0) or 0),
        "clicks": int(payload.get("clicks", 0) or 0),
        "installs": installs,
        "spend_usd": round(float(payload.get("spend", 0) or 0), 4),
        "country": "ALL",  # country breakdown is a config option (breakdowns=country)
        "platform": "all",
    }


register(MetaAdsConnector())
