#!/bin/sh
# Runs once, on first initialisation of the data directory (docker-entrypoint-initdb.d).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v migrator_password="$PG_MIGRATOR_PASSWORD" \
  -v app_password="$PG_APP_PASSWORD" \
  -v worker_password="$PG_WORKER_PASSWORD" \
  -f /opt/golden/bootstrap.sql
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -c "CREATE DATABASE \"$GOLDEN_DB\" OWNER aios_migrator" \
  -c "REVOKE ALL ON DATABASE \"$GOLDEN_DB\" FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE \"$GOLDEN_DB\" TO aios_app, aios_worker"
