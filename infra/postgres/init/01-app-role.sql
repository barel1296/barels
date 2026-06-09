-- Runs once on first container start (docker-entrypoint-initdb.d).
-- The application connects as gros_app (NOSUPERUSER) so Row-Level Security
-- actually applies — the bootstrap POSTGRES_USER is a superuser and would
-- silently bypass every policy. Migrations/seeds run as the owner role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gros_app') THEN
    CREATE ROLE gros_app LOGIN PASSWORD 'gros_app' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
