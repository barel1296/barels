-- 002: data sources, integrations, sync bookkeeping, data quality, entity
-- registry (apps/campaigns/ad_groups/ads/creatives/audiences/experiments),
-- event taxonomy, semantic metric definitions.

CREATE TABLE data_sources (
  key                    text PRIMARY KEY,
  category               text NOT NULL,    -- mmp|ad_network|revenue|product|crm|aso
  display_name           text NOT NULL,
  capabilities           jsonb NOT NULL DEFAULT '{}',
  min_sync_interval_min  int NOT NULL DEFAULT 60
);

CREATE TABLE integrations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  source_key          text NOT NULL REFERENCES data_sources(key),
  name                text NOT NULL,
  external_account_id text,
  credentials_enc     bytea,                       -- AES-256-GCM envelope (local KMS abstraction)
  scopes_granted      text[] NOT NULL DEFAULT '{}',-- read-only scopes only at autonomy L2
  status              text NOT NULL DEFAULT 'pending', -- pending|healthy|degraded|broken|paused
  health              jsonb NOT NULL DEFAULT '{}',
  config              jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integrations (tenant_id);

CREATE TABLE sync_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  integration_id uuid NOT NULL REFERENCES integrations(id),
  kind           text NOT NULL,              -- backfill|incremental|restatement
  status         text NOT NULL,              -- running|succeeded|failed|partial
  cursor_before  jsonb,
  cursor_after   jsonb,
  window_start   timestamptz,
  window_end     timestamptz,
  rows_ingested  bigint NOT NULL DEFAULT 0,
  error          jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX ON sync_runs (tenant_id, integration_id, started_at DESC);

CREATE TABLE data_quality_checks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  check_key text NOT NULL,
  domain    text NOT NULL,                   -- attribution|spend|revenue|events|skan
  scope     jsonb NOT NULL DEFAULT '{}',
  status    text NOT NULL,                   -- pass|warn|fail
  observed  jsonb NOT NULL DEFAULT '{}',
  threshold jsonb NOT NULL DEFAULT '{}',
  run_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON data_quality_checks (tenant_id, domain, run_at DESC);

CREATE TABLE health_status (
  tenant_id   uuid NOT NULL,
  domain      text NOT NULL,
  status      text NOT NULL,                 -- green|yellow|red
  reasons     jsonb NOT NULL DEFAULT '[]',
  declared_by text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain)
);

-- ── Entity registry ──────────────────────────────────────────────────────────

CREATE TABLE apps (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name      text NOT NULL,
  platform  text NOT NULL,                   -- ios|android|web
  store_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform, store_id)
);

CREATE TABLE creatives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  name          text NOT NULL,
  format        text NOT NULL,               -- video|image|playable|carousel
  asset_url     text,
  duration_s    int,
  language      text,
  tags          jsonb NOT NULL DEFAULT '{}', -- {hook_type, theme, style}
  fingerprint   text,
  first_seen_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON creatives (tenant_id);

CREATE TABLE campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  integration_id uuid REFERENCES integrations(id),
  app_id         uuid REFERENCES apps(id),
  external_id    text NOT NULL,
  name           text NOT NULL,
  channel        text NOT NULL,
  objective      text,
  status         text NOT NULL DEFAULT 'active',
  budget_amount  numeric(14,2),
  budget_type    text,
  currency       text NOT NULL DEFAULT 'USD',
  geo_targets    text[] NOT NULL DEFAULT '{}',
  raw_config     jsonb NOT NULL DEFAULT '{}',
  managed_state  text NOT NULL DEFAULT 'observed', -- observed|managed|locked
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, integration_id, external_id)
);
CREATE INDEX ON campaigns (tenant_id, channel);

CREATE TABLE ad_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  external_id text NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  bid_strategy text,
  raw_config  jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, campaign_id, external_id)
);

CREATE TABLE ads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  ad_group_id uuid NOT NULL REFERENCES ad_groups(id),
  creative_id uuid REFERENCES creatives(id),
  external_id text NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  UNIQUE (tenant_id, ad_group_id, external_id)
);

CREATE TABLE audiences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  name       text NOT NULL,
  definition jsonb NOT NULL,
  synced_to  jsonb NOT NULL DEFAULT '[]',
  status     text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experiments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind      text NOT NULL,                   -- ab_test|paywall|price|liveops|app_release
  name      text NOT NULL,
  scope     jsonb NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz,
  source    text NOT NULL DEFAULT 'manual',
  metadata  jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON experiments (tenant_id, starts_at);

-- ── Event taxonomy (canonical dictionary + quarantine) ───────────────────────

CREATE TABLE event_taxonomy (
  tenant_id   uuid NOT NULL,
  event_name  text NOT NULL,
  description text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT 'product',  -- lifecycle|monetization|product|marketing
  schema      jsonb NOT NULL DEFAULT '{}',      -- required/optional property spec
  status      text NOT NULL DEFAULT 'active',   -- active|deprecated
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_name)
);

CREATE TABLE taxonomy_violations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  event_name text NOT NULL,
  reason     text NOT NULL,                  -- unknown_event|schema_mismatch
  sample     jsonb NOT NULL,
  count      bigint NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_name, reason)
);

-- ── Semantic metrics layer ───────────────────────────────────────────────────

CREATE TABLE metric_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL,
  version      int NOT NULL DEFAULT 1,
  tenant_id    uuid,                          -- NULL = global definition
  display_name text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- Structured formula spec (NOT raw user SQL): {table, timeCol, valueExpr,
  -- defaultWhere?}. valueExpr fragments are defined only in reviewed
  -- migrations; runtime composes parameterized queries from this spec.
  formula      jsonb NOT NULL,
  dimensions   text[] NOT NULL DEFAULT '{}',  -- allowlisted dimension columns
  grains       text[] NOT NULL DEFAULT '{day}',
  value_format text NOT NULL DEFAULT 'number',-- number|currency|percent|ratio
  caveats      jsonb NOT NULL DEFAULT '[]',
  status       text NOT NULL DEFAULT 'active',
  UNIQUE (key, version, tenant_id)
);

-- ── RLS for this batch ───────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integrations','sync_runs','data_quality_checks','health_status','apps',
    'creatives','campaigns','ad_groups','ads','audiences','experiments',
    'event_taxonomy','taxonomy_violations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- metric_definitions: global rows readable by everyone, tenant rows isolated.
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_visibility ON metric_definitions
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id());
