"""Meta connector tests against recorded-style fixtures (httpx MockTransport).
No real Meta API is ever called from tests — or from this build at all."""

import json
from typing import Any

import httpx

from gros_workers.connectors.meta_ads import (
    MetaAdsConnector,
    normalize_campaign,
    normalize_insight,
)

CAMPAIGNS_FIXTURE = {
    "data": [
        {"id": "1001", "name": "DE_Google_Style_UA", "status": "ACTIVE",
         "objective": "APP_INSTALLS", "daily_budget": "120000"},
        {"id": "1002", "name": "US_ASC", "status": "PAUSED",
         "objective": "OUTCOME_SALES", "lifetime_budget": "5000000"},
    ],
    "paging": {"cursors": {"after": None}},
}

INSIGHTS_FIXTURE = {
    "data": [
        {"campaign_id": "1001", "date_start": "2026-06-01", "impressions": "150000",
         "clicks": "1800", "spend": "1187.42",
         "actions": [{"action_type": "mobile_app_install", "value": "520"},
                     {"action_type": "purchase", "value": "33"}]},
        {"campaign_id": "1001", "date_start": "2026-06-02", "impressions": "149000",
         "clicks": "1750", "spend": "1190.00",
         "actions": [{"action_type": "mobile_app_install", "value": "505"}]},
    ],
    "paging": {"cursors": {"after": None}},
}


def make_transport(permissions: list[dict[str, str]]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/me/permissions"):
            return httpx.Response(200, json={"data": permissions})
        if path.endswith("/act_123") and "fields" in str(request.url):
            return httpx.Response(200, json={"name": "E2E Account", "account_status": 1})
        if path.endswith("/act_123/campaigns"):
            return httpx.Response(200, json=CAMPAIGNS_FIXTURE)
        if path.endswith("/act_123/insights"):
            return httpx.Response(200, json=INSIGHTS_FIXTURE)
        return httpx.Response(404, json={"error": f"unexpected path {path}"})

    return httpx.MockTransport(handler)


READ_ONLY = [{"permission": "ads_read", "status": "granted"}]
CREDS = {"access_token": "tok"}
CONFIG: dict[str, Any] = {"ad_account_id": "act_123"}


def test_check_accepts_read_only_token() -> None:
    conn = MetaAdsConnector(transport=make_transport(READ_ONLY))
    report = conn.check(CREDS, CONFIG)
    assert report.ok
    assert report.account_name == "E2E Account"


def test_check_refuses_write_capable_tokens() -> None:
    """Structural L2 safety: a token that COULD mutate campaigns is rejected
    at connect time, before any data flows."""
    writey = READ_ONLY + [{"permission": "ads_management", "status": "granted"}]
    conn = MetaAdsConnector(transport=make_transport(writey))
    report = conn.check(CREDS, CONFIG)
    assert not report.ok
    assert "write scopes" in report.detail


def test_backfill_yields_entities_then_insights_with_cursor() -> None:
    conn = MetaAdsConnector(transport=make_transport(READ_ONLY))
    batches = list(conn.backfill(CREDS, CONFIG, "2026-06-01", "2026-06-02", "t1"))
    assert [b.entity_kind for b in batches] == ["entity_snapshot", "spend_row"]
    campaigns = batches[0].normalized["campaigns"]
    assert campaigns[0] == {
        "external_id": "1001", "name": "DE_Google_Style_UA", "channel": "meta",
        "objective": "APP_INSTALLS", "status": "active",
        "budget_amount": 1200.0, "budget_type": "daily",
    }
    spend = batches[1].normalized["spend_metrics_daily"]
    assert spend[0]["installs"] == 520
    assert spend[0]["spend_usd"] == 1187.42
    assert batches[1].cursor == {"lastDate": "2026-06-02"}
    # Raw payloads are preserved verbatim for the raw zone.
    assert json.loads(json.dumps(batches[1].raw_payloads[0]))["spend"] == "1187.42"


def test_normalize_campaign_handles_lifetime_budgets_and_statuses() -> None:
    row = normalize_campaign({"id": "9", "name": "X", "status": "ARCHIVED",
                              "lifetime_budget": "250000"})
    assert row["status"] == "archived"
    assert row["budget_amount"] == 2500.0
    assert row["budget_type"] == "lifetime"


def test_normalize_insight_defaults_and_validates() -> None:
    row = normalize_insight({"campaign_id": "1", "date_start": "2026-06-01"})
    assert row["installs"] == 0 and row["spend_usd"] == 0.0
    try:
        normalize_insight({"campaign_id": "1", "date_start": "garbage"})
        raise AssertionError("malformed dates must fail loudly")
    except ValueError:
        pass
