-- 006: privileges for the non-superuser application role (gros_app).
-- RLS (FORCE) governs row visibility; these grants govern statement-level
-- access. audit_logs/evidence/agent_messages/approvals/executions are
-- additionally protected by append-only triggers.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gros_app') THEN
    GRANT USAGE ON SCHEMA public TO gros_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gros_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gros_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gros_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO gros_app;
    -- The migrations ledger is not the app's business.
    REVOKE ALL ON schema_migrations FROM gros_app;
  END IF;
END $$;
