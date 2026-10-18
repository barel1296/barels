-- =============================================================================
-- Migration 0001 — baseline schema.
-- Verbatim copy of docs/schema/schema.sql as reviewed in Phase 1 (commit 86b4a71).
-- From this migration on, db/migrations/ is the authoritative schema; the docs
-- file is kept as the annotated design reference. Never edit an applied
-- migration: the runner verifies checksums.
-- =============================================================================
-- =============================================================================
-- AI Influencer OS — reference schema (Phase 1 design artifact, not a migration)
-- Target: PostgreSQL 16+
--
-- Conventions
--   * Primary keys: uuid. The application generates UUIDv7 for index locality.
--     gen_random_uuid() is only a fallback default.
--   * Every tenant-owned table carries workspace_id and is covered by RLS.
--   * Each module owns one schema. Cross-schema foreign keys may only point at
--     stable root entities: core.workspaces, core.users, identity.influencers,
--     crm.fans, publishing.channels, content.media_assets.
--   * Telegram Stars (XTR) amounts are bigint whole Stars. Fiat amounts are
--     numeric and are always an *estimate*, unless they come from a recorded
--     payout (monetization.payouts).
--   * Large or variable payloads (raw provider responses, full LLM transcripts)
--     live in object storage. The row keeps a *_ref pointer to them.
--   * Status columns are text + CHECK rather than enums, so values can evolve
--     without a type migration. content_rating is the one ordered enum.
--   * Deployment: single workstation, all AI inference local (docs/04, docs/13).
--     Postgres is also the persistent job queue; there is no Redis.
--     Media lives on local disk under content-addressed paths (storage_key).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist; -- exclusion constraints on entitlements

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS publishing;
CREATE SCHEMA IF NOT EXISTS conversation;
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS monetization;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS agents;
CREATE SCHEMA IF NOT EXISTS approvals;
CREATE SCHEMA IF NOT EXISTS inference;   -- platform-level: model registry, workflows, GPU scheduling
CREATE SCHEMA IF NOT EXISTS ops;         -- platform-level: benchmarks, capacity, energy and cost ledger

-- Ordered rating scale used by content policy, channels, products and fans.
--   general     : suitable for any audience
--   suggestive  : fashion/swimwear/fitness, light flirtation, no nudity
--   mature      : lingerie / implied nudity / strong romantic themes; no explicit
--                 nudity or sexual acts. Adult-only channels, behind a flag.
--   explicit    : nudity / sexual content. DISABLED platform-wide until legal,
--                 age-assurance, platform and vendor eligibility are confirmed
--                 (see docs/03-risk-register.md).
CREATE TYPE content_rating AS ENUM ('general', 'suggestive', 'mature', 'explicit');

-- =============================================================================
-- CORE (platform): tenancy, staff identity, RBAC, audit, outbox, idempotency
-- =============================================================================

CREATE TABLE core.workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL UNIQUE,
  name          text   NOT NULL,
  status        text   NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'closed')),
  settings      jsonb  NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text   NOT NULL,
  idp_issuer    text   NOT NULL,           -- OIDC issuer (MFA enforced at IdP)
  idp_subject   text   NOT NULL,
  status        text   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idp_issuer, idp_subject)
);

-- System roles (workspace_id NULL) + optional custom roles per workspace.
-- System role keys: owner, admin, compliance_officer, content_manager, reviewer,
-- chat_operator, finance, analyst, viewer.
CREATE TABLE core.roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES core.workspaces(id),
  key           text NOT NULL,
  description   text,
  UNIQUE NULLS NOT DISTINCT (workspace_id, key)
);

-- Permission strings, e.g. 'content.approve', 'publication.publish',
-- 'payment.refund', 'persona.activate', 'autonomy.policy.edit', 'fan.pii.read'.
CREATE TABLE core.role_permissions (
  role_id       uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  permission    text NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE core.memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  user_id       uuid NOT NULL REFERENCES core.users(id),
  role_id       uuid NOT NULL REFERENCES core.roles(id),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

-- Append-only audit trail. The app role holds INSERT and SELECT only (see grants
-- at the end). Tamper evidence: an hourly job seals each workspace's new rows
-- into core.audit_seals (hash chain) and exports them to a WORM bucket.
CREATE TABLE core.audit_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  workspace_id        uuid,                       -- NULL = platform-level action
  influencer_id       uuid,
  actor_type          text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'external')),
  actor_id            text NOT NULL,              -- user id / agent run id / job name / platform
  action              text NOT NULL,              -- e.g. 'publication.publish', 'entitlement.revoke'
  subject_type        text NOT NULL,
  subject_id          text NOT NULL,
  approval_request_id uuid,
  proposal_id         uuid,
  request_id          text,
  trace_id            text,
  ip                  inet,
  user_agent          text,
  changes             jsonb,                      -- {before, after}, PII-redacted
  metadata            jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE core.audit_log_2026_10 PARTITION OF core.audit_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- Later partitions are created ahead of time by the maintenance job.

CREATE INDEX audit_log_subject_idx ON core.audit_log (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_log_ws_time_idx ON core.audit_log (workspace_id, occurred_at DESC);

CREATE TABLE core.audit_seals (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid,
  first_log_id  bigint NOT NULL,
  last_log_id   bigint NOT NULL,
  rows_hash     bytea  NOT NULL,                  -- hash over the sealed rows
  prev_seal_hash bytea,
  seal_hash     bytea  NOT NULL,                  -- H(prev_seal_hash || rows_hash)
  exported_ref  text,                             -- object key in the WORM bucket
  sealed_at     timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: written in the same transaction as the state change.
CREATE TABLE core.outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid,
  event_type        text NOT NULL,                -- e.g. 'monetization.payment_succeeded'
  event_version     smallint NOT NULL DEFAULT 1,
  aggregate_type    text NOT NULL,
  aggregate_id      uuid NOT NULL,
  payload           jsonb NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at     timestamptz,
  dispatch_attempts int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending_idx ON core.outbox_events (occurred_at) WHERE dispatched_at IS NULL;

-- Inbox: one row per (consumer, event) gives exactly-once effects.
CREATE TABLE core.processed_events (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- Raw inbound webhooks, persisted before acknowledging (retention: 30 days).
CREATE TABLE core.inbound_webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL CHECK (provider IN ('telegram', 'meta', 'vendor')),
  account_ref   text,                             -- bot id / IG account id / vendor
  dedup_key     text NOT NULL UNIQUE,             -- e.g. 'telegram:<bot_id>:<update_id>'
  headers       jsonb NOT NULL DEFAULT '{}',      -- secrets stripped
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  error         jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX inbound_webhooks_status_idx ON core.inbound_webhooks (status, received_at)
  WHERE status IN ('received', 'failed');

-- Cursors for pull-based ingestion: Telegram getUpdates offsets per bot, Instagram
-- comment/conversation backfill, getStarTransactions paging. A cursor advances only
-- after the fetched items are persisted (persist-then-advance), so a crash
-- re-fetches instead of losing updates.
CREATE TABLE core.poll_cursors (
  source        text NOT NULL CHECK (source IN ('telegram_updates', 'instagram_comments',
                                                'instagram_conversations', 'telegram_star_transactions')),
  account_ref   text NOT NULL,                    -- bot id / IG account id
  cursor        text NOT NULL,                    -- e.g. next getUpdates offset
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, account_ref)
);

-- Idempotency ledger for every side-effecting external call.
CREATE TABLE core.external_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  idempotency_key text NOT NULL UNIQUE,           -- e.g. 'ig.publish:<publication_id>'
  provider        text NOT NULL,
  operation       text NOT NULL,                  -- e.g. 'instagram.media_publish'
  subject_type    text NOT NULL,
  subject_id      uuid NOT NULL,
  request_hash    bytea NOT NULL,                 -- detects a key reused with a different request
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_flight', 'succeeded', 'failed_retryable',
                                    'failed_permanent', 'unknown', 'reconciled')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  external_ref    text,                           -- id returned by the provider
  response        jsonb,                          -- small, redacted
  last_error      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX external_operations_unknown_idx ON core.external_operations (status, updated_at)
  WHERE status IN ('unknown', 'failed_retryable', 'in_flight');

-- Jobs (Postgres-backed queue) that exhausted their attempts.
CREATE TABLE core.dead_letter_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid,
  queue           text NOT NULL,
  job_id          text NOT NULL,
  job_name        text NOT NULL,
  payload         jsonb NOT NULL,
  error           jsonb NOT NULL,
  attempts        int NOT NULL,
  failed_at       timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replayed', 'discarded')),
  resolved_by     uuid REFERENCES core.users(id),
  resolved_at     timestamptz,
  resolution_note text,
  UNIQUE (queue, job_id)
);

CREATE TABLE core.feature_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES core.workspaces(id),   -- NULL = global
  influencer_id uuid,                                  -- NULL = workspace-wide
  key           text NOT NULL,                         -- e.g. 'kill_switch.autonomy', 'rating.mature.enabled'
  value         jsonb NOT NULL,
  updated_by    uuid REFERENCES core.users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (workspace_id, influencer_id, key)
);

-- =============================================================================
-- INFERENCE REGISTRY (platform-level, no tenant data): licenses and models.
-- A model can be used in production only when status = 'approved', which
-- requires a reviewed license allowing commercial use (CHECK below).
-- =============================================================================

CREATE TABLE inference.licenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text NOT NULL UNIQUE,        -- e.g. 'apache-2.0', 'openrail++-m', 'flux-1-dev-noncommercial'
  name                text NOT NULL,
  url                 text NOT NULL,
  weights_commercial  boolean NOT NULL,            -- may we run the weights for a commercial service?
  outputs_commercial  boolean NOT NULL,            -- may we use generated outputs commercially?
  territory_exclusions text[] NOT NULL DEFAULT '{}',  -- e.g. '{EU,UK,KR}'
  revenue_threshold   text,                        -- e.g. 'free below USD 1M annual revenue'
  use_restrictions    text,                        -- acceptable-use clauses relevant to us
  reviewed_by         uuid REFERENCES core.users(id),
  reviewed_at         timestamptz,
  evidence_ref        text NOT NULL                -- where the license text was read (docs/15)
);

CREATE TABLE inference.models (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text NOT NULL UNIQUE,        -- e.g. 'chat.primary', 'image.base.v1', 'video.i2v.v1'
  kind                text NOT NULL CHECK (kind IN ('llm', 'vlm', 'guard', 'embedding', 'reranker',
                                                    'image_base', 'image_edit', 'video', 'lipsync',
                                                    'tts', 'upscaler', 'detector', 'segmenter',
                                                    'face_embedding', 'image_classifier', 'vae',
                                                    'text_encoder', 'lora_base')),
  name                text NOT NULL,               -- upstream model name
  source_uri          text NOT NULL,               -- upstream repo / URL
  revision            text NOT NULL,               -- upstream commit / version tag
  file_sha256         text[] NOT NULL,             -- hashes of the exact files deployed
  quantization        text,                        -- e.g. 'fp8_e4m3', 'nvfp4', 'gguf-q5_k_m', 'awq-int4'
  engine              text NOT NULL CHECK (engine IN ('llm_engine', 'comfyui', 'inference_host', 'trainer')),
  license_id          uuid NOT NULL REFERENCES inference.licenses(id),
  measured_peak_vram_mb int,                       -- from ops.benchmark_runs (B-*-1)
  measured_load_s     numeric,                     -- from B-SYS-2
  status              text NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate', 'evaluating', 'approved', 'retired', 'blocked')),
  approved_by         uuid REFERENCES core.users(id),
  approved_at         timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL)
);

-- Enforce: only commercially licensed models can be approved.
CREATE FUNCTION inference.assert_model_license() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l inference.licenses%ROWTYPE;
BEGIN
  IF NEW.status = 'approved' THEN
    SELECT * INTO l FROM inference.licenses WHERE id = NEW.license_id;
    IF NOT (l.weights_commercial AND l.outputs_commercial) OR l.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'model % cannot be approved: license % not reviewed or not commercial', NEW.key, l.key;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER models_license_gate BEFORE INSERT OR UPDATE ON inference.models
  FOR EACH ROW EXECUTE FUNCTION inference.assert_model_license();

-- =============================================================================
-- IDENTITY (Module A): influencer, persona versions, canon, visual references
-- =============================================================================

CREATE TABLE identity.influencers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES core.workspaces(id),
  slug                      citext NOT NULL,
  display_name              text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  ai_disclosure_short       text NOT NULL,   -- e.g. 'AI-generated virtual creator'
  ai_disclosure_long        text NOT NULL,   -- shown at conversation start, in bios, in /about
  timezone                  text NOT NULL,
  primary_language          text NOT NULL,
  active_persona_version_id uuid,            -- FK added below
  autonomy_paused           boolean NOT NULL DEFAULT false,  -- per-influencer kill switch
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id)
);

-- Staff access narrowed to specific influencers (no rows = all influencers).
CREATE TABLE core.membership_influencer_scopes (
  membership_id uuid NOT NULL REFERENCES core.memberships(id) ON DELETE CASCADE,
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  PRIMARY KEY (membership_id, influencer_id)
);

-- Encrypted platform credentials, one row per connected account.
-- Envelope encryption: a per-workspace data key, wrapped by the local master
-- key (docs/09 §2); the token is encrypted with AES-256-GCM under the data key.
CREATE TABLE core.integration_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id         uuid REFERENCES identity.influencers(id),
  provider              text NOT NULL CHECK (provider IN ('instagram', 'telegram_bot', 'telegram_business')),
  external_account_id   text NOT NULL,            -- IG user id / bot id / business connection owner
  display_name          text,
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'needs_reauth', 'revoked', 'disabled')),
  scopes                text[] NOT NULL DEFAULT '{}',
  credential_ciphertext bytea NOT NULL,
  credential_nonce      bytea NOT NULL,
  data_key_ciphertext   bytea NOT NULL,
  wrapping_key_id       text  NOT NULL,           -- id/version of the master key that wrapped the data key
  credential_version    int   NOT NULL DEFAULT 1,
  expires_at            timestamptz,              -- IG long-lived tokens expire; refresh job alerts
  last_refreshed_at     timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, external_account_id)
);

CREATE TABLE identity.persona_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id      uuid NOT NULL REFERENCES identity.influencers(id),
  version            int  NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'in_review', 'approved', 'active', 'retired')),
  personality        jsonb NOT NULL,  -- traits, values, interests, humour, boundaries, red lines
  writing_style      jsonb NOT NULL,  -- tone, register, emoji policy, vocabulary, banned phrases, few-shot examples
  biography          jsonb NOT NULL,  -- explicitly fictional; persona is an adult; no real-person likeness
  visual_identity    jsonb NOT NULL,  -- face/body descriptors, hair, eyes, marks, wardrobe, palette, photo style
  voice_profile      jsonb,           -- for future TTS/voice notes
  conversation_rules jsonb NOT NULL,  -- disclosure phrasing, relationship-framing limits, escalation triggers
  change_summary     text,
  created_by         uuid REFERENCES core.users(id),
  approved_by        uuid REFERENCES core.users(id),
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (influencer_id, version),
  CHECK (status NOT IN ('approved', 'active') OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX persona_one_active_idx ON identity.persona_versions (influencer_id) WHERE status = 'active';

ALTER TABLE identity.influencers
  ADD CONSTRAINT influencers_active_persona_fk
  FOREIGN KEY (active_persona_version_id) REFERENCES identity.persona_versions(id);

-- Per-persona runtime configuration: what makes 30 personas share one stack.
CREATE TABLE identity.persona_runtime_config (
  influencer_id            uuid PRIMARY KEY REFERENCES identity.influencers(id),
  workspace_id             uuid NOT NULL REFERENCES core.workspaces(id),
  rollout_stage            smallint NOT NULL DEFAULT 1 CHECK (rollout_stage BETWEEN 1 AND 4),
  content_tier             text NOT NULL DEFAULT 'lite' CHECK (content_tier IN ('lite', 'standard', 'plus')),
  gpu_quota_seconds_day    int  NOT NULL CHECK (gpu_quota_seconds_day >= 0),   -- fair-share weight (docs/13 §6.2)
  free_replies_per_day     int  NOT NULL CHECK (free_replies_per_day >= 0),    -- capacity + wellbeing control
  premium_replies_per_day  int  NOT NULL CHECK (premium_replies_per_day >= 0),
  languages                text[] NOT NULL DEFAULT '{en}',
  quiet_hours              jsonb NOT NULL DEFAULT '{}',   -- persona "offline" hours for scheduled posts
  image_workflow_key       text,                          -- inference.workflows.key
  video_workflow_key       text,
  identity_adapter_id      uuid,                          -- FK to identity.model_adapters added below
  business_account_enabled boolean NOT NULL DEFAULT false,
  paused                   boolean NOT NULL DEFAULT false, -- excludes persona from scheduling
  updated_by               uuid REFERENCES core.users(id),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Canon facts keep the fictional biography consistent across content and chats.
CREATE TABLE identity.canon_facts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  category      text NOT NULL CHECK (category IN ('biography', 'preference', 'relationship',
                                                  'timeline', 'location', 'routine', 'other')),
  statement     text NOT NULL,
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'premium', 'internal')),
  source        text NOT NULL CHECK (source IN ('persona', 'approved_proposal', 'published_content')),
  source_ref    text,
  valid_from    date,
  valid_to      date,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('proposed', 'active', 'retired')),
  approved_by   uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canon_facts_inf_idx ON identity.canon_facts (influencer_id, status, category);

CREATE TABLE identity.business_objectives (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  metric        text NOT NULL,     -- e.g. 'ig_followers', 'premium_active_subscribers', 'revenue_stars'
  target_value  numeric NOT NULL,
  priority      smallint NOT NULL DEFAULT 2,
  notes         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'achieved', 'missed', 'cancelled')),
  created_by    uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- Configurable content policy (workspace default when influencer_id IS NULL).
-- rules example:
--   {"channel_max_rating": {"instagram_account":"suggestive", "telegram_public_channel":"suggestive",
--                           "telegram_premium_channel":"suggestive", "telegram_bot":"suggestive"},
--    "banned_themes": ["minors","real_people","weapons","drugs","medical_claims",...],
--    "required_disclosures": {"caption_suffix":"#AIgenerated", "sponsored":"#ad"},
--    "brand_safety": {...}, "max_offers_per_fan_per_day": 2}
CREATE TABLE identity.content_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid REFERENCES identity.influencers(id),
  version       int  NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  max_rating    content_rating NOT NULL DEFAULT 'suggestive',   -- absolute ceiling
  rules         jsonb NOT NULL,
  approved_by   uuid REFERENCES core.users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (workspace_id, influencer_id, version),
  CHECK (status <> 'active' OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX content_policy_one_active_idx
  ON identity.content_policies (workspace_id, influencer_id) NULLS NOT DISTINCT WHERE status = 'active';

-- =============================================================================
-- CONTENT (Module B): plans, items, generation, media, validation, revisions
-- =============================================================================

CREATE TABLE content.media_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id     uuid NOT NULL REFERENCES identity.influencers(id),
  kind              text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'thumbnail')),
  storage_key       text NOT NULL UNIQUE,         -- local path: ws/{ws}/inf/{inf}/media/{sha256[0:2]}/{sha256}.{ext}
  mime_type         text NOT NULL,
  bytes             bigint NOT NULL,
  width             int,
  height            int,
  duration_ms       int,
  sha256            bytea NOT NULL,
  phash             bigint,                       -- perceptual hash for duplicate detection
  origin            text NOT NULL CHECK (origin IN ('generated', 'edited', 'uploaded', 'derived')),
  parent_asset_id   uuid REFERENCES content.media_assets(id),
  generation_job_id uuid,                         -- FK added below
  provenance        jsonb NOT NULL DEFAULT '{}',  -- vendor, model, seed, IPTC digital source type, C2PA manifest id
  c2pa_embedded     boolean NOT NULL DEFAULT false,
  assessed_rating   content_rating,
  status            text NOT NULL DEFAULT 'pending_validation'
                    CHECK (status IN ('pending_validation', 'valid', 'rejected', 'quarantined', 'deleted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX media_assets_inf_idx ON content.media_assets (influencer_id, created_at DESC);

CREATE TABLE identity.reference_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id   uuid NOT NULL REFERENCES identity.influencers(id),
  media_asset_id  uuid NOT NULL REFERENCES content.media_assets(id),
  kind            text NOT NULL CHECK (kind IN ('face_canonical', 'face_angle', 'body', 'outfit',
                                                'style', 'environment', 'voice_sample')),
  is_canonical    boolean NOT NULL DEFAULT false,
  face_embedding  real[],                         -- from the face-matching provider; model recorded below
  embedding_model text,
  vendor_face_ref text,                           -- e.g. a face id in a vendor collection
  notes           text,
  approved_by     uuid REFERENCES core.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz
);

-- LoRA / fine-tune / reference-set adapters per influencer and base model,
-- trained locally (class T jobs). Weights live on local disk (external_ref = path).
CREATE TABLE identity.model_adapters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  provider            text NOT NULL DEFAULT 'local',
  base_model          text NOT NULL,
  base_model_id       uuid REFERENCES inference.models(id),
  kind                text NOT NULL CHECK (kind IN ('lora', 'fine_tune', 'reference_set', 'voice')),
  training_gpu_job_id uuid,                       -- FK added below (inference.gpu_jobs)
  external_ref        text,                       -- weights URL/id at vendor or our bucket key
  trigger_token       text,
  dataset_manifest_ref text,                      -- which reference assets were used (reproducibility)
  status              text NOT NULL DEFAULT 'training'
                      CHECK (status IN ('training', 'ready', 'failed', 'retired')),
  eval_metrics        jsonb,                      -- identity pass rate on the calibration set, etc.
  approved_by         uuid REFERENCES core.users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content.prompt_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid REFERENCES core.workspaces(id),   -- NULL = platform default
  key           text NOT NULL,                         -- e.g. 'image.lifestyle.v', 'caption.instagram'
  version       int  NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('image', 'video', 'caption', 'brief',
                                                 'agent_system', 'conversation_system', 'guard')),
  body          text NOT NULL,
  variables     jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_by    uuid REFERENCES core.users(id),
  approved_by   uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (workspace_id, key, version)
);

CREATE TABLE content.content_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'pending_approval', 'approved', 'superseded')),
  strategy_notes      text,
  created_by_type     text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id       text NOT NULL,
  approval_request_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content.content_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  plan_id             uuid REFERENCES content.content_plans(id),
  format              text NOT NULL CHECK (format IN (
                        'ig_image', 'ig_carousel', 'ig_reel', 'ig_story_image', 'ig_story_video',
                        'tg_post', 'tg_album', 'tg_video', 'tg_paid_media', 'bot_paid_media',
                        'custom_request')),
  planned_for         timestamptz,
  target_rating       content_rating NOT NULL DEFAULT 'general',
  assessed_rating     content_rating,             -- worst rating across assets + caption
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN (
                        'planned', 'briefed', 'generating', 'validating', 'needs_rework',
                        'ready_for_review', 'changes_requested', 'approved', 'scheduled',
                        'partially_published', 'published', 'rejected', 'failed', 'archived')),
  brief               jsonb,                      -- scene, outfit, location, mood, shot list, CTA, angle
  current_revision_id uuid,                       -- FK added below
  is_sponsored        boolean NOT NULL DEFAULT false,
  sponsor_disclosure  text,
  created_by_type     text NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_id       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_sponsored OR sponsor_disclosure IS NOT NULL)
);
CREATE INDEX content_items_status_idx ON content.content_items (influencer_id, status, planned_for);

CREATE TABLE content.generation_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  content_item_id     uuid REFERENCES content.content_items(id),
  kind                text NOT NULL CHECK (kind IN ('image', 'image_edit', 'video', 'upscale',
                                                    'adapter_training', 'caption')),
  provider            text NOT NULL DEFAULT 'comfyui',
  model               text NOT NULL,              -- inference.models.key of the base model
  workflow_key        text,                       -- inference.workflows.key
  workflow_version    int,
  gpu_job_id          uuid,                       -- FK added below (inference.gpu_jobs)
  prompt_template_id  uuid REFERENCES content.prompt_templates(id),
  prompt              jsonb NOT NULL,             -- rendered prompt, negative prompt, seed
  params              jsonb NOT NULL DEFAULT '{}',
  reference_asset_ids uuid[] NOT NULL DEFAULT '{}',
  model_adapter_id    uuid REFERENCES identity.model_adapters(id),
  n_outputs           smallint NOT NULL DEFAULT 1,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN (
                        'queued', 'submitted', 'running', 'succeeded', 'failed', 'cancelled',
                        'blocked_by_vendor_policy')),
  external_job_id     text,
  attempts            int NOT NULL DEFAULT 0,
  requested_by_type   text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system')),
  requested_by_id     text NOT NULL,
  agent_run_id        uuid,
  gpu_seconds         numeric(12, 3),             -- measured
  energy_wh           numeric(12, 4),             -- attributed from power telemetry
  cost_usd            numeric(14, 6),             -- attributed internal cost (docs/12)
  error               jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz
);
CREATE INDEX generation_jobs_item_idx ON content.generation_jobs (content_item_id);

ALTER TABLE content.media_assets
  ADD CONSTRAINT media_assets_generation_job_fk
  FOREIGN KEY (generation_job_id) REFERENCES content.generation_jobs(id);

-- Automated checks on media and on caption revisions.
CREATE TABLE content.validation_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('media_asset', 'revision')),
  subject_id    uuid NOT NULL,
  check_type    text NOT NULL CHECK (check_type IN (
                  'technical', 'identity_face', 'identity_attributes', 'moderation', 'rating',
                  'real_person_resemblance', 'ip_brand', 'duplicate', 'artifact', 'text_in_image',
                  'temporal_consistency', 'caption_policy', 'disclosure_present')),
  provider      text NOT NULL,
  model         text,
  score         numeric,
  threshold     numeric,
  passed        boolean NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validation_subject_idx ON content.validation_results (subject_type, subject_id);

-- Immutable revision: exactly what a reviewer approves and what gets published.
CREATE TABLE content.content_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  content_item_id uuid NOT NULL REFERENCES content.content_items(id),
  revision        int  NOT NULL,
  caption         text,
  hashtags        text[] NOT NULL DEFAULT '{}',
  alt_text        text,
  cta             jsonb,
  disclosure_text text NOT NULL,               -- AI disclosure always present
  content_hash    bytea NOT NULL,              -- H(caption, hashtags, disclosure, ordered asset sha256s, cta)
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_id   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, revision)
);

CREATE TABLE content.revision_assets (
  revision_id    uuid NOT NULL REFERENCES content.content_revisions(id),
  position       smallint NOT NULL,
  media_asset_id uuid NOT NULL REFERENCES content.media_assets(id),
  role           text NOT NULL CHECK (role IN ('primary', 'carousel', 'cover', 'teaser', 'full')),
  PRIMARY KEY (revision_id, position)
);

ALTER TABLE content.content_items
  ADD CONSTRAINT content_items_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES content.content_revisions(id);

-- =============================================================================
-- PUBLISHING (Module C): channels, publications, comments
-- =============================================================================

CREATE TABLE publishing.channels (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id          uuid NOT NULL REFERENCES identity.influencers(id),
  integration_account_id uuid NOT NULL REFERENCES core.integration_accounts(id),
  kind                   text NOT NULL CHECK (kind IN ('instagram_account', 'telegram_public_channel',
                                                       'telegram_premium_channel', 'telegram_bot',
                                                       'telegram_business_account')),
  external_id            text NOT NULL,          -- IG user id / Telegram chat id
  username               text,
  title                  text,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disconnected')),
  max_rating             content_rating NOT NULL DEFAULT 'general',
  audience_gate          text NOT NULL DEFAULT 'none'
                         CHECK (audience_gate IN ('none', 'self_attested_adult', 'verified_adult')),
  publish_frozen         boolean NOT NULL DEFAULT false,   -- per-channel kill switch
  settings               jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_id),
  -- Mature content only on adult-gated channels; explicit content additionally
  -- needs verified-adult gating (and is globally disabled for the MVP via flag).
  CHECK (max_rating <= 'suggestive' OR audience_gate <> 'none'),
  CHECK (max_rating <> 'explicit' OR audience_gate = 'verified_adult')
);

CREATE TABLE publishing.publications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id           uuid NOT NULL REFERENCES identity.influencers(id),
  content_item_id         uuid NOT NULL REFERENCES content.content_items(id),
  revision_id             uuid NOT NULL REFERENCES content.content_revisions(id),
  channel_id              uuid NOT NULL REFERENCES publishing.channels(id),
  scheduled_for           timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'pending_authorization' CHECK (status IN (
                            'pending_authorization', 'scheduled', 'publishing', 'published', 'failed',
                            'cancelled', 'unknown', 'removed')),
  -- Authorization binding: the hash that was approved must equal the revision's hash.
  authorized_content_hash bytea,
  authorization_kind      text CHECK (authorization_kind IN ('human_approval', 'policy_autonomous')),
  approval_request_id     uuid,
  proposal_id             uuid,
  external_operation_id   uuid REFERENCES core.external_operations(id),
  external_container_id   text,                  -- IG media container id
  external_post_id        text,                  -- IG media id / Telegram message id(s)
  permalink               text,
  platform_flags          jsonb NOT NULL DEFAULT '{}',   -- e.g. {"is_ai_generated": true} on Instagram containers
  published_at            timestamptz,
  removed_at              timestamptz,
  attempts                int NOT NULL DEFAULT 0,
  last_error              jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, channel_id),
  CHECK (status IN ('pending_authorization', 'cancelled')
         OR (authorized_content_hash IS NOT NULL AND authorization_kind IS NOT NULL))
);
CREATE INDEX publications_due_idx ON publishing.publications (scheduled_for) WHERE status = 'scheduled';

-- Instagram publishing quota observations (content_publishing_limit endpoint).
CREATE TABLE publishing.quota_snapshots (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id  uuid NOT NULL REFERENCES publishing.channels(id),
  quota_used  int NOT NULL,
  quota_total int NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publishing.comments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id          uuid NOT NULL REFERENCES identity.influencers(id),
  channel_id             uuid NOT NULL REFERENCES publishing.channels(id),
  publication_id         uuid REFERENCES publishing.publications(id),
  external_comment_id    text NOT NULL,
  parent_external_id     text,
  fan_id                 uuid,                    -- FK added after crm.fans
  author_platform_user_id text,
  author_username        text,
  body                   text NOT NULL,
  classification         jsonb,                   -- intent, sentiment, spam/abuse, risk
  status                 text NOT NULL DEFAULT 'new' CHECK (status IN (
                           'new', 'replied', 'hidden', 'deleted', 'ignored', 'escalated')),
  commented_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_comment_id)
);

CREATE TABLE publishing.comment_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES core.workspaces(id),
  comment_id            uuid NOT NULL REFERENCES publishing.comments(id),
  action                text NOT NULL CHECK (action IN ('reply', 'hide', 'unhide', 'delete', 'private_reply')),
  body                  text,
  actor_type            text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id              text NOT NULL,
  approval_request_id   uuid,
  external_operation_id uuid REFERENCES core.external_operations(id),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'rejected')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- CRM (Module F): fans, cross-platform identities, consent, age status, DSRs
-- =============================================================================

CREATE TABLE crm.fans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  display_name           text,
  primary_language       text,
  country_code           char(2),                 -- only if user-provided / platform-provided
  age_status             text NOT NULL DEFAULT 'unknown' CHECK (age_status IN (
                           'unknown', 'self_attested_adult', 'verified_adult',
                           'suspected_minor', 'confirmed_minor')),
  age_status_updated_at  timestamptz,
  age_verification_ref   text,                    -- vendor reference only; never documents
  status                 text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'restricted', 'blocked', 'erased')),
  risk_flags             text[] NOT NULL DEFAULT '{}',  -- e.g. 'vulnerability_signal', 'chargeback_risk'
  first_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz,
  erased_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Instagram-scoped user IDs are scoped to our IG account, so scope_ref holds
-- that account id. For Telegram user ids scope_ref = 'global'.
CREATE TABLE crm.fan_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id           uuid NOT NULL REFERENCES crm.fans(id),
  platform         text NOT NULL CHECK (platform IN ('instagram', 'telegram')),
  scope_ref        text NOT NULL,
  platform_user_id text NOT NULL,
  username         text,
  linked_via       text NOT NULL CHECK (linked_via IN ('first_contact', 'deep_link_token', 'operator')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  UNIQUE (workspace_id, platform, scope_ref, platform_user_id)
);

CREATE TABLE crm.fan_influencer_profiles (
  workspace_id          uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id                uuid NOT NULL REFERENCES crm.fans(id),
  influencer_id         uuid NOT NULL REFERENCES identity.influencers(id),
  lifecycle_stage       text NOT NULL DEFAULT 'new' CHECK (lifecycle_stage IN (
                          'new', 'engaged', 'lead', 'customer', 'subscriber', 'lapsed', 'churned')),
  engagement_score      numeric(6, 3),
  lifetime_stars        bigint NOT NULL DEFAULT 0,
  preferences           jsonb NOT NULL DEFAULT '{}',   -- user-set: language, interests, notification opt-ins
  marketing_opt_in      boolean NOT NULL DEFAULT false,
  monthly_spend_cap_stars bigint,                       -- user-set or protective default
  first_interaction_at  timestamptz NOT NULL DEFAULT now(),
  last_interaction_at   timestamptz,
  PRIMARY KEY (fan_id, influencer_id)
);

CREATE TABLE crm.policy_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  kind          text NOT NULL CHECK (kind IN ('terms', 'privacy', 'ai_disclosure', 'content_rules', 'refund_policy')),
  version       text NOT NULL,
  url           text NOT NULL,
  content_hash  bytea NOT NULL,
  published_at  timestamptz NOT NULL,
  UNIQUE (workspace_id, kind, version)
);

CREATE TABLE crm.consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id             uuid NOT NULL REFERENCES crm.fans(id),
  influencer_id      uuid REFERENCES identity.influencers(id),
  purpose            text NOT NULL CHECK (purpose IN (
                       'terms_acceptance',
                       'ai_processing',            -- explicit, per-chat consent before any AI reads the fan's messages
                       'memory_personalization',
                       'marketing_messages', 'age_attestation_18', 'mature_content_optin')),
  status             text NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  policy_document_id uuid REFERENCES crm.policy_documents(id),
  method             text NOT NULL CHECK (method IN ('bot_button', 'bot_command', 'ig_dm', 'operator_recorded')),
  evidence           jsonb NOT NULL,              -- message id, callback payload, timestamp
  granted_at         timestamptz,
  withdrawn_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX consents_one_current_idx
  ON crm.consents (fan_id, influencer_id, purpose) NULLS NOT DISTINCT WHERE status = 'granted';

-- One-time tokens for cross-platform linking (e.g. t.me/<bot>?start=<token>).
CREATE TABLE crm.link_tokens (
  token_hash    bytea PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id        uuid REFERENCES crm.fans(id),
  purpose       text NOT NULL CHECK (purpose IN ('link_instagram_identity', 'campaign_attribution', 'offer')),
  payload       jsonb NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm.segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id   uuid NOT NULL REFERENCES identity.influencers(id),
  name            text NOT NULL,
  definition      jsonb NOT NULL,
  materialized_at timestamptz
);

CREATE TABLE crm.segment_members (
  segment_id uuid NOT NULL REFERENCES crm.segments(id) ON DELETE CASCADE,
  fan_id     uuid NOT NULL REFERENCES crm.fans(id),
  PRIMARY KEY (segment_id, fan_id)
);

CREATE TABLE crm.data_subject_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id        uuid REFERENCES crm.fans(id),
  kind          text NOT NULL CHECK (kind IN ('access', 'erasure', 'rectification', 'restriction', 'objection')),
  received_via  text NOT NULL,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN (
                  'received', 'verifying', 'in_progress', 'completed', 'rejected')),
  received_at   timestamptz NOT NULL DEFAULT now(),
  due_at        timestamptz NOT NULL,
  completed_at  timestamptz,
  handled_by    uuid REFERENCES core.users(id),
  notes         text,
  evidence_ref  text
);

ALTER TABLE publishing.comments
  ADD CONSTRAINT comments_fan_fk FOREIGN KEY (fan_id) REFERENCES crm.fans(id);

-- =============================================================================
-- CONVERSATION (Module D): conversations, messages, memory, escalations
-- =============================================================================

CREATE TABLE conversation.conversations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id             uuid NOT NULL REFERENCES identity.influencers(id),
  channel_id                uuid NOT NULL REFERENCES publishing.channels(id),
  fan_id                    uuid NOT NULL REFERENCES crm.fans(id),
  external_chat_id          text NOT NULL,
  business_connection_id    text,                -- Telegram Business chats
  mode                      text NOT NULL DEFAULT 'ai_draft' CHECK (mode IN (
                              'ai_auto', 'ai_draft', 'human', 'paused')),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'closed', 'blocked')),
  assigned_user_id          uuid REFERENCES core.users(id),
  ai_disclosed_at           timestamptz,         -- first disclosure (must precede the first AI message)
  last_disclosure_at        timestamptz,         -- periodic re-disclosure tracking
  last_inbound_at           timestamptz,
  last_outbound_at          timestamptz,
  platform_window_expires_at timestamptz,        -- e.g. Instagram standard messaging window
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_chat_id)
);

CREATE TABLE conversation.messages (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  workspace_id         uuid NOT NULL,
  influencer_id        uuid NOT NULL,
  conversation_id      uuid NOT NULL,
  fan_id               uuid NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_type          text NOT NULL CHECK (author_type IN ('fan', 'ai', 'operator', 'system')),
  author_user_id       uuid,
  external_message_id  text,
  kind                 text NOT NULL CHECK (kind IN ('text', 'photo', 'video', 'voice', 'sticker',
                                                     'paid_media', 'invoice', 'disclosure', 'service')),
  body                 text,
  media                jsonb,
  status               text NOT NULL CHECK (status IN ('received', 'drafted', 'pending_approval',
                                                       'approved', 'sent', 'failed', 'suppressed', 'deleted')),
  reply_to_message_id  uuid,
  agent_run_id         uuid,
  guard_result         jsonb,                     -- input/output guard verdicts
  approval_request_id  uuid,
  sent_at              timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE conversation.messages_2026_10 PARTITION OF conversation.messages
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE INDEX messages_conv_time_idx ON conversation.messages (conversation_id, created_at DESC);

-- Dedup of platform message ids across partitions.
CREATE TABLE conversation.message_external_ids (
  channel_id          uuid NOT NULL REFERENCES publishing.channels(id),
  external_message_id text NOT NULL,
  message_id          uuid NOT NULL,
  PRIMARY KEY (channel_id, external_message_id)
);

CREATE TABLE conversation.conversation_summaries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  conversation_id  uuid NOT NULL REFERENCES conversation.conversations(id),
  covers_until     timestamptz NOT NULL,
  summary          text NOT NULL,
  model            text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Long-term memory about a fan, per influencer, consent-bound.
-- MVP decision: special-category data (health, sexual life, religion, etc.)
-- is never stored. The CHECK enforces that until a DPIA plus an explicit-consent
-- flow exist.
CREATE TABLE conversation.fan_memories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id      uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id             uuid NOT NULL REFERENCES crm.fans(id),
  category           text NOT NULL CHECK (category IN ('preference', 'interest', 'personal_detail',
                                                       'boundary', 'content_feedback', 'other')),
  statement          text NOT NULL,
  sensitivity        text NOT NULL DEFAULT 'normal' CHECK (sensitivity = 'normal'),
  consent_id         uuid NOT NULL REFERENCES crm.consents(id),
  source_message_ids uuid[] NOT NULL DEFAULT '{}',
  confidence         numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'rejected', 'deleted')),
  superseded_by      uuid REFERENCES conversation.fan_memories(id),
  expires_at         timestamptz,
  created_by_type    text NOT NULL CHECK (created_by_type IN ('agent', 'user', 'fan')),
  created_by_id      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX fan_memories_lookup_idx ON conversation.fan_memories (influencer_id, fan_id) WHERE status = 'active';

CREATE TABLE conversation.escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id    uuid NOT NULL REFERENCES identity.influencers(id),
  conversation_id  uuid NOT NULL REFERENCES conversation.conversations(id),
  message_id       uuid,
  reason           text NOT NULL CHECK (reason IN (
                     'self_harm_risk', 'minor_signal', 'threat_or_illegal', 'explicit_request',
                     'payment_dispute', 'refund_request', 'complaint', 'legal', 'vulnerability_signal',
                     'agent_uncertain', 'guard_failure', 'human_requested')),
  severity         text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  assigned_user_id uuid REFERENCES core.users(id),
  sla_due_at       timestamptz NOT NULL,
  resolution       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);
CREATE INDEX escalations_open_idx ON conversation.escalations (severity, sla_due_at) WHERE status <> 'resolved';

-- De-identified log of crisis referrals. It supports the companion-chatbot
-- reporting duty (e.g. California SB 243 annual report) without user identifiers.
CREATE TABLE conversation.crisis_referrals (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id     uuid NOT NULL REFERENCES identity.influencers(id),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  channel_kind      text NOT NULL,
  locale            text,
  protocol_version  text NOT NULL,
  resource_shown    text NOT NULL            -- which helpline/resource set was shown
);

-- =============================================================================
-- MONETIZATION (Module E): catalog, orders, payments, subscriptions, entitlements
-- =============================================================================

CREATE TABLE monetization.products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id          uuid NOT NULL REFERENCES identity.influencers(id),
  sku                    text NOT NULL,
  version                int  NOT NULL DEFAULT 1,
  kind                   text NOT NULL CHECK (kind IN ('premium_channel_subscription', 'bot_subscription',
                                                       'paid_media', 'message_pack', 'custom_request',
                                                       'tip', 'bundle')),
  name                   text NOT NULL,
  description            text NOT NULL,
  rail                   text NOT NULL DEFAULT 'telegram_stars' CHECK (rail IN ('telegram_stars')),
  price_stars            bigint NOT NULL CHECK (price_stars > 0),
  billing_period_seconds int,                      -- set for subscriptions only
  -- Entitlement templates, e.g.
  -- [{"kind":"premium_channel_access","channel_id":"…","duration":"billing_period"},
  --  {"kind":"message_credits","quantity":300}]
  grants                 jsonb NOT NULL,
  min_age_status         text NOT NULL DEFAULT 'self_attested_adult',
  content_rating         content_rating NOT NULL DEFAULT 'general',
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'active', 'retired')),
  approved_by            uuid REFERENCES core.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (influencer_id, sku, version),
  CHECK ((kind IN ('premium_channel_subscription', 'bot_subscription')) = (billing_period_seconds IS NOT NULL)),
  CHECK (status <> 'active' OR approved_by IS NOT NULL)
);

CREATE TABLE monetization.offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  product_id          uuid NOT NULL REFERENCES monetization.products(id),
  fan_id              uuid REFERENCES crm.fans(id),      -- NULL = broadcast/channel offer
  channel_id          uuid NOT NULL REFERENCES publishing.channels(id),
  conversation_id     uuid REFERENCES conversation.conversations(id),
  price_stars         bigint NOT NULL CHECK (price_stars > 0),  -- snapshot at offer time
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN (
                        'draft', 'pending_approval', 'sent', 'purchased', 'expired', 'cancelled')),
  invoice_link        text,
  created_by_type     text NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_id       text NOT NULL,
  proposal_id         uuid,
  approval_request_id uuid,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_fan_recent_idx ON monetization.offers (fan_id, created_at DESC);

CREATE TABLE monetization.orders (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id            uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id                   uuid NOT NULL REFERENCES crm.fans(id),
  product_id               uuid NOT NULL REFERENCES monetization.products(id),
  offer_id                 uuid REFERENCES monetization.offers(id),
  price_stars              bigint NOT NULL CHECK (price_stars > 0),
  invoice_payload          text NOT NULL UNIQUE,  -- opaque, HMAC-signed reference; no PII
  status                   text NOT NULL DEFAULT 'created' CHECK (status IN (
                             'created', 'pre_checkout_ok', 'pre_checkout_rejected', 'paid',
                             'refunded', 'expired', 'failed')),
  pre_checkout_answered_at timestamptz,
  paid_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monetization.subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id         uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id                uuid NOT NULL REFERENCES crm.fans(id),
  product_id            uuid NOT NULL REFERENCES monetization.products(id),
  rail                  text NOT NULL CHECK (rail IN ('bot_star_subscription', 'channel_subscription_link')),
  status                text NOT NULL CHECK (status IN ('active', 'cancelled', 'payment_failed',
                                                    'expired', 'refunded', 'suspended')),
  -- 'cancelled'      = will not renew, still inside a paid period.
  -- 'payment_failed' = renewal failed (Bot API 'subscription' update, state 'failed'); grace window applies.
  started_at            timestamptz NOT NULL,
  current_period_start  timestamptz NOT NULL,
  current_period_end    timestamptz NOT NULL,
  auto_renew            boolean NOT NULL DEFAULT true,
  renewal_count         int NOT NULL DEFAULT 0,
  external_ref          text,                     -- charge id of the initial payment
  cancelled_at          timestamptz,
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE UNIQUE INDEX subscriptions_one_live_idx
  ON monetization.subscriptions (fan_id, product_id) WHERE status IN ('active', 'cancelled', 'payment_failed');
CREATE INDEX subscriptions_expiry_idx
  ON monetization.subscriptions (current_period_end) WHERE status IN ('active', 'cancelled', 'payment_failed');

CREATE TABLE monetization.payments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id               uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id                      uuid NOT NULL REFERENCES crm.fans(id),
  order_id                    uuid REFERENCES monetization.orders(id),
  subscription_id             uuid REFERENCES monetization.subscriptions(id),
  kind                        text NOT NULL CHECK (kind IN ('one_time', 'subscription_initial',
                                                            'subscription_renewal', 'paid_media_purchase')),
  currency                    text NOT NULL DEFAULT 'XTR' CHECK (currency = 'XTR'),
  amount_stars                bigint NOT NULL CHECK (amount_stars > 0),
  -- Unique business key for dedup: charge id for invoices; for paid-media
  -- purchase updates (which may carry no charge id) a derived key.
  external_dedup_key          text NOT NULL UNIQUE,
  telegram_payment_charge_id  text UNIQUE,
  is_recurring                boolean,
  is_first_recurring          boolean,
  subscription_expiration_at  timestamptz,
  raw                         jsonb NOT NULL,     -- the SuccessfulPayment / purchase object (no PII beyond ids)
  received_at                 timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_fan_idx ON monetization.payments (fan_id, received_at DESC);
CREATE INDEX payments_influencer_time_idx ON monetization.payments (influencer_id, received_at);

CREATE TABLE monetization.refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES core.workspaces(id),
  payment_id            uuid NOT NULL REFERENCES monetization.payments(id),
  amount_stars          bigint NOT NULL CHECK (amount_stars > 0),
  reason                text NOT NULL,
  requested_by          text NOT NULL CHECK (requested_by IN ('fan', 'operator', 'system', 'platform')),
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN (
                          'requested', 'pending_approval', 'processing', 'completed', 'failed', 'rejected')),
  approval_request_id   uuid,
  external_operation_id uuid REFERENCES core.external_operations(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);
CREATE UNIQUE INDEX refunds_one_completed_idx ON monetization.refunds (payment_id) WHERE status = 'completed';

-- Single source of truth for "who may access what".
CREATE TABLE monetization.entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id    uuid NOT NULL REFERENCES identity.influencers(id),
  fan_id           uuid NOT NULL REFERENCES crm.fans(id),
  kind             text NOT NULL CHECK (kind IN ('premium_channel_access', 'bot_premium_tier',
                                                 'media_unlock', 'custom_request')),
  resource_type    text NOT NULL,                 -- 'channel' | 'content_item' | 'tier'
  resource_id      uuid NOT NULL,
  source_type      text NOT NULL CHECK (source_type IN ('subscription', 'order', 'grant', 'promo', 'compensation')),
  source_id        uuid NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  valid_from       timestamptz NOT NULL,
  valid_until      timestamptz,                   -- NULL = perpetual (e.g. purchased media)
  granted_by_type  text NOT NULL CHECK (granted_by_type IN ('system', 'user')),
  granted_by_id    text NOT NULL,
  revoked_at       timestamptz,
  revoke_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  -- No overlapping active grants for the same fan/resource from the same source.
  EXCLUDE USING gist (
    fan_id WITH =, kind WITH =, resource_id WITH =, source_id WITH =,
    tstzrange(valid_from, valid_until) WITH &&
  ) WHERE (status = 'active')
);
CREATE INDEX entitlements_check_idx ON monetization.entitlements (fan_id, kind, resource_id) WHERE status = 'active';
CREATE INDEX entitlements_expiry_idx ON monetization.entitlements (valid_until) WHERE status = 'active';

-- Consumable credits (paid chat messages). Balance row + immutable ledger.
CREATE TABLE monetization.credit_balances (
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id        uuid NOT NULL REFERENCES crm.fans(id),
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  balance       int  NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (fan_id, influencer_id)
);

-- Daily free/premium reply allowance usage (persistent; formerly a cache counter).
CREATE TABLE monetization.daily_allowances (
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id        uuid NOT NULL REFERENCES crm.fans(id),
  influencer_id uuid NOT NULL REFERENCES identity.influencers(id),
  day           date NOT NULL,                    -- in the persona's timezone
  used          int  NOT NULL DEFAULT 0 CHECK (used >= 0),
  daily_limit   int  NOT NULL CHECK (daily_limit >= 0),   -- may be lowered intra-day by load shedding
  PRIMARY KEY (fan_id, influencer_id, day)
  -- consumption is atomic: UPDATE … SET used = used + 1 WHERE used < daily_limit RETURNING …
);

CREATE TABLE monetization.credit_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES core.workspaces(id),
  fan_id          uuid NOT NULL REFERENCES crm.fans(id),
  influencer_id   uuid NOT NULL REFERENCES identity.influencers(id),
  delta           int  NOT NULL CHECK (delta <> 0),
  balance_after   int  NOT NULL CHECK (balance_after >= 0),
  reason          text NOT NULL CHECK (reason IN ('purchase', 'consumption', 'refund_reversal',
                                                  'grant', 'expiry', 'correction')),
  ref_type        text NOT NULL,
  ref_id          uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,           -- e.g. 'consume:<message_id>'
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monetization.invite_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES core.workspaces(id),
  channel_id               uuid NOT NULL REFERENCES publishing.channels(id),
  fan_id                   uuid REFERENCES crm.fans(id),
  entitlement_id           uuid REFERENCES monetization.entitlements(id),
  kind                     text NOT NULL CHECK (kind IN ('join_request', 'subscription', 'single_use', 'public')),
  invite_link              text NOT NULL UNIQUE,
  name                     text,
  expires_at               timestamptz,
  member_limit             int,
  subscription_price_stars bigint,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz
);

CREATE TABLE monetization.channel_memberships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  channel_id         uuid NOT NULL REFERENCES publishing.channels(id),
  fan_id             uuid REFERENCES crm.fans(id),
  telegram_user_id   bigint NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending_request', 'member', 'left', 'removed', 'banned')),
  invite_link_id     uuid REFERENCES monetization.invite_links(id),
  joined_at          timestamptz,
  left_at            timestamptz,
  removed_reason     text,
  last_verified_at   timestamptz,                 -- last getChatMember check
  UNIQUE (channel_id, telegram_user_id)
);

-- Mirror of getStarTransactions for reconciliation against payments/refunds.
CREATE TABLE monetization.star_transactions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  integration_account_id uuid NOT NULL REFERENCES core.integration_accounts(id),
  external_tx_id         text NOT NULL,
  amount_stars           bigint NOT NULL,
  nanostar_amount        int,
  direction              text NOT NULL CHECK (direction IN ('in', 'out')),
  partner                jsonb,                   -- source/receiver partner object
  occurred_at            timestamptz NOT NULL,
  matched_payment_id     uuid REFERENCES monetization.payments(id),
  matched_refund_id      uuid REFERENCES monetization.refunds(id),
  match_status           text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('matched', 'unmatched', 'ignored')),
  synced_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_account_id, external_tx_id)
);

-- Realized fiat only exists when Stars are withdrawn (recorded by finance).
CREATE TABLE monetization.payouts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  integration_account_id uuid REFERENCES core.integration_accounts(id),
  channel_id             uuid REFERENCES publishing.channels(id),
  initiated_at           timestamptz NOT NULL,
  completed_at           timestamptz,
  stars_amount           bigint NOT NULL CHECK (stars_amount > 0),
  crypto_asset           text,                    -- e.g. 'TON'
  crypto_amount          numeric(30, 9),
  fiat_currency          char(3),
  fiat_realized          numeric(14, 2),
  fees_fiat              numeric(14, 2),
  tx_ref                 text,
  status                 text NOT NULL CHECK (status IN ('initiated', 'completed', 'failed')),
  recorded_by            uuid NOT NULL REFERENCES core.users(id),
  notes                  text
);

-- Valuation used ONLY for estimated fiat reporting. It is never treated as a
-- fixed exchange rate. Every estimate records which valuation produced it.
CREATE TABLE monetization.star_valuations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid REFERENCES core.workspaces(id),
  effective_date  date NOT NULL,
  fiat_currency   char(3) NOT NULL DEFAULT 'USD',
  fiat_per_star   numeric(14, 8) NOT NULL CHECK (fiat_per_star > 0),
  method          text NOT NULL CHECK (method IN ('realized_payouts_trailing_90d', 'platform_quoted_rate', 'finance_manual')),
  source_ref      text,
  created_by      uuid REFERENCES core.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- ANALYTICS (Module G): metrics, events, KPIs, costs, budgets, experiments
-- =============================================================================

CREATE TABLE analytics.metric_snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  workspace_id  uuid NOT NULL,
  influencer_id uuid NOT NULL,
  channel_id    uuid,
  subject_type  text NOT NULL CHECK (subject_type IN ('account', 'publication', 'channel', 'story')),
  subject_ref   text NOT NULL,
  metric        text NOT NULL,                    -- platform metric name as returned
  value         numeric NOT NULL,
  period        text NOT NULL CHECK (period IN ('lifetime', 'day', 'week', 'days_28')),
  period_end    date,
  source        text NOT NULL CHECK (source IN ('instagram_insights', 'telegram_bot_api', 'internal')),
  PRIMARY KEY (id, captured_at)
) PARTITION BY RANGE (captured_at);
CREATE TABLE analytics.metric_snapshots_2026_10 PARTITION OF analytics.metric_snapshots
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Product/funnel events (pseudonymous fan_id; never message bodies).
CREATE TABLE analytics.events (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL,
  workspace_id  uuid NOT NULL,
  influencer_id uuid,
  fan_id        uuid,
  name          text NOT NULL,                    -- e.g. 'bot_started', 'offer_shown', 'invoice_opened', 'paid'
  properties    jsonb NOT NULL DEFAULT '{}',
  source        text NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE analytics.events_2026_10 PARTITION OF analytics.events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

-- Vendor price book (versioned). Costs are computed at event time from the
-- price effective then, and reconciled monthly against invoices.
CREATE TABLE analytics.price_book (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,
  model          text NOT NULL,
  unit           text NOT NULL CHECK (unit IN ('gpu_second', 'kwh', 'gb_month', 'gb_egress',
                                               'month', 'request',
                                               -- retained for optional future paid providers:
                                               'input_mtok', 'output_mtok', 'image', 'video_second')),
  unit_price_usd numeric(14, 8) NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  source_url     text NOT NULL,
  verified_by    uuid REFERENCES core.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Every billable AI/infra call. Coverage target: >=99% of vendor spend.
CREATE TABLE analytics.usage_events (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at         timestamptz NOT NULL,
  workspace_id        uuid NOT NULL,
  influencer_id       uuid,                        -- NULL = shared/platform overhead (allocated later)
  category            text NOT NULL CHECK (category IN ('llm', 'vlm', 'guard', 'image_generation',
                                                        'video_generation', 'adapter_training', 'moderation',
                                                        'face_check', 'embedding', 'storage', 'egress',
                                                        'telegram_paid_broadcast', 'other')),
  provider            text NOT NULL,
  model               text,
  operation           text NOT NULL,              -- e.g. 'conversation.reply', 'agent.content_strategist'
  quantities          jsonb NOT NULL,             -- {"gpu_seconds":…, "energy_wh":…, "prompt_tokens":…, "completion_tokens":…, "images":…}
  cost_usd            numeric(14, 6) NOT NULL,
  price_book_ids      uuid[] NOT NULL DEFAULT '{}',
  agent_run_id        uuid,
  generation_job_id   uuid,
  conversation_id     uuid,
  message_id          uuid,
  external_request_id text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE analytics.usage_events_2026_10 PARTITION OF analytics.usage_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX usage_events_inf_time_idx ON analytics.usage_events (influencer_id, occurred_at);

CREATE TABLE analytics.budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id uuid REFERENCES identity.influencers(id),
  scope         text NOT NULL CHECK (scope IN ('llm', 'media', 'total')),
  period        text NOT NULL CHECK (period IN ('day', 'month')),
  limit_usd     numeric(12, 2) NOT NULL CHECK (limit_usd > 0),
  warn_at_pct   smallint NOT NULL DEFAULT 80,
  hard_action   text NOT NULL CHECK (hard_action IN ('alert_only', 'block_noncritical', 'block_all')),
  created_by    uuid REFERENCES core.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics.daily_influencer_kpis (
  workspace_id               uuid NOT NULL,
  influencer_id              uuid NOT NULL,
  kpi_date                   date NOT NULL,
  ig_followers               int,
  ig_reach                   int,
  ig_engagements             int,
  tg_public_members          int,
  tg_premium_members         int,
  bot_active_users           int,
  new_fans                   int,
  messages_inbound           int,
  messages_ai                int,
  messages_human             int,
  revenue_stars              bigint NOT NULL DEFAULT 0,
  refunds_stars              bigint NOT NULL DEFAULT 0,
  purchases                  int NOT NULL DEFAULT 0,
  new_subscriptions          int NOT NULL DEFAULT 0,
  renewals                   int NOT NULL DEFAULT 0,
  churned_subscriptions      int NOT NULL DEFAULT 0,
  active_subscribers         int NOT NULL DEFAULT 0,
  free_to_paid_conversions   int NOT NULL DEFAULT 0,
  llm_cost_usd               numeric(12, 4) NOT NULL DEFAULT 0,
  media_cost_usd             numeric(12, 4) NOT NULL DEFAULT 0,
  other_variable_cost_usd    numeric(12, 4) NOT NULL DEFAULT 0,
  allocated_fixed_cost_usd   numeric(12, 4) NOT NULL DEFAULT 0,
  est_revenue_fiat           numeric(12, 4),      -- revenue_stars x valuation (estimate)
  star_valuation_id          uuid REFERENCES monetization.star_valuations(id),
  est_contribution_margin    numeric(12, 4),      -- est_revenue_fiat - variable costs
  computed_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (influencer_id, kpi_date)
);

CREATE TABLE analytics.experiments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  key                 text NOT NULL,
  hypothesis          text NOT NULL,
  primary_metric      text NOT NULL,
  guardrail_metrics   text[] NOT NULL DEFAULT '{}',
  variants            jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN (
                        'draft', 'pending_approval', 'running', 'stopped', 'concluded')),
  approval_request_id uuid,
  started_at          timestamptz,
  ended_at            timestamptz,
  result              jsonb,
  UNIQUE (influencer_id, key)
);

CREATE TABLE analytics.experiment_assignments (
  experiment_id uuid NOT NULL REFERENCES analytics.experiments(id),
  fan_id        uuid NOT NULL REFERENCES crm.fans(id),
  variant       text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, fan_id)
);

-- =============================================================================
-- AGENTS (Module H): definitions, autonomy policies, tasks, runs, proposals
-- =============================================================================

CREATE TABLE agents.agent_definitions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid REFERENCES core.workspaces(id),   -- NULL = platform default
  key                      text NOT NULL CHECK (key IN (
                             'influencer_manager', 'content_strategist', 'media_production',
                             'social_media', 'conversation', 'community', 'monetization',
                             'analytics', 'qa_compliance')),
  version                  int  NOT NULL,
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'evaluating', 'shadow', 'active', 'retired')),
  model                    text NOT NULL,
  effort                   text NOT NULL,
  system_prompt_template_id uuid NOT NULL REFERENCES content.prompt_templates(id),
  tools                    jsonb NOT NULL,        -- allowlist: read tools + proposal tools, with schema versions
  output_schema            jsonb NOT NULL,        -- JSON Schema for structured output
  allowed_action_types     text[] NOT NULL,
  max_autonomy_level       smallint NOT NULL CHECK (max_autonomy_level BETWEEN 0 AND 4),
  budgets                  jsonb NOT NULL,        -- {"per_run_usd":…, "per_day_usd":…, "max_steps":…, "timeout_s":…}
  eval_report_ref          text,
  approved_by              uuid REFERENCES core.users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (workspace_id, key, version),
  CHECK (status NOT IN ('shadow', 'active') OR approved_by IS NOT NULL)
);

-- Effective autonomy = min(agent max, matching policy level, kill switches, risk overrides).
CREATE TABLE agents.autonomy_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id          uuid REFERENCES identity.influencers(id),
  action_type            text NOT NULL,           -- e.g. 'conversation.send_reply', 'publication.publish'
  agent_key              text,
  level                  smallint NOT NULL CHECK (level BETWEEN 0 AND 4),
  conditions             jsonb NOT NULL DEFAULT '{}',  -- max_per_day, max_rating, min_confidence, segments, quiet hours
  required_approver_role text,
  required_approvals     smallint NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 3),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  approved_by            uuid REFERENCES core.users(id),
  effective_from         timestamptz NOT NULL DEFAULT now(),
  effective_to           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR approved_by IS NOT NULL)
);

CREATE TABLE agents.tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id     uuid NOT NULL REFERENCES identity.influencers(id),
  agent_key         text NOT NULL,
  task_type         text NOT NULL,
  input             jsonb NOT NULL,
  priority          smallint NOT NULL DEFAULT 3,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
                      'queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'dead_lettered')),
  parent_task_id    uuid REFERENCES agents.tasks(id),
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system', 'schedule')),
  requested_by_id   text NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  scheduled_for     timestamptz,
  deadline_at       timestamptz,
  attempts          int NOT NULL DEFAULT 0,
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents.runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  task_id             uuid REFERENCES agents.tasks(id),
  agent_definition_id uuid NOT NULL REFERENCES agents.agent_definitions(id),
  mode                text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'shadow', 'eval')),
  model               text NOT NULL,
  effort              text NOT NULL,
  status              text NOT NULL DEFAULT 'running' CHECK (status IN (
                        'running', 'succeeded', 'failed', 'timed_out', 'budget_exceeded',
                        'invalid_output', 'refused')),
  stop_reason         text,
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  cache_read_tokens   int NOT NULL DEFAULT 0,
  cache_write_tokens  int NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 6) NOT NULL DEFAULT 0,
  transcript_ref      text,                      -- full request/response transcript in object storage
  error               jsonb,
  trace_id            text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz
);
CREATE INDEX runs_task_idx ON agents.runs (task_id);

CREATE TABLE agents.run_steps (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES agents.runs(id),
  seq         int  NOT NULL,
  step_type   text NOT NULL CHECK (step_type IN ('model_call', 'tool_call', 'tool_result', 'guard', 'policy_eval')),
  tool_name   text,
  input       jsonb,
  output      jsonb,
  latency_ms  int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE agents.action_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id       uuid NOT NULL REFERENCES identity.influencers(id),
  run_id              uuid NOT NULL REFERENCES agents.runs(id),
  agent_key           text NOT NULL,
  action_type         text NOT NULL,
  payload             jsonb NOT NULL,
  payload_hash        bytea NOT NULL,
  rationale           text NOT NULL,
  confidence          numeric(3, 2) CHECK (confidence BETWEEN 0 AND 1),
  risk_level          text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  evidence            jsonb NOT NULL DEFAULT '[]',  -- refs to the data the decision used
  resolved_level      smallint CHECK (resolved_level BETWEEN 0 AND 4),
  policy_decision     text NOT NULL CHECK (policy_decision IN ('allow', 'require_approval', 'deny')),
  policy_trace        jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'awaiting_approval', 'approved', 'rejected', 'executed',
                        'execution_failed', 'expired', 'denied')),
  approval_request_id uuid,
  executed_at         timestamptz,
  execution_ref       text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_status_idx ON agents.action_proposals (influencer_id, status, created_at DESC);

CREATE TABLE agents.eval_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_definition_id uuid NOT NULL REFERENCES agents.agent_definitions(id),
  suite_key           text NOT NULL,
  suite_version       text NOT NULL,
  cases               int NOT NULL,
  passed              int NOT NULL,
  critical_failures   int NOT NULL DEFAULT 0,
  metrics             jsonb NOT NULL DEFAULT '{}',
  report_ref          text,
  triggered_by        text NOT NULL,
  run_at              timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- APPROVALS (Module I): approval requests bound to payload hashes, QA, incidents
-- =============================================================================

CREATE TABLE approvals.approval_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id      uuid REFERENCES identity.influencers(id),
  subject_type       text NOT NULL,              -- 'content_revision', 'offer', 'refund', 'product', 'reply', …
  subject_id         uuid NOT NULL,
  action_type        text NOT NULL,
  risk_level         text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  payload_snapshot   jsonb NOT NULL,             -- exactly what will be executed
  payload_hash       bytea NOT NULL,
  requested_by_type  text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system')),
  requested_by_id    text NOT NULL,
  proposal_id        uuid REFERENCES agents.action_proposals(id),
  required_role      text NOT NULL,
  required_approvals smallint NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 3),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'approved', 'rejected', 'changes_requested', 'expired',
                       'cancelled', 'superseded')),
  superseded_by      uuid REFERENCES approvals.approval_requests(id),
  priority           smallint NOT NULL DEFAULT 3,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz
);
CREATE INDEX approval_queue_idx ON approvals.approval_requests (workspace_id, status, priority, created_at)
  WHERE status = 'pending';

-- Edits never mutate an approved payload: an edit produces a new revision and a
-- new request, and the old request becomes 'superseded'. The application
-- enforces requester != approver; a trigger enforces it as a backstop.
CREATE TABLE approvals.approval_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES core.workspaces(id),
  approval_request_id uuid NOT NULL REFERENCES approvals.approval_requests(id),
  approver_user_id    uuid NOT NULL REFERENCES core.users(id),
  decision            text NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes')),
  payload_hash_seen   bytea NOT NULL,            -- must equal request.payload_hash
  comment             text,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_request_id, approver_user_id)
);

CREATE TABLE approvals.qa_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id    uuid NOT NULL REFERENCES identity.influencers(id),
  subject_type     text NOT NULL,
  subject_id       uuid NOT NULL,
  action_type      text NOT NULL,
  sample_reason    text NOT NULL CHECK (sample_reason IN ('random', 'risk_flagged', 'new_agent_version',
                                                          'complaint', 'shadow_comparison')),
  reviewer_type    text NOT NULL CHECK (reviewer_type IN ('user', 'agent')),
  reviewer_id      text NOT NULL,
  verdict          text NOT NULL CHECK (verdict IN ('pass', 'minor', 'major', 'critical')),
  issues           jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qa_reviews_action_idx ON approvals.qa_reviews (influencer_id, action_type, created_at DESC);

CREATE TABLE approvals.incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id  uuid REFERENCES identity.influencers(id),
  severity       text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  category       text NOT NULL CHECK (category IN ('policy_violation', 'safety', 'data_protection',
                                                   'payment', 'platform_enforcement', 'availability', 'security')),
  title          text NOT NULL,
  description    text NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigated', 'resolved', 'postmortem_done')),
  detected_by    text NOT NULL,
  related_refs   jsonb NOT NULL DEFAULT '[]',
  opened_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  postmortem_ref text
);

-- =============================================================================
-- INFERENCE RUNTIME (platform-level): nodes, workflows, GPU modes, GPU job queue
-- =============================================================================

CREATE TABLE inference.gpu_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,            -- e.g. 'ws-01'
  gpu_name        text NOT NULL,
  vram_total_mb   int  NOT NULL,
  capabilities    text[] NOT NULL,                 -- job classes this node accepts: '{I,N,B,H,A,T}'
  current_mode    text,
  status          text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'draining', 'safe', 'offline')),
  last_heartbeat  timestamptz
);

-- Versioned ComfyUI workflow templates (API format) with measured profiles.
CREATE TABLE inference.workflows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   text NOT NULL,             -- e.g. 'img.portrait.v', 'vid.i2v.v'
  version               int  NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('image_gen', 'image_edit', 'upscale', 'detail',
                                                      'video_gen', 'lipsync', 'lora_train')),
  graph                 jsonb NOT NULL,            -- ComfyUI API-format graph
  param_bindings        jsonb NOT NULL,            -- which node inputs receive prompt/seed/LoRA/refs/size
  required_model_ids    uuid[] NOT NULL,
  custom_nodes_lock     text NOT NULL,             -- hash of the pinned custom-node set
  degradation_profiles  jsonb NOT NULL DEFAULT '[]',  -- OOM ladder steps (docs/13 §6.6)
  allowed_modes         text[] NOT NULL,           -- e.g. '{S,M}'
  measured_peak_vram_mb int,                       -- B-IMG-1 / B-VID-1
  measured_p50_s        numeric,                   -- B-IMG-2 / B-VID-2 (sustained)
  measured_p95_s        numeric,
  benchmark_run_id      uuid,
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'benchmarked', 'approved', 'retired')),
  approved_by           uuid REFERENCES core.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND measured_peak_vram_mb IS NOT NULL))
);

CREATE TABLE inference.gpu_modes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id               uuid NOT NULL REFERENCES inference.gpu_nodes(id),
  name                  text NOT NULL CHECK (name IN ('S', 'M', 'T', 'Safe')),
  version               int  NOT NULL,
  chat_model_id         uuid REFERENCES inference.models(id),
  chat_kv_budget_mb     int,
  chat_admitted_concurrency int,                   -- b* for this mode (B-LLM-3)
  comfy_reserve_vram_mb int,
  media_budget_mb       int,
  allowed_classes       text[] NOT NULL,
  max_duration_min      int,
  windows               jsonb NOT NULL DEFAULT '[]',   -- scheduled windows (persona-traffic aware)
  enter_exit_thresholds jsonb NOT NULL DEFAULT '{}',   -- λ thresholds with hysteresis
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  approved_by           uuid REFERENCES core.users(id),
  UNIQUE (node_id, name, version),
  -- A mode cannot be active with unmeasured (NULL) sizing parameters.
  CHECK (status <> 'active' OR (approved_by IS NOT NULL AND chat_model_id IS NOT NULL
                                AND chat_kv_budget_mb IS NOT NULL AND chat_admitted_concurrency IS NOT NULL
                                AND comfy_reserve_vram_mb IS NOT NULL AND media_budget_mb IS NOT NULL))
);

CREATE TABLE inference.mode_transitions (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id               uuid NOT NULL REFERENCES inference.gpu_nodes(id),
  from_mode             text NOT NULL,
  to_mode               text NOT NULL,
  reason                text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  jobs_interrupted      int NOT NULL DEFAULT 0,
  chat_requests_delayed int NOT NULL DEFAULT 0,
  holding_messages_sent int NOT NULL DEFAULT 0,
  success               boolean
);

-- Persistent GPU job queue (classes N, B, H, A, T). Chat (class I) is admitted
-- in-process from the conversation queue (docs/13 §6.3).
CREATE TABLE inference.gpu_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid REFERENCES core.workspaces(id),        -- NULL for platform jobs (benchmarks)
  influencer_id     uuid REFERENCES identity.influencers(id),
  node_id           uuid REFERENCES inference.gpu_nodes(id),     -- set on lease
  job_class         char(1) NOT NULL CHECK (job_class IN ('N', 'B', 'H', 'A', 'T')),
  kind              text NOT NULL CHECK (kind IN ('image_gen', 'image_edit', 'upscale', 'detail', 'video_gen',
                                                  'lipsync', 'vlm_validate', 'embed_batch', 'agent_run',
                                                  'memory_extract', 'lora_train', 'benchmark', 'eval')),
  workflow_id       uuid REFERENCES inference.workflows(id),
  model_ids         uuid[] NOT NULL DEFAULT '{}',
  subject_type      text,                                        -- e.g. 'generation_job', 'agent_task'
  subject_id        uuid,
  priority          smallint NOT NULL DEFAULT 3,
  due_at            timestamptz,
  est_vram_mb       int NOT NULL,
  est_gpu_seconds   numeric(12, 3) NOT NULL,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
                      'queued', 'leased', 'running', 'succeeded', 'failed_retryable',
                      'preempted', 'dead', 'cancelled')),
  attempts          int NOT NULL DEFAULT 0,
  max_attempts      int NOT NULL DEFAULT 4,
  degradation_step  smallint NOT NULL DEFAULT 0,
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,
  input             jsonb NOT NULL,
  output            jsonb,
  gpu_seconds       numeric(12, 3),
  energy_wh         numeric(12, 4),
  peak_vram_mb      int,
  error             jsonb,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system', 'schedule')),
  requested_by_id   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  CHECK (attempts <= max_attempts)
);
CREATE INDEX gpu_jobs_ready_idx ON inference.gpu_jobs (job_class, priority, due_at) WHERE status = 'queued';
CREATE INDEX gpu_jobs_inflight_idx ON inference.gpu_jobs (heartbeat_at) WHERE status IN ('leased', 'running');
CREATE INDEX gpu_jobs_persona_day_idx ON inference.gpu_jobs (influencer_id, finished_at) WHERE status = 'succeeded';

ALTER TABLE content.generation_jobs
  ADD CONSTRAINT generation_jobs_gpu_job_fk FOREIGN KEY (gpu_job_id) REFERENCES inference.gpu_jobs(id);
ALTER TABLE identity.model_adapters
  ADD CONSTRAINT model_adapters_training_job_fk FOREIGN KEY (training_gpu_job_id) REFERENCES inference.gpu_jobs(id);
ALTER TABLE identity.persona_runtime_config
  ADD CONSTRAINT persona_runtime_adapter_fk FOREIGN KEY (identity_adapter_id) REFERENCES identity.model_adapters(id);

-- =============================================================================
-- OPS (platform-level): benchmarks, capacity, telemetry rollups, energy, costs
-- =============================================================================

CREATE TABLE ops.environment_fingerprints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       uuid REFERENCES inference.gpu_nodes(id),
  captured_at   timestamptz NOT NULL DEFAULT now(),
  fingerprint   jsonb NOT NULL,                  -- docs/14 §1: hardware, driver, engines, power mode, …
  fingerprint_hash text NOT NULL,
  complete      boolean NOT NULL                 -- incomplete fingerprints cannot satisfy gates
);

CREATE TABLE ops.benchmark_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite           text NOT NULL,                 -- e.g. 'llm', 'image', 'video', 'thermal', 'fail', 'quality'
  test_id         text NOT NULL,                 -- e.g. 'B-LLM-3', 'Q-CHAT-1'
  environment_id  uuid NOT NULL REFERENCES ops.environment_fingerprints(id),
  subject_key     text,                          -- model or workflow key + version
  params          jsonb NOT NULL,
  metrics         jsonb NOT NULL,                -- {"p50":…, "p95":…, "throughput":…, "peak_vram_mb":…, "n":…, "cv":…}
  raw_ref         text NOT NULL,                 -- bench/results/<run_id>/
  git_sha         text NOT NULL,
  operator        uuid REFERENCES core.users(id),
  valid           boolean NOT NULL,              -- false if CV/repetition rules not met
  passed          boolean,                       -- for pass/fail tests (drills, quality)
  run_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX benchmark_runs_latest_idx ON ops.benchmark_runs (test_id, subject_key, run_at DESC) WHERE valid;

-- Capacity worksheet snapshots (docs/13 §7.4), generated from the latest valid runs.
CREATE TABLE ops.capacity_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             uuid NOT NULL REFERENCES inference.gpu_nodes(id),
  computed_at         timestamptz NOT NULL DEFAULT now(),
  inputs              jsonb NOT NULL,            -- every parameter with its benchmark_run_id
  g_day_media_s       numeric,
  d_persona_s         jsonb,                     -- per tier
  n_max               jsonb,                     -- per tier
  chat_b_star         int,
  chat_mu_star        numeric,
  chat_a_max          numeric,
  chat_daf_max        numeric,
  rollout_stage       smallint NOT NULL
);

CREATE TABLE ops.gpu_daily (
  node_id               uuid NOT NULL REFERENCES inference.gpu_nodes(id),
  day                   date NOT NULL,
  busy_seconds          jsonb NOT NULL,          -- per job class
  utilization_by_mode   jsonb NOT NULL,          -- U_mode observed
  throttle_seconds      int NOT NULL,
  max_temp_c            numeric,
  energy_kwh_gpu_est    numeric,                 -- NVML power integration
  oom_count             int NOT NULL DEFAULT 0,
  engine_restarts       int NOT NULL DEFAULT 0,
  mode_transitions      int NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, day)
);

-- Wall-socket energy readings (smart plug) — the measured basis for energy cost.
CREATE TABLE ops.energy_readings (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id         uuid REFERENCES inference.gpu_nodes(id),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  kwh             numeric(12, 4) NOT NULL CHECK (kwh >= 0),
  source          text NOT NULL CHECK (source IN ('smart_plug', 'utility_meter', 'manual')),
  tariff_per_kwh  numeric(10, 5) NOT NULL,
  currency        char(3) NOT NULL,
  evidence_ref    text,
  CHECK (period_end > period_start)
);

-- Measured monthly operating costs (docs/12): every line has evidence.
CREATE TABLE ops.cost_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period          date NOT NULL,                 -- first day of month
  category        text NOT NULL CHECK (category IN ('electricity', 'connectivity', 'backup_storage',
                                                    'phone_numbers', 'domain_dns', 'monitoring',
                                                    'hardware_amortization', 'hardware_reserve',
                                                    'software', 'other')),
  amount          numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency        char(3) NOT NULL,
  basis           text NOT NULL,                 -- invoice, kWh x tariff, straight-line amortization
  evidence_ref    text NOT NULL,                 -- invoice id / energy_readings range / asset record
  allocation_rule text NOT NULL DEFAULT 'gpu_seconds',   -- how it is attributed to personas
  recorded_by     uuid REFERENCES core.users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, category, evidence_ref)
);

-- Takedown / likeness / NCII complaints (48-hour handling target).
CREATE TABLE approvals.takedown_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES core.workspaces(id),
  influencer_id    uuid REFERENCES identity.influencers(id),
  received_via     text NOT NULL CHECK (received_via IN ('email', 'telegram', 'instagram', 'platform_notice', 'other')),
  claimant_ref     text NOT NULL,             -- contact reference, stored encrypted elsewhere if personal
  reason           text NOT NULL CHECK (reason IN ('likeness_real_person', 'intimate_imagery', 'copyright',
                                                   'trademark', 'privacy', 'other')),
  content_refs     jsonb NOT NULL,            -- publications / media assets concerned
  status           text NOT NULL DEFAULT 'received' CHECK (status IN (
                     'received', 'content_restricted', 'under_review', 'removed', 'rejected')),
  received_at      timestamptz NOT NULL DEFAULT now(),
  due_at           timestamptz NOT NULL,      -- received_at + 48h
  actioned_at      timestamptz,
  decided_by       uuid REFERENCES core.users(id),
  notes            text
);

-- =============================================================================
-- ROW-LEVEL SECURITY (defense in depth for tenant isolation)
-- 'inference' and 'ops' are platform-level schemas operated by the Inference
-- Host and ops tooling (separate DB roles); they hold no fan data. Tenant
-- isolation for generated media is enforced when outputs are registered into
-- the tenant-scoped content tables.
-- The application sets: SET LOCAL app.workspace_id = '<uuid>' per transaction.
-- The application role is created NOBYPASSRLS. Migrations run as the owner role.
-- =============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'workspace_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('identity', 'content', 'publishing', 'conversation', 'crm',
                             'monetization', 'analytics', 'agents', 'approvals')
      AND c.table_name NOT LIKE '%\_20__\___'   -- partitions inherit from the parent
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I
         USING (workspace_id = current_setting(''app.workspace_id'')::uuid)
         WITH CHECK (workspace_id = current_setting(''app.workspace_id'')::uuid)',
      r.table_schema, r.table_name);
  END LOOP;
END $$;

-- Roles and grants (illustrative):
--   CREATE ROLE app_rw NOBYPASSRLS LOGIN;  -- API and workers
--   CREATE ROLE app_ro NOBYPASSRLS LOGIN;  -- dashboard read replica / analytics
--   GRANT INSERT, SELECT ON core.audit_log TO app_rw;   -- no UPDATE/DELETE/TRUNCATE
--   REVOKE UPDATE, DELETE, TRUNCATE ON core.audit_log FROM app_rw;
--   Same append-only treatment for monetization.payments, monetization.credit_ledger,
--   approvals.approval_decisions.
