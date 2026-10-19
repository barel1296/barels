# Golden Influencer platform (Track B)

This is the platform: a modular monolith in TypeScript on Node 22, with PostgreSQL 16 as both the system of record and the persistent job queue. One process serves the API, the admin dashboard and the background worker. It covers:

- influencers, persona versions, identity material and golden-template cloning;
- the ComfyUI integration gateway (Visual Engine Contract v1) with GPU-aware scheduling, ingestion and QA;
- a generic **ComfyUI bridge** (`src/comfy-bridge`) for the existing ComfyUI installation;
- the local LLM gateway, Telegram conversations, consent, guards, escalations and fan memory;
- Telegram Stars subscriptions, entitlements, refunds and reconciliation;
- Instagram and Telegram publishing, and comment moderation;
- agents with autonomy policies and automated caption QA;
- analytics and cost attribution;
- staff authentication with TOTP, RBAC, an audit hash chain, monitoring and backups.

**Deploying on the Windows workstation:** see [`deploy/windows/README.md`](../../deploy/windows/README.md).

> **Validation status.**
> - Everything is covered by automated tests against real PostgreSQL 16 and **simulated** external systems: LLM, Telegram, Instagram, ComfyUI, and the contract-mock engine. The dashboard is tested in a real Chromium.
> - **Nothing has run against a real ComfyUI, a real local model, real Telegram/Meta accounts, or on the workstation.** Simulated output is labelled, contract-mock output can never be published, and neither counts as production validation.
> - See [`docs/16-implementation-status.md`](../../docs/16-implementation-status.md).

## Ownership boundary

**Track B (this code) owns:**

- the business logic;
- the scheduler;
- the contract client;
- QA decisions;
- approvals;
- publishing;
- audit.

**Track A (ChatGPT/Codex) owns** everything behind `contracts/visual-engine`:

- ComfyUI workflows;
- image and video model selection;
- LoRA training;
- identity consistency;
- media GPU optimisation.

The platform never sees node graphs or model names. It knows workflow keys and SemVer versions, typed parameters, references, outputs, errors and measured resource figures. It hardcodes no image or video model.

## Layout

```
apps/platform/
  src/
    config.ts            environment → typed config (empty values count as unset)
    main.ts              process entry (API + worker, or --api / --worker)
    cli.ts               operator commands (bootstrap, migrate, workspace, users, keys, health, backup:record, llm:bench, audit)
    registry.ts          handlers, subscriptions, periodic tasks and loops contributed by modules
    wiring.ts            which contributions run (Telegram, monetization, Instagram, agents, analytics)
    worker.ts            job runner lanes (payments, conversation, default) and loops
    services.ts          pools, store, engine clients, LLM gateway, publishing adapters
    api/                 Fastify server, auth (sessions + TOTP, API tokens, CSRF), routes per area, dashboard + previews
    contract/            Visual Engine Contract: types, JSON Schema validator, HTTP client
    db/                  pools, tenant transactions (RLS), migration runner
    lib/                 canonical JSON/hashing, crypto, TOTP, semver, PNG/JPEG/MIME
    modules/
      identity.ts        influencers, persona versions, reference assets, adapters, bindings, QA thresholds
      templates.ts       golden-template cloning (configuration only; never fans, payments or credentials)
      visual/            engines, workflow registry, job state machine, GPU scheduler, dispatcher, poller, ingest, QA
      content.ts         content items, immutable revisions, approval requests
      approvals.ts       decisions bound to payload hashes
      conversation/      engine (debounce, consent, modes, allowances), guards, prompt, fan memory, inbox/escalations
      crm.ts             fans, consents, erasure
      llm/               OpenAI-compatible gateway (chat lane, priorities), usage, benchmark
      monetization/      catalog, Telegram Stars invoices/payments, entitlements, refunds, reconciliation
      agents/            definitions, runner, policy engine, executor, caption QA
      analytics/         metrics ingestion, daily KPI rollups, cost attribution
      publishing.ts      scheduling and the publisher (adapters opt in with PUBLISHING_ADAPTERS)
      monitoring.ts      health report, GPU sampling, Prometheus metrics; alerts.ts, audit-seal.ts, outbox.ts
    integrations/
      telegram/          Bot API client, long-poll ingestion, bot routing, channel publisher
      instagram/         Graph API client, publisher, comments
    comfy-bridge/        VEC v1 engine in front of the EXISTING ComfyUI (discover, check-packages, serve)
    simulators/          SIMULATED LLM, Telegram, Instagram and ComfyUI servers for tests
    mock-engine/         CONTRACT TEST ADAPTER (not an engine)
    conformance/         conformance runner C01–C16
  web/admin/             admin dashboard (no framework, strict CSP, text-only rendering)
  test/                  unit, integration (PostgreSQL), e2e (API + worker + simulators + Chromium)
db/                      bootstrap.sql (roles), migrations/ (authoritative schema, 0001–0008)
contracts/visual-engine/ the contract (OpenAPI, JSON Schemas, examples, fixtures) and the bridge package format
deploy/windows/          workstation installation, services, health, backup/restore, acceptance scripts and guides
ops/                     docker-compose (PostgreSQL), env template, host verification scripts
```

## Prerequisites

- **Node.js 22.12 or newer.**
- **PostgreSQL 16.** Either native or via `ops/docker-compose.yml`. Docker is optional on the workstation.
- **Windows:** run the platform natively or in WSL2. Paths in `.env` may use forward slashes (`D:/golden/media`).
- **Hardware check:**
  - Run `ops/scripts/verify-host.ps1` (Windows) or `ops/scripts/verify-host.sh` (Linux/WSL) before capacity planning.
  - It records installed RAM, free storage, GPU, driver and CUDA compatibility, and running services, as JSON for `ops.environment_fingerprints`.
  - **No hardware figure in the docs is valid until this has been run on the workstation.**

## First-time setup

All commands run from `apps/platform/` unless noted.

1. **Install dependencies.** Run `npm ci`.

2. **Generate secrets.**

   ```bash
   npm run cli -- keys:generate
   ```

   - Put `MASTER_KEY` and `ASSET_URL_SECRET` into `ops/.env`. Start from `ops/env.example`.
   - Give `VEC_ENGINE_TOKEN` to whoever runs the visual engine.
   - **Back up `MASTER_KEY` offline.** Without it, every stored credential is unrecoverable.

3. **Create the database roles and database.** Choose one option:

   - **Option A — Docker:** from the repository root, run

     ```bash
     docker compose -f ops/docker-compose.yml --env-file ops/.env up -d
     ```

   - **Option B — native PostgreSQL:** run the following with a superuser connection.

     ```bash
     PG_ADMIN_URL=postgres://postgres:...@127.0.0.1:5432/postgres \
     PG_MIGRATOR_PASSWORD=... PG_APP_PASSWORD=... PG_WORKER_PASSWORD=... \
     npm run cli -- db:bootstrap --database golden
     ```

     This creates:

     - `aios_migrator` (owns the schema);
     - `aios_app` (API, `NOBYPASSRLS`);
     - `aios_worker` (background workers).

4. **Apply migrations.** Run this as `aios_migrator`. The runner is checksum-verified and safe to re-run.

   ```bash
   MIGRATION_DATABASE_URL=postgres://aios_migrator:...@127.0.0.1:5432/golden npm run cli -- db:migrate
   ```

5. **Create the workspace and its owner.** `--platform-admin` lets this user register engines and approve workflow versions. The command prints an API token **once**.

   ```bash
   npm run cli -- workspace:create --slug studio --name "Studio" \
     --owner-email you@example.com --owner-name "You" --platform-admin
   npm run cli -- user:add --workspace studio --email reviewer@example.com --name "Reviewer" --role reviewer
   ```

   Approvals require a second person: a requester can never approve their own request. Roles are:

   - `owner`
   - `admin`
   - `compliance_officer`
   - `content_manager`
   - `reviewer`
   - `chat_operator`
   - `finance`
   - `analyst`
   - `viewer`

6. **Start the platform.** It runs the API and the worker in one process.

   ```bash
   npm run build && npm start      # production build
   npm run dev                     # or directly from TypeScript
   ```

   - The API listens on `HTTP_HOST:HTTP_PORT` (default `127.0.0.1:8080`).
   - `GET /healthz` checks the database.
   - **Do not expose the API publicly.** The workstation deployment is local only, and production deployment needs explicit approval.

## Connecting the visual engine (Track A hand-off)

1. **Run conformance against Track A's engine.** The engine must be started in conformance mode. The runner checks C01–C16 of `contracts/visual-engine/fixtures/conformance-scenarios.json`.

   ```bash
   npm run conformance -- --engine-url http://127.0.0.1:8188/vec/v1 --token "$VEC_ENGINE_TOKEN" --report conformance.json
   ```

2. **Register the engine.** This is a platform-admin call. The platform calls `GET /engine`, validates the response against the schema, and stores the token envelope-encrypted.

   ```bash
   curl -X POST $API/v1/platform/engines -H "Authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
     -d '{"engine_key":"ws01-comfyui","base_url":"http://127.0.0.1:8188/vec/v1","token":"'$VEC_ENGINE_TOKEN'"}'
   ```

   You can optionally set:

   - `dispatch_limit`: caps concurrency below the engine's `max_concurrent_jobs`;
   - `media_lane_vram_mb`: the **measured** media-lane budget. Leave it unset until B-* benchmarks exist; unset means GPU jobs run one at a time.

3. **Discover workflows.** `POST /v1/platform/engines/{id}/sync`:

   - verifies each `manifest_sha256`;
   - registers new versions as `registered` (never auto-approved);
   - refuses a changed manifest under an existing version (`MANIFEST_IMMUTABLE`).

4. **Approve versions.** `POST /v1/platform/workflows/{id}/decision` with `{"decision":"approve","note":"<licence + QA evidence ref>"}`. Approval is a human, audited decision based on evidence that Track A provides.

5. **Bind per influencer.** `PUT /v1/influencers/{id}/workflow-bindings/{purpose}` with `{"workflow_key":"…","version_range":"^1.2","default_parameters":{…}}`. Ranges never cross a MAJOR version. Each job pins the exact version it resolved to.

To try everything without Track A, run `MOCK_ENGINE_TOKEN=… npm run mock-engine -- --port 8188` and register it in the same way. It reports `engine_kind: contract_mock`, and the platform labels everything it produces accordingly.

## Vertical slice: API walkthrough

Every call needs `Authorization: Bearer <token>`. The token's role decides what is allowed.

| Step | Call |
|---|---|
| 1. Create and configure an influencer | `POST /v1/influencers` (`slug`, `display_name`, AI disclosures, `timezone`, `primary_language`, `runtime`). `PATCH /v1/influencers/{id}/runtime-config`. |
| 2. Persona identity | `POST /v1/influencers/{id}/persona-versions`, then `/v1/persona-versions/{id}/submit`, `…/approve` (by a different user), `…/activate`. Upload references: `POST /v1/influencers/{id}/reference-assets?kind=face_canonical` with raw `image/png` bytes, then `POST /v1/reference-assets/{id}/approve`. Optional adapter: `POST /v1/influencers/{id}/adapters` (`engine_ref` from Track A), then `POST /v1/adapters/{id}/approve`. Activate: `POST /v1/influencers/{id}/status` `{"status":"active"}`. |
| 3. Workflow contract | Engine registration, sync, approval and binding, as described above. QA thresholds: `POST /v1/qa-thresholds` (`check_key`, `min_score`/`max_score`, `required`, `on_fail`). |
| 4. Submit a job | `POST /v1/influencers/{id}/content-items`. Then `POST /v1/influencers/{id}/visual-jobs` with `Idempotency-Key` and `{"purpose":"feed_photo","parameters":{…},"content_item_id":"…"}` (202 = created, 200 = idempotent replay). |
| 5. Track status | `GET /v1/visual-jobs/{id}` returns the state, attempt, progress, error and the full event log. `POST /v1/visual-jobs/{id}/cancel` cancels. |
| 6. Assets | `GET /v1/influencers/{id}/media-assets?visual_job_id=…` returns status (`valid`/`rejected`), QA summary and provenance. |
| 7. Review | `POST /v1/content-items/{id}/revisions` (caption, hashtags, assets). `POST /v1/revisions/{id}/approval-requests`. The reviewer reads `GET /v1/approvals/{id}`, then sends `POST /v1/approvals/{id}/decisions` with `{"decision":"approve"\|"reject"\|"request_changes","payload_hash":"<from the request>","comment":"…"}`. A comment is required for reject and request_changes. |
| 8. Schedule | `POST /v1/integration-accounts` (the credential is stored encrypted and never returned). `POST /v1/influencers/{id}/channels`. `POST /v1/content-items/{id}/publications` with `{"channel_id","scheduled_for"}`. The response states whether it can actually execute. |
| 9. History | `GET /v1/content-items/{id}/lineage` covers persona, workflow, engine, job events, assets, QA, revisions, approvals and decisions, publications, account, cost and audit. `GET /v1/influencers/{id}/audit`. |

## Platform error codes

Errors are returned as `{"error":{"code","message","details?"}}`. Engine-side codes are listed in the contract README §8.1.

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Body or params fail the route schema. `details.violations` lists them. |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_VERSION_RANGE`, `INVALID_SCHEDULE`, `REASON_REQUIRED`, `INVALID_THRESHOLD`, `INVALID_TIMEZONE` | Input rule violations |
| 401 | `UNAUTHORIZED` | Missing, invalid, revoked or expired token, or an inactive user or membership |
| 403 | `FORBIDDEN` | Missing permission; outside the influencer scope; self-approval (`SELF_APPROVAL_FORBIDDEN`); not a platform admin |
| 403 | `INVALID_SIGNATURE` | Signed asset URL invalid or expired |
| 404 | `NOT_FOUND` | The resource does not exist **in your workspace** (RLS) |
| 409 | `IDEMPOTENCY_CONFLICT` | Same idempotency key, different request |
| 409 | `MANIFEST_IMMUTABLE` | A different manifest under an existing workflow version |
| 409 | `INVALID_STATUS_TRANSITION`, `NO_ACTIVE_PERSONA`, `INFLUENCER_NOT_GENERATING` | Lifecycle rule violations |
| 409 | `NOT_APPROVED`, `UNAUTHORIZED_CONTENT`, `REVISION_NOT_CURRENT`, `PAYLOAD_HASH_MISMATCH`, `APPROVAL_NOT_PENDING`, `APPROVAL_EXPIRED`, `APPROVAL_EXISTS` | Approval binding |
| 409 | `JOB_ALREADY_TERMINAL`, `JOB_NOT_CANCELLABLE`, `ALREADY_SCHEDULED`, `CHANNEL_UNAVAILABLE`, `ACCOUNT_UNAVAILABLE` | State conflicts |
| 422 | `PARAMETER_VALIDATION_FAILED` | Parameters violate the workflow manifest `input_schema`. Nothing is sent to the engine. |
| 422 | `NO_APPROVED_VERSION`, `NO_BINDING`, `WORKFLOW_SELECTION`, `OUTPUT_COUNT_OUT_OF_RANGE` | Workflow resolution |
| 422 | `REFERENCE_NOT_ALLOWED`, `REFERENCE_NOT_OWNED` | References outside manifest limits or belonging to another influencer |
| 422 | `PERSONA_POLICY`, `DISCLOSURE_REQUIRED`, `RATING_DISABLED`, `RATING_EXCEEDS_CHANNEL`, `CHANNEL_RATING_GATE` | Policy guard rails |
| 422 | `ASSET_NOT_VALID`, `ASSET_NOT_OWNED`, `ASSET_NOT_CONTENT` | Revision asset rules |
| 502 | `ENGINE_CALL_FAILED` | Engine registration call failed. `details.engine_error` carries the contract error. |

Job-level platform error codes (in `visual_jobs.error_code`):

| Code | Class | Retried? |
|---|---|---|
| `OUTPUT_VERIFICATION_FAILED` | transient | yes |
| `PLATFORM_TIMEOUT` | timeout | yes |
| `ENGINE_JOB_LOST` | transient | yes |
| `ENGINE_PROTOCOL_ERROR` | permanent | no |
| `WORKFLOW_DISABLED` | — | no |
| `DEADLINE_EXCEEDED` | — | no |
| `PLATFORM_CONTRACT_VIOLATION` | permanent | no |

Publication holds (in `publications.last_error.code`):

- `MOCK_ASSET_NOT_PUBLISHABLE`
- `NO_CHANNEL_ADAPTER`
- `CHANNEL_UNAVAILABLE`
- `INFLUENCER_NOT_ACTIVE`

## Operations runbook

### Kill switches

- **All media generation:**

  ```sql
  INSERT INTO core.feature_flags (key, value) VALUES ('kill_switch.media_generation', 'true')
  ON CONFLICT (workspace_id, influencer_id, key) DO UPDATE SET value = 'true';
  ```

  Queued jobs stay queued and running jobs finish. Set the value to `false` to resume.

- **One workspace or influencer:** the same key with `workspace_id` (and optionally `influencer_id`) set.
- **One persona:** `PATCH /v1/influencers/{id}/runtime-config {"paused":true}` excludes it from scheduling. Alternatively, set its status to `paused`.
- **One workflow version:** set `decision: "disable"`. Queued jobs fail with `WORKFLOW_DISABLED`.
- **One channel:** set `publishing.channels.publish_frozen = true`. Due publications are then held.

### Engine down

- The health loop marks the engine `unreachable`, and dispatch skips it.
- Submitted jobs keep their state.
- The per-job `timeout_s` bounds the wait. After that comes `timed_out`, then a retry, then failure.
- Nothing is lost: when the engine returns, polling resumes.
- If the engine lost its jobs, they retry as attempt+1 (`ENGINE_JOB_LOST`).

### Ambiguous submits

- A timeout or connection reset during `POST /jobs` is re-sent with the **same `request_id` and attempt, byte-identical**. The submission body is stored per attempt.
- The engine's idempotency guarantees at most one job.
- Never edit `visual_jobs.submission` by hand.

### Worker crash

All work is lease-based:

- a `dispatching` job with an expired lease returns to `queued` with the same attempt;
- an `ingesting` job with an expired lease is re-ingested, idempotently on `(visual_job_id, engine_output_id)`.

Restart the process. No manual cleanup is needed.

### Inspecting a job

`GET /v1/visual-jobs/{id}`, or SQL on `inference.visual_job_events` ordered by `id`.

### Backups

Back up all three; none is sufficient alone:

- `pg_dump` of the database;
- the `MEDIA_ROOT` directory (content-addressed, immutable files);
- the `MASTER_KEY`, offline and separately.

On the workstation, `deploy/windows/backup.ps1` and `restore.ps1` do this (verified dump, incremental media mirror, restore test into a scratch database, Replace with rollback). See [BACKUP-RESTORE.md](../../deploy/windows/BACKUP-RESTORE.md). Restore-test monthly.

### Key rotation

- Move the current key to `MASTER_KEY_PREVIOUS_ID`/`MASTER_KEY_PREVIOUS`, set a new `MASTER_KEY_ID`/`MASTER_KEY`, then restart.
- New secrets use the new key. Old ones still decrypt.
- *Not yet implemented:* a re-encryption job that retires the previous key.

### Logs

- The API logs JSON lines (Fastify/pino).
- The worker logs `[worker:<loop>]` errors.
- Every state change is also in `core.audit_log`, which is append-only for the runtime roles.

## Local demo (visual review of the dashboard)

`npm run demo` starts the real platform build against a separate database on a **development** PostgreSQL server. All external systems are simulated, in-process: Telegram (including Stars), Instagram, the LLM, and ComfyUI behind the real bridge. It then seeds two demo influencers through the API:

- "Luna Vale": persona, media, content, plans, fans, chats, payments and analytics;
- "Nova Reyes": cloned from Luna, then given her own persona, bot, fans, product and post.

**To click through it in a browser,** use [`deploy/demo/`](../../deploy/demo/README.md). It runs the same demo in a GitHub Codespace (a private HTTPS URL behind GitHub sign-in) or in a local dev container, and stops with `deploy/demo/stop.sh`.

```bash
npm run build
npm run demo -- --admin-url postgres://postgres:<pw>@127.0.0.1:5432/postgres --out /tmp/golden-demo --reset
# → http://127.0.0.1:8090/admin/ ; sign-in details in /tmp/golden-demo/demo-credentials.txt (mode 600, never printed)
npm run demo:totp -- --out /tmp/golden-demo          # the current 6-digit sign-in code
npm run demo:screenshots -- --out /tmp/golden-demo   # full-page PNGs of every screen (real Chromium)
npm run demo:snapshot -- --out /tmp/golden-demo      # one read-only HTML file of every screen, openable anywhere
```

- It refuses database servers that are not on loopback, unless they are listed in `DEMO_ALLOWED_DB_HOSTS`.
- It resets the `aios_*` role passwords on the server it is given, so use a development server only.

The latest screenshots and the list of frontend gaps are in [`docs/evidence/dashboard-demo-2026-10-18/`](../../docs/evidence/dashboard-demo-2026-10-18/README.md).

## Tests

The tests need a PostgreSQL 16 superuser connection. Each test file creates its own throwaway database, with roles from `db/bootstrap.sql`.

```bash
export TEST_PG_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres
npm run typecheck
npm run test:unit          # no database
npm run test:integration   # governance and security against PostgreSQL
npm run test:e2e           # vertical slice + failure handling + conformance (contract mock)
npm test                   # everything
```

CI (`.github/workflows/ci.yml`) runs all of these, plus the conformance CLI against the mock, on every push.

| Validated here (automated) | Not validated here |
|---|---|
| Platform workflows end to end through the API, the worker and the dashboard (real Chromium) | Real ComfyUI generation, image quality and identity consistency (Track A) |
| Contract client and the ComfyUI bridge against the contract mock and the SIMULATED ComfyUI | The bridge against the real ComfyUI installation (COMFYUI.md §6 checks) |
| Conversations, guards, memory and agents against the SIMULATED LLM | Any real model: quality, latency, JSON validity, VRAM |
| Telegram bots, Stars payments, refunds, reconciliation against the SIMULATED Bot API | Real Telegram, real Stars |
| Instagram publishing, comments and insights against the SIMULATED Graph API | Real Meta accounts, app review, the public media tunnel |
| RLS, RBAC, four-eyes rules, append-only audit, encryption on PostgreSQL 16 (Linux) | PostgreSQL and Node on Windows (ACCEPTANCE-TESTS W1.3) |
| Scheduler policy as logic; GPU sampling parsing | Scheduling under real GPU load; real VRAM figures |
| Windows deployment scripts under PowerShell 7 on Linux (`docs/evidence/m10-windows-package`) | Windows PowerShell 5.1, scheduled tasks, the workstation itself |
