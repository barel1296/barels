# 01 — Requirements Analysis

> Status: Proposed · Inputs: the business brief, [02-platform-capabilities](02-platform-capabilities.md)

## 1. Problem restatement

We are building an **operating system for AI-generated virtual influencers**. Each influencer is a fictional, clearly disclosed AI persona with a consistent look, voice and story. The system runs the influencer across Instagram (top of funnel) and Telegram (community and monetization), and records every decision for later review. The business goal is a growing share of operations run autonomously and safely. The MVP proves the loop end-to-end for **one** influencer. The architecture must reach **many influencers across many workspaces** without a redesign.

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
| Availability | Bot replies and payment handling | 99.5% monthly | 99.9% |
| Availability | Admin dashboard | 99.0% | 99.5% |
| Latency | `pre_checkout_query` answered | p99 < 2s (hard platform limit: 10s) | same |
| Latency | Fan message → AI reply sent (includes a 2–4s debounce) | p95 < 12s | p95 < 8s |
| Latency | Payment → entitlement granted | p95 < 5s | p95 < 2s |
| Latency | Entitlement expired → removed from premium channel | < 1h after grace period | < 15 min |
| Punctuality | Scheduled publication executed | 95% within 5 min of schedule | 99% |
| Correctness | Duplicate publications or duplicate grants | 0 | 0 |
| Correctness | Payments reconciled to Telegram transactions | 100% daily, discrepancies alerted | same |
| Durability | RPO / RTO | 15 min / 4 h | 5 min / 1 h |
| Security | Staff auth | SSO + MFA; RBAC enforced server-side | + per-tenant SSO |
| Privacy | Erasure request completion | ≤ 30 days (target 7) | same |
| Auditability | Sensitive actions with audit entry and actor | 100% | 100% |
| Cost visibility | Vendor spend attributed to an influencer | ≥ 99% of spend; ±5% vs invoices | same |
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
| **One influencer vs multi-tenant ready** | Full multi-tenant data model and RLS from day one; one workspace with one influencer in production. |

## 6. Assumptions (to validate)

| ID | Assumption | Validation |
|---|---|---|
| AS1 | The company operates its own influencer accounts (no third-party accounts in the MVP), so Meta Standard Access is sufficient | Phase 0 test (doc 02 §8 #2) |
| AS2 | Launch audience: adults (18+, self-attested); primary language English; EU/UK/US reachable | Product decision |
| AS3 | Team: 2–3 engineers, 1 content/ops lead, 1–2 part-time operators/reviewers, fractional counsel/compliance | Staffing plan |
| AS4 | Content volume per influencer per month: IG 16 feed/carousel, 12 Reels, 60 Stories; TG free 30 posts; premium 40 items; 4 PPV sets | Content strategy |
| AS5 | Chat volume at MVP: ≤ 1,000 monthly active bot users, ≤ 30 messages each | Growth plan |
| AS6 | No fan-uploaded media is processed by AI or stored long-term in the MVP | Product decision |
| AS7 | Telegram bot remains the core paid surface; no fiat checkout in MVP | Business decision |

## 7. Out of scope for the MVP

- Explicit or `mature` content; age assurance vendor integration
- Fiat payments, a web checkout, a marketing website
- Voice notes/TTS and live video
- Paid ads and Meta ads automation
- Multiple workspaces (supported in data model only)
- Automated (L3+) Instagram DMs; L4 anything
- Telegram Business automation beyond AI drafts
- MTProto-based channel statistics
