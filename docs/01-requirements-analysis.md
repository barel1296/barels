# 01 — Requirements Analysis

> Status: Proposed — **revised 2026-10-18 (MVP scope update: 20–30 personas, one workstation, all AI local)** · Inputs: the business brief, the 2026-10-18 scope update, [02-platform-capabilities](02-platform-capabilities.md), [15-local-model-stack](15-local-model-stack.md)

## 0. Scope update (2026-10-18)

| # | New constraint | Design consequence |
|---|---|---|
| C1 | **20–30 personas** at initial deployment | Shared inference services; per-persona configuration (`identity.persona_runtime_config`); fair-share GPU scheduling; gated rollout 1 → 5 → 10 → 20–30 (doc 10) |
| C2 | **One Windows workstation, RTX 5090 Laptop GPU (24 GB VRAM)** | Single-host topology (doc 04); a GPU Arbiter with measured VRAM budgets (doc 13); single-host resilience design (doc 09 §9, §11) |
| C3 | **All inference local:** conversations, images, video, embeddings, moderation, agents. No paid AI APIs, no managed GPUs. | Local model stack chosen licence-first (doc 15); Inference Host + ComfyUI + local LLM engine |
| C4 | **ComfyUI is the primary media engine** | Versioned workflows behind the [Visual Engine Contract](../contracts/visual-engine/README.md) (`inference.visual_workflows`: manifests with measured resource figures; ComfyUI internals are Track A's) |
| C5 | No unnecessary microservices, no Kubernetes | Modular monolith + one Inference Host; systemd units in WSL2 |
| C6 | Distinguish configured personas from concurrent users; **no invented benchmarks** | Separate capacity models (doc 13 §7); every sizing value comes from the benchmark protocol (doc 14) |
| C7 | Preserve security, consent, compliance, payment-integrity and audit requirements | Unchanged requirements. Payments made GPU-independent; outage recovery via Telegram retention + reconciliation. |
| C8 | Start with one complete end-to-end persona; expand only after measured gates | Doc 10 stages and doc 11 gate tests |

**Optimization goals, in priority order** (they resolve trade-offs everywhere in these docs):

1. **Commercially usable content quality and character consistency.** This is why licence-clean model choice and per-persona LoRAs come first, and why quality beats throughput in model selection.
2. **Reliable customer conversations and monetization.** The chat lane is always resident, payments never wait on the GPU, and paid fans get chat priority.
3. **Minimal recurring infrastructure and AI costs.** Local inference and self-hosted tooling; recurring costs measured monthly (doc 12).
4. **Maximum automation with appropriate safeguards.** Autonomy promotion is evidence-based and a rollout gate (doc 06 §5.1).
5. **Extensibility beyond 30 personas.** Inference nodes register with the Postgres queue; a second GPU machine joins without redesign (doc 13 §10).

## 1. Problem restatement

We are building an **operating system for AI-generated virtual influencers**. Each influencer is a fictional, clearly disclosed AI persona with a consistent look, voice and story. The system runs the influencer across Instagram (top of funnel) and Telegram (community and monetization), and records every decision for later review. The business goal is a growing share of operations run autonomously and safely.

The MVP **starts with one complete end-to-end persona** and then scales on the same workstation to **20–30 configured personas**, each step gated by measurements. The architecture must reach many influencers and workspaces, including additional GPU machines, without a redesign.

## 2. Actors

| Actor | Description | Primary needs |
|---|---|---|
| Workspace owner / admin | Runs the business | Configure influencers, policies, budgets, autonomy; see P&L |
| Content manager | Shapes the persona and the content calendar | Plan, brief, generate, revise, schedule |
| Reviewer / approver | Gatekeeper for sensitive actions | Fast, unambiguous approval queue; diff of what will ship |
| Chat operator | Human in the loop for conversations | Live inbox, takeover, AI drafts, escalations |
| Compliance officer | Owns policy, disclosures, incidents | Policy editor, audit search, QA sampling, takedown handling |
| Finance | Revenue and cost | Stars ledger, payouts, valuations, cost per influencer, margin |
| Analyst | Growth | KPIs, funnels, experiments |
| AI agents (9) | Bounded automated actors | Read tools, proposal tools, budgets, clear policies |
| Fan | End user on Instagram and Telegram | Engaging persona, honest disclosure, control over their data, fair purchases |

## 3. Functional requirements, interpreted

Each requirement in the brief is mapped to a concrete interpretation. Where an interpretation narrows the brief, the reason is given.

| # | Brief requirement | Interpretation for design | Notes / reason |
|---|---|---|---|
| F1 | Instagram feed, Reels, Stories | Publish all formats via the official API on a **Business** account | Stories via API are Business-only (doc 02 §1.2) |
| F2 | Instagram comments, DMs | Comment inbox with AI-proposed replies; DMs within the 24h window; comment-to-DM private replies | Platform windows and human-agent rules apply |
| F3 | Instagram analytics | Insights snapshots stored in our DB (Meta keeps 90 days) | |
| F4 | Free Telegram channel | Bot-administered public channel: scheduled posts, teasers, deep links into the bot | Bot API offers no view counts (doc 02 §2.1) |
| F5 | Premium Telegram channel | Private channel; **entry only via join requests the bot approves for entitled fans**; expired fans removed | Native channel-subscription links give the bot no payment events |
| F6 | Locked photos/videos | Paid media sold **in bot DMs** (attributable). Channel paid media only for teasers. | Channel paid-media revenue goes to the channel with no events |
| F7 | Subscription lifecycle | Bot Star subscriptions (30-day fixed period) + `subscription` updates + reconciliation | |
| F8 | Telegram AI bot, persistent memory, paid interactions | Persona chat with consented memory; free daily allowance; message-credit packs; premium tier | Telegram requires explicit consent before AI processing |
| F9 | Telegram personal/business account | **Telegram Business + one connected bot.** Human operates; AI drafts (L2). | Userbots prohibited/high risk. Premium no longer required. |
| F10 | Consistent identity | Versioned persona (personality, style, biography, canon facts, visual identity) + reference set / LoRA + automated identity checks | |
| F11 | Content generation workflows | Image, identity validation, video, platform renditions, captions, moderation, approval, scheduling | Doc 07 |
| F12 | Configurable content policies | Rating scale + per-channel ceilings + banned themes + provider eligibility + disclosure rules | Rating ceiling is also enforced by vendor terms |
| F13 | Adult content restricted to eligible, age-verified users on compliant platforms | **Modelled but disabled.** `mature` behind a flag; `explicit` not supported. | Blocked by Instagram, Stars' app-store basis, every researched media vendor, the LLM vendor's policy, and age-assurance law |
| F14 | AI disclosure everywhere | Bios, channel descriptions, bot description, `/start`, first message in every conversation, periodic re-disclosure, captions, C2PA, `is_ai_generated` (if confirmed) | Several jurisdictions mandate this |
| F15 | Monetization tracking | Revenue (Stars), purchases, active subscribers, renewals, churn, conversion, revenue per influencer, AI costs, contribution margin | Fiat is always an estimate until payout |
| F16 | Nine specialized agents | Structured-output agents that **propose**; a deterministic executor acts after policy and approval | Doc 06 |
| F17 | Autonomy levels 0–4 | Per action type, per influencer, with promotion criteria from QA data | |
| F18 | Human approval & QA | Approval requests bound to content hashes; QA sampling of autonomous actions; incidents | |
| F19 | Admin dashboard | Operator, reviewer, finance and compliance consoles | |
| F20 | No public website | No marketing site. **Exception required:** a minimal static legal and safety page (privacy policy, terms, AI disclosure, crisis protocol, takedown contact). | The Meta app needs a privacy-policy URL; CA SB 243 requires the protocol to be published |

## 4. Non-functional requirements (targets)

| Area | Requirement | MVP target | Scale target |
|---|---|---|---|
| Availability | Payment handling (pre-checkout answered or cleanly failed; no charge without service) | **Measured monthly; target 99.5%** of minutes with the host up. A single host can't promise more; standby option D10. | 99.9% with a warm standby |
| Availability | Bot replies (any reply, including an honest holding message, within SLO) | Measured monthly; target 99.0% | 99.5% |
| Availability | Admin dashboard | 98% | 99% |
| Correctness | **Payment integrity after recovery from any outage** | **0 discrepancies** after reconciliation (doc 08 §4.8a) | same |
| Latency | `pre_checkout_query` answered | p99 < 2s (hard platform limit: 10s) | same |
| Latency | Fan message → AI reply sent (includes a 2–4s debounce), **at the stage's target load with media running** | p95 < 12s; holding message after `hold_after_s` (config) | p95 < 8s |
| Latency | Payment → entitlement granted | p95 < 5s | p95 < 2s |
| Latency | Entitlement expired → removed from premium channel | < 1h after grace period | < 15 min |
| Punctuality | Scheduled publication executed | 95% within 5 min of schedule | 99% |
| Correctness | Duplicate publications or duplicate grants | 0 | 0 |
| Correctness | Payments reconciled to Telegram transactions | 100% daily, discrepancies alerted | same |
| Durability | RPO / RTO | DB RPO ≤ 15 min, content ≤ 1 h; RTO ≤ 4 h same machine, ≤ 24 h on replacement hardware (verified by B-FAIL-7) | Warm standby: RTO ≤ 1 h |
| Capacity | Configured personas vs. concurrent chatters | Reported separately from measurements (doc 13 §7); scaling allowed only with ≥ 40% chat headroom and ≥ 30% media headroom | same |
| Content | Scheduled publications delivered on time, all personas | ≥ 95% within 5 min of schedule; no persona starved (> 24 h without GPU progress) | same |
| Security | Staff auth | SSO + MFA; RBAC enforced server-side | + per-tenant SSO |
| Privacy | Erasure request completion | ≤ 30 days (target 7) | same |
| Auditability | Sensitive actions with audit entry and actor | 100% | 100% |
| Cost visibility | GPU-seconds attributed to a persona; recurring cash costs evidenced | ≥ 99% of GPU-busy time attributed; every `ops.cost_entries` row with evidence | same |
| Tenancy | Cross-tenant data access | Impossible by RLS + app checks (tested) | same |
| Portability | Vendor replacement | Swap an image/video/LLM vendor by adapter + config, no schema change | same |

## 5. Tensions in the brief and how we resolve them

| Tension | Resolution |
|---|---|
| **"Highly autonomous" vs "all sensitive actions need approval initially"** | Autonomy is a *policy* per action type, not a code path. The MVP starts at L1–L2. Promotion to L3 needs measured QA evidence (doc 06 §5), so autonomy grows without code changes. |
| **Real-time chat vs human approval** | Approving every chat message doesn't scale and ruins UX. Plan: closed beta in **L2 draft mode** (operator approves AI drafts). Then promote low-risk intents to **L3** once QA thresholds are met. Sensitive intents (payments, distress, minors signals, refunds, complaints) always escalate. |
| **Persistent memory vs privacy law and Telegram's AI-consent rule** | Memory only after explicit consent; special-category data never stored (DB-enforced); fan-facing `/memory` and `/forget`; erasure cascade. |
| **Monetization pressure vs companion-chatbot laws and the FTC's focus on engagement tactics** | Ethical monetization rules in the policy engine: offer frequency caps, no offers during distress, no guilt or scarcity manipulation, optional spend caps, transparent pricing. |
| **"Adult-oriented content" vs every platform and vendor in the stack** | The architecture supports rating-gated content and age assurance as *capabilities*, but the MVP and the near-term roadmap are SFW. An adult product would need a separate legal/vendor/platform decision (doc 03). |
| **"Stars have no fixed USD value" vs contribution margin** | Report revenue in Stars. Fiat revenue is an *estimate* under a named valuation method (platform-quoted reward rate or trailing realized payouts). Realized fiat only appears from recorded payouts. |
| **"No public website" vs legal publication duties** | A minimal static legal and safety page, not a website. Decision required (see README). |
| **20–30 personas vs one power-limited laptop GPU** | Personas share inference (one chat model, one ComfyUI); per-persona tiers; fair-share GPU quotas; measured `N_max`. Rollout stops at the measured limit if it is below 30, and the scale-out path (second node) is ready. |
| **Local models vs commercial quality (goal #1)** | Licence-clean bake-off with blind human panels; persona LoRAs; human approval of every published asset. Quality decides the model; throughput is optimized second. |
| **Single host vs reliable monetization (goal #2)** | Payments never depend on the GPU; outage-safe payment flows (no charge without service); Telegram's 24 h retention + transaction reconciliation; tested restore; optional warm standby. |
| **No vendor safety layer vs safety requirements** | Local guard model, strict validators, prompt-layer bans, human approval, Q-CHAT-1 critical cases 100%. Local inference never relaxes the SFW or consent rules. |
| **Minimal cost vs reliability** | Free tiers and self-hosting by default. The few paid items (backup storage, connectivity, phone numbers, optional standby) are tracked as measured monthly costs (doc 12). |
| **One influencer vs multi-tenant ready** | Full multi-tenant data model and RLS from day one; one workspace with one influencer in production. |

## 6. Assumptions (to validate)

| ID | Assumption | Validation |
|---|---|---|
| AS1 | The company operates its own influencer accounts (no third-party accounts in the MVP), so Meta Standard Access is sufficient. With 30 accounts as app testers, Business Verification is needed for headroom (50-tester limit). | Stage 0 test (doc 02 §8 #2, #15) |
| AS2 | Launch audience: adults (18+, self-attested); primary language English; EU/UK/US reachable | Product decision |
| AS3 | Team: 2 engineers (one with ML-ops/ComfyUI depth), 1 content/persona lead, reviewers and operators scaled per stage (measured review load), fractional counsel/compliance | Staffing plan per stage |
| AS4 | Content volume per persona is set by **tier** (Lite / Standard / Plus, doc 13 §8), not one fixed plan. The mix across 30 personas must fit measured GPU capacity. | Content strategy + capacity worksheet |
| AS5 | Chat demand per persona is unknown. Stage 1 measures `Z` (seconds between a chatter's requests) and `κ` (peak concurrency ratio); later stages are sized from those measurements. | Stage 1 beta |
| AS8 | Workstation has ≥ 64 GB RAM (96–128 GB preferred) and ≥ 2 TB NVMe + a 4 TB backup disk (doc 15 §4) | Hardware inventory in Stage 0 |
| AS9 | The workstation runs at a controlled site with stable power and broadband; staff can physically intervene within hours | Ops plan |
| AS6 | No fan-uploaded media is processed by AI or stored long-term in the MVP | Product decision |
| AS7 | Telegram bot remains the core paid surface; no fiat checkout in MVP | Business decision |

## 7. Out of scope for the MVP

- Explicit or `mature` content; age assurance vendor integration
- Any paid/cloud AI API or managed GPU (excluded by C3); a cloud fallback is not built
- A second GPU node (designed for, built only when a gate requires it)
- TTS voice notes and lip-sync video (post-MVP, Stage 4+)
- Fiat payments, a web checkout, a marketing website
- Live video
- Paid ads and Meta ads automation
- Multiple workspaces (supported in data model only)
- Automated (L3+) Instagram DMs; L4 anything
- Telegram Business automation beyond AI drafts
- MTProto-based channel statistics
