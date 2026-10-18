-- =============================================================================
-- Migration 0002 — Visual Engine Contract v1 and the Phase 1 vertical slice.
--
--  1. Replace inference.workflows (stored raw ComfyUI graphs) with a
--     model- and workflow-agnostic registry of contract manifests
--     (contracts/visual-engine). Business logic never sees node graphs or
--     model names; Track A owns everything behind the contract.
--  2. Visual engines, engine ↔ workflow availability, per-influencer workflow
--     bindings (version ranges) and per-persona QA thresholds.
--  3. Persistent visual job queue (platform job state machine, contract §6.2)
--     with an append-only event log.
--  4. Media assets linked to the job and engine that produced them, with the
--     engine kind recorded so contract-mock output can never be published.
--  5. API tokens, platform-admin flag, seeded system roles and permissions.
--  6. Backstop triggers: requester ≠ approver, publication authorization,
--     no publishing of contract-mock assets, manifest immutability.
--  7. Default partitions, row-level security for the new tenant tables, and
--     grants for the runtime roles created by db/bootstrap.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove model/graph-specific structures
-- -----------------------------------------------------------------------------
ALTER TABLE inference.gpu_jobs DROP CONSTRAINT gpu_jobs_workflow_id_fkey;
DROP TABLE inference.workflows;

-- Workflow selection moves to identity.workflow_bindings (per influencer, per purpose).
ALTER TABLE identity.persona_runtime_config
  DROP COLUMN image_workflow_key,
  DROP COLUMN video_workflow_key;

-- Generation records must not require a model name (image/video model choice is
-- Track A's, behind the contract). Visual generation is tracked in
-- inference.visual_jobs; content.generation_jobs remains for non-visual kinds.
ALTER TABLE content.generation_jobs
  ALTER COLUMN model DROP NOT NULL,
  ALTER COLUMN prompt DROP NOT NULL,
  ALTER COLUMN workflow_version TYPE text USING workflow_version::text;

-- Adapters (e.g. character LoRAs) are produced and registered by Track A; the
-- platform stores an opaque engine reference and never a base-model name.
ALTER TABLE identity.model_adapters
  ALTER COLUMN base_model DROP NOT NULL,
  ADD COLUMN engine_ref text CHECK (engine_ref IS NULL OR length(engine_ref) BETWEEN 1 AND 512),
  ADD COLUMN workflow_keys text[] NOT NULL DEFAULT '{}',   -- empty = any workflow that accepts adapters
  ADD COLUMN registered_by uuid REFERENCES core.users(id),
  ADD COLUMN approved_at timestamptz;
ALTER TABLE identity.model_adapters
  ADD CONSTRAINT model_adapters_ready_needs_ref CHECK (status <> 'ready' OR engine_ref IS NOT NULL OR external_ref IS NOT NULL);

-- -----------------------------------------------------------------------------
-- 2. Engines, workflows, bindings, QA thresholds
-- -----------------------------------------------------------------------------
ALTER TABLE core.users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

CREATE TABLE inference.visual_engines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engine_key            text NOT NULL UNIQUE CHECK (engine_key ~ '^[a-z0-9][a-z0-9_.-]{1,63}$'),
  base_url              text NOT NULL CHECK (base_url ~ '^https?://'),  -- …/vec/v1
  contract_version      text NOT NULL DEFAULT '1.0' CHECK (contract_version ~ '^1\.(0|[1-9][0-9]*)$'),
  -- Engine bearer token, envelope-encrypted (same scheme as core.integration_accounts).
  token_ciphertext      bytea NOT NULL,
  token_nonce           bytea NOT NULL,
  data_key_ciphertext   bytea NOT NULL,
  wrapping_key_id       text  NOT NULL,
  -- As reported by GET /engine (never trusted for authorization decisions).
  reported_engine_id    text,
  reported_engine_version text,
  engine_kind           text CHECK (engine_kind IN ('comfyui', 'contract_mock', 'other')),
  capabilities          jsonb NOT NULL DEFAULT '{}',
  advertised_max_concurrent_jobs int CHECK (advertised_max_concurrent_jobs >= 1),
  dispatch_limit        int CHECK (dispatch_limit >= 1),            -- optional platform cap
  -- Measured media-lane VRAM budget (docs/13). NULL = not measured → one job at a time.
  media_lane_vram_mb    int CHECK (media_lane_vram_mb > 0),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  health                text NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('unknown', 'ready', 'busy', 'degraded', 'maintenance', 'unreachable')),
  last_seen_at          timestamptz,
  last_sync_at          timestamptz,
  last_error            jsonb,
  created_by            uuid REFERENCES core.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Contract manifests. (workflow_key, version) is immutable (contract §4.2).
CREATE TABLE inference.visual_workflows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key          text NOT NULL CHECK (workflow_key ~ '^[a-z_][a-z0-9_.]{1,80}$'),
  version               text NOT NULL
                        CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  version_major         int  NOT NULL,
  version_minor         int  NOT NULL,
  version_patch         int  NOT NULL,
  version_prerelease    text,
  contract_version      text NOT NULL,
  task                  text NOT NULL CHECK (task IN ('generate_image', 'edit_image', 'upscale_image',
                                                      'generate_video', 'upscale_video', 'other')),
  title                 text NOT NULL,
  output_kind           text NOT NULL CHECK (output_kind IN ('image', 'video')),
  manifest              jsonb NOT NULL,              -- as first registered; opaque engine_metadata included
  manifest_sha256       text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  gpu_required          boolean NOT NULL,
  vram_mb_peak          int CHECK (vram_mb_peak >= 0),   -- measured by Track A; NULL = unmeasured
  max_runtime_s         int NOT NULL CHECK (max_runtime_s BETWEEN 1 AND 86400),
  default_priority      text CHECK (default_priority IN ('time_sensitive', 'scheduled_image', 'video', 'maintenance')),
  is_conformance        boolean GENERATED ALWAYS AS (workflow_key LIKE '\_\_conformance\_\_.%') STORED,
  deprecated            boolean NOT NULL DEFAULT false,
  sunset_at             timestamptz,
  status                text NOT NULL DEFAULT 'registered'
                        CHECK (status IN ('registered', 'approved', 'rejected', 'deprecated', 'disabled')),
  registered_from_engine_id uuid REFERENCES inference.visual_engines(id),
  registered_by_type    text NOT NULL CHECK (registered_by_type IN ('user', 'system')),
  registered_by_id      text NOT NULL,
  decided_by            uuid REFERENCES core.users(id),
  decided_at            timestamptz,
  decision_note         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_key, version),
  CHECK (status NOT IN ('approved', 'rejected', 'disabled') OR decided_by IS NOT NULL)
);
CREATE INDEX visual_workflows_key_idx ON inference.visual_workflows (workflow_key, status);

ALTER TABLE inference.gpu_jobs
  ADD CONSTRAINT gpu_jobs_visual_workflow_fk FOREIGN KEY (workflow_id) REFERENCES inference.visual_workflows(id);

CREATE FUNCTION inference.assert_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_key <> OLD.workflow_key OR NEW.version <> OLD.version
     OR NEW.manifest_sha256 <> OLD.manifest_sha256 OR NEW.manifest <> OLD.manifest THEN
    RAISE EXCEPTION 'MANIFEST_IMMUTABLE: workflow % % cannot change content', OLD.workflow_key, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visual_workflows_immutable BEFORE UPDATE ON inference.visual_workflows
  FOR EACH ROW EXECUTE FUNCTION inference.assert_manifest_immutable();

-- Which engine can execute which workflow version (refreshed by sync).
CREATE TABLE inference.engine_workflows (
  engine_id     uuid NOT NULL REFERENCES inference.visual_engines(id),
  workflow_id   uuid NOT NULL REFERENCES inference.visual_workflows(id),
  available     boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engine_id, workflow_id)
);

-- Per-influencer workflow selection. Ranges never cross a MAJOR (contract §4.2);
-- jobs pin the exact version resolved at creation time.
CREATE TABLE identity.workflow_bindings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id      uuid NOT NULL REFERENCES identity.influencers(id),
  purpose            text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{1,62}$'),   -- e.g. 'feed_photo'
  workflow_key       text NOT NULL CHECK (workflow_key ~ '^[a-z_][a-z0-9_.]{1,80}$'),
  version_range      text NOT NULL,                                             -- '1.2.3' | '^1.2' | '~1.2.3'
  default_parameters jsonb NOT NULL DEFAULT '{}',
  priority_class     text CHECK (priority_class IN ('time_sensitive', 'scheduled_image', 'video', 'maintenance')),
  output_count       smallint CHECK (output_count BETWEEN 1 AND 64),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by         uuid REFERENCES core.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, influencer_id) REFERENCES identity.influencers(workspace_id, id)
);
CREATE UNIQUE INDEX workflow_bindings_one_active_idx
  ON identity.workflow_bindings (influencer_id, purpose) WHERE status = 'active';

-- Platform-side QA decision thresholds (engine QA results are advisory, contract §11).
CREATE TABLE identity.qa_thresholds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid REFERENCES identity.influencers(id),          -- NULL = workspace default
  check_key     text NOT NULL CHECK (check_key ~ '^[a-z][a-z0-9_.]{0,63}$'),
  min_score     numeric,
  max_score     numeric,
  required      boolean NOT NULL DEFAULT false,                     -- missing engine result fails the check
  on_fail       text NOT NULL DEFAULT 'reject' CHECK (on_fail IN ('reject', 'flag')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_by    uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (min_score IS NOT NULL OR max_score IS NOT NULL OR required),
  CHECK (min_score IS NULL OR max_score IS NULL OR min_score <= max_score)
);
CREATE UNIQUE INDEX qa_thresholds_one_active_idx
  ON identity.qa_thresholds (workspace_id, influencer_id, check_key) NULLS NOT DISTINCT WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- 3. Visual jobs (persistent queue) and their event log
-- -----------------------------------------------------------------------------
CREATE TABLE inference.visual_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id      uuid NOT NULL REFERENCES identity.influencers(id),
  persona_version_id uuid NOT NULL REFERENCES identity.persona_versions(id),
  content_item_id    uuid REFERENCES content.content_items(id),
  binding_id         uuid REFERENCES identity.workflow_bindings(id),
  workflow_id        uuid NOT NULL REFERENCES inference.visual_workflows(id),
  workflow_key       text NOT NULL,
  workflow_version   text NOT NULL,
  engine_id          uuid REFERENCES inference.visual_engines(id),     -- set at dispatch
  engine_kind        text CHECK (engine_kind IN ('comfyui', 'contract_mock', 'other')),
  request_id         uuid NOT NULL UNIQUE,                             -- stable across attempts
  attempt            int  NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  max_attempts       int  NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  priority_class     text NOT NULL CHECK (priority_class IN ('time_sensitive', 'scheduled_image', 'video', 'maintenance')),
  priority           smallint NOT NULL CHECK (priority BETWEEN 2 AND 5),  -- P2..P5 (docs/13, contract §9)
  parameters         jsonb NOT NULL,
  "references"       jsonb NOT NULL DEFAULT '[]',                      -- [{asset_id, role}] per-job references
  persona_reference_ids uuid[] NOT NULL DEFAULT '{}',                  -- approved persona references pinned at creation
  adapter_ids        uuid[] NOT NULL DEFAULT '{}',
  output_count       smallint NOT NULL CHECK (output_count BETWEEN 1 AND 64),
  timeout_s          int  NOT NULL CHECK (timeout_s BETWEEN 1 AND 86400),
  deadline_at        timestamptz,
  state              text NOT NULL DEFAULT 'queued' CHECK (state IN (
                       'queued', 'dispatching', 'submitted', 'running', 'ingesting', 'succeeded',
                       'failed', 'cancel_requested', 'cancelled', 'timed_out')),
  not_before         timestamptz NOT NULL DEFAULT now(),               -- retry backoff
  engine_job_id      text,
  engine_state       text,
  progress           jsonb,
  -- Exact body of the current attempt. An ambiguous submit (timeout, reset) is
  -- re-sent byte-identical under the same request_id + attempt (contract §7).
  submission         jsonb,
  submission_sha256  text,
  lease_owner        text,
  lease_expires_at   timestamptz,
  dispatched_at      timestamptz,                                      -- current attempt
  started_at         timestamptz,                                      -- first time running
  finished_at        timestamptz,
  last_polled_at     timestamptz,
  error              jsonb,                                            -- last ErrorObject (+ platform codes)
  error_code         text,
  error_class        text,
  resource_usage     jsonb,                                            -- last attempt, as reported
  gpu_seconds        numeric(12, 3) NOT NULL DEFAULT 0,                -- summed over attempts (engine-reported)
  wall_seconds       numeric(12, 3) NOT NULL DEFAULT 0,
  output_asset_ids   uuid[] NOT NULL DEFAULT '{}',
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system', 'schedule')),
  requested_by_id    text NOT NULL,
  agent_run_id       uuid REFERENCES agents.runs(id),
  idempotency_key    text NOT NULL,
  request_hash       text NOT NULL,
  trace_id           text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, influencer_id) REFERENCES identity.influencers(workspace_id, id),
  CHECK (attempt <= max_attempts),
  CHECK (state NOT IN ('succeeded', 'failed', 'cancelled') OR finished_at IS NOT NULL),
  CHECK (state <> 'failed' OR error IS NOT NULL),
  CHECK (state NOT IN ('submitted', 'running', 'timed_out')
         OR (engine_id IS NOT NULL AND engine_job_id IS NOT NULL))
);
CREATE INDEX visual_jobs_ready_idx ON inference.visual_jobs (priority, not_before) WHERE state = 'queued';
CREATE INDEX visual_jobs_inflight_idx ON inference.visual_jobs (engine_id, state)
  WHERE state IN ('dispatching', 'submitted', 'running', 'cancel_requested', 'timed_out', 'ingesting');
CREATE INDEX visual_jobs_influencer_idx ON inference.visual_jobs (influencer_id, created_at DESC);
CREATE INDEX visual_jobs_item_idx ON inference.visual_jobs (content_item_id);

-- Append-only (contract §12): every state transition, poll result, retry,
-- download, verification and QA result.
CREATE TABLE inference.visual_job_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  visual_job_id uuid NOT NULL REFERENCES inference.visual_jobs(id),
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_type    text NOT NULL,
  from_state    text,
  to_state      text,
  attempt       int  NOT NULL,
  engine_job_id text,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'engine')),
  actor_id      text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX visual_job_events_job_idx ON inference.visual_job_events (visual_job_id, id);

-- -----------------------------------------------------------------------------
-- 4. Media assets produced through the contract; validation results for engine QA
-- -----------------------------------------------------------------------------
-- Storage is content-addressed per influencer, so two rows may share a file
-- (byte-identical outputs). Row identity is (visual_job_id, engine_output_id).
ALTER TABLE content.media_assets DROP CONSTRAINT media_assets_storage_key_key;
CREATE INDEX media_assets_storage_key_idx ON content.media_assets (storage_key);

ALTER TABLE content.media_assets
  ADD COLUMN visual_job_id    uuid REFERENCES inference.visual_jobs(id),
  ADD COLUMN engine_output_id text,
  ADD COLUMN engine_kind      text CHECK (engine_kind IN ('comfyui', 'contract_mock', 'other')),
  ADD COLUMN qa_summary       jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN status_reason    text,
  ADD CONSTRAINT media_assets_generated_has_job
    CHECK (origin <> 'generated' OR visual_job_id IS NOT NULL OR generation_job_id IS NOT NULL);
CREATE UNIQUE INDEX media_assets_job_output_idx
  ON content.media_assets (visual_job_id, engine_output_id) WHERE visual_job_id IS NOT NULL;

ALTER TABLE content.validation_results DROP CONSTRAINT validation_results_check_type_check;
ALTER TABLE content.validation_results
  ADD CONSTRAINT validation_results_check_type_check CHECK (check_type IN (
    'technical', 'identity_face', 'identity_attributes', 'moderation', 'rating',
    'real_person_resemblance', 'ip_brand', 'duplicate', 'artifact', 'text_in_image',
    'temporal_consistency', 'caption_policy', 'disclosure_present',
    'engine_qa', 'qa_threshold')),
  ADD COLUMN check_key text,                -- engine QaResult.check / threshold check_key
  ADD COLUMN advisory boolean NOT NULL DEFAULT false;  -- true for engine-reported results

-- -----------------------------------------------------------------------------
-- 5. Staff API tokens and seeded system roles
-- -----------------------------------------------------------------------------
-- Phase 1 authentication: per-user, per-workspace bearer tokens (only the
-- SHA-256 is stored). OIDC login with IdP-enforced MFA replaces interactive use
-- in Phase 2; tokens remain for automation.
CREATE TABLE core.api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES core.users(id),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  name          text NOT NULL,
  token_prefix  text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_by    uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON core.api_tokens (user_id);

INSERT INTO core.roles (workspace_id, key, description) VALUES
  (NULL, 'owner',              'Workspace owner: every workspace permission'),
  (NULL, 'admin',              'Workspace administrator: every workspace permission'),
  (NULL, 'compliance_officer', 'Approves personas, references and content; reads audit'),
  (NULL, 'content_manager',    'Configures influencers, requests generation, prepares and schedules content'),
  (NULL, 'reviewer',           'Reviews and approves or rejects content'),
  (NULL, 'chat_operator',      'Handles escalated conversations (Phase 3)'),
  (NULL, 'finance',            'Payments and payouts (Phase 5)'),
  (NULL, 'analyst',            'Read-only analytics'),
  (NULL, 'viewer',             'Read-only');

WITH grants(role_key, permission) AS (
  SELECT r, p FROM unnest(ARRAY['owner', 'admin']) AS r,
    unnest(ARRAY[
      'influencer.read', 'influencer.create', 'influencer.update',
      'persona.edit', 'persona.approve', 'persona.activate',
      'reference_asset.upload', 'reference_asset.approve', 'adapter.register',
      'binding.manage', 'qa_threshold.manage', 'workflow.read',
      'visual_job.create', 'visual_job.read', 'visual_job.cancel',
      'content.read', 'content.create', 'content.submit', 'content.approve',
      'integration.manage', 'channel.read',
      'publication.schedule', 'publication.cancel', 'publication.read',
      'audit.read']) AS p
  UNION ALL
  SELECT 'compliance_officer', p FROM unnest(ARRAY[
      'influencer.read', 'persona.approve', 'reference_asset.approve', 'qa_threshold.manage',
      'workflow.read', 'visual_job.read', 'content.read', 'content.approve', 'channel.read',
      'publication.read', 'publication.cancel', 'audit.read']) AS p
  UNION ALL
  SELECT 'content_manager', p FROM unnest(ARRAY[
      'influencer.read', 'influencer.update', 'persona.edit', 'reference_asset.upload',
      'adapter.register', 'binding.manage', 'workflow.read',
      'visual_job.create', 'visual_job.read', 'visual_job.cancel',
      'content.read', 'content.create', 'content.submit', 'channel.read',
      'publication.schedule', 'publication.cancel', 'publication.read', 'audit.read']) AS p
  UNION ALL
  SELECT 'reviewer', p FROM unnest(ARRAY[
      'influencer.read', 'workflow.read', 'visual_job.read', 'content.read', 'content.approve',
      'channel.read', 'publication.read', 'audit.read']) AS p
  UNION ALL
  SELECT 'chat_operator', 'influencer.read'
  UNION ALL
  SELECT 'finance', p FROM unnest(ARRAY['influencer.read', 'audit.read']) AS p
  UNION ALL
  SELECT 'analyst', p FROM unnest(ARRAY['influencer.read', 'content.read', 'visual_job.read', 'publication.read']) AS p
  UNION ALL
  SELECT 'viewer', p FROM unnest(ARRAY[
      'influencer.read', 'content.read', 'visual_job.read', 'workflow.read', 'channel.read', 'publication.read']) AS p
)
INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, g.permission FROM grants g JOIN core.roles r ON r.key = g.role_key AND r.workspace_id IS NULL;

-- -----------------------------------------------------------------------------
-- 6. Backstop triggers (the application enforces the same rules first)
-- -----------------------------------------------------------------------------
-- Approval decisions: requester ≠ approver, decision bound to the payload hash,
-- only pending and unexpired requests can be decided.
CREATE FUNCTION approvals.assert_valid_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  req approvals.approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM approvals.approval_requests WHERE id = NEW.approval_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APPROVAL_NOT_FOUND' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF req.requested_by_type = 'user' AND req.requested_by_id = NEW.approver_user_id::text THEN
    RAISE EXCEPTION 'SELF_APPROVAL_FORBIDDEN: the requester cannot decide their own request'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payload_hash_seen <> req.payload_hash THEN
    RAISE EXCEPTION 'PAYLOAD_HASH_MISMATCH: decision does not match the requested payload'
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.status <> 'pending' OR req.expires_at <= now() THEN
    RAISE EXCEPTION 'APPROVAL_NOT_PENDING: request is % (expires %)', req.status, req.expires_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decisions_valid BEFORE INSERT ON approvals.approval_decisions
  FOR EACH ROW EXECUTE FUNCTION approvals.assert_valid_decision();

-- Publications beyond pending_authorization must carry the hash of exactly the
-- revision that was approved, and a human approval must exist for it.
CREATE FUNCTION publishing.assert_publication_authorized() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rev_hash bytea;
BEGIN
  IF NEW.status IN ('pending_authorization', 'cancelled') THEN
    RETURN NEW;
  END IF;
  SELECT content_hash INTO rev_hash FROM content.content_revisions WHERE id = NEW.revision_id;
  IF NEW.authorized_content_hash IS DISTINCT FROM rev_hash THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CONTENT: authorized hash does not match revision %', NEW.revision_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.authorization_kind = 'human_approval' THEN
    IF NEW.approval_request_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM approvals.approval_requests ar
         WHERE ar.id = NEW.approval_request_id
           AND ar.status = 'approved'
           AND ar.subject_type = 'content_revision'
           AND ar.subject_id = NEW.revision_id) THEN
      RAISE EXCEPTION 'UNAUTHORIZED_CONTENT: no approved approval request for revision %', NEW.revision_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.authorization_kind = 'policy_autonomous' THEN
    IF NEW.proposal_id IS NULL THEN
      RAISE EXCEPTION 'UNAUTHORIZED_CONTENT: autonomous publication requires a proposal'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publications_authorized BEFORE INSERT OR UPDATE ON publishing.publications
  FOR EACH ROW EXECUTE FUNCTION publishing.assert_publication_authorized();

-- Contract-mock output is test material: it can be reviewed and scheduled to
-- prove the workflow, but it can never leave the platform.
CREATE FUNCTION publishing.assert_no_mock_assets() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('publishing', 'published') AND EXISTS (
       SELECT 1 FROM content.revision_assets ra
       JOIN content.media_assets ma ON ma.id = ra.media_asset_id
       WHERE ra.revision_id = NEW.revision_id AND ma.engine_kind = 'contract_mock') THEN
    RAISE EXCEPTION 'MOCK_ASSET_NOT_PUBLISHABLE: revision % contains contract-mock output', NEW.revision_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publications_no_mock_assets BEFORE INSERT OR UPDATE ON publishing.publications
  FOR EACH ROW EXECUTE FUNCTION publishing.assert_no_mock_assets();

-- -----------------------------------------------------------------------------
-- 7. Default partitions, row-level security, grants
-- -----------------------------------------------------------------------------
-- Rows outside pre-created monthly partitions land in DEFAULT instead of failing.
CREATE TABLE core.audit_log_default PARTITION OF core.audit_log DEFAULT;
CREATE TABLE conversation.messages_default PARTITION OF conversation.messages DEFAULT;
CREATE TABLE analytics.metric_snapshots_default PARTITION OF analytics.metric_snapshots DEFAULT;
CREATE TABLE analytics.events_default PARTITION OF analytics.events DEFAULT;
CREATE TABLE analytics.usage_events_default PARTITION OF analytics.usage_events DEFAULT;

-- Tenant isolation for the new tenant tables (same policy as the baseline) and
-- for stored credentials.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['identity.workflow_bindings', 'identity.qa_thresholds',
                           'inference.visual_jobs', 'inference.visual_job_events',
                           'core.integration_accounts']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s
         USING (workspace_id = current_setting(''app.workspace_id'')::uuid)
         WITH CHECK (workspace_id = current_setting(''app.workspace_id'')::uuid)', t);
  END LOOP;
END $$;

-- Audit log: a tenant session reads only its workspace; it may append
-- workspace rows and platform-level rows (workspace_id NULL, e.g. engine
-- registration by a platform admin).
ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON core.audit_log FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY audit_append ON core.audit_log FOR INSERT
  WITH CHECK (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT USAGE ON SCHEMA core, identity, content, publishing, conversation, crm, monetization,
  analytics, agents, approvals, inference, ops TO aios_app, aios_worker;

-- No DELETE or TRUNCATE for runtime roles in Phase 1: records are retired by status.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA core, identity, content, publishing,
  conversation, crm, monetization, analytics, agents, approvals, inference, ops TO aios_app, aios_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, identity, content, publishing,
  conversation, crm, monetization, analytics, agents, approvals, inference, ops TO aios_app, aios_worker;

-- Append-only records.
REVOKE UPDATE ON core.audit_log, core.audit_seals, approvals.approval_decisions,
  inference.visual_job_events, monetization.payments, monetization.credit_ledger
  FROM aios_app, aios_worker;

-- Partitions are reached only through their parent (where RLS applies).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relispartition AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM aios_app, aios_worker', r.nspname, r.relname);
  END LOOP;
END $$;

-- Future tables created by migrations get the same baseline grants; each
-- migration still states its own exceptions explicitly. The partition
-- maintenance job must REVOKE on each partition it creates.
ALTER DEFAULT PRIVILEGES FOR ROLE aios_migrator IN SCHEMA core, identity, content, publishing,
  conversation, crm, monetization, analytics, agents, approvals, inference, ops
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aios_app, aios_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE aios_migrator IN SCHEMA core, identity, content, publishing,
  conversation, crm, monetization, analytics, agents, approvals, inference, ops
  GRANT USAGE, SELECT ON SEQUENCES TO aios_app, aios_worker;
