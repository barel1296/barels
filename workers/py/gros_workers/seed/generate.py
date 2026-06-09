"""DEV-ONLY local dataset generator.

1. Writes deterministic synthetic analytics data to ClickHouse for the demo
   tenant (seeded first via `pnpm db:seed`): 120 days of spend, cohort,
   creative and revenue facts with PLANTED incidents — a creative-fatigue
   driven ROAS decline in DE on the Google campaign starting ~day -21.
2. Enqueues a detection job for the worker.
3. Runs ONE golden-incident session through the REAL orchestrator (PG repos,
   real evidence store, real publisher) with the eval-mode scripted provider,
   so the War Room has a fully inspectable, honestly-produced session even
   without LLM API keys.

Run: uv run python -m gros_workers.seed.generate
"""

from __future__ import annotations

import copy
import json
import random
from datetime import date, timedelta
from typing import Any

import clickhouse_connect

from ..artifacts import ArtifactStore
from ..db import worker_conn
from ..evidence import PgEvidenceStore
from ..settings import get_settings

TENANT = "aaaaaaaa-0000-4000-8000-000000000001"
APP = "aaaaaaaa-0000-4000-8000-000000000003"
C_DE = "aaaaaaaa-0000-4000-8000-000000000010"
C_US = "aaaaaaaa-0000-4000-8000-000000000011"
C_BRAND = "aaaaaaaa-0000-4000-8000-000000000012"
CR_HERO = "aaaaaaaa-0000-4000-8000-000000000020"
CR_B = "aaaaaaaa-0000-4000-8000-000000000021"
CR_C = "aaaaaaaa-0000-4000-8000-000000000022"

DAYS = 120
FATIGUE_START = 21  # days ago the hero creative began decaying

rng = random.Random(42)


def _ch_client() -> Any:
    s = get_settings()
    tail = s.clickhouse_url.split("//")[-1]
    host = tail.split(":")[0]
    port = int(tail.rsplit(":", 1)[-1]) if ":" in tail else 8123
    return clickhouse_connect.get_client(
        host=host, port=port, username=s.clickhouse_user,
        password=s.clickhouse_password, database=s.clickhouse_db,
    )


def _noise(base: float, pct: float = 0.05) -> float:
    return base * (1 + rng.uniform(-pct, pct))


def generate_clickhouse() -> None:
    client = _ch_client()
    today = date.today()
    spend_rows: list[list[Any]] = []
    cohort_rows: list[list[Any]] = []
    creative_rows: list[list[Any]] = []

    campaigns = [
        # (id, channel, country, base_budget, base_ipm, base_roas7)
        (C_DE, "google", "DE", 1200.0, 4.6, 1.55),
        (C_US, "meta", "US", 3000.0, 3.8, 1.7),
        (C_BRAND, "google", "US", 400.0, 2.0, 2.4),
    ]

    for ago in range(DAYS, 0, -1):
        d = today - timedelta(days=ago)
        dow_boost = 1.12 if d.weekday() >= 5 else 1.0
        for cid, channel, country, budget, base_ipm, base_roas in campaigns:
            fatigue_factor = 1.0
            if cid == C_DE and ago <= FATIGUE_START:
                # planted incident: IPM/ROAS decay on the DE Google campaign
                fatigue_factor = max(0.55, 1.0 - 0.022 * (FATIGUE_START - ago + 1))
            spend = _noise(budget * dow_boost)
            ipm = _noise(base_ipm * fatigue_factor)
            impressions = int(spend / _noise(9.0) * 1000)  # ~$9 CPM
            installs = int(impressions * ipm / 1000)
            clicks = int(impressions * _noise(0.012))
            spend_rows.append([
                TENANT, channel, cid,
                "00000000-0000-0000-0000-000000000000",
                "00000000-0000-0000-0000-000000000000",
                CR_HERO if cid == C_DE else CR_B,
                country, "android", d, impressions, clicks, installs,
                round(spend, 2),
            ])
            roas7 = _noise(base_roas * fatigue_factor, 0.04)
            cohort_size = installs
            spend_cohort = round(spend, 2)
            for day_n, frac in ((0, 0.18), (1, 0.42), (3, 0.68), (7, 1.0), (14, 1.28), (30, 1.6)):
                if ago <= day_n:
                    continue  # cohort not mature for this day_n yet
                retained = int(cohort_size * max(0.04, 0.42 * (0.82 ** (day_n or 1))))
                revenue = round(spend_cohort * roas7 * frac / 1.0, 2)
                cohort_rows.append([
                    TENANT, APP, d, channel, cid, country, "android",
                    day_n, cohort_size, retained,
                    int(cohort_size * 0.05), revenue, spend_cohort if day_n == 0 else 0,
                ])

        # creative mart: hero fatigues, others stable
        for crid, base in ((CR_HERO, 4.8), (CR_B, 3.9), (CR_C, 3.2)):
            factor = 1.0
            if crid == CR_HERO and ago <= FATIGUE_START:
                factor = max(0.5, 1.0 - 0.025 * (FATIGUE_START - ago + 1))
            imp = int(_noise(220_000))
            ipm_c = _noise(base * factor, 0.04)
            creative_rows.append([
                TENANT, crid, "google" if crid == CR_HERO else "meta",
                "DE" if crid == CR_HERO else "US", d,
                imp, int(imp * 0.011), int(imp * ipm_c / 1000),
                round(imp / 1000 * 9.1, 2),
                0.4, DAYS - ago,
            ])

    client.insert(
        "spend_metrics_daily", spend_rows,
        column_names=["tenant_id", "channel", "campaign_id", "ad_group_id", "ad_id",
                      "creative_id", "country", "platform", "date", "impressions",
                      "clicks", "installs", "spend_usd"],
    )
    client.insert(
        "cohort_metrics", cohort_rows,
        column_names=["tenant_id", "app_id", "cohort_date", "media_source", "campaign_id",
                      "country", "platform", "day_n", "cohort_size", "retained",
                      "payers", "revenue_usd", "spend_usd"],
    )
    client.insert(
        "creative_metrics_daily", creative_rows,
        column_names=["tenant_id", "creative_id", "channel", "country", "date",
                      "impressions", "clicks", "installs", "spend_usd",
                      "spend_share", "days_live"],
    )
    print(f"ClickHouse: {len(spend_rows)} spend, {len(cohort_rows)} cohort, "
          f"{len(creative_rows)} creative rows")


def enqueue_detection() -> None:
    with worker_conn(TENANT) as conn:
        conn.execute(
            "INSERT INTO jobs (tenant_id, kind, payload) VALUES (%s, 'run_detection', '{}')",
            (TENANT,),
        )
    print("queued detection job (start the worker to process it)")


def seed_demo_session() -> None:
    """Runs the fatigue golden incident through the real pipeline against
    Postgres, with entity ids remapped to the seeded campaigns."""
    from ..agents.roster import ROSTER
    from ..evals.harness import DEFAULT_GUARDRAILS, InMemoryLedger
    from ..evals.incidents import FATIGUE_DE
    from ..llm.gateway import LLMGateway
    from ..llm.providers import ScriptedProvider
    from ..metrics_client import FixtureMetricsClient
    from ..orchestrator.engine import Orchestrator, OrchestratorDeps
    from ..orchestrator.state import PgMessageRepo, PgSessionRepo
    from ..protocol import ProtocolValidator
    from ..recommend.publish import PgPublisher
    from ..tools import InMemoryDataAccess, ToolContext, ToolRegistry

    incident = copy.deepcopy(FATIGUE_DE)
    # Remap fixture entity ids to the seeded UUIDs.
    raw = json.dumps({"script": incident.script, "campaigns": incident.campaigns})
    raw = raw.replace("c-de-google", C_DE).replace("c-us-meta", C_US)
    remapped = json.loads(raw)
    incident.script = remapped["script"]
    incident.campaigns = remapped["campaigns"]

    with worker_conn(TENANT) as conn:
        existing = conn.execute(
            """SELECT id FROM agent_sessions
                WHERE tenant_id = %s AND trigger_ref ->> 'seed' = 'true'""",
            (TENANT,),
        ).fetchone()
        if existing:
            print("demo session already seeded — skipping")
            return
        row = conn.execute(
            """INSERT INTO agent_sessions
               (tenant_id, playbook_key, trigger_type, trigger_ref, title, scope,
                money_at_stake_usd, budgets)
               VALUES (%s, 'roas_drop', 'anomaly', %s, %s, %s, 14200, %s)
               RETURNING id""",
            (
                TENANT,
                json.dumps({"seed": "true", "detector": "zscore"}),
                incident.title,
                json.dumps(incident.scope),
                json.dumps(incident.playbook["budgets"]),
            ),
        ).fetchone()
        assert row is not None
        session_id = str(row["id"])

    evidence = PgEvidenceStore(TENANT, session_id, ArtifactStore())
    deps = OrchestratorDeps(
        sessions=PgSessionRepo(TENANT),
        messages=PgMessageRepo(
            TENANT, validator_factory=lambda: ProtocolValidator(evidence.known_ids())
        ),
        evidence=evidence,
        tools=ToolRegistry(
            ctx=ToolContext(
                tenant_id=TENANT,
                scope=incident.scope,
                metrics=FixtureMetricsClient(incident.metric_fixtures),
                data=InMemoryDataAccess(
                    health=incident.health,
                    experiments=incident.experiments,
                    campaigns=incident.campaigns,
                ),
                evidence=evidence,
            )
        ),
        gateway=LLMGateway(
            providers=[ScriptedProvider(incident.script)],
            ledger=InMemoryLedger(),
            eval_mode=True,
        ),
        publisher=PgPublisher(TENANT),
        agents={name: cls() for name, cls in ROSTER.items()},
        playbook=incident.playbook,
        tenant_memory=incident.tenant_memory,
        guardrail_policies=DEFAULT_GUARDRAILS,
    )
    result = Orchestrator(deps).run(session_id)
    print(f"demo session {session_id}: {result.phase}/{result.status}")


def main() -> None:
    generate_clickhouse()
    enqueue_detection()
    seed_demo_session()


if __name__ == "__main__":
    main()
