-- =============================================================================
-- Migration 0007 — agent runtime: autonomy policy authorship (four-eyes),
-- proposal lookups, kill switches and permissions.
-- =============================================================================

ALTER TABLE agents.autonomy_policies
  ADD COLUMN created_by uuid REFERENCES core.users(id),
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT autonomy_policies_four_eyes CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by);

-- One active policy per scope (workspace, influencer, action, agent).
CREATE UNIQUE INDEX autonomy_policies_one_active_idx
  ON agents.autonomy_policies (workspace_id, influencer_id, action_type, agent_key) NULLS NOT DISTINCT
  WHERE status = 'active';

CREATE INDEX proposals_approval_idx ON agents.action_proposals (approval_request_id);
CREATE INDEX tasks_influencer_idx ON agents.tasks (influencer_id, agent_key, created_at DESC);
CREATE INDEX runs_influencer_idx ON agents.runs (influencer_id, started_at DESC);
CREATE INDEX qa_reviews_subject_idx ON approvals.qa_reviews (subject_type, subject_id);
CREATE INDEX content_items_planned_idx ON content.content_items (influencer_id, planned_for);

INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES
    ('owner', 'agent.manage'), ('owner', 'agent.run'), ('owner', 'proposal.read'), ('owner', 'proposal.approve'),
    ('owner', 'autonomy.manage'), ('owner', 'autonomy.approve'), ('owner', 'killswitch.manage'),
    ('admin', 'agent.manage'), ('admin', 'agent.run'), ('admin', 'proposal.read'), ('admin', 'proposal.approve'),
    ('admin', 'autonomy.manage'), ('admin', 'killswitch.manage'),
    ('content_manager', 'agent.run'), ('content_manager', 'proposal.read'), ('content_manager', 'proposal.approve'),
    ('compliance_officer', 'proposal.read'), ('compliance_officer', 'proposal.approve'), ('compliance_officer', 'autonomy.approve'),
    ('compliance_officer', 'killswitch.manage'),
    ('reviewer', 'proposal.read'),
    ('analyst', 'proposal.read')
  ) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;

-- Why an approved or allowed proposal failed to execute.
ALTER TABLE agents.action_proposals ADD COLUMN execution_error jsonb;
