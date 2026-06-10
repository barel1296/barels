# Deployment Guide

## Topology

Three stateless services + three stateful stores:

| Service | Image | Port | Scaling |
|---|---|---|---|
| `api` (NestJS) | `apps/api/Dockerfile` | 3001 | horizontal (stateless; sessions are JWT) |
| `web` (Next.js standalone) | `apps/web/Dockerfile` | 3000 | horizontal |
| `worker` (Python) | `workers/py/Dockerfile` | — | horizontal (SKIP LOCKED queue makes concurrent workers safe; the scheduler dedupe guard makes concurrent schedulers safe) |
| Postgres 16 | managed preferred | 5432 | system of record |
| ClickHouse 24 | managed preferred | 8123 | analytics |
| Redis 7 | managed preferred | 6379 | cache (reserved) |

Single-host/staging: `docker compose -f infra/docker-compose.prod.yml --env-file .env up -d`
(the `migrate` one-shot service runs migrations as the owner role before the API starts).

## Non-negotiable production configuration

1. **Two database roles.** The API and worker connect as `gros_app`
   (non-superuser — RLS only applies to non-superusers). Migrations use the
   owner URL (`DATABASE_URL_OWNER`). The init script
   `infra/postgres/init/01-app-role.sh` creates the app role from
   `APP_DB_PASSWORD` on first boot; on managed Postgres create it manually.
2. **Secrets.** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SERVICE_TOKEN`,
   `CREDENTIALS_MASTER_KEY` must be long random values from a secret manager.
   The API **refuses to boot** in `NODE_ENV=production` with any dev-prefixed
   secret. `CREDENTIALS_MASTER_KEY` encrypts integration credentials at rest
   (AES-256-GCM) and must be identical for API and worker; rotating it
   requires re-entering integration credentials.
3. **TLS terminates at your ingress/load balancer** in front of `web` and
   `api`; cookies are `secure` in production.
4. **LLM keys** (`ANTHROPIC_API_KEY`, optional `OPENAI_API_KEY` failover) go
   to the worker only. Without them, live agent sessions fail loudly —
   ingestion, dashboards, detection and approvals keep working.
5. **Artifacts**: set `ARTIFACT_S3_BUCKET` (+ `ARTIFACT_S3_ENDPOINT` for
   non-AWS S3) so evidence snapshots and LLM transcripts live in object
   storage; the FS volume is the fallback.

## Operational runbook (top failure modes)

| Symptom | Check | Action |
|---|---|---|
| Sessions stuck `running` | worker logs; `jobs` table dead rows | Worker restart is safe (sessions resume from persisted phase); the maintenance job fails zombies after 2h |
| Approvals blocked, "domain is red" | Tracking Health Center | Fix the data issue, or a `health:manage` user overrides with a logged reason |
| Agents stopped mid-month | `/v1/costs/budget` | Budget hard-stop hit — raise the tenant budget or wait for the month roll |
| Integration `degraded` | `sync_runs.error` for the integration | Credential expiry is the usual cause; re-enter credentials, trigger `/sync` |
| LLM provider outage | worker logs `all providers failed` | Failover handles single-provider outages; dashboards/detection unaffected |
| Suspected cross-tenant issue | run the e2e suite against prod-shaped staging | RLS is FORCEd; verify the app is NOT connecting as a superuser |

## Backup & retention

- Postgres: standard PITR/base backups (system of record — decisions, audit,
  approvals live here).
- ClickHouse: raw_events carries a 13-month TTL; marts are rebuildable from
  raw, raw is re-pullable from sources after the restatement window.
- Artifacts bucket: evidence snapshots are immutable audit material — apply
  object-lock/versioning per your compliance needs.

## What this guide does NOT cover yet

Kubernetes manifests, OTel collector wiring, SIEM export, multi-region — see
docs/dev/known-gaps.md.

## Hosted demo paths

### Free: GitHub Codespaces (no card, ~5 minutes)

The repo ships a devcontainer. From GitHub: Code -> Codespaces -> Create
codespace on this branch -> wait for setup -> run "make demo" in the
terminal -> open the PORTS tab and click the port-3000 URL (set public).
Login: demo@gros.dev / demo-password-123. The free personal quota is 120
core-hours/month; the codespace sleeps when idle and resumes on open.

### Permanent: Render Blueprint (~$25/mo)

render.yaml provisions the full topology (web, api, worker, ClickHouse
private service + disk, managed Postgres) with migrations pre-deploy and
self-seeding demo data. Render Dashboard -> New -> Blueprint -> connect the
repo, pick the branch -> Apply. The public URL is the gros-web service.
ANTHROPIC_API_KEY is the only manual env (optional; enables live agent
sessions). RLS note: Render's Postgres user is a non-superuser owner, so
FORCE RLS applies in single-role mode.
