-- =============================================================================
-- Migration 0004 — conversations, fan memory and Telegram runtime.
-- =============================================================================

-- Per-persona conversation policy. 'ai_draft' (operator approves every AI
-- reply) is the closed-beta default (docs/README D9); promotion to 'ai_auto'
-- is an explicit, audited configuration change.
ALTER TABLE identity.persona_runtime_config
  ADD COLUMN default_conversation_mode text NOT NULL DEFAULT 'ai_draft'
    CHECK (default_conversation_mode IN ('ai_auto', 'ai_draft', 'human')),
  ADD COLUMN redisclosure_every_messages int NOT NULL DEFAULT 40 CHECK (redisclosure_every_messages BETWEEN 5 AND 1000),
  ADD COLUMN redisclosure_every_hours int NOT NULL DEFAULT 3 CHECK (redisclosure_every_hours BETWEEN 1 AND 168),
  ADD COLUMN memory_enabled boolean NOT NULL DEFAULT true;

-- Telegram bot identity on the integration account (getMe), for routing and
-- for the bot's own messages.
ALTER TABLE core.integration_accounts
  ADD COLUMN bot_username text;

-- Unanswered-inbound tracking for the debounced reply job.
ALTER TABLE conversation.conversations
  ADD COLUMN last_replied_inbound_at timestamptz,
  ADD COLUMN messages_since_disclosure int NOT NULL DEFAULT 0,
  ADD COLUMN locale text;

-- Operator review of AI drafts.
ALTER TABLE conversation.messages
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN original_body text;          -- AI draft text when an operator edited it before sending

INSERT INTO core.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM core.roles r
  JOIN (VALUES
    ('owner', 'conversation.read'), ('owner', 'conversation.reply'), ('owner', 'conversation.manage'),
    ('owner', 'fan.read'), ('owner', 'fan.manage'), ('owner', 'escalation.manage'),
    ('admin', 'conversation.read'), ('admin', 'conversation.reply'), ('admin', 'conversation.manage'),
    ('admin', 'fan.read'), ('admin', 'fan.manage'), ('admin', 'escalation.manage'),
    ('compliance_officer', 'conversation.read'), ('compliance_officer', 'fan.read'), ('compliance_officer', 'fan.manage'),
    ('compliance_officer', 'escalation.manage'),
    ('chat_operator', 'conversation.read'), ('chat_operator', 'conversation.reply'), ('chat_operator', 'fan.read'),
    ('chat_operator', 'escalation.manage'),
    ('content_manager', 'conversation.read'),
    ('analyst', 'conversation.read')
  ) AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.workspace_id IS NULL;
