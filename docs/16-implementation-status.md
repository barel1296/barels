# 16 — Implementation status: Golden Influencer platform

> Updated 2026-10-18. This document records **what exists as code**, **how it was validated**, and **what is blocked**. It is the source of truth for status; docs 01–15 remain the design.
>
> **One-line status:**
> - The whole Track B platform and the Windows deployment package are implemented.
> - They pass 216/216 automated tests against real PostgreSQL 16 and **simulated** external systems.
> - **Nothing has been run on the workstation**, against the real ComfyUI, a real local model, or real Telegram/Meta accounts. Nothing is deployed.

## 1. Tracks and boundaries

- **Track A (ChatGPT/Codex)** owns everything visual:
  - ComfyUI workflows;
  - image/video model selection;
  - identity consistency;
  - LoRA training;
  - media GPU optimisation.

  Track A delivers **workflow packages** for the bridge (`contracts/visual-engine/comfyui-bridge.md`), or its own VEC v1 engine.
- **Track B (this repository)** owns the platform and its deployment. It hard-codes no image/video model, installs no custom node, and never modifies the existing ComfyUI installation.
- **Local language models** are Track B's to choose and measure (docs/15). No paid AI API is used anywhere.

## 2. Delivered (by milestone)

| Milestone | What exists | Main code | Automated evidence |
|---|---|---|---|
| Phase 1 | Influencers, persona versions (four-eyes), reference assets, adapters, bindings, Visual Engine Contract v1, GPU-aware media jobs, ingestion + QA, approvals bound to content hashes, scheduling, full lineage | `modules/identity.ts`, `modules/visual/*`, `modules/content.ts`, `modules/approvals.ts`, `contracts/visual-engine/` | `vertical-slice`, `failure-handling`, `conformance`, `governance` |
| M1 Platform services | Staff login (scrypt + mandatory TOTP, sessions, CSRF, lockout), job queue with lanes, outbox, audit hash-chain seals, partition maintenance, health/readiness, Prometheus metrics, GPU sampling and alerts | `api/auth-routes.ts`, `modules/sessions.ts`, `jobs-queue.ts`, `outbox.ts`, `audit-seal.ts`, `monitoring.ts` | `platform-services` |
| M2 Local LLM | OpenAI-compatible gateway, a chat lane where fan replies jump ahead of agent work, a bounded queue, JSON mode with schema validation, usage accounting | `modules/llm/*` | `conversation`, `llm-bench` |
| M3 Telegram conversations | Long-poll ingestion (persist, then advance), consent + AI disclosure, `ai_draft`/`ai_auto`/`human` modes, debounce, input/output guards, escalations with SLA, allowances/credits, fan memory, `/forget`, `/deletemydata` | `integrations/telegram/*`, `modules/conversation/*`, `crm.ts` | `telegram-conversation` |
| M4 Monetization | Products (four-eyes), signed Stars invoices, idempotent payments, subscriptions and entitlements, premium-channel join gating, refunds (four-eyes, idempotent, locked), reconciliation against the Stars ledger | `modules/monetization/*` | `monetization` |
| M5 Publishing | Instagram (containers, JPEG conversion, signed public media URLs) and Telegram channel adapters, opt-in per `PUBLISHING_ADAPTERS`, ambiguous-failure handling, comment ingestion and moderation | `integrations/instagram/*`, `integrations/telegram/publisher.ts`, `publishing.ts` | `publishing-adapters` |
| M6 Agents | Agent definitions, runs, schema-validated proposals, policy engine (allow / approval / deny), least-privilege executor, autonomy policies (four-eyes), kill switches, content calendar, automated caption QA (rules + LLM) | `modules/agents/*` | `agents` |
| M7 Analytics | Instagram insights and Telegram member ingestion, daily KPIs in the persona's time zone, cost attribution from configured estimates, Stars valuation | `modules/analytics/*` | `analytics` |
| M8 Dashboard | Single-page admin UI (no framework, strict CSP, text-only rendering): overview, approvals with previews and QA, inbox and drafts, escalations, calendar, media library, agents, money, analytics, ops, users | `web/admin/*`, `api/web-routes.ts` | `dashboard` (real Chromium) |
| M9 ComfyUI bridge | VEC v1 engine in front of the **existing** ComfyUI: Track A packages, input bindings only, reference upload to a subfolder, targeted interrupt, persisted state, read-only discovery and package checks | `comfy-bridge/*`, `simulators/comfyui.ts` | `comfy-bridge` (SIMULATED ComfyUI) |
| Template / bench | Golden-template cloning (configuration only; see §3) and the `llm:bench` command | `modules/templates.ts`, `modules/llm/bench.ts` | `templates`, `llm-bench` |
| M10 Windows package | Install, services, discovery, health, GPU monitor, conformance, LLM bench, integration test, backup/restore, guides | `deploy/windows/*` | `docs/evidence/m10-windows-package/` (PowerShell 7 on Linux) |
| M11 Dashboard setup | Create/clone influencers; persona drafts → review → activate; reference uploads; adapters; bindings; Telegram bot connection; engines and workflow approvals | `web/admin/app.js`, `GET /v1/persona-versions/:id` | `dashboard` (setup flow) |

## 3. Requirement coverage

### Platform

| Requirement | Status | Notes |
|---|---|---|
| Influencer management | Done | Lifecycle draft → active → paused → archived; per-influencer kill switches |
| Persona configuration | Done | Versioned; fictional-adult and AI-disclosure guard rails; author ≠ approver |
| Local LLM integration | Done (code) | Any OpenAI-compatible server. **No model chosen or measured yet:** needs the workstation (B3) |
| Persistent fan memory | Done | Extracted facts with a sensitivity filter; fan can view, forget and erase |
| Autonomous agents | Done | Policy-gated proposals; human approval by default; kill switches |
| Content strategy and calendar | Done | Strategist agent proposals; calendar UI |
| Generic ComfyUI integration | Done (code) | VEC v1 gateway + bridge. **Real ComfyUI untested** (B2) |
| Media library | Done | Content-addressed store, previews, provenance, validation results |
| Automated QA | Done | Media QA thresholds per influencer; caption QA (rules + LLM) that blocks critical findings |
| Telegram integration | Done (code) | Bots, conversations, channel publishing, Stars. **Real bot untested** (B4) |
| Instagram integration | Done (code) | Publishing, comments, insights. **Needs Meta app review and the public media tunnel** (B5) |
| Subscriptions and monetization | Done (code) | Telegram Stars only; **real payments untested** (B4) |
| Payment reconciliation | Done | Against `getStarTransactions`; heals lost payments and refunds; raises alerts |
| Analytics | Done | Daily KPIs, costs from operator estimates (no measured energy yet) |
| Administration dashboard | Done | Including setup and cloning (M11) |
| Authentication and permissions | Done | Local accounts with TOTP; 9 roles; RLS; four-eyes rules in the app and in the database |
| Auditing and monitoring | Done | Hash-chained audit; alerts; metrics; **no push notification of critical alerts yet** (O2) |
| Backup and recovery | Done (scripts) | Backup, test restore and Replace verified on Linux pwsh and on a real Windows runner in CI; not yet on the workstation (B1) |
| Golden template → 20–30 influencers | Done (mechanism) | Clone copies configuration only. Never copied: persona, reference assets, adapters, credentials, bot tokens, channels, fans, conversations, memories, payments, content. Capacity for 20–30 needs measurements (B1, docs/13) |

### Windows deployment package

| # | Requirement | Where |
|---|---|---|
| 1 | Installation instructions | `deploy/windows/README.md` |
| 2 | PowerShell setup scripts | `install.ps1`, `register-services.ps1`, `run-service.ps1`, `common.ps1` |
| 3 | Docker Compose where appropriate | `ops/docker-compose.yml` (PostgreSQL, optional), `deploy/windows/compose.llm.yml` (LLM, optional) |
| 4 | Database migration scripts | `migrate.ps1` → checksum-verified runner, `db/migrations/0001–0008` |
| 5 | Environment templates | `ops/env.example` (complete, no machine-specific values) |
| 6 | Local LLM setup instructions | `LOCAL-LLM.md` (llama.cpp native task, Ollama, Docker) |
| 7 | ComfyUI connection configuration | `discover-comfyui.ps1` (read-only), `COMFYUI.md` |
| 8 | VEC conformance runner | `conformance.ps1` |
| 9 | Service health checks | `health-check.ps1`, `/healthz`, `/readyz`, `/metrics` |
| 10 | Backup/restore procedures | `backup.ps1`, `restore.ps1`, `BACKUP-RESTORE.md` |
| 11 | GPU/VRAM monitoring | Platform sampler + `gpu-monitor.ps1` (per-process VRAM), `MONITORING.md` |
| 12 | Full integration test scripts | `integration-test.ps1` (labels simulated runs), `ACCEPTANCE-TESTS.md` |
| 13 | Troubleshooting/recovery documentation | `TROUBLESHOOTING.md` |

## 4. Validation scope

| What | Simulated / mock (passed) | Real (not yet run) |
|---|---|---|
| Platform logic, database, RLS, four-eyes, audit | PostgreSQL 16.15 on Linux: **passed** | Windows + PostgreSQL on the workstation |
| Visual pipeline | Contract mock and SIMULATED ComfyUI behind the real bridge: **passed** | Real ComfyUI with Track A packages; quality and identity (Track A) |
| Local LLM | SIMULATED server: **passed** (gateway, guards, memory, agents, bench harness) | Any real model: latency, JSON validity, VRAM (docs/14 B-LLM) |
| Telegram (bots, Stars, refunds, channels) | SIMULATED Bot API: **passed** | Real bots, real Stars |
| Instagram | SIMULATED Graph API: **passed** | Real accounts after Meta app review |
| Dashboard | Real Chromium against the real API: **passed** | — |
| Windows scripts | PowerShell 7.4 on Linux (`docs/evidence/m10-windows-package`): **passed**. **Real Windows** (GitHub `windows-latest`, Windows PowerShell 5.1, Task Scheduler, PostgreSQL 16 service, simulators; CI job `windows-deploy`): **passed** | The workstation (GPU, real ComfyUI, model) |
| Automated suite on Windows | Same CI job, full suite on Windows: **passed** | — |
| GPU behaviour | Parsing and alert logic only | Everything (no GPU here) |

**Rules, enforced in code:**

- Contract-mock assets can never be published (database trigger).
- Every job and asset carries `validation_scope`.
- `integration-test.ps1` marks runs against simulators `acceptance_evidence: false`.

## 5. Blockers and open items

| ID | Item | Status | What unblocks it |
|---|---|---|---|
| **B1** | **Workstation not verified.** The scripts and the test suite pass on a GitHub Windows runner, but not yet on the workstation; hardware figures in docs 13–15 are unmeasured | Blocked: needs the workstation (intentionally not accessed in this phase) | `ACCEPTANCE-TESTS.md` W0–W2, W12 |
| **B2** | **No real visual engine run.** Bridge tested only against the simulator; six behaviours to confirm (COMFYUI.md §6) | Blocked: workstation + Track A packages | W3, W5, W6 |
| **B3** | **No local language model selected or measured** | Blocked: workstation | LOCAL-LLM.md; W4 (docs/14 B-LLM-1…6) |
| **B4** | **Telegram bots, Stars payments and refunds untested for real** | Needs bot tokens from @BotFather and allowlisted testers | W8, W9 |
| **B5** | **Instagram untested for real** | Needs a Meta app with Instagram permissions (app review), test accounts, and a public HTTPS tunnel for `PUBLIC_MEDIA_BASE_URL` | W10 |
| B6 | `media_lane_vram_mb` and workflow `vram_mb_peak` unmeasured, so GPU jobs run one at a time | By design until measured | W4.4, Track A manifests |
| B7 | `DEFAULT_GPU_QUOTA_S_DAY=1800` is a policy placeholder | Open | Capacity worksheet (docs/13 §7) |
| O1 | Master-key re-encryption job (retire `MASTER_KEY_PREVIOUS`) | Not implemented | Keep both keys offline until then |
| O2 | Push notification of critical alerts (e.g. to an operator Telegram chat) | Not implemented; alerts are visible in the dashboard and `/metrics` | Small follow-up |
| O3 | Docker images (`postgres:16`, llama.cpp `server-cuda`) use floating tags | Open | Pin by digest after the first pull |
| O4 | Reference-asset approval has no author ≠ approver rule (personas, adapters, content, products, refunds and autonomy policies do) | Open design decision | Decide whether to add four-eyes for identity material |
| **B10** | **Production deployment** | **Not done and not authorised** | Explicit approval after the acceptance sign-off |

## 6. Schema (migrations)

`db/migrations/` is authoritative and checksum-verified. `0001` is the reviewed baseline.

| Migration | Adds |
|---|---|
| `0002_visual_engine_contract` | Contract manifests (immutable, SemVer, approval lifecycle), engines (encrypted tokens), visual jobs + append-only events, bindings, QA thresholds, API tokens, system roles, backstop triggers (four-eyes, payload hash, no mock publishing) |
| `0003_platform_services` | Staff auth (passwords, TOTP, sessions, lockout), durable job queue with priorities, periodic tasks, alerts and GPU samples, integration runtime settings |
| `0004_conversations` | Conversation policy per persona (`ai_draft` default), fan memory, Telegram runtime (poll cursors, inbound updates) |
| `0005_monetization` | Product approval (four-eyes), order invoices and expiry, refunds with four-eyes and one open refund per payment, permissions |
| `0006_comments` | Comment moderation permissions and lookups |
| `0007_agents` | Autonomy policy authorship (four-eyes, one active per scope), proposal execution errors, kill-switch permissions |
| `0008_analytics` | Metric lookups and analytics/valuation permissions |

## 7. Evidence

- `docs/evidence/platform-tests-2026-10-18/`: full automated run, 216/216 passed. 217/217 after the dashboard review fixes.
- CI job `windows-deploy`: the Windows package and the full suite on real Windows. First green run: https://github.com/barel1296/barels/actions/runs/39137945926
- `docs/evidence/dashboard-demo-2026-10-18/`: screenshots of every dashboard screen with demo data, a walkthrough, and the frontend features not yet implemented.
- `deploy/demo/`: the same demo (two influencers, everything simulated) to click through interactively, in a GitHub Codespace behind a private HTTPS URL or in a local dev container. The dev container and its start/stop scripts were run in the development container; a Codespace has not been started from here.
- `docs/evidence/m10-windows-package/`: every deployment script run under PowerShell 7 on Linux, plus the bugs that exercise found and fixed.
- `docs/evidence/phase1-vertical-slice/`: the Phase 1 slice and conformance against the contract mock.

## 8. Next steps (in order)

1. **Workstation, platform only:** W0–W2 and W12 of `deploy/windows/ACCEPTANCE-TESTS.md`.
2. **Local LLM:** pick candidates from docs/15, then W4 measurements.
3. **ComfyUI with Track A:** packages delivered, W3 (discovery, package check, conformance, the six bridge checks), W5, then W6 (first real generation, human quality review).
4. **Channels:** Telegram W8/W9 with allowlisted testers; Instagram W10 after Meta review.
5. **Golden Influencer sign-off.** Then clone (W13) and scale in batches of five (W14, gates G2–G4).
6. **Production:** only after explicit approval.
