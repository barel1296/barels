-- 004: recommendations, actions, approvals, approval policies, guardrail
-- policies, executions.

CREATE TABLE recommendations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  session_id           uuid REFERENCES agent_sessions(id),
  playbook_key         text,
  title                text NOT NULL,
  summary              text NOT NULL,
  category             text NOT NULL,        -- budget|creative|structure|tracking|crm|aso|product
  confidence           numeric(3,2) NOT NULL,
  confidence_breakdown jsonb NOT NULL DEFAULT '{}',
  predicted_impact     jsonb,                -- {metric, low, mid, high, horizonDays, basisEvidenceIds}
  evidence_ids         uuid[] NOT NULL DEFAULT '{}',
  status               text NOT NULL DEFAULT 'proposed',
    -- proposed|approved|rejected|expired|superseded|realized|dismissed
  rejection            jsonb,
  outcome              jsonb,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON recommendations (tenant_id, status, created_at DESC);

CREATE TABLE actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  recommendation_id uuid REFERENCES recommendations(id),
  session_id        uuid REFERENCES agent_sessions(id),
  kind              text NOT NULL,
  target            jsonb NOT NULL DEFAULT '{}',  -- {integrationId, entityType, entityId}
  diff              jsonb NOT NULL,               -- exact before -> after
  diff_hash         text NOT NULL,                -- sha256 of canonical diff JSON
  payload           jsonb NOT NULL DEFAULT '{}',
  execution_plan    jsonb NOT NULL DEFAULT '{}',
  rollback_plan     jsonb NOT NULL,               -- REQUIRED: action invalid without it
  monitoring_plan   jsonb NOT NULL,               -- REQUIRED: watch metrics + revert thresholds
  guardrail_eval    jsonb NOT NULL DEFAULT '[]',
  dry_run           jsonb,
  autonomy_level    int NOT NULL DEFAULT 2,
  version           int NOT NULL DEFAULT 1,
  supersedes        uuid REFERENCES actions(id),
  status            text NOT NULL DEFAULT 'draft',
  idempotency_key   text UNIQUE NOT NULL,
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON actions (tenant_id, status, created_at DESC);

-- Only one in-flight (awaiting/approved/executing) action per target entity.
CREATE UNIQUE INDEX actions_one_in_flight_per_target
  ON actions (tenant_id, (target ->> 'entityId'))
  WHERE status IN ('awaiting_approval', 'approved', 'executing');

CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  action_id       uuid NOT NULL REFERENCES actions(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  decision        text NOT NULL,              -- approve|reject|request_changes
  reason_code     text,
  note            text,
  via             text NOT NULL DEFAULT 'web',
  policy_snapshot jsonb NOT NULL DEFAULT '{}',
  diff_hash       text NOT NULL,              -- the hash the approver actually saw
  decided_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON approvals (tenant_id, action_id);

CREATE TRIGGER approvals_append_only
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE approval_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  action_kind    text NOT NULL,
  rules          jsonb NOT NULL DEFAULT '{}',
    -- {maxMagnitudeUsd, requiredPermission, twoPersonAboveUsd, expiryHours}
  autonomy_level int NOT NULL DEFAULT 2,      -- the L2 -> L4 dial
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, action_kind)
);

CREATE TABLE guardrail_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  key         text NOT NULL,
  description text NOT NULL DEFAULT '',
  params      jsonb NOT NULL DEFAULT '{}',
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  action_id       uuid NOT NULL REFERENCES actions(id),
  attempt         int NOT NULL DEFAULT 1,
  status          text NOT NULL,             -- started|succeeded|failed|verified|verify_failed|rolled_back
  request_digest  jsonb NOT NULL DEFAULT '{}',
  response_digest jsonb,
  verification    jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX ON executions (tenant_id, action_id);

CREATE TRIGGER executions_append_only
  BEFORE UPDATE OR DELETE ON executions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'recommendations','actions','approvals','approval_policies',
    'guardrail_policies','executions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
