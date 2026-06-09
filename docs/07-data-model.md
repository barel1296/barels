# Part 7 — Data Model

Two stores, one rule: **Postgres is the system of record for entities, decisions, and governance; ClickHouse is the system of record for events and metrics.** Every tenant-scoped Postgres table carries `tenant_id` with RLS; every ClickHouse table is keyed by `tenant_id` first.

## 7.1 PostgreSQL schema (OLTP / governance)

Conventions: `uuid` PKs (v7), `created_at/updated_at timestamptz` everywhere (omitted below for brevity), soft business states via `status` enums, append-only tables have no UPDATE/DELETE grants. RLS policy template applied to all tenant tables:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

### Tenancy, identity, RBAC

```sql
CREATE TABLE tenants (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  slug          text UNIQUE NOT NULL,
  plan          text NOT NULL DEFAULT 'design_partner',   -- design_partner|growth|scale|enterprise
  status        text NOT NULL DEFAULT 'active',           -- active|suspended|deleted
  settings      jsonb NOT NULL DEFAULT '{}',              -- timezone, currency, fiscal config
  llm_budget_usd_month numeric(10,2) NOT NULL DEFAULT 500
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  auth_provider text NOT NULL DEFAULT 'password',         -- password|google|saml
  password_hash text,                                     -- argon2id, null for SSO
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
);

CREATE TABLE memberships (                                 -- users ↔ tenants (agency-ready)
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  role_id   uuid NOT NULL REFERENCES roles(id),
  status    text NOT NULL DEFAULT 'active',
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE roles (
  id         uuid PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id),                  -- NULL = system role (Owner/Admin/Approver/Analyst/Viewer)
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (                                 -- catalog, seeded by migration
  key         text PRIMARY KEY,                            -- 'actions:approve:budget', 'metrics:read', ...
  description text NOT NULL,
  category    text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid REFERENCES roles(id),
  permission_key text REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  key_hash    text NOT NULL,                               -- sha256, prefix shown once
  scopes      text[] NOT NULL,
  expires_at  timestamptz,
  last_used_at timestamptz,
  revoked_at  timestamptz
);
```

### Data sources & integrations

```sql
CREATE TABLE data_sources (                                -- catalog of supported connectors
  key            text PRIMARY KEY,                         -- 'appsflyer','meta_ads','google_ads',...
  category       text NOT NULL,                            -- mmp|ad_network|revenue|product|crm|aso
  capabilities   jsonb NOT NULL,                           -- entities, granularities, supports_execution
  min_sync_interval_min int NOT NULL DEFAULT 60
);

CREATE TABLE integrations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  source_key      text NOT NULL REFERENCES data_sources(key),
  name            text NOT NULL,                           -- "Meta — Main Ad Account"
  external_account_id text,
  credentials_enc bytea NOT NULL,                          -- KMS envelope-encrypted
  scopes_granted  text[] NOT NULL,                         -- read-only until autonomy enabled
  status          text NOT NULL DEFAULT 'pending',         -- pending|healthy|degraded|broken|paused
  health          jsonb NOT NULL DEFAULT '{}',             -- last check result
  config          jsonb NOT NULL DEFAULT '{}'              -- app ids, report templates, tz
);

CREATE TABLE sync_runs (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  integration_id uuid NOT NULL REFERENCES integrations(id),
  kind         text NOT NULL,                              -- backfill|incremental|restatement
  status       text NOT NULL,                              -- running|succeeded|failed|partial
  cursor_before jsonb, cursor_after jsonb,
  window_start timestamptz, window_end timestamptz,
  rows_ingested bigint NOT NULL DEFAULT 0,
  error        jsonb,
  started_at   timestamptz NOT NULL, finished_at timestamptz
);
CREATE INDEX ON sync_runs (tenant_id, integration_id, started_at DESC);

CREATE TABLE data_quality_checks (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  check_key   text NOT NULL,                               -- 'spend_recon_meta_vs_mmp', 'event_taxonomy_drift', ...
  domain      text NOT NULL,                               -- attribution|spend|revenue|events|skan
  scope       jsonb NOT NULL,                              -- {geo, platform, app_id, date_range}
  status      text NOT NULL,                               -- pass|warn|fail
  observed    jsonb NOT NULL,                              -- deltas, rates, examples
  threshold   jsonb NOT NULL,
  run_at      timestamptz NOT NULL
);

CREATE TABLE health_status (                               -- current per-domain status (Tracking Agent output)
  tenant_id   uuid NOT NULL,
  domain      text NOT NULL,
  status      text NOT NULL,                               -- green|yellow|red
  reasons     jsonb NOT NULL DEFAULT '[]',                 -- refs to data_quality_checks
  declared_by text NOT NULL,                               -- 'tracking_agent' | user id (override)
  declared_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, domain)
);
```

### Entity registry (campaign hierarchy, creatives, audiences, apps)

```sql
CREATE TABLE apps (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name      text NOT NULL,
  platform  text NOT NULL,                                 -- ios|android|web
  store_id  text,                                          -- bundle/package id
  UNIQUE (tenant_id, platform, store_id)
);

CREATE TABLE campaigns (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  integration_id uuid NOT NULL REFERENCES integrations(id),
  app_id        uuid REFERENCES apps(id),
  external_id   text NOT NULL,
  name          text NOT NULL,
  channel       text NOT NULL,                             -- meta|google|tiktok|...
  objective     text,
  status        text NOT NULL,                             -- active|paused|archived
  budget_amount numeric(14,2), budget_type text,           -- daily|lifetime
  currency      text NOT NULL DEFAULT 'USD',
  geo_targets   text[],
  raw_config    jsonb NOT NULL DEFAULT '{}',               -- platform snapshot
  managed_state text NOT NULL DEFAULT 'observed',          -- observed|managed|locked (locked = agents hands-off)
  UNIQUE (tenant_id, integration_id, external_id)
);

CREATE TABLE ad_groups (                                   -- ad sets / ad groups / asset groups
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  external_id text NOT NULL, name text NOT NULL,
  status text NOT NULL, bid_strategy text, raw_config jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, campaign_id, external_id)
);

CREATE TABLE ads (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  ad_group_id uuid NOT NULL REFERENCES ad_groups(id),
  creative_id uuid REFERENCES creatives(id),
  external_id text NOT NULL, name text NOT NULL, status text NOT NULL,
  UNIQUE (tenant_id, ad_group_id, external_id)
);

CREATE TABLE creatives (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  format      text NOT NULL,                               -- video|image|playable|carousel
  asset_url   text,                                        -- S3
  duration_s  int,
  language    text,
  tags        jsonb NOT NULL DEFAULT '{}',                 -- {hook_type, theme, style,...} from tagging pipeline
  first_seen_at timestamptz, 
  fingerprint text                                         -- perceptual hash for cross-network identity
);

CREATE TABLE audiences (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  name text NOT NULL, definition jsonb NOT NULL,           -- segment spec (semantic-layer query)
  synced_to jsonb NOT NULL DEFAULT '[]',                   -- [{integration_id, external_id, last_synced}]
  status text NOT NULL DEFAULT 'draft'
);

CREATE TABLE experiments (                                  -- A/B tests, paywall tests, LiveOps events
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  kind text NOT NULL,                                      -- ab_test|paywall|price|liveops|app_release
  name text NOT NULL, scope jsonb NOT NULL,                -- geos, platforms, % rollout
  starts_at timestamptz NOT NULL, ends_at timestamptz,
  source text NOT NULL,                                    -- firebase|manual|api
  metadata jsonb NOT NULL DEFAULT '{}'
);
```

### Semantic layer

```sql
CREATE TABLE metric_definitions (
  id          uuid PRIMARY KEY,
  key         text NOT NULL,                               -- 'roas_d7', 'cpi', 'retention_d1', ...
  version     int NOT NULL,
  tenant_id   uuid,                                        -- NULL = global definition; tenant rows override
  display_name text NOT NULL,
  formula_sql text NOT NULL,                               -- templated ClickHouse SQL
  dimensions  text[] NOT NULL,
  grain       text NOT NULL,
  caveats     jsonb NOT NULL DEFAULT '[]',
  status      text NOT NULL DEFAULT 'active',
  UNIQUE (key, version, tenant_id)
);
```

### Agent layer

```sql
CREATE TABLE playbooks (
  id uuid PRIMARY KEY,
  key text NOT NULL, version int NOT NULL,                 -- 'roas_drop_investigation' v3
  definition jsonb NOT NULL,                               -- phases, agent roster, budgets, output schema
  status text NOT NULL DEFAULT 'active',
  UNIQUE (key, version)
);

CREATE TABLE agent_sessions (                              -- one War Room session
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  playbook_id   uuid REFERENCES playbooks(id),
  trigger_type  text NOT NULL,                             -- anomaly|schedule|user|opportunity_scan
  trigger_ref   jsonb NOT NULL,                            -- anomaly id / user question / schedule key
  title         text NOT NULL,
  scope         jsonb NOT NULL,                            -- entities, geos, channels, date range
  phase         text NOT NULL DEFAULT 'triage',            -- triage|health_gate|investigation|debate|synthesis|action_prep|review|published|monitoring|closed
  status        text NOT NULL DEFAULT 'running',           -- running|published|monitoring|closed|failed|parked
  money_at_stake_usd numeric(14,2),
  decision      jsonb,                                     -- final Decision object
  abstract      text,                                      -- 3-sentence summary
  budgets       jsonb NOT NULL,                            -- token/time/tool caps & usage
  outcome       jsonb,                                     -- predicted vs realized, filled at horizon
  closed_at     timestamptz
);
CREATE INDEX ON agent_sessions (tenant_id, status, created_at DESC);

CREATE TABLE agent_runs (                                  -- one agent's participation in a session phase
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  session_id  uuid NOT NULL REFERENCES agent_sessions(id),
  agent       text NOT NULL,                               -- growth_director|intelligence|operations|creative|tracking
  phase       text NOT NULL,
  status      text NOT NULL,                               -- running|completed|failed|budget_exceeded
  model       text NOT NULL,
  tokens_in bigint DEFAULT 0, tokens_out bigint DEFAULT 0,
  cost_usd    numeric(10,4) DEFAULT 0,
  tool_calls  int DEFAULT 0,
  trace_ref   text,                                        -- S3 pointer to full LLM transcript
  error       jsonb
);

CREATE TABLE agent_messages (                              -- the blackboard (append-only)
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  session_id   uuid NOT NULL REFERENCES agent_sessions(id),
  run_id       uuid REFERENCES agent_runs(id),
  agent        text NOT NULL,                              -- agents or 'user' (ask-the-room) or 'orchestrator'
  type         text NOT NULL,                              -- finding|hypothesis|challenge|concession|proposal|vote|request|directive|resolution
  claim        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',                -- structured fields incl. falsification check
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  confidence   numeric(3,2),
  directed_to  text[],
  in_reply_to  uuid REFERENCES agent_messages(id),
  seq          bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX ON agent_messages (tenant_id, session_id, seq);

CREATE TABLE evidence (                                    -- append-only
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  session_id    uuid REFERENCES agent_sessions(id),
  kind          text NOT NULL,                             -- metric_query|recon_report|external|computation
  metric_key    text, metric_version int,
  params        jsonb NOT NULL,                            -- dimensions, filters, range
  sql_hash      text NOT NULL,
  result_ref    text NOT NULL,                             -- S3 pointer to frozen snapshot
  result_digest jsonb NOT NULL,                            -- small inline summary for rendering
  freshness_at  timestamptz NOT NULL,                      -- data freshness when executed
  executed_at   timestamptz NOT NULL
);

CREATE TABLE tenant_memory (                               -- curated business memory (versioned)
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  category text NOT NULL,                                  -- targets|constraints|seasonality|preferences|learned
  key text NOT NULL, value jsonb NOT NULL,
  source text NOT NULL,                                    -- onboarding|user|agent_proposed_user_confirmed
  version int NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, category, key, version)
);
```

### Recommendations, actions, approvals

```sql
CREATE TABLE anomalies (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  metric_key text NOT NULL, scope jsonb NOT NULL,
  direction text NOT NULL, magnitude numeric, zscore numeric,
  detector text NOT NULL,                                  -- zscore|cusum|stl_residual|fatigue_curve
  window_start date NOT NULL, window_end date NOT NULL,
  materiality_usd numeric(14,2),
  status text NOT NULL DEFAULT 'new',                      -- new|triaged|in_session|dismissed|merged
  session_id uuid REFERENCES agent_sessions(id),
  detected_at timestamptz NOT NULL
);

CREATE TABLE recommendations (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  session_id    uuid REFERENCES agent_sessions(id),
  playbook_key  text,
  title         text NOT NULL,
  summary       text NOT NULL,
  category      text NOT NULL,                             -- budget|creative|structure|tracking|crm|aso|product
  confidence    numeric(3,2) NOT NULL,
  confidence_breakdown jsonb NOT NULL,                     -- rubric components (Part 9.6)
  predicted_impact jsonb NOT NULL,                         -- {metric, low, mid, high, horizon_days, basis_evidence_ids}
  evidence_ids  uuid[] NOT NULL,
  status        text NOT NULL DEFAULT 'proposed',          -- proposed|approved|rejected|expired|superseded|realized
  rejection     jsonb,                                     -- {reason_code, note, by}
  outcome       jsonb,                                     -- realized impact at horizon
  expires_at    timestamptz
);

CREATE TABLE actions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  recommendation_id uuid REFERENCES recommendations(id),
  session_id      uuid REFERENCES agent_sessions(id),
  kind            text NOT NULL,                           -- budget_change|pause_entity|create_campaign|audience_sync|creative_rotation|crm_journey_change|aso_change
  target          jsonb NOT NULL,                          -- {integration_id, entity_type, entity_id}
  diff            jsonb NOT NULL,                          -- exact before → after
  payload         jsonb NOT NULL,                          -- platform-ready, validated
  execution_plan  jsonb NOT NULL,                          -- steps, ramp schedule
  rollback_plan   jsonb NOT NULL,
  monitoring_plan jsonb NOT NULL,                          -- watch metrics + auto-revert thresholds
  guardrail_eval  jsonb NOT NULL,                          -- each policy: pass/fail + values
  dry_run         jsonb,                                   -- platform validation result + at
  autonomy_level  int NOT NULL DEFAULT 2,                  -- level at which this kind runs for this tenant
  version         int NOT NULL DEFAULT 1,
  supersedes      uuid REFERENCES actions(id),             -- human-modified chains
  status          text NOT NULL DEFAULT 'draft',           -- draft|awaiting_approval|approved|executing|executed|verify_failed|rolled_back|rejected|expired|cancelled
  idempotency_key text UNIQUE NOT NULL,
  expires_at      timestamptz
);

CREATE TABLE approvals (                                   -- append-only decision records
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  action_id   uuid NOT NULL REFERENCES actions(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  decision    text NOT NULL,                               -- approve|reject|request_changes
  reason_code text, note text,
  via         text NOT NULL DEFAULT 'web',                 -- web|slack|api
  policy_snapshot jsonb NOT NULL,                          -- the approval policy in force at decision time
  decided_at  timestamptz NOT NULL
);

CREATE TABLE approval_policies (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  action_kind text NOT NULL,
  rules jsonb NOT NULL,            -- {max_auto_magnitude, required_role, two_person_above_usd, expiry_hours, evidence_drift_tolerance}
  autonomy_level int NOT NULL DEFAULT 2,                   -- per-kind autonomy (the L2→L4 dial)
  UNIQUE (tenant_id, action_kind)
);

CREATE TABLE executions (                                  -- append-only
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  action_id   uuid NOT NULL REFERENCES actions(id),
  attempt     int NOT NULL DEFAULT 1,
  status      text NOT NULL,                               -- started|succeeded|failed|verified|verify_failed|rolled_back
  request_digest jsonb NOT NULL,                           -- what we sent (sanitized)
  response_digest jsonb,                                   -- what platform returned
  verification jsonb,                                      -- read-back comparison
  started_at timestamptz NOT NULL, finished_at timestamptz
);
```

### Audit & cost

```sql
CREATE TABLE audit_logs (                                  -- append-only, monthly partitions
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  actor_type  text NOT NULL,                               -- user|agent|system|api_key
  actor_id    text NOT NULL,
  event       text NOT NULL,                               -- 'action.approved','integration.created','session.decision',...
  object_type text NOT NULL, object_id text NOT NULL,
  before_ref  jsonb, after_ref jsonb,
  ip inet, user_agent text,
  at          timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (at);
CREATE INDEX ON audit_logs (tenant_id, at DESC);
CREATE INDEX ON audit_logs (tenant_id, object_type, object_id);

CREATE TABLE llm_cost_ledger (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  session_id uuid, run_id uuid, agent text, model text NOT NULL,
  tokens_in bigint NOT NULL, tokens_out bigint NOT NULL,
  cost_usd numeric(10,5) NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (                                      -- transactional outbox
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  topic text NOT NULL, payload jsonb NOT NULL,
  published_at timestamptz
);
```

## 7.2 ClickHouse schema (analytics)

Conventions: `ReplacingMergeTree`/`MergeTree`, partition by month, `tenant_id` always first in ORDER BY, `LowCardinality` for enums, TTL on raw tables (raw also archived in S3).

```sql
-- Landing zone: every source payload, untouched
CREATE TABLE raw_events (
  tenant_id        UUID,
  source           LowCardinality(String),     -- appsflyer|meta_ads|google_ads|revenuecat|firebase|firstparty|...
  entity_kind      LowCardinality(String),     -- event|spend_row|attribution|postback|entity_snapshot
  external_id      String,
  payload          String,                     -- raw JSON
  payload_hash     UInt64,
  ingested_at      DateTime64(3),
  sync_run_id      UUID
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (tenant_id, source, entity_kind, ingested_at)
TTL ingested_at + INTERVAL 13 MONTH;

-- Canonical product/game events (normalized taxonomy)
CREATE TABLE events (
  tenant_id      UUID,
  app_id         UUID,
  event_name     LowCardinality(String),       -- canonical: install|session_start|level_complete|trial_start|purchase|paywall_view|...
  event_time     DateTime64(3),
  user_id        String,                       -- tenant's user id (pseudonymous)
  device_platform LowCardinality(String),
  country        LowCardinality(String),
  app_version    LowCardinality(String),
  source_install LowCardinality(String),       -- attributed media source of the user
  campaign_id    UUID,                          -- internal id, resolved
  revenue_usd    Decimal(14,4) DEFAULT 0,
  properties     Map(String, String),
  source         LowCardinality(String),
  inserted_at    DateTime DEFAULT now()
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, app_id, event_name, event_time, user_id);

-- Attribution facts (installs / re-engagements / conversions by source)
CREATE TABLE attribution (
  tenant_id UUID, app_id UUID,
  install_time DateTime64(3),
  user_id String,
  media_source LowCardinality(String), channel LowCardinality(String),
  campaign_id UUID, campaign_external String,
  adset_external String, ad_external String,
  country LowCardinality(String), device_platform LowCardinality(String),
  attribution_type LowCardinality(String),     -- deterministic|probabilistic|skan_modeled|organic
  touch_type LowCardinality(String),
  cost_usd Decimal(14,4) DEFAULT 0,
  source LowCardinality(String)
) ENGINE = ReplacingMergeTree(install_time)
PARTITION BY toYYYYMM(install_time)
ORDER BY (tenant_id, app_id, user_id, install_time);

CREATE TABLE skan_postbacks (
  tenant_id UUID, app_id UUID,
  postback_time DateTime,
  source_app LowCardinality(String), network LowCardinality(String),
  campaign_external String,
  conversion_value Nullable(UInt8),
  coarse_value LowCardinality(Nullable(String)),
  did_win Bool, postback_index UInt8,
  cv_schema_version LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(postback_time)
ORDER BY (tenant_id, app_id, network, postback_time);

-- Spend & delivery (the UA workhorse) — hourly grain, daily MV on top
CREATE TABLE spend_metrics_hourly (
  tenant_id UUID,
  channel LowCardinality(String),
  campaign_id UUID, ad_group_id UUID, ad_id UUID, creative_id UUID,
  country LowCardinality(String), device_platform LowCardinality(String),
  hour DateTime,
  impressions UInt64, clicks UInt64, installs UInt64,
  spend_usd Decimal(14,4),
  conversions Map(String, UInt64),              -- network-reported conversion events
  restated_at DateTime                          -- networks restate; ReplacingMergeTree keeps latest
) ENGINE = ReplacingMergeTree(restated_at)
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, channel, campaign_id, ad_group_id, ad_id, country, hour);

-- Revenue lifecycle (IAP + subscriptions, from RevenueCat + stores + MMP)
CREATE TABLE revenue_events (
  tenant_id UUID, app_id UUID,
  event_time DateTime64(3),
  user_id String,
  kind LowCardinality(String),                  -- trial_start|trial_convert|renewal|cancel|refund|iap|grace|reactivation
  product_id String,
  revenue_usd Decimal(14,4), proceeds_usd Decimal(14,4),
  is_first_payment Bool,
  country LowCardinality(String), store LowCardinality(String),
  source LowCardinality(String)
) ENGINE = ReplacingMergeTree(event_time)
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, app_id, user_id, event_time, kind, product_id);

-- Cohort mart (built nightly + intraday partial): one row per cohort slice per day-N
CREATE TABLE cohort_metrics (
  tenant_id UUID, app_id UUID,
  cohort_date Date,
  media_source LowCardinality(String), campaign_id UUID,
  country LowCardinality(String), device_platform LowCardinality(String),
  day_n UInt16,                                 -- 0,1,3,7,14,30,60,90,180
  cohort_size UInt64,
  retained UInt64,
  payers UInt64,
  revenue_usd Decimal(14,4),                    -- cumulative to day_n
  spend_usd Decimal(14,4),                      -- cohort acquisition cost
  computed_at DateTime
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(cohort_date)
ORDER BY (tenant_id, app_id, cohort_date, media_source, campaign_id, country, device_platform, day_n);

-- Creative mart
CREATE TABLE creative_metrics_daily (
  tenant_id UUID, creative_id UUID,
  channel LowCardinality(String), country LowCardinality(String),
  date Date,
  impressions UInt64, clicks UInt64, installs UInt64, spend_usd Decimal(14,4),
  ctr Float32, ipm Float32, cvr Float32,
  spend_share Float32,                          -- share of channel spend this day
  days_live UInt16,
  computed_at DateTime
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, creative_id, channel, country, date);

CREATE TABLE aso_metrics_daily (
  tenant_id UUID, app_id UUID, date Date,
  country LowCardinality(String), store LowCardinality(String),
  impressions UInt64, page_views UInt64, installs_organic UInt64,
  cvr_listing Float32,
  keyword_ranks Map(String, UInt16),
  computed_at DateTime
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, app_id, store, country, date);

CREATE TABLE experiment_assignments (
  tenant_id UUID, app_id UUID,
  experiment_id UUID, variant LowCardinality(String),
  user_id String, assigned_at DateTime
) ENGINE = MergeTree
PARTITION BY toYYYYMM(assigned_at)
ORDER BY (tenant_id, experiment_id, user_id);
```

## 7.3 Design notes & deliberate choices

1. **Restatement-safe by construction.** Ad networks and MMPs restate history; `ReplacingMergeTree(restated_at)` + 3–7 day re-pull windows make the marts converge to truth without manual fixes. Cohort and creative marts are rebuilt from facts, never incrementally patched.
2. **Evidence immutability vs. data restatement.** Evidence snapshots are frozen at execution (S3) precisely *because* underlying data restates — the Evidence Inspector's "re-run & diff" makes drift visible instead of silently rewriting history.
3. **Entity registry in Postgres, metrics in ClickHouse, joined by internal UUIDs** resolved at normalization time. Agents and UI never juggle external IDs.
4. **`managed_state` on campaigns** (`observed|managed|locked`) is the per-entity autonomy scoping primitive — "never touch brand campaigns" is a data flag, not a prompt instruction.
5. **`approval_policies.autonomy_level` is the L2→L4 dial.** Level 2: all actions require approval. Level 3: low-magnitude actions of approved kinds auto-execute with notification. Level 4: full kinds auto-execute within guardrails; approvals reserved for threshold breaches. Same tables, same pipeline.
6. **No user-level PII in ClickHouse beyond pseudonymous IDs.** Email/CRM identity stays in the CRM integration boundary; joins happen on hashed IDs.
