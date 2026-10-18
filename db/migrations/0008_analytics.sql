-- =============================================================================
-- Migration 0008 — analytics: metric lookups and permissions.
-- =============================================================================

CREATE INDEX metric_snapshots_lookup_idx ON analytics.metric_snapshots (influencer_id, subject_type, subject_ref, metric, captured_at DESC);
CREATE INDEX visual_jobs_finished_idx ON inference.visual_jobs (influencer_id, finished_at) WHERE finished_at IS NOT NULL;

INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES
    ('owner', 'analytics.read'), ('owner', 'analytics.manage'), ('owner', 'valuation.manage'),
    ('admin', 'analytics.read'), ('admin', 'analytics.manage'), ('admin', 'valuation.manage'),
    ('finance', 'analytics.read'), ('finance', 'valuation.manage'),
    ('analyst', 'analytics.read'),
    ('content_manager', 'analytics.read'),
    ('compliance_officer', 'analytics.read')
  ) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;
