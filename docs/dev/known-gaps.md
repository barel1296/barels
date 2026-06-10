# Known Gaps & Why

Honest inventory of what is NOT implemented, mapped to the founding spec's
roadmap (docs/11). Nothing here is silently stubbed into the product path —
gaps either have explicit interfaces, fail loudly, or are absent entirely.

## Closed by the production-hardening pass (for the record)

argon2id (with transparent bcrypt upgrade) · Idempotency-Key replay ·
rate limiting · security headers/CSP · automated e2e in CI (postgres service,
non-superuser role) · connector framework + **Meta Ads connector** (read-only
tokens enforced at connect time) · sync runner with raw zone, registry
resolution, cursors, freshness DQ checks · anomaly→session auto-triage ·
action/recommendation expiry + zombie-session timeout · predicted-vs-realized
outcome job · worker scheduler · S3 artifact store option · Dockerfiles +
production compose + deployment runbook · production boot refuses dev secrets.

## Data plane

- **Connectors beyond Meta** (AppsFlyer, Google, TikTok, RevenueCat,
  Firebase) — the framework, credential encryption, sync runner, scheduler
  and freshness checks are shared; each remaining source is a connector class
  + normalizer + fixtures (Meta is the template). AppsFlyer is the highest-
  value next one (attribution + revenue cross-checks).
- **Meta connector has not run against the live Meta API** — it is fully
  tested against recorded-style fixtures and the whole sync path is verified
  against live Postgres, but first contact with a real ad account (token
  shapes, rate-limit behavior at volume, country breakdowns) needs a real
  sandbox account. Country breakdown (`breakdowns=country`) is a config flag
  away but defaults to account-level rows.
- **Cross-source reconciliation** (network vs MMP vs revenue) — requires a
  second source; the freshness/unresolved-ref checks are live today.
- **Cohort/creative mart builders** — populated by the dev seed; production
  builders land with the attribution/revenue connectors that feed them.

## Agent plane

- **Live-LLM prompt tuning** — the full pipeline runs (verified with the
  scripted provider against live Postgres); real Anthropic/OpenAI calls use
  the same gateway, but prompt packs are untuned against real model outputs.
  Expect structured-output retries until tuned; the validator catches
  anything unbacked (by design).
- **Creative tagging pipeline & competitor scout** — schema + brief models
  exist; multimodal tagging is Phase-4 work.
- **Calibration page** — outcomes are computed and stored; the per-tenant
  "when we say 0.8 we were right X%" surface is not built.

## Execution

- **No execution adapters exist** (validate/dry_run/execute/verify/rollback).
  Intentional at autonomy level 2: approval marks an action `approved` and
  stops; the API rejects policy writes above L2. The Meta connector refuses
  write-scoped tokens, so the system cannot mutate platforms even if every
  software control failed.

## Platform

- Email invitations (dev returns a temp password once), MFA enrollment
  (column exists), SSO/SAML, Slack approvals, billing, OpenTelemetry
  exporters (structured logs + request-ids exist), SIEM export, Kubernetes
  manifests.
- Docker images are written to standard multi-stage patterns but were not
  built in the CI/build environment (no Docker daemon available there);
  first `docker build` may need minor path adjustments.

## UI

- Contention cards as a distinct component, session export, evidence re-run
  & drift diff, command palette/keyboard nav, UA & budget drill-down tables,
  product-growth and ASO modules, integration credential entry form (API
  accepts credentials; the settings UI lists integrations but the connect
  form is API/curl-first for now).
