"""Sync runner: executes a connector for one integration, persisting the raw
zone, registry upserts, mart rows, sync bookkeeping and a freshness check.

ClickHouse writes are injectable (tests/live verification run with a capture
writer); Postgres goes through worker_conn with the tenant context set.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from ..credentials import decrypt_credentials
from ..db import worker_conn
from .base import RawBatch, get_connector

ChWriter = Callable[[str, list[dict[str, Any]]], None]


def clickhouse_writer() -> ChWriter:
    import clickhouse_connect

    from ..settings import get_settings

    s = get_settings()
    tail = s.clickhouse_url.split("//")[-1]
    host = tail.split(":")[0]
    port = int(tail.rsplit(":", 1)[-1]) if ":" in tail else 8123
    client = clickhouse_connect.get_client(
        host=host, port=port, username=s.clickhouse_user,
        password=s.clickhouse_password, database=s.clickhouse_db,
    )

    def write(table: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        cols = sorted(rows[0].keys())
        client.insert(table, [[r[c] for c in cols] for r in rows], column_names=cols)

    return write


def _payload_hash(payload: dict[str, Any]) -> int:
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFFFFFFFFFFFFFF


def run_sync_job(
    tenant_id: str,
    integration_id: str,
    kind: str = "incremental",
    window: dict[str, str] | None = None,
    ch_write: ChWriter | None = None,
) -> dict[str, Any]:
    ch = ch_write or clickhouse_writer()

    with worker_conn(tenant_id) as conn:
        integration = conn.execute(
            """SELECT id, source_key, credentials_enc, config, status
                 FROM integrations WHERE id = %s AND tenant_id = %s""",
            (integration_id, tenant_id),
        ).fetchone()
        if integration is None:
            raise KeyError(f"integration not found: {integration_id}")
        if integration["credentials_enc"] is None:
            raise ValueError("integration has no credentials; connect it first")
        run_row = conn.execute(
            """INSERT INTO sync_runs (tenant_id, integration_id, kind, status,
                                      cursor_before, window_start, window_end)
               VALUES (%s, %s, %s, 'running', %s, %s, %s) RETURNING id""",
            (
                tenant_id, integration_id, kind,
                json.dumps(dict(integration["config"]).get("cursor", {})),
                (window or {}).get("from"), (window or {}).get("to"),
            ),
        ).fetchone()
        assert run_row is not None
        sync_run_id = str(run_row["id"])

    config = dict(integration["config"])
    credentials = decrypt_credentials(bytes(integration["credentials_enc"]))
    connector = get_connector(str(integration["source_key"]))

    rows_ingested = 0
    cursor_after: dict[str, Any] = config.get("cursor", {})
    try:
        if kind == "backfill":
            w = window or {}
            batches = connector.backfill(
                credentials, config, w.get("from", ""), w.get("to", ""), tenant_id
            )
        else:
            batches = connector.sync_incremental(
                credentials, config, config.get("cursor", {}), tenant_id
            )
        for batch in batches:
            rows_ingested += _persist_batch(
                tenant_id, integration_id, sync_run_id,
                str(integration["source_key"]), batch, ch,
            )
            if batch.cursor:
                cursor_after = batch.cursor

        with worker_conn(tenant_id) as conn:
            conn.execute(
                """UPDATE sync_runs SET status = 'succeeded', rows_ingested = %s,
                          cursor_after = %s, finished_at = now() WHERE id = %s""",
                (rows_ingested, json.dumps(cursor_after), sync_run_id),
            )
            conn.execute(
                """UPDATE integrations
                      SET status = 'healthy',
                          config = config || %s::jsonb,
                          health = %s, updated_at = now()
                    WHERE id = %s""",
                (
                    json.dumps({"cursor": cursor_after}),
                    json.dumps({"lastSync": datetime.now(UTC).isoformat(),
                                "rows": rows_ingested}),
                    integration_id,
                ),
            )
        _record_freshness_check(tenant_id, str(integration["source_key"]), cursor_after)
        return {"rows": rows_ingested, "cursor": cursor_after, "syncRunId": sync_run_id}
    except Exception as err:
        with worker_conn(tenant_id) as conn:
            conn.execute(
                """UPDATE sync_runs SET status = 'failed', error = %s,
                          finished_at = now() WHERE id = %s""",
                (json.dumps({"message": str(err)[:500]}), sync_run_id),
            )
            conn.execute(
                "UPDATE integrations SET status = 'degraded', updated_at = now() WHERE id = %s",
                (integration_id,),
            )
        raise


def _persist_batch(
    tenant_id: str,
    integration_id: str,
    sync_run_id: str,
    source_key: str,
    batch: RawBatch,
    ch: ChWriter,
) -> int:
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
    # 1. Raw zone first — replayable forever.
    ch(
        "raw_events",
        [
            {
                "tenant_id": tenant_id,
                "source": source_key,
                "entity_kind": batch.entity_kind,
                "external_id": str(p.get("id", p.get("campaign_id", ""))),
                "payload": json.dumps(p),
                "payload_hash": _payload_hash(p),
                "ingested_at": now,
                "sync_run_id": sync_run_id,
            }
            for p in batch.raw_payloads
        ],
    )

    count = 0
    # 2. Registry upserts (Postgres).
    for campaign in batch.normalized.get("campaigns", []):
        with worker_conn(tenant_id) as conn:
            conn.execute(
                """INSERT INTO campaigns
                   (tenant_id, integration_id, external_id, name, channel, objective,
                    status, budget_amount, budget_type)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, integration_id, external_id)
                   DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
                                 objective = EXCLUDED.objective,
                                 budget_amount = EXCLUDED.budget_amount,
                                 budget_type = EXCLUDED.budget_type,
                                 updated_at = now()""",
                (
                    tenant_id, integration_id, campaign["external_id"], campaign["name"],
                    campaign["channel"], campaign.get("objective"), campaign["status"],
                    campaign.get("budget_amount"), campaign.get("budget_type"),
                ),
            )
            count += 1

    # 3. Mart rows: resolve external campaign ids to internal UUIDs.
    spend_rows = batch.normalized.get("spend_metrics_daily", [])
    if spend_rows:
        with worker_conn(tenant_id) as conn:
            mapping_rows = conn.execute(
                """SELECT external_id, id FROM campaigns
                    WHERE tenant_id = %s AND integration_id = %s""",
                (tenant_id, integration_id),
            ).fetchall()
        mapping = {str(r["external_id"]): str(r["id"]) for r in mapping_rows}
        zero = "00000000-0000-0000-0000-000000000000"
        resolved = []
        unresolved = 0
        for r in spend_rows:
            internal = mapping.get(str(r["campaign_external"]))
            if internal is None:
                unresolved += 1  # surfaced via DQ check below, never guessed
                continue
            resolved.append(
                {
                    "tenant_id": tenant_id,
                    "channel": "meta" if source_key == "meta_ads" else source_key,
                    "campaign_id": internal,
                    "ad_group_id": zero,
                    "ad_id": zero,
                    "creative_id": zero,
                    "country": r["country"],
                    "platform": r["platform"],
                    "date": r["date"],
                    "impressions": r["impressions"],
                    "clicks": r["clicks"],
                    "installs": r["installs"],
                    "spend_usd": r["spend_usd"],
                    "restated_at": now,
                }
            )
        ch("spend_metrics_daily", resolved)
        count += len(resolved)
        if unresolved:
            with worker_conn(tenant_id) as conn:
                conn.execute(
                    """INSERT INTO data_quality_checks
                       (tenant_id, check_key, domain, scope, status, observed, threshold)
                       VALUES (%s, 'unresolved_campaign_refs', 'spend', %s, 'warn', %s, %s)""",
                    (
                        tenant_id,
                        json.dumps({"source": source_key}),
                        json.dumps({"unresolvedRows": unresolved}),
                        json.dumps({"max": 0}),
                    ),
                )
    return count


def _record_freshness_check(
    tenant_id: str, source_key: str, cursor: dict[str, Any]
) -> None:
    last = str(cursor.get("lastDate", ""))
    if not last:
        return
    lag_days = (datetime.now(UTC).date() - datetime.strptime(last, "%Y-%m-%d").date()).days
    status = "pass" if lag_days <= 2 else "warn" if lag_days <= 4 else "fail"
    with worker_conn(tenant_id) as conn:
        conn.execute(
            """INSERT INTO data_quality_checks
               (tenant_id, check_key, domain, scope, status, observed, threshold)
               VALUES (%s, 'source_freshness', 'spend', %s, %s, %s, %s)""",
            (
                tenant_id, json.dumps({"source": source_key}), status,
                json.dumps({"lastDate": last, "lagDays": lag_days}),
                json.dumps({"warnDays": 2, "failDays": 4}),
            ),
        )
        if status == "fail":
            conn.execute(
                """INSERT INTO health_status (tenant_id, domain, status, reasons, declared_by)
                   VALUES (%s, 'spend', 'yellow', %s, 'tracking_agent')
                   ON CONFLICT (tenant_id, domain)
                   DO UPDATE SET status = 'yellow', reasons = EXCLUDED.reasons,
                                 declared_by = 'tracking_agent', declared_at = now()
                   WHERE health_status.status <> 'red'""",
                (tenant_id, json.dumps([{"check": "source_freshness",
                                         "source": source_key, "lagDays": lag_days}])),
            )
