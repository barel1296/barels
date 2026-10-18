-- =============================================================================
-- Migration 0003 — platform services.
--
--  1. Staff authentication: password (scrypt) + mandatory TOTP, browser
--     sessions with CSRF binding, login lockout.
--  2. Generic durable job queue (core.jobs) for every non-GPU background task
--     (Telegram updates, payments, outbox consumers, sweeps), with priorities:
--     0 = payments (P0) … 9 = maintenance.
--  3. Periodic task bookkeeping (core.periodic_tasks).
--  4. Monitoring: alerts and GPU samples (ops).
--  5. Integration runtime settings per channel/account (polling state).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Staff authentication
-- -----------------------------------------------------------------------------
ALTER TABLE core.users
  ADD COLUMN password_hash          text,
  ADD COLUMN totp_ciphertext        bytea,
  ADD COLUMN totp_nonce             bytea,
  ADD COLUMN totp_data_key          bytea,
  ADD COLUMN totp_wrapping_key_id   text,
  ADD COLUMN totp_last_step         bigint,          -- replay protection
  ADD COLUMN mfa_enrolled_at        timestamptz,
  ADD COLUMN failed_login_count     int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until           timestamptz,
  ADD COLUMN password_changed_at    timestamptz,
  -- Invite flow: an admin creates the account; the person sets a password and
  -- enrolls TOTP with a single-use setup token (hash only).
  ADD COLUMN setup_token_hash       bytea UNIQUE,
  ADD COLUMN setup_expires_at       timestamptz;

CREATE TABLE core.sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES core.users(id),
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  token_hash      bytea NOT NULL UNIQUE,            -- sha256(session token); the token lives only in the cookie
  csrf_hash       bytea NOT NULL,                   -- sha256(csrf token); double-submit check
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,             -- absolute lifetime
  idle_expires_at timestamptz NOT NULL,             -- sliding idle timeout
  revoked_at      timestamptz,
  revoke_reason   text,
  ip              inet,
  user_agent      text
);
CREATE INDEX sessions_user_idx ON core.sessions (user_id) WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Durable job queue
-- -----------------------------------------------------------------------------
CREATE TABLE core.jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid REFERENCES core.workspaces(id),
  queue            text NOT NULL CHECK (queue ~ '^[a-z][a-z0-9_]{1,40}$'),
  name             text NOT NULL,                   -- handler name, e.g. 'telegram.process_update'
  job_key          text NOT NULL UNIQUE,            -- idempotency key
  payload          jsonb NOT NULL,
  priority         smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 100),
  run_at           timestamptz NOT NULL DEFAULT now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  last_error       jsonb,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX jobs_ready_idx ON core.jobs (priority, run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON core.jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX jobs_queue_status_idx ON core.jobs (queue, status);

-- -----------------------------------------------------------------------------
-- 3. Periodic tasks (sweeps, reconciliation, rollups, sealing)
-- -----------------------------------------------------------------------------
CREATE TABLE core.periodic_tasks (
  name              text PRIMARY KEY,
  interval_seconds  int NOT NULL CHECK (interval_seconds > 0),
  enabled           boolean NOT NULL DEFAULT true,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_status       text CHECK (last_status IN ('ok', 'error')),
  last_error        text,
  last_result       jsonb,
  run_count         bigint NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 4. Monitoring
-- -----------------------------------------------------------------------------
CREATE TABLE ops.alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES core.workspaces(id),
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  source          text NOT NULL,                    -- e.g. 'gpu', 'engine', 'payments', 'audit', 'backup'
  code            text NOT NULL,                    -- e.g. 'GPU_TEMP_HIGH'
  dedup_key       text NOT NULL,                    -- one open alert per key
  message         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  occurrences     int NOT NULL DEFAULT 1,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES core.users(id),
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);
CREATE UNIQUE INDEX alerts_one_open_idx ON ops.alerts (dedup_key) WHERE status <> 'resolved';

CREATE TABLE ops.gpu_samples (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node           text NOT NULL,                     -- host name / node key
  gpu_index      int NOT NULL,
  gpu_name       text,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  util_pct       numeric(5, 2),
  vram_used_mb   int,
  vram_total_mb  int,
  temp_c         numeric(5, 1),
  power_w        numeric(7, 2),
  source         text NOT NULL CHECK (source IN ('nvidia_smi', 'engine_resources', 'manual'))
);
CREATE INDEX gpu_samples_time_idx ON ops.gpu_samples (node, captured_at DESC);

CREATE TABLE ops.backup_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('backup', 'restore_test', 'restore')),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  manifest      jsonb NOT NULL DEFAULT '{}',        -- files, sizes, sha256s, row counts
  location      text,
  error         text,
  recorded_by   text NOT NULL
);

-- -----------------------------------------------------------------------------
-- 5. Grants for the new objects (default privileges from 0002 cover new tables;
--    restate the append-only and ownership exceptions explicitly).
-- -----------------------------------------------------------------------------
-- Sessions: the API needs DELETE-free lifecycle (revoke by update).
-- ops.alerts / gpu_samples / backup_runs: written by workers and ops tooling.
GRANT SELECT, INSERT, UPDATE ON core.sessions, core.jobs, core.periodic_tasks, ops.alerts, ops.gpu_samples, ops.backup_runs
  TO aios_app, aios_worker;
GRANT USAGE, SELECT ON SEQUENCE ops.gpu_samples_id_seq TO aios_app, aios_worker;
-- Health checks compare the applied schema version with the shipped migrations.
GRANT SELECT ON public.schema_migrations TO aios_app, aios_worker;
-- Retention jobs (old gpu samples, finished jobs) run as the worker.
GRANT DELETE ON ops.gpu_samples, core.jobs TO aios_worker;

-- -----------------------------------------------------------------------------
-- 6. New permissions
-- -----------------------------------------------------------------------------
INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES ('owner', 'user.manage'), ('admin', 'user.manage')) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;
