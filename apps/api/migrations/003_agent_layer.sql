-- 003: agent layer — playbooks, sessions, runs, messages (blackboard),
-- evidence artifacts, tenant memory, anomalies, LLM cost ledger.

CREATE TABLE playbooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL,
  version    int NOT NULL DEFAULT 1,
  definition jsonb NOT NULL,       -- phases, roster, budgets, mandatory primitives
  status     text NOT NULL DEFAULT 'active',
  UNIQUE (key, version)
);

CREATE TABLE agent_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  playbook_key        text,
  trigger_type        text NOT NULL,         -- anomaly|schedule|user|opportunity_scan
  trigger_ref         jsonb NOT NULL DEFAULT '{}',
  title               text NOT NULL,
  scope               jsonb NOT NULL DEFAULT '{}',
  phase               text NOT NULL DEFAULT 'triage',
  status              text NOT NULL DEFAULT 'running',
  money_at_stake_usd  numeric(14,2),
  decision            jsonb,
  abstract            text,
  budgets             jsonb NOT NULL DEFAULT '{}',
  outcome             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);
CREATE INDEX ON agent_sessions (tenant_id, status, created_at DESC);

CREATE TABLE agent_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  agent      text NOT NULL,
  phase      text NOT NULL,
  status     text NOT NULL DEFAULT 'running', -- running|completed|failed|budget_exceeded
  model      text,
  tokens_in  bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  cost_usd   numeric(10,4) NOT NULL DEFAULT 0,
  tool_calls int NOT NULL DEFAULT 0,
  trace_ref  text,
  error      jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON agent_runs (tenant_id, session_id);

CREATE TABLE evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  session_id    uuid REFERENCES agent_sessions(id),
  kind          text NOT NULL,               -- metric_query|recon_report|external|computation
  metric_key    text,
  metric_version int,
  params        jsonb NOT NULL DEFAULT '{}',
  sql_hash      text NOT NULL DEFAULT '',
  result_ref    text NOT NULL,               -- artifact store pointer (frozen snapshot)
  result_digest jsonb NOT NULL DEFAULT '{}',
  freshness_at  timestamptz,
  executed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON evidence (tenant_id, session_id);

CREATE TRIGGER evidence_append_only
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE agent_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  session_id   uuid NOT NULL REFERENCES agent_sessions(id),
  run_id       uuid REFERENCES agent_runs(id),
  agent        text NOT NULL,                -- agent name | user | orchestrator
  type         text NOT NULL,
  claim        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  confidence   numeric(3,2),
  directed_to  text[] NOT NULL DEFAULT '{}',
  in_reply_to  uuid REFERENCES agent_messages(id),
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON agent_messages (tenant_id, session_id, seq);

CREATE TRIGGER agent_messages_append_only
  BEFORE UPDATE OR DELETE ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- DB-level enforcement of the evidence rule (defense in depth; the worker
-- protocol validator is the first line): claim-bearing message types must
-- reference at least one evidence row belonging to the same tenant.
CREATE OR REPLACE FUNCTION enforce_evidence_rule() RETURNS trigger AS $$
DECLARE n int;
BEGIN
  IF NEW.type IN ('finding', 'hypothesis', 'challenge') THEN
    IF NEW.evidence_ids IS NULL OR array_length(NEW.evidence_ids, 1) IS NULL THEN
      RAISE EXCEPTION 'protocol violation: % message requires evidence_ids', NEW.type;
    END IF;
    SELECT count(*) INTO n FROM evidence e
      WHERE e.id = ANY (NEW.evidence_ids) AND e.tenant_id = NEW.tenant_id;
    IF n <> array_length(NEW.evidence_ids, 1) THEN
      RAISE EXCEPTION 'protocol violation: evidence_ids must resolve to stored evidence';
    END IF;
  END IF;
  IF NEW.type = 'hypothesis' AND (NEW.payload ->> 'falsification') IS NULL THEN
    RAISE EXCEPTION 'protocol violation: hypothesis requires payload.falsification';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_messages_evidence_rule
  BEFORE INSERT ON agent_messages
  FOR EACH ROW EXECUTE FUNCTION enforce_evidence_rule();

CREATE TABLE tenant_memory (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  category  text NOT NULL,                   -- targets|constraints|seasonality|preferences|learned
  key       text NOT NULL,
  value     jsonb NOT NULL,
  source    text NOT NULL DEFAULT 'user',
  version   int NOT NULL DEFAULT 1,
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category, key, version)
);

CREATE TABLE anomalies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  metric_key      text NOT NULL,
  scope           jsonb NOT NULL DEFAULT '{}',
  direction       text NOT NULL,             -- up|down
  magnitude       numeric,
  zscore          numeric,
  detector        text NOT NULL,             -- zscore|cusum|fatigue_curve|dq
  detector_version text NOT NULL DEFAULT 'v1',
  window_start    date NOT NULL,
  window_end      date NOT NULL,
  materiality_usd numeric(14,2),
  status          text NOT NULL DEFAULT 'new', -- new|triaged|in_session|dismissed|merged
  session_id      uuid REFERENCES agent_sessions(id),
  detected_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON anomalies (tenant_id, status, detected_at DESC);

CREATE TABLE llm_cost_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  session_id uuid,
  run_id     uuid,
  agent      text,
  model      text NOT NULL,
  purpose    text NOT NULL DEFAULT '',
  tokens_in  bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  cost_usd   numeric(10,5) NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON llm_cost_ledger (tenant_id, at DESC);

CREATE TABLE cost_budgets (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id),
  monthly_usd      numeric(10,2) NOT NULL DEFAULT 500,
  hard_stop        boolean NOT NULL DEFAULT true,
  soft_alert_ratio numeric(3,2) NOT NULL DEFAULT 0.8,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_sessions','agent_runs','evidence','agent_messages','tenant_memory',
    'anomalies','llm_cost_ledger','cost_budgets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- playbooks are global (versioned in-repo, synced to DB), readable by all.
ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE playbooks FORCE ROW LEVEL SECURITY;
CREATE POLICY playbooks_read ON playbooks USING (true);
