-- =============================================================================
-- Golden Influencer — cluster bootstrap (run ONCE per PostgreSQL cluster, as a
-- superuser, before the first migration).
--
--   psql -v ON_ERROR_STOP=1 \
--        -v migrator_password="$PG_MIGRATOR_PASSWORD" \
--        -v app_password="$PG_APP_PASSWORD" \
--        -v worker_password="$PG_WORKER_PASSWORD" \
--        -f db/bootstrap.sql
--   createdb --owner=aios_migrator golden
--
-- or, equivalently:  npm run cli -- db:bootstrap  (apps/platform; reads the same
-- file and substitutes the :'variables').
--
-- Roles
--   aios_migrator  owns every schema object; used ONLY to run db/migrations.
--   aios_app       API process. NOBYPASSRLS: every tenant query runs with
--                  app.workspace_id set (row-level security).
--   aios_worker    background workers (GPU scheduler, poller, ingest, publisher)
--                  that legitimately operate across workspaces. BYPASSRLS, but
--                  the same column-level grants as aios_app (no UPDATE/DELETE on
--                  append-only tables).
-- Passwords are set through session settings so they never appear inside a
-- dollar-quoted body. They may appear in the server log if log_statement=all.
-- =============================================================================

SET gi.migrator_password = :'migrator_password';
SET gi.app_password = :'app_password';
SET gi.worker_password = :'worker_password';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('aios_migrator', 'gi.migrator_password', 'NOBYPASSRLS'),
      ('aios_app',      'gi.app_password',      'NOBYPASSRLS'),
      ('aios_worker',   'gi.worker_password',   'BYPASSRLS')) AS t(role_name, setting, rls)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION %s PASSWORD %L',
                     r.role_name, r.rls, current_setting(r.setting));
    ELSE
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION %s PASSWORD %L',
                     r.role_name, r.rls, current_setting(r.setting));
    END IF;
  END LOOP;
END $$;

-- Runtime roles get no implicit search path surprises and short statement limits.
ALTER ROLE aios_app SET statement_timeout = '30s';
ALTER ROLE aios_worker SET statement_timeout = '120s';
ALTER ROLE aios_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE aios_worker SET idle_in_transaction_session_timeout = '300s';

RESET gi.migrator_password;
RESET gi.app_password;
RESET gi.worker_password;
