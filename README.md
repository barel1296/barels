# barels — AI Influencer Operating System

A multi-influencer platform for running clearly disclosed, AI-generated virtual influencers across Instagram and Telegram. It covers content production, publishing, conversations, monetization (Telegram Stars), analytics, and a policy-bounded agent layer with human approval.

**Deployment target (MVP):** 20–30 personas on one Windows workstation (RTX 5090 Laptop GPU, 24 GB). All AI inference is local; ComfyUI is the media engine.

**Status (2026-10-18):**

- **Implemented:** the platform and the Windows deployment package. That covers personas, conversations with a local LLM, fan memory, agents, the content calendar, the ComfyUI bridge, media library and QA, Telegram (including Stars), Instagram, analytics, the admin dashboard, auth/audit/monitoring and backups.
- **Tested:** 216/216 automated tests pass against PostgreSQL 16 and **simulated** LLM, Telegram, Instagram and ComfyUI.
- **Not done yet:** workstation deployment, real ComfyUI/LLM/Telegram/Meta validation and production.
- Details in [`docs/16-implementation-status.md`](docs/16-implementation-status.md).

| Path | What |
|---|---|
| [`apps/platform/`](apps/platform/README.md) | The platform (TypeScript, Node 22, PostgreSQL 16): API, worker, admin dashboard, ComfyUI bridge, integrations |
| [`deploy/windows/`](deploy/windows/README.md) | Workstation installation, services, health, GPU monitoring, backup/restore, acceptance tests and guides |
| [`contracts/visual-engine/`](contracts/visual-engine/README.md) | Visual Engine Contract v1 between the platform (Track B) and the ComfyUI-backed engine (Track A) |
| [`db/`](db/) | Role bootstrap and authoritative migrations |
| [`ops/`](ops/) | PostgreSQL compose file, env template, host verification scripts |
| [`docs/`](docs/README.md) | Architecture, plans, status and test evidence |

Start here: [`docs/README.md`](docs/README.md). It has the executive summary, key decisions, open decisions, and the map to the full design.
