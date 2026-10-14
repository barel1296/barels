# AI Influencer Operating System: Phase 1 Architecture & Plan

> Status: **Proposed for approval. No application code yet.** · Date: 2026-10-14 · Author: CTO / Principal Architect

## Executive summary

We will build a **modular monolith**:

- **Core stack:** TypeScript on Node 24, PostgreSQL as the system of record, BullMQ on Redis/Valkey for jobs, and Cloudflare R2 for media.
- **Hosting:** Render, with fully separate staging and production.
- **Modules:** ten bounded modules (Identity, Content, Publishing, Conversation, Monetization, CRM, Analytics, Agents, Approvals, plus Platform core). Each owns its own Postgres schema.
- **Integration:** modules talk through in-process interfaces and a transactional outbox.
- **External calls:** every one goes through a Provider Gateway, which applies idempotency, rate limits, retries, circuit breaking and cost metering.
- **Agents:** they **propose** structured actions. A deterministic executor carries them out only after a **Policy Engine** resolves the autonomy level, and through approval when required. Moving an action from Level 0 to Level 4 is a configuration change backed by QA evidence, not a rewrite.

The research changed the plan in five important ways:

1. **The MVP must be SFW** (rating ceiling `suggestive`). Explicit or adult content is blocked on every layer of the realistic stack:
   - Instagram removes AI nudity and bans links to paid adult content.
   - Telegram Stars run on App Store/Play rules, and Telegram removes porn bots.
   - Every researched image and video vendor prohibits explicit output.
   - Anthropic's usage policy prohibits erotic chat.
   - UK and US law would require highly effective age assurance.

   The data model supports rating-gated content and age gates, but an adult tier is a separate product decision, not a toggle.
2. **Sell premium access as a bot Star subscription and gate the premium channel with bot-approved join requests.** Telegram's native channel-subscription links give the bot no payment or renewal events, and Bot API 10.2 `subscription` updates make the bot route reliable. PPV is sold in bot DMs, the only place paid-media purchases are reported to the bot.
3. **AI processing of Telegram messages requires explicit, per-chat consent** under Telegram's terms. This is a hard gate in the conversation pipeline.
4. **The persona bot is a "companion chatbot"** under California SB 243 and New York's AI-companion law. That means AI disclosure at the start and every 3 hours, a published crisis protocol, and a de-identified referral log. It is also why we need a **minimal static legal and safety page**, despite "no public website".
5. **Conversation model choice dominates unit economics.** At scale, chat costs ≈ $37k/month on Opus 5.5, ≈ $19.5k on Sonnet 5.5, and ≈ $1k on Haiku 5.5. We will decide per route from evals in Phase 2.

**MVP:** about 15 weeks to public launch for one influencer, across 4 phases, with a 2–3 week closed beta in which chat runs as **AI drafts approved by operators**.

**Running cost:** ≈ $620–1,340/month for infrastructure and AI at MVP volume, excluding people. See doc 12.

## Document map

| # | Document | Covers task item |
|---|---|---|
| 01 | [Requirements analysis](01-requirements-analysis.md) | 1. Analyze requirements |
| 02 | [Platform capabilities: verified vs. assumed](02-platform-capabilities.md) | 2. Integration constraints and API capabilities |
| 03 | [Risk register](03-risk-register.md) | 3. Technical and business risks |
| 04 | [System architecture](04-system-architecture.md) | 4. System architecture |
| 05 | [Data model](05-data-model.md) + [reference DDL](schema/schema.sql) | 5. Database schema |
| 06 | [Agent system](06-agent-system.md) | 6. Agent system |
| 07 | [Content production pipeline](07-content-pipeline.md) | 7. Content pipeline |
| 08 | [Telegram monetization & entitlements](08-telegram-monetization.md) | 8. Monetization workflows |
| 09 | [Operations & security](09-operations-security.md) | 9. Operational and security requirements |
| 10 | [Implementation plan](10-implementation-plan.md) | 10. Phased plan |
| 11 | [MVP acceptance criteria](11-mvp-acceptance-criteria.md) | 11. Acceptance criteria |
| 12 | [Cost model](12-cost-model.md) | 12. Infrastructure and AI costs |

## Key architecture decisions

| # | Decision | Main alternative | Why |
|---|---|---|---|
| AD1 | Modular monolith, one schema per module, outbox events | Microservices | Small team, I/O-bound workloads; extraction path preserved |
| AD2 | TypeScript end-to-end | Python | One language for API, workers, bot and dashboard; shared Zod schemas for API contracts and agent outputs |
| AD3 | Postgres state machines + BullMQ jobs | Temporal/DBOS durable workflows | Short workflows; fewer moving parts. Revisit for long-running agent workflows. |
| AD4 | Shared DB/schema multi-tenancy + RLS | DB per tenant | Scales to hundreds of workspaces; silo option kept |
| AD5 | Agents only propose; the executor acts after policy and approval | Agents with direct tools | Bounded autonomy, one audited execution path for humans and agents |
| AD6 | Autonomy = per-action policy rows promoted by QA evidence | Hard-coded modes | L0→L4 without code changes; automatic demotion |
| AD7 | Bot Star subscription + join-request-gated premium channel | Native channel subscription links | Payment visibility, unified entitlements, reconciliation |
| AD8 | Single entitlement engine as the source of truth | Per-feature flags | Bundles, refunds, erasure and audits all consistent |
| AD9 | Stars as the accounting unit; fiat only as a labelled estimate or realized payout | Fixed USD conversion | Stars have no fixed value |
| AD10 | Provider ports + data-driven router with per-provider max rating | Hard-wired vendors | Vendors are discontinued (e.g. Sora API) and policies differ |
| AD11 | Approvals bound to content and payload hashes, enforced by DB constraints | Status flags only | What was approved is exactly what ships |
| AD12 | Telegram Business + connected bot for the personal account; **no userbots** | MTProto automation | Telegram ToS; permitted method; Premium no longer required |
| AD13 | Render PaaS + R2 + Doppler + KMS | AWS ECS/RDS | Least ops for the MVP; Docker keeps AWS as an exit path |

## Decisions needed from you

| # | Decision | My recommendation |
|---|---|---|
| **D1** | Confirm the **SFW-only MVP** (`suggestive` ceiling on every channel) and treat any adult tier as a separate future product decision | **Yes.** It isn't viable on the current platforms and vendors, and it carries the highest legal risk. |
| **D2** | Approve a **minimal static legal and safety page** as an exception to "no public website" | **Yes.** It is required: Meta app privacy and data-deletion URLs, and the SB 243 published protocol. |
| **D3** | Conversation model per route (Opus 5.5 default vs. Sonnet 5.5 / Haiku 5.5) | Decide in Phase 2 from the eval suite plus cost per completed conversation. Safety cases must stay at 100%. |
| **D4** | Hosting: Render (PaaS) vs. AWS | **Render** for the MVP. |
| **D5** | Data residency | **EU** (Frankfurt) for the DB and storage. |
| **D6** | Closed beta with **L2 chat drafts**, which needs operator coverage (hours/day) | Yes. Staff 2 part-time operators during the beta. |
| **D7** | Launch audience | 18+ (self-attested), English first, EU/UK/US, with jurisdiction-aware disclosure config |
| **D8** | Budget envelope for MVP run-rate | ≈ $1–1.5k/month for infrastructure and AI, plus people, counsel and accountant |

## Evidence quality: please read

This environment's network policy blocked direct access to Meta, Telegram and most vendor sites. Research used:

- same-day **verbatim snapshots** of the Telegram docs, which give high confidence;
- **official-domain search excerpts** for Meta and the vendors, medium confidence;
- direct reads of Anthropic's usage policy and some Google pages.

Every claim in [doc 02](02-platform-capabilities.md) carries an evidence tag (V / E / R / A). **Phase 0 begins with a 12-item verification checklist** against the live primary docs, before any dependent code is written. Nothing in this plan relies on an unverified capability without a fallback.
