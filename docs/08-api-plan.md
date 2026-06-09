# Part 8 — API Plan

API-first: the web app consumes the same versioned REST API exposed to customers. Base path `/v1`. OpenAPI generated from NestJS decorators + Zod schemas; SDK generated from spec.

**Conventions**
- AuthN: `Authorization: Bearer <JWT>` (web session via httpOnly cookie wraps the same tokens) or `X-Api-Key` for machine access.
- Tenancy: tenant resolved from token; cross-tenant access impossible by construction (RLS). Agency users switch via `X-Tenant-Id` (validated against memberships).
- All mutating POSTs accept `Idempotency-Key`.
- Pagination: cursor-based (`?cursor=&limit=`). Errors: RFC 7807 problem+json. Every response carries `request_id`.
- Realtime: `GET /v1/stream` (SSE) with event types `session.message`, `session.phase`, `action.status`, `anomaly.new`, `approval.requested`, `health.changed`.

## 8.1 Authentication & identity

```
POST   /v1/auth/register              First user + tenant bootstrap (invite-only flag in v1)
POST   /v1/auth/login                 Email/password → access+refresh tokens (sets cookies on web)
POST   /v1/auth/refresh
POST   /v1/auth/logout
POST   /v1/auth/mfa/enroll | /verify
GET    /v1/auth/sso/:provider/start | /callback        (Google OAuth v1; SAML Phase 7)
GET    /v1/me                          Profile + memberships + permissions (drives UI gating)
PATCH  /v1/me
```

## 8.2 Tenants, users, roles

```
GET    /v1/tenant                      Current tenant (settings, plan, llm budget)
PATCH  /v1/tenant                      [tenant:manage]
GET    /v1/tenant/members              List memberships
POST   /v1/tenant/members/invite       [members:manage]
PATCH  /v1/tenant/members/:id          Change role / deactivate
GET    /v1/roles                       System + custom roles with permission sets
POST   /v1/roles                       [roles:manage] custom role
PATCH  /v1/roles/:id
GET    /v1/permissions                 Permission catalog
GET    /v1/api-keys  POST /v1/api-keys  DELETE /v1/api-keys/:id    [apikeys:manage]
```

## 8.3 Integrations & data ingestion

```
GET    /v1/data-sources                          Connector catalog + capabilities
GET    /v1/integrations                          With live health
POST   /v1/integrations                          [integrations:manage] start setup
GET    /v1/integrations/oauth/:source/start | /callback
POST   /v1/integrations/:id/check                Re-validate credentials & scopes
POST   /v1/integrations/:id/backfill             {window} → backfill job
POST   /v1/integrations/:id/sync                 Manual incremental trigger
PATCH  /v1/integrations/:id                      Pause/resume/config
DELETE /v1/integrations/:id                      Revoke + schedule data purge
GET    /v1/integrations/:id/sync-runs            History with errors/lag

POST   /v1/ingest/events                         First-party event ingestion (api-key scoped,
                                                 batched, schema-validated against taxonomy)
POST   /v1/ingest/webhooks/:source               RevenueCat etc. (signature-verified)
GET    /v1/taxonomy                              Canonical event dictionary
PUT    /v1/taxonomy/events/:name                 [taxonomy:manage] define/version events
```

## 8.4 Metrics & dashboards (semantic layer — the only read path)

```
GET    /v1/metrics/definitions                   All metric definitions (key, version, caveats)
POST   /v1/metrics/query                         {metric_key, grain, dimensions[], filters{},
                                                  range, compare_to?} → series/table + freshness
                                                  + caveats. Used by UI, agents, and customers.
POST   /v1/metrics/decompose                     Contribution analysis of a metric change across
                                                  dimensions (the Intelligence workhorse, exposed)
GET    /v1/dashboard/command-center              The 10-second payload: status summary, deltas,
                                                  waste & scale cards, top recommendations,
                                                  approvals count, health strip (single request)
GET    /v1/dashboard/ua                          UA & budget intelligence view model
GET    /v1/dashboard/creatives                   Creative intelligence view model
GET    /v1/dashboard/product-growth              Funnel/cohort/paywall view model
GET    /v1/dashboard/aso                         ASO insights view model
GET    /v1/cohorts                               Cohort grid (params: breakdown, day_n set)
```

## 8.5 Tracking health

```
GET    /v1/health/status                         Per-domain green/yellow/red + reasons
GET    /v1/health/checks                         data_quality_checks (filter: domain, status, range)
GET    /v1/health/reconciliation                 Cross-source delta reports with drilldown
POST   /v1/health/checks/:id/acknowledge         Mute known issue with reason [health:manage]
POST   /v1/health/override                       Human override of a red gate (logged, reasoned)
```

## 8.6 Agents & War Room

```
GET    /v1/sessions                              War Room list (filters: status, phase, scope, playbook)
POST   /v1/sessions                              Start investigation {question|scope|playbook_key}
                                                 [warroom:create]
GET    /v1/sessions/:id                          Full session: phases, decision, actions
GET    /v1/sessions/:id/messages                 Thread (cursor-paginated; live tail via /stream)
POST   /v1/sessions/:id/messages                 Ask-the-room directive [warroom:participate]
POST   /v1/sessions/:id/cancel                   [warroom:manage]
GET    /v1/sessions/:id/export                   Markdown/PDF timeline

GET    /v1/evidence/:id                          Digest + definition + params
GET    /v1/evidence/:id/snapshot                 Frozen result (S3-signed)
POST   /v1/evidence/:id/rerun                    Re-execute & diff (evidence drift)

GET    /v1/agents                                Roster, model tiers, per-agent activity stats
GET    /v1/agents/runs                           agent_runs (cost, tokens, status; filterable)
GET    /v1/playbooks                             Active playbooks + versions
PATCH  /v1/playbooks/:key                        Enable/disable per tenant [policies:manage]
GET    /v1/memory                                Tenant business memory entries
PUT    /v1/memory/:category/:key                 Curate memory [memory:manage]
```

## 8.7 Recommendations

```
GET    /v1/recommendations                       Filters: status, category, confidence_gte, scope
GET    /v1/recommendations/:id                   Full: evidence, confidence breakdown, actions
POST   /v1/recommendations/:id/dismiss           With mandatory reason_code [recs:manage]
GET    /v1/recommendations/stats                 Precision/calibration: approval rate, predicted-vs-
                                                 realized, by playbook (the trust dashboard)
```

## 8.8 Actions & approvals

```
GET    /v1/actions                               Queue (status, kind, magnitude filters)
GET    /v1/actions/:id                           Diff, payload, guardrails, dry-run, plans
POST   /v1/actions/:id/dry-run                   Re-validate against platform now
POST   /v1/actions/:id/approve                   [actions:approve:<kind>] body: {confirm_diff_hash}
                                                 — client must echo the diff hash it displayed,
                                                 preventing approve-on-stale-render
POST   /v1/actions/:id/reject                    {reason_code, note} required
POST   /v1/actions/:id/modify                    Bounded param edits → new version (supersedes)
POST   /v1/actions/:id/execute                   System-internal post-approval; exposed for retry
                                                 [actions:execute] (L3+ only)
POST   /v1/actions/:id/rollback                  Manual rollback trigger [actions:execute]
GET    /v1/actions/:id/executions                Attempt log with request/response digests

GET    /v1/approval-policies                     Per-kind rules + autonomy level
PUT    /v1/approval-policies/:kind               [policies:manage] — changing autonomy_level
                                                 requires elevated permission + writes audit event
GET    /v1/guardrails                            Guardrail policy set
PUT    /v1/guardrails/:key                       [policies:manage]
```

## 8.9 Audit & cost

```
GET    /v1/audit-logs                            Filters: actor, event, object, range; cursor-paginated
GET    /v1/audit-logs/export                     CSV/JSON async export job
GET    /v1/costs/llm                             Ledger rollups by agent/session/model/day
GET    /v1/costs/budget                          Budget status + projections
PUT    /v1/costs/budget                          [tenant:manage]
```

## 8.10 Notifications

```
GET/PUT /v1/notifications/preferences            Digest cadence, channels, thresholds
POST    /v1/notifications/slack/install | /callback
POST    /v1/webhooks                             Customer outbound webhooks (recommendation.created,
GET     /v1/webhooks                              action.awaiting_approval, action.executed,
DELETE  /v1/webhooks/:id                          health.changed) — HMAC-signed
```

## 8.11 Permission ↔ endpoint matrix (excerpt of enforcement defaults)

| Permission | Default roles | Gates |
|---|---|---|
| `metrics:read` | all roles | 8.4, dashboards |
| `warroom:participate` | Analyst+ | ask-the-room, start sessions |
| `actions:approve:budget` | Approver+ (CMO above threshold via policy) | approve/reject budget actions |
| `actions:approve:creative` / `:crm` / `:campaign` | Approver+ | per-kind approval |
| `policies:manage` | Admin+ | guardrails, approval policies, autonomy level |
| `integrations:manage` | Admin+ | connect/revoke sources |
| `audit:read` | Admin+ (Viewer for own actions) | audit endpoints |
| `actions:execute` | none in L2 (system only) | manual execute/rollback at L3+ |

Magnitude-tiered approval (e.g., budget moves >$5K/day need `role >= cmo_approver`) is evaluated by `approval_policies.rules` at approve-time, not by static permission alone.
