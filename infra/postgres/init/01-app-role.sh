#!/bin/sh
# Creates the NON-superuser application role on first container start.
# Password comes from APP_DB_PASSWORD (falls back to the dev default).
# RLS only applies to non-superusers — the app must never connect as the
# bootstrap POSTGRES_USER.
set -e
APP_PW="${APP_DB_PASSWORD:-gros_app}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gros_app') THEN
    CREATE ROLE gros_app LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
SQL
