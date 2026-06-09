# Known Gaps & Why

Honest inventory of what is NOT implemented in this build, mapped to the
founding spec's roadmap (docs/11). Nothing here is silently stubbed into the
product path — gaps either have explicit interfaces, fail loudly, or are
absent entirely.

## Data plane

- **Live external connectors (AppsFlyer, Meta, Google, TikTok, RevenueCat,
  Firebase)** — Phase 1 of the roadmap. The integration registry, encrypted
  credential storage (AES-GCM local-KMS abstraction), sync_runs bookkeeping,
  data-source catalog and the ClickHouse landing schema exist; no external
  API is called anywhere. Reason: connectors require real accounts/credentials
  and weeks of reconciliation work per source (spec Part 11, exit criteria).
  First-party ingestion (`/v1/ingest/events`) IS live with taxonomy quarantine.
- **Reconciliation jobs** producing `data_quality_checks` — table, API,
  Tracking Health UI and the health-gate consumption path exist; the
  cross-source jobs themselves arrive with connectors (nothing to reconcile
  against until two sources flow).
- **Cohort/creative mart builder jobs** — marts are populated by the dev seed;
  production builders belong to the connector phase. Metric definitions and
  the query path are final.

## Agent plane

- **Live-LLM session quality** — the orchestrator, protocol, tools, budgets
  and publish gate run end-to-end (verified with the scripted provider and a
  live Postgres); real Anthropic/OpenAI calls go through the same gateway but
  prompt packs have NOT been tuned against real model outputs. Expect
  structured-output retries until tuned (the validator will catch anything
  unbacked — that is the design).
- **Triage layer** (anomaly→session auto-creation with dedupe/merge) —
  detection writes anomalies and sessions can be started by users; the
  automatic anomaly→playbook router is the next worker job kind.
- **Creative tagging pipeline & competitor scout** — `creatives.tags` schema
  and the Creative Agent's brief models exist; multimodal tagging and ad-
  library ingestion are Phase-4 work.
- **Outcome tracking** (predicted vs realized at horizon) — `recommendations.
  outcome` column and monitoring_plan structures exist; the scheduled job and
  calibration page are not built.

## Execution

- **No execution adapters exist at all** (validate/dry_run/execute/verify/
  rollback). This is intentional for autonomy level 2: approval marks an
  action `approved` and stops. `executions` table, idempotency keys, rollback/
  monitoring plans are in place so adapters can land without schema change.
  The API rejects any `autonomyLevel != 2` policy write.

## Platform

- argon2id (using bcryptjs), email invitations (dev returns a temp password
  once), MFA enrollment (column exists), SSO/SAML, Slack approvals, billing,
  rate limiting, OpenTelemetry wiring (request-ids + structured logs exist;
  OTel exporters do not), S3 artifact store (local FS behind the interface),
  Redis caching (provisioned, unused), CSP headers on web.
- **Idempotency-Key interceptor** — table exists; interceptor not wired.
- **API e2e tests against live Postgres** — the isolation suite ran manually
  in this build's verification (documented in architecture-notes); an
  automated CI variant needs a Postgres service container.

## UI

- Contention cards as a distinct component (challenges are visually marked in
  the thread instead), session export, evidence re-run & drift diff, command
  palette/keyboard nav, UA & budget drill-down tables, product-growth and ASO
  modules (APIs partially exist; pages not built).
