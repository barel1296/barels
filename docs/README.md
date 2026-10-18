# AI Influencer Operating System: Architecture & Implementation Plan

> Status: **Platform and Windows deployment package implemented. 216/216 automated tests pass against simulated external systems. Not yet run on the workstation or with real ComfyUI, LLM, Telegram or Meta** (see [16 — Implementation status](16-implementation-status.md)). Architecture below remains the design. · Revision: **2026-10-18 — MVP scope update: 20–30 personas on one Windows workstation (RTX 5090 Laptop, 24 GB), all AI inference local, ComfyUI as media engine** · Previous revision: 2026-10-14 (cloud design)

## Executive summary

The platform is a **modular monolith plus one shared Inference Host** on a single Windows 11 Pro workstation.

**Runtime and storage:**

- All services run in WSL2 under systemd: Postgres 16 (records **and** persistent job queues), the TypeScript domain application, a Python Inference Host, a local OpenAI-compatible LLM engine, and ComfyUI.
- Media lives on local disk, with encrypted offsite backups.

**Connectivity, with no inbound ports:**

- Telegram via long polling.
- Meta webhooks and signed media URLs via a free Cloudflare Tunnel.
- Staff access through Cloudflare Access + SSO.

**No paid AI APIs, no managed GPUs, no Kubernetes.**

**What makes 30 personas work on one GPU:**

1. **Personas share inference.** One resident chat model serves every persona through persona prompts. One ComfyUI instance renders for every persona by swapping **per-persona LoRAs**. A persona is configuration (`identity.persona_runtime_config`), not infrastructure.
2. **A GPU Arbiter owns the 24 GB.** It keeps a resident chat lane, gives paid fans' chats priority, runs media in a measured VRAM budget, schedules media fairly across personas with model-affinity campaigns, and handles thermal throttling and OOMs. Payments never touch the GPU (doc 13).
3. **Capacity is measured, not assumed.** Configured personas and concurrent chatters are separate limits (`N_max` vs. `A_max`). Both are computed from benchmarks run on *this* machine (doc 14). No performance number in these docs is invented; every sizing value is a parameter until measured.
4. **The licence comes first in model choice** (doc 15). Image and video choices are **advisory input for Track A**, which owns them since the 2026-10-18 Golden Influencer update. The platform reaches media only through the model-agnostic [Visual Engine Contract](../contracts/visual-engine/README.md):
   - **Images (Track A decision):** Z-Image Turbo with persona LoRAs; edits with Qwen-Image-Edit-2511.
   - **Video (Track A decision):** Wan 2.2 image-to-video.
   - **Chat and image judging:** Qwen3.5-9B. **Safety:** Qwen3Guard. **Embeddings:** Qwen3-Embedding.
   - **Engine:** llama.cpp or vLLM.
   - All are Apache/MIT, and are **candidates in a Stage-0 bake-off** judged by blind quality panels.
   - Popular alternatives are excluded as non-commercial or territory-restricted: FLUX dev models, InsightFace-based face adapters, Hunyuan, SUPIR, CodeFormer and others.
5. **Rollout is gated.** One complete persona end-to-end first, then 5 → 10 → 20–30 in batches of five. Each step happens only after measured acceptance gates pass. **If the workstation's measured limit is below 30, the plan stops there** and offers lower content tiers or a second inference node, never lower quality or safety bars.

**Everything required before is preserved:**

- consent gate;
- AI disclosure cadence;
- crisis protocol;
- SFW policy;
- payment integrity;
- entitlements;
- audit;
- RBAC;
- tenant isolation.

**Local inference relaxes none of them.** It removes vendor safety layers, so our guards and validators get stricter.

**Costs:**

- **No per-call AI fees.** Recurring cash costs are electricity (metered), connectivity, offsite backup storage (e.g. B2 at $6.95/TB-month), phone numbers, a domain and hardware amortization.
- All are recorded monthly with evidence (doc 12).
- **The binding constraints are now GPU capacity, single-host availability, and human review time.**

## What changed in this revision (2026-10-18)

| Area | 2026-10-14 (cloud) | 2026-10-18 (this revision) |
|---|---|---|
| Hosting | Render PaaS, managed Postgres, Redis, R2 | One Windows workstation; WSL2 + systemd; Postgres also as queue; local content store |
| AI | Claude API, cloud image/video vendors, cloud moderation | **All local:** LLM engine, ComfyUI, local guard, classifiers, face scoring, C2PA signing |
| Ingress | Webhooks to a cloud API | Telegram long polling; Cloudflare Tunnel for Meta and media URLs |
| Scale target | 1 influencer MVP | 1 → 5 → 10 → 20–30 personas, measured gates |
| New docs | — | [13 GPU scheduling & capacity](13-gpu-scheduling-and-capacity.md), [14 benchmark protocol](14-benchmark-protocol.md), [15 local model stack & licensing](15-local-model-stack.md) |
| Schema | 10 tenant schemas | + `inference` (licence-gated model registry, workflows, GPU nodes/modes/jobs) and `ops` (benchmarks, capacity, energy, cost ledger); 14 DB invariant tests |
| Unchanged | Module boundaries, command bus, policy engine, consent and disclosure, SFW decision, Stars monetization and entitlements, approvals, audit, RBAC, multi-tenancy | — |

## Document map

| # | Document | Covers |
|---|---|---|
| 01 | [Requirements analysis](01-requirements-analysis.md) | Scope update, goals in priority order, NFRs, tensions |
| 02 | [Platform capabilities: verified vs. assumed](02-platform-capabilities.md) | Instagram, Telegram, 30-persona account limits, legal; cloud vendors (superseded) |
| 03 | [Risk register](03-risk-register.md) | Revised top 10 + single-workstation risks |
| 04 | [System architecture](04-system-architecture.md) | Deployment topology, processes, modules, ingress, environments, scale-out |
| 05 | [Data model](05-data-model.md) + [DDL](schema/schema.sql) + [invariant tests](schema/invariants_test.sql) | Schemas, state machines, invariants, retention, erasure. **Authoritative schema is now [`db/migrations/`](../db/migrations/)** |
| 06 | [Agent system](06-agent-system.md) | Agents on local models, autonomy levels, autonomy as a scaling gate |
| 07 | [Content pipeline](07-content-pipeline.md) | ComfyUI workflows, persona LoRAs, local validation, provenance |
| 08 | [Telegram monetization & entitlements](08-telegram-monetization.md) | Stars flows for 30 bots, outage-safe payment integrity |
| 09 | [Operations & security](09-operations-security.md) | Local secrets, observability, backups/DR, Windows host hardening |
| 10 | [Implementation plan](10-implementation-plan.md) | Stages 0–5 and the 1 → 5 → 10 → 20–30 rollout |
| 11 | [Acceptance criteria & stage gates](11-mvp-acceptance-criteria.md) | Gate tests G0, G1, G2, G3, G4.n |
| 12 | [Operating cost model](12-cost-model.md) | Measured monthly cost ledger, unit costs, attribution |
| 13 | [GPU scheduling, capacity & admission control](13-gpu-scheduling-and-capacity.md) | VRAM model, modes, arbiter, fair share, capacity formulas, limits |
| 14 | [Benchmark protocol](14-benchmark-protocol.md) | Hardware/model benchmarks, quality evals, drills, recording rules |
| 15 | [Local model stack & licensing](15-local-model-stack.md) | Candidates, exclusions, licence workflow, hardware requirements (image/video sections advisory to Track A) |
| 16 | [Implementation status](16-implementation-status.md) | What is built, how it was validated (contract-tested vs. real), blockers |
| — | [Visual Engine Contract v1](../contracts/visual-engine/README.md) | Track A ↔ Track B API: OpenAPI, JSON Schemas, state machines, error codes, conformance |
| — | [Platform README](../apps/platform/README.md) | Setup, operations runbook, API walkthrough, error codes, tests |

## Key architecture decisions

| # | Decision | Main alternative | Why |
|---|---|---|---|
| AD1 | Modular monolith + one Inference Host on one machine | Microservices / per-persona stacks | Minimal ops; personas are configuration; failure domains still isolated by process |
| AD2 | TypeScript domain app + Python Inference Host | All-Python / all-TypeScript | Domain design and Telegram stack unchanged; ML ecosystem is Python |
| AD3 | Postgres-backed persistent queues (incl. `inference.gpu_jobs`) | Redis/BullMQ | Persistence by design, transactional enqueue, one less stateful service |
| AD4 | Shared DB/schema multi-tenancy + RLS | DB per tenant | Unchanged |
| AD5 | Agents propose; executor acts after policy and approval | Agents with direct tools | Unchanged |
| AD6 | Autonomy = per-action policy rows promoted by evidence, **and a rollout gate** | Hard-coded modes | L2 chat drafts don't scale to 30 personas |
| AD7 | Bot Star subscription + join-request-gated premium channel | Native channel subscription links | Unchanged (payment visibility) |
| AD8 | Single entitlement engine | Per-feature flags | Unchanged |
| AD9 | Stars as accounting unit; fiat only estimated or realized | Fixed USD rate | Unchanged |
| AD10 | **GPU Arbiter** with measured VRAM budgets, resident chat lane, fair share, campaigns | FIFO GPU queue | Chat reliability and fairness across 30 personas on one GPU |
| AD11 | **Licence-gated model registry** (DB trigger) | Ad-hoc model downloads | Commercial use is the first quality requirement |
| AD12 | **Consistency via persona LoRAs + reference editing** on Apache/MIT bases | InsightFace-based face adapters | Those depend on non-commercial weights |
| AD13 | Telegram long polling + Cloudflare Tunnel (free) | Inbound webhooks / port forwarding | No inbound ports; Telegram's 24 h retention covers short outages |
| AD14 | Measured capacity with explicit stop rule | Promise 30 up front | Honest scaling; scale-out path designed in (second node) |
| AD15 | Telegram Business only for selected personas | All 30 | Phone-number sourcing and human operation cost |

## Decisions needed from you

| # | Decision | My recommendation |
|---|---|---|
| **D1** | Keep the **SFW-only** product (`suggestive` ceiling). Local models don't change the platform, legal or age-assurance reasons. | **Yes** |
| **D2** | Minimal static legal and safety page (Cloudflare Pages, free) as an exception to "no public website" | **Yes** (required: Meta app URLs, SB 243 published protocol) |
| **D3** | Confirm the **hardware baseline**: ≥ 64 GB RAM (96–128 GB if the chassis allows), ≥ 2 TB NVMe, ≥ 4 TB backup disk, router UPS, smart plugs | **Yes.** Video feasibility depends on RAM. |
| **D4** | Accept a **single point of failure** for the MVP (target RTO ≤ 24 h on replacement hardware; payments outage-safe) | **Yes for Stages 0–2.** Revisit at D10. |
| **D5** | Accept **"measured maximum < 30 personas"** as a valid outcome, with tiers and scale-out as the response | **Yes.** No benchmark exists yet for this laptop GPU under this mix. |
| **D6** | Content **tiers** per persona (Lite / Standard / Plus) instead of one content plan for all 30 | **Yes** |
| **D7** | **Meta Business Verification** and **two BotFather owner accounts** in Stage 0 | **Yes** |
| **D8** | Telegram Business account **only for selected personas** | **Yes** |
| **D9** | Closed beta with operator-approved chat drafts, then **L3 for low-risk chat intents as the gate to 10+ personas** | **Yes** |
| **D10** | Revenue threshold at which to add a **warm standby** or **second inference node** | Set when monthly revenue exceeds the cost of one day of downtime |
| **D11** | Budget for **counsel review of model licences** (doc 15 §6) before G0 | **Yes.** Licences are now a top risk. |
| **D12** | Launch audience | 18+ (self-attested), English first, EU/UK/US, jurisdiction-aware disclosure |

## Evidence quality: please read

This environment's network policy blocked most vendor and platform sites. Research used:

- verbatim primary text where available: LICENSE and README files on GitHub, mirrored Telegram Bot API text, the ComfyUI source;
- official-domain search excerpts elsewhere.

Every claim carries an evidence tag (V / E / R / A) in docs 02 and 15.

**No benchmark figures were taken from the internet.** Docs 13 and 14 define what to measure on the production workstation, and the gates in doc 11 refuse unmeasured values.
