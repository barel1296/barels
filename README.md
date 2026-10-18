# barels — AI Influencer Operating System

A multi-influencer platform for running clearly disclosed, AI-generated virtual influencers across Instagram and Telegram. It covers content production, publishing, conversations, monetization (Telegram Stars), analytics, and a policy-bounded agent layer with human approval.

**Deployment target (MVP):** 20–30 personas on one Windows workstation (RTX 5090 Laptop GPU, 24 GB). All AI inference is local; ComfyUI is the media engine.

**Status (2026-10-18):** Phase 1 implemented. The platform foundation and the first vertical slice ("Golden Influencer") run end to end against the Visual Engine Contract **test adapter**. Real ComfyUI integration and workstation validation are **not done yet**: see [`docs/16-implementation-status.md`](docs/16-implementation-status.md).

| Path | What |
|---|---|
| [`apps/platform/`](apps/platform/README.md) | Platform backend (TypeScript, Node 22, PostgreSQL 16): API, workers, GPU-aware media scheduler, contract gateway, approvals, publishing, audit |
| [`contracts/visual-engine/`](contracts/visual-engine/README.md) | Visual Engine Contract v1 between the platform (Track B) and the ComfyUI-backed engine (Track A) |
| [`db/`](db/) | Role bootstrap and authoritative migrations |
| [`ops/`](ops/) | PostgreSQL compose file, env template, host verification scripts |
| [`docs/`](docs/README.md) | Architecture, plans, status and test evidence |

Start here: [`docs/README.md`](docs/README.md). It has the executive summary, key decisions, open decisions, and the map to the full design.
