-- 001: extensions, tenancy, identity, RBAC, audit, outbox, jobs.
-- All tenant-scoped tables use RLS with FORCE so even the table owner is
-- subject to the tenant_isolation policy. App code sets app.tenant_id /
-- app.user_id per transaction (see src/db/db.service.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Tenancy & identity ───────────────────────────────────────────────────────

CREATE TABLE tenants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  slug                  text UNIQUE NOT NULL,
  plan                  text NOT NULL DEFAULT 'design_partner',
  status                text NOT NULL DEFAULT 'active',
  settings              jsonb NOT NULL DEFAULT '{}',
  llm_budget_usd_month  numeric(10,2) NOT NULL DEFAULT 500,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text NOT NULL,
  auth_provider text NOT NULL DEFAULT 'password',
  password_hash text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid REFERENCES tenants(id),          -- NULL = system role
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE permissions (
  key         text PRIMARY KEY,
  description text NOT NULL,
  category    text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role_id    uuid NOT NULL REFERENCES roles(id),
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  token_hash  text UNIQUE NOT NULL,
  expires_at  timestamptz NOT NULL,
  rotated_to  uuid,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  key_hash     text UNIQUE NOT NULL,
  key_prefix   text NOT NULL,
  scopes       text[] NOT NULL,
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Audit (append-only) ──────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  actor_type  text NOT NULL,            -- user|agent|system|api_key
  actor_id    text NOT NULL,
  event       text NOT NULL,
  object_type text NOT NULL,
  object_id   text NOT NULL,
  before_ref  jsonb,
  after_ref   jsonb,
  ip          inet,
  user_agent  text,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

-- Rolling partitions; ops creates future ones. Wide initial range for dev.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX ON audit_logs (tenant_id, at DESC);
CREATE INDEX ON audit_logs (tenant_id, object_type, object_id);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Outbox & job queue (Postgres-backed, SKIP LOCKED consumers) ─────────────

CREATE TABLE outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX ON outbox (published_at) WHERE published_at IS NULL;

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  kind         text NOT NULL,             -- run_session|run_detection|compute_outcomes|...
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued', -- queued|running|succeeded|failed|dead
  priority     int NOT NULL DEFAULT 100,
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX ON jobs (status, run_after, priority) WHERE status = 'queued';

CREATE TABLE idempotency_keys (
  tenant_id     uuid NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  response_body jsonb,
  status_code   int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Helper: current tenant/user from per-transaction settings (NULL when unset).

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- memberships: visible within the tenant context OR to the authenticated user
-- themselves (required by the login flow, before a tenant is resolved).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_self ON memberships
  USING (tenant_id = app_tenant_id() OR user_id = app_user_id());

-- Worker processes poll the job queue across tenants; they mark their
-- connection with app.role='worker' (trusted process boundary — the API
-- never sets it) and then set app.tenant_id per job before touching any
-- tenant-scoped table.
CREATE OR REPLACE FUNCTION app_is_worker() RETURNS boolean AS $$
  SELECT current_setting('app.role', true) = 'worker';
$$ LANGUAGE sql STABLE;

-- refresh_tokens and api_keys intentionally carry NO RLS: both flows run
-- pre-authentication and look rows up by an unguessable 256-bit secret hash;
-- rows contain only opaque ids/scopes/timestamps, and tenant-scoped listing
-- endpoints filter by tenant explicitly inside an authenticated context.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_logs', 'idempotency_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['outbox', 'jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_or_worker ON %I USING (tenant_id = app_tenant_id() OR app_is_worker())', t);
  END LOOP;
END $$;

-- roles: system roles (tenant_id IS NULL) visible to all; tenant roles isolated.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_visibility ON roles
  USING (tenant_id IS NULL OR tenant_id = app_tenant_id());

-- tenants: a row is visible only inside its own context (resolution happens
-- through memberships first).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_tenant_id());
-- INSERT during registration happens before context exists:
CREATE POLICY tenant_insert ON tenants FOR INSERT WITH CHECK (true);
