# 16 — Implementation status: Golden Influencer, Phase 1

> Updated 2026-10-18. This document records **what exists as code**, **how it was validated**, and **what is blocked**. It is the source of truth for status; docs 01–15 remain the design.

## 1. Scope of this phase

The 2026-10-18 project update split the work into two tracks:

- **Track A (ChatGPT/Codex)** owns everything visual behind a contract:
  - ComfyUI workflows;
  - image and video model selection;
  - identity consistency and reference pipelines;
  - LoRA training and evaluation;
  - media GPU optimisation;
  - media-inference implementation.
- **Track B (this repository's platform code)** owns the platform:
  - lifecycle, personas, conversation engine, fan memory, agents, content strategy;
  - **media job orchestration and the ComfyUI integration gateway**;
  - media library, QA orchestration;
  - Instagram and Telegram integration, payments, analytics, admin;
  - auth, RBAC, audit, operations.

Phase 1 delivered the foundation and the **first vertical slice**:

- schema migrations;
- influencer configuration;
- the versioned, model-agnostic **Visual Engine Contract v1**;
- persistent visual jobs with GPU-aware scheduling;
- ingestion and QA;
- approvals;
- scheduling;
- full history.

## 2. Deliverable checklist (first deliverable)

| # | Requirement | Implementation | Evidence (automated, contract-tested) |
|---|---|---|---|
| 1 | Create and configure one influencer | `modules/identity.ts` (`createInfluencer`, runtime config, status lifecycle, mandatory AI disclosure) | `test/e2e/vertical-slice.test.ts` step 1 |
| 2 | Assign independent persona identity | Persona versions (draft → in_review → approved → active; author ≠ approver), reference assets (upload, sha256, approval), adapters (opaque `engine_ref`, approval), per-influencer bindings and QA thresholds. Nothing is shared between influencers. | Step 2; `failure-handling` "keeps persona identity independent"; `governance` "a new influencer starts empty" |
| 3 | Register a ComfyUI workflow contract | `contracts/visual-engine/` (OpenAPI 3.1, JSON Schemas, examples, fixtures, error codes, state machines, auth, versioning). Platform side: engine registration, workflow discovery (sync), immutable manifests (hash + DB trigger), approval lifecycle, SemVer bindings. | Step 3; `contract-artifacts.test.ts`; conformance C01–C16 |
| 4 | Submit a generation job using the contract | `visual/jobs.ts` (`createVisualJob`: idempotent, manifest parameter validation, reference/adapter rules, pinned version) and `visual/dispatcher.ts` (contract submission with signed reference URLs) | Step 4 |
| 5 | Track job status and handle failures | Platform state machine (`visual/state-machine.ts`, identical to contract README §6.2 by test). `poller.ts` handles progress, retries (attempt+1, backoff with jitter, honouring `retry_after`), timeouts with engine cancel, cancellation, lost jobs and protocol errors. Ambiguous submits are replayed byte-identically. ENGINE_BUSY backs off. Kill switches. | Step 5; `failure-handling.test.ts` (18 scenarios) |
| 6 | Receive and store generated asset metadata | `visual/ingest.ts`: download, verify sha256/size/MIME/dimensions/provenance, write to the content-addressed store, `media_assets` with full provenance, validation results, per-persona QA thresholds | Step 6; failure-handling "rejects outputs…", "applies per-persona QA thresholds" |
| 7 | Review and approve or reject the asset | Immutable revisions (`content_hash`); approval requests (`payload_hash`); decisions bound to the hash. A reason is required to reject. Requester ≠ approver in the app and in a DB trigger. A new revision supersedes pending approvals. | Step 7; `governance` approvals block |
| 8 | Schedule approved content for publication | `publishing.ts`: approval + content-hash binding (app and DB trigger), channel/account checks, rating gate; encrypted platform credentials. The publisher holds rather than fakes: `NO_CHANNEL_ADAPTER`, `MOCK_ASSET_NOT_PUBLISHABLE`. | Step 8; `governance` publication block |
| 9 | Record the entire action history | `core.audit_log` (append-only for runtime roles), `inference.visual_job_events` (append-only), validation results, decisions with comments, outbox events. `GET /v1/content-items/{id}/lineage` and `/v1/influencers/{id}/audit`. | Step 9; `docs/evidence/phase1-vertical-slice/vertical-slice-lineage.json` |

**Test totals:** 106 tests, 106 passed (59 unit, 18 integration, 29 e2e). The previous build passed 105/105 in five runs. The evidence is in `docs/evidence/phase1-vertical-slice/`. CI is `.github/workflows/ci.yml`.

## 3. Validation scope: contract-tested vs. real integration

| Capability | Contract-tested (mock) | Real ComfyUI engine | Workstation |
|---|---|---|---|
| Engine registration, discovery, manifest hashing | **Passed** | **NOT tested** (engine not available) | — |
| Job submit / idempotency / replay / retry / timeout / cancel | **Passed** | **NOT tested** | — |
| Output download and verification, provenance, QA decision | **Passed** (solid-colour PNGs) | **NOT tested** | — |
| Image quality, identity consistency, LoRA behaviour | n/a | **NOT tested** (Track A) | NOT tested |
| GPU scheduling under real VRAM pressure | Logic unit-tested; dispatch tested with `gpu_required: false` mock workflows | **NOT tested** | **NOT tested** (no GPU in this environment) |
| PostgreSQL schema, RLS, triggers, roles | **Passed** on PostgreSQL 16.15 (Linux) | — | NOT tested on the Windows host |
| Instagram / Telegram publishing | Guards tested; execution tested only with an in-process test adapter | — | **NOT implemented** |

**Rule (from the project brief, enforced in code):**

- Contract-mock results never count as production acceptance.
- The platform labels every job, asset and lineage with `validation_scope`.
- A DB trigger prevents contract-mock assets from ever reaching `publishing` or `published`.

## 4. Blockers and open items

| ID | Item | Status | What unblocks it |
|---|---|---|---|
| **B1** | **Workstation hardware not verified.** RAM, storage, CUDA/driver and running services are unknown. All capacity figures in docs 13–15 remain unmeasured parameters. | **Blocked: needs the workstation.** This cloud container has no GPU and no Windows. `ops/scripts/verify-host.sh` ran here and correctly reported `complete: false`. `verify-host.ps1` parses cleanly under PowerShell 7.4.6 but has **not been executed on Windows**. | Run `ops/scripts/verify-host.ps1 -OutFile fingerprint.json` on the workstation and share the JSON. Then run B-* benchmarks (doc 14). |
| **B2** | **No real visual engine.** Track A's ComfyUI-backed engine implementing VEC v1 is not available. | **Blocked: Track A.** | Track A runs `npm run conformance` against their engine. Then register, sync, approve, and run the vertical slice with `engine_kind = comfyui` on the workstation. |
| B3 | `media_lane_vram_mb` and workflow `vram_mb_peak` are unmeasured. GPU jobs therefore run one at a time. | By design until measured | Track A publishes measured figures in manifests; B-IMG/B-VID benchmarks |
| B4 | `DEFAULT_GPU_QUOTA_S_DAY=1800` is a **policy placeholder**, not a capacity figure | Open | Capacity worksheet (doc 13 §7) from measurements |
| B5 | Instagram Graph API and Telegram Bot API publishing adapters | Not implemented (Phase 4). Publications are held with `NO_CHANNEL_ADAPTER`. | Meta app review and verified accounts (D7); bot tokens |
| B6 | Local LLM (one shared model for all personas), conversation engine, fan memory | Not started (Phase 3). Claude may select and benchmark **language** models only. | The workstation for B-LLM benchmarks |
| B7 | Staff login via OIDC + MFA, admin dashboard UI | Not implemented. Phase 1 uses per-user API tokens (hash-only storage, expiry, revocation). | Phase 2 |
| B8 | Outbox dispatcher, audit seal hash-chain job, partition maintenance job, master-key re-encryption job | Events and rows are written; the background consumers are not implemented | Phase 2 |
| B9 | Docker image `postgres:16` is a floating tag | Open | Pin by digest on first pull |
| B10 | **Production deployment** | **Not done and not authorised.** Nothing has been deployed. | Explicit approval |

## 5. Schema changes in this phase (migration 0002)

`db/migrations/` is now authoritative. `0001_baseline.sql` is the reviewed `docs/schema/schema.sql`. Migration `0002_visual_engine_contract.sql` makes these changes:

- **Removes** `inference.workflows`, which stored raw ComfyUI graphs. Business logic must not see node graphs. It is replaced by `inference.visual_workflows`, which holds contract manifests: immutable by trigger, SemVer, with an approval lifecycle. `inference.engine_workflows` records availability per engine. `inference.visual_engines` stores the token envelope-encrypted.
- **Replaces** `persona_runtime_config.image_workflow_key` / `video_workflow_key` with `identity.workflow_bindings` (per influencer, per purpose, version range).
- **Model-agnostic records:**
  - `content.generation_jobs.model` and `prompt` become nullable;
  - `identity.model_adapters.base_model` becomes nullable;
  - adapters gain an opaque `engine_ref`.
- **Adds:**
  - `inference.visual_jobs`: the persistent queue and platform state machine;
  - `inference.visual_job_events`: append-only;
  - `identity.qa_thresholds`;
  - `core.api_tokens`;
  - `core.users.is_platform_admin`;
  - seeded system roles and permissions.
- **Media assets** gain `visual_job_id`, `engine_output_id`, `engine_kind` and `qa_summary`. `storage_key` is no longer unique: the content-addressed files may be shared by identical outputs.
- **Backstop triggers:**
  - approval decisions: requester ≠ approver, payload hash, pending and unexpired;
  - publication authorization bound to the approved revision hash;
  - no contract-mock assets in `publishing`/`published`;
  - manifest immutability.
- **Default partitions** for partitioned tables.
- **RLS:**
  - on the new tenant tables and on `core.integration_accounts`;
  - read/append policies on `core.audit_log`.
- **Grants for runtime roles:** SELECT/INSERT/UPDATE only, no DELETE. UPDATE is revoked on the append-only tables. There is no direct access to partitions.

## 6. Design changes against docs 04, 07, 13 and 15

- **GPU scheduling for media** is implemented in the TypeScript platform (`visual/scheduler.ts`, `dispatcher.ts`):
  - priority classes P2–P5;
  - aging of at most one class;
  - deadline urgency;
  - per-influencer daily fair share;
  - measured-VRAM admission with strict head-of-line;
  - engine concurrency slots;
  - kill switches.

  It replaces the media half of the planned Python "GPU Arbiter". The chat-lane half (P1) arrives with the local LLM in Phase 3. P0 (payments) never uses the GPU.
- **Image and video model choices in doc 15 §2.4–2.6 are advisory input for Track A**, not platform decisions. The platform depends on none of them.
- **Docs 07 and 13 describe ComfyUI internals** (graphs, LoRA swaps, degradation ladders). These are Track A implementation guidance. The platform-side contract is `contracts/visual-engine/README.md`.

## 7. Next (Phase 2 candidates, in order)

1. Run B1 on the workstation. Install PostgreSQL 16 there, migrate, and run the full suite (`npm test`).
2. Track A conformance (B2), then the vertical slice on the real engine, with `validation_scope = real_engine` evidence.
3. Outbox dispatcher and audit seal job.
4. OIDC staff login and a minimal admin UI over the existing API.
5. Local LLM selection and benchmarks (B-LLM-*), then the conversation engine.
