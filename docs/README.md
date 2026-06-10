# AI Growth Operating System — Founding Design Specification

**Codename: GROS (Growth Operating System)**
**Status:** Founding design, v1.0
**Date:** 2026-06-09

This is the complete founding-level design for an **Autonomous AI Growth Operating System** for mid-size mobile game studios and subscription app companies. It is not a dashboard. It is an AI Growth Team that understands the business, debates problems in a War Room, prepares executable actions, and operates under a strict human-approval regime — with an architecture built to graduate to supervised autonomy.

## How to read this spec

| # | Document | What it answers |
|---|----------|-----------------|
| 1 | [Executive Product Vision](./01-executive-vision.md) | What we are building and why it wins |
| 2 | [Product Principles](./02-product-principles.md) | What this product is — and is not |
| 3 | [User Personas](./03-user-personas.md) | Who uses it, their pains, JTBD, success metrics |
| 4 | [System Architecture](./04-system-architecture.md) | Full production-grade technical architecture |
| 5 | [Agent Architecture](./05-agent-architecture.md) | The 5 super-agents in depth |
| 6 | [War Room Design](./06-war-room-design.md) | The debate/decision/approval experience |
| 7 | [Data Model](./07-data-model.md) | PostgreSQL + ClickHouse schemas (DDL) |
| 8 | [API Plan](./08-api-plan.md) | Full API surface |
| 9 | [Recommendation Engine](./09-recommendation-engine.md) | Detection → diagnosis → reasoning → confidence |
| 10 | [Execution Layer](./10-execution-layer.md) | How actions are prepared, guarded, and executed |
| 11 | [Roadmap](./11-roadmap.md) | Phase 0 → Phase 8, with exit criteria |
| 12 | [QA & Validation Plan](./12-qa-validation-plan.md) | Technical, data, agent, security QA |
| 13 | [Claude Code Build Prompt Chain](./13-claude-code-prompt-chain.md) | Copy-paste-ready build prompts |
| 14 | [Risks & Mitigations](./14-risks-mitigations.md) | What kills this product and how we prevent it |
| 15 | [Final Recommendation](./15-final-recommendation.md) | How to start building, concretely, tomorrow |

## The one-paragraph version

Mid-size studios run growth with 3–8 people juggling AppsFlyer, Meta, Google, TikTok, RevenueCat, Firebase, spreadsheets, and gut feel. Decisions are slow, evidence is fragmented, and money burns while people reconcile dashboards. GROS ingests everything into a Single Source of Truth, runs five super-agents (Growth Director, Intelligence, Operations, Creative, Tracking/Data) that investigate, debate, and decide in a visible **War Room**, and converts decisions into **prepared, executable actions** — budget shifts, campaign changes, creative briefs, audience syncs — that a human approves with one click. Every claim is backed by a query you can inspect. Every action is audited, reversible, and guarded. Autonomy starts at Level 2 (prepare-for-approval) and graduates, per action type and per tenant, toward Level 4.

## Non-negotiables (carried through every document)

1. **Production-grade from day one** — multi-tenant, RBAC, audit logs, observability, error budgets.
2. **No fake demo logic** — every insight traces to a real query against real data; evidence is stored, replayable, and inspectable.
3. **Human-in-the-loop execution** — no campaign change, budget move, creative upload, or audience sync without approval in v1.
4. **Architecture for autonomy** — the approval gate is a policy, not a load-bearing wall; removing it later is a configuration change governed by guardrails, not a rewrite.
5. **LLM cost discipline** — statistics and SQL detect; LLMs interpret, debate, and synthesize. Never burn tokens on what a z-score can do.
