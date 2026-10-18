-- =============================================================================
-- Migration 0006 — comment moderation permissions and lookup index.
-- =============================================================================

CREATE INDEX comments_influencer_status_idx ON publishing.comments (influencer_id, status, commented_at DESC);

INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES
    ('owner', 'comment.read'), ('owner', 'comment.reply'), ('owner', 'comment.moderate'),
    ('admin', 'comment.read'), ('admin', 'comment.reply'), ('admin', 'comment.moderate'),
    ('content_manager', 'comment.read'), ('content_manager', 'comment.reply'),
    ('chat_operator', 'comment.read'), ('chat_operator', 'comment.reply'), ('chat_operator', 'comment.moderate'),
    ('compliance_officer', 'comment.read'), ('compliance_officer', 'comment.moderate'),
    ('analyst', 'comment.read')
  ) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;
