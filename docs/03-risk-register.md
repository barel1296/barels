# 03 — Risk Register

> Status: Proposed · Review cadence: monthly, and on any platform policy change · Likelihood/Impact: L(ow) / M(edium) / H(igh)
>
> This is engineering and business risk analysis, **not legal advice**. Items marked ⚖️ need counsel sign-off before launch.

## 1. Top 10 (executive view)

| # | Risk | L | I | Primary mitigation |
|---|---|---|---|---|
| 1 | Instagram account restricted or removed (AI content, solicitation policy, automation patterns) | M | H | Business account; `suggestive` ceiling; no adult CTAs; AI labels; no engagement automation beyond official APIs; Telegram as the owned audience; backup handles reserved |
| 2 | Telegram policy or economics shift (Stars rate, fees, hold, adult/companion crackdowns, bot bans) | M | H | Stay SFW; Stars as accounting unit; diversified products; monitor the changelog and ToS; keep an export of fan consent records so the audience can be migrated |
| 3 | Companion-chatbot law non-compliance (CA SB 243, NY Art. 47, WA/OR from 2027, EU Art. 50) ⚖️ | M | H | Disclosure engine (start + every 3h), crisis protocol + published page, de-identified referral log, jurisdiction-aware config, counsel review |
| 4 | Harm to vulnerable users (emotional dependence, distress, overspending) | M | H | Crisis detection and escalation; ethical-monetization rules; spend caps; no manipulative tactics; QA sampling; incident process |
| 5 | Minors interacting with the bot | M | H | 18+ service; age attestation at `/start`; minor-signal classifier → restricted mode + human review; no romantic framing; no mature content |
| 6 | Unit economics fail (LLM and media cost per fan above Stars revenue) | M | H | Per-message cost metering; free-allowance caps; model/effort per route set from evals; caching; budgets with hard stops; pricing experiments |
| 7 | Character inconsistency / drift (vendor model updates, LoRA drift) | H | M | Versioned reference set; automated face + attribute checks; pinned model versions; calibration set re-run on vendor changes |
| 8 | Synthetic persona resembles a real person (likeness/NCII claims) ⚖️ | L | H | Celebrity/real-person resemblance check at design time and on every asset; takedown intake with a 48h SLA; persona design documented |
| 9 | Duplicate or missing actions on external platforms (double posts, double grants, missed revocations) | M | M | Idempotency ledger, ambiguous-outcome reconciliation, unique constraints, daily reconciliation jobs |
| 10 | Prompt injection / jailbreak makes the persona say prohibited things | H | M | Fan text treated as untrusted data; no side-effecting tools in the conversation path; output guard; red-team eval suite in CI |

## 2. Platform risks

| ID | Risk | L | I | Mitigation | Residual |
|---|---|---|---|---|---|
| P1 | IG removes or demotes AI content; "AI-generated profile" label missing → excluded from recommendations | M | H | Turn on the profile label at launch; `is_ai_generated` on posts (if confirmed); C2PA; disclosure in captions and bio | M |
| P2 | IG adult-solicitation policy triggered by funnel CTAs | M | H | Link-policy check on captions, bios, stories and DMs; Telegram assets linked from IG are SFW only; reviewer checklist | L |
| P3 | Meta App Review / Business Verification delays (needed for webhooks from non-role users, or for SaaS) | M | M | Phase 0 test; start Business Verification in week 1; MVP launch does not depend on IG DMs | L |
| P4 | Graph API version deprecations (roughly 2-year lifecycle) and metric changes (e.g. `impressions` → `views`) | H | L | Pinned version per adapter; contract tests; upgrade calendar | L |
| P5 | IG publishing limits (100/24h, 400 containers) or API outages | L | M | Quota check before publish; retries; manual fallback runbook | L |
| P6 | IG token expiry (60 days, unrecoverable if missed) | M | M | Refresh every ~30 days; alert at T−10 days; re-auth runbook | L |
| P7 | Telegram removes the bot or channels (reports, policy) | L | H | SFW content; prompt `/paysupport`; low refund-dispute rate; responsive moderation; documented ToS compliance | M |
| P8 | Telegram economics: Stars reward rate changes (currently "0.013 USD equivalent" at sole discretion), 21-day hold, 3-year expiry, chargebacks debited | M | M | Stars-native accounting; withdraw regularly; keep the 21-day float in treasury planning | M |
| P9 | Accidentally enabling private-chat topics triggers a 15% fee on all Stars purchases | L | M | Config assertion + startup check + runbook | L |
| P10 | Native channel subscription behavior is opaque (no payment events, unclear auto-removal) | — | — | Avoided by design: bot-managed subscriptions + join-request gating | L |
| P11 | Telegram AI-data consent rule violated (AI processing without explicit per-chat consent) | M | H | Hard consent gate in the conversation pipeline; tests; `/stopai` withdrawal | L |
| P12 | Business-bot ToS: concealing automation or sharing data with third-party APIs without authorization | M | H | Human-operated account; AI drafts only after the counterpart consents; disclosure in bio and first message | L |
| P13 | Platform concentration: all revenue on Telegram | H | H | Accept for the MVP; Phase 5 diversification (web checkout, other platforms) | H (accepted) |

## 3. Regulatory and legal risks ⚖️

| ID | Risk | L | I | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | EU AI Act Art. 50 (in force for new systems since 2026-08-02): chatbot disclosure, deepfake disclosure (the Commission's guidelines treat a photorealistic invented person as a deepfake), machine-readable marking | M | H | Disclosure engine; visible "AI-generated" marks on persona media; keep vendor C2PA + our own manifest | L |
| R2 | California SB 243 (companion chatbots): disclosure, crisis protocol **published on a website**, minor protections, a "may not be suitable for some minors" notice, annual reporting from 2027-07-01, private right of action ($1,000/violation reported) | M | H | Crisis protocol v1; static legal and safety page; de-identified referral log; notice in bot description and `/start` | L |
| R3 | New York GBL Art. 47: notice at start and every 3h for all users; self-harm protocol; AG enforcement | M | H | 3-hour re-disclosure timer (config per jurisdiction; applied globally by default) | L |
| R4 | WA HB 2225 / OR SB 1546 (2027-01-01) and other state laws (≈22 chatbot laws) | M | M | Jurisdiction-aware policy config; quarterly legal review | M |
| R5 | GDPR: legal basis for memory, special categories (Art. 9), DPIA (Art. 35), erasure, minors (Art. 8); regulator precedent (Replika €5M) | M | H | Explicit consent per purpose; never store special-category data; DPIA before launch; DSR tooling; data minimization; EU hosting option for the DB | L |
| R6 | FTC: virtual-influencer endorsements must disclose material connections; fake testimonials banned; 6(b) scrutiny of companion monetization | M | M | Sponsored-content workflow with mandatory disclosure; no product testimonials implying real use; ethical-monetization rules | L |
| R7 | Age-assurance laws (UK OSA Part 5, ~25 US states, EU DSA guidance) if any adult content were offered | — | H | **Avoided:** no `mature`/`explicit` content in the MVP | L |
| R8 | TAKE IT DOWN Act / likeness and IP claims (brand logos, copyrighted characters, real-person resemblance) | L | H | Resemblance and brand/text checks in validation; takedown intake (48h); legal review of persona origin | L |
| R9 | Tax/accounting for Stars → TON → fiat (revenue recognition, FX, VAT on digital services, DAC8/KYC) | H | M | Engage an accountant before the first withdrawal; payout ledger with tx refs and rates | M |
| R10 | Consumer protection: refunds for non-reclaimable digital services; Telegram discourages real-time sale of such services | M | M | Clear pricing; refund policy (unused credits refundable); prompt `/paysupport`; credits instead of per-message charges | L |
| R11 | AI vendor usage policies: Anthropic prohibits erotic chat and sexual content and requires AI disclosure; media vendors prohibit explicit output (Runway: even lingerie) | M | H | Provider-eligibility table; rating ceiling; output guard; refusal handling; quarterly policy review | L |

## 4. Safety and ethics risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| S1 | Fan in crisis (self-harm) | M | H | Input classifier on every message; crisis-referral response template (localized); immediate human escalation (critical, 15-min SLA in staffed hours); no monetization in that conversation for 72h |
| S2 | Emotional dependence / parasocial harm | M | H | No exclusivity or jealousy scripts; no "I need you" framing; persona boundaries in the persona spec; periodic AI reminders; usage-pattern flags → operator review |
| S3 | Over-spending / exploitation | M | H | Offer caps (e.g. ≤2 offers/day, ≤1 unsolicited per 48h); optional monthly spend caps; flag users with spend spikes; no countdown or scarcity manipulation |
| S4 | Minor detected | M | H | Restricted mode (no offers, no persona flirtation), human review, account closure if confirmed; never store age evidence documents |
| S5 | Deception: persona claims to be human, invents real-world meetups, claims real-world services | M | H | Hard rule + output guard; canon facts mark the persona as fictional; regression evals |
| S6 | Harassment or abuse directed at the persona; fans sharing illegal content | M | M | Block/report flows; MVP does not retain fan media; illegal-content runbook |

## 5. Business and economic risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| B1 | Low conversion because of disclosure and SFW constraints | M | H | Strong persona and storytelling; premium value = exclusivity, early access, personalization; pricing experiments |
| B2 | LLM cost per active chatter exceeds revenue | M | H | Free daily allowance; credits; per-route model/effort decision backed by evals (doc 12 shows the sensitivity); caching; summarization |
| B3 | Media cost overruns (video regeneration loops) | M | M | Per-item generation budgets; candidate caps; cheap drafts before final renders; video only from approved keyframes |
| B4 | Refund abuse / disputes | L | M | Refund policy; dispute-rate monitoring; block abusive accounts |
| B5 | Market fatigue for AI influencers | M | M | Differentiate on story and community; fast experiment loop; multi-influencer portfolio |
| B6 | Reviewer bottleneck (L2 queues) delays content and chats | H | M | Batch approval UX; SLAs; autonomy promotion as QA evidence accumulates; priority queues |

## 6. Technical risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| T1 | Vendor discontinuation (e.g. Sora API shut down 2026-09-24; Imagen removed from the Gemini API) | H | M | Provider ports + primary/fallback per capability; no vendor-specific data in the domain model |
| T2 | Character drift on vendor model updates | H | M | Pin model versions; calibration-set regression on update; reference-set/LoRA re-training playbook |
| T3 | C2PA manifests stripped by our own re-encoding | H | L | Keep the signed original; re-sign renditions with our manifest; tests |
| T4 | Ambiguous outcomes (timeouts) cause duplicates | M | M | Idempotency ledger; `UNKNOWN` state + reconciliation; no blind retries of non-idempotent calls |
| T5 | Webhook loss or processing failure | L | H | Persist-before-ack; retries; DLQ; Telegram keeps updates 24h; reconciliation jobs |
| T6 | LLM latency spikes / provider outage | M | M | Timeouts; fallback model config; holding message ("give me a sec"), never silence; circuit breaker |
| T7 | Cross-fan memory leakage | L | H | Memory retrieval scoped by `(influencer_id, fan_id)` in the query layer + RLS; tests; no shared caches keyed only by influencer |
| T8 | Queue backlog starves the real-time path | M | M | Separate `worker-realtime`; queue-depth alerts |
| T9 | Secrets leak (bot tokens, IG tokens, vendor keys) | L | H | Secrets manager; envelope encryption; token rotation runbooks; secret scanning in CI; least privilege |

## 7. Operational risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| O1 | No 24/7 coverage for critical escalations | H | H | Staffed-hours SLA; outside hours the bot uses the safe crisis template + auto-pause of AI for that fan; pager for sev1 |
| O2 | Key-person dependency | M | M | Runbooks; IaC; two admins for every platform account (Meta Business, BotFather tokens kept in the vault) |
| O3 | Loss of platform account access (2FA device, phone number for the Telegram account) | M | H | Credentials in the vault; recovery codes; dedicated company-owned phone numbers; access review |
| O4 | Incorrect financial reporting from Stars valuation | M | M | Label every fiat figure as an estimate with its valuation id; finance sign-off monthly |

## 8. Decisions this register forces

1. **SFW-only MVP** (`suggestive` ceiling). Mature/explicit tiers out of scope (R7, R11, P2).
2. **Minimal static legal and safety page** is required despite "no public website" (R2, Meta privacy-policy URL).
3. **Explicit AI-processing consent** before any AI reads Telegram messages (P11).
4. **18+ service with attestation**, minor-signal handling and restricted mode (S4).
5. **Accountant engaged before the first Stars withdrawal** (R9).
6. **Counsel review** of: disclosure cadence, crisis protocol, privacy policy, terms, DPIA, persona likeness, sponsored-content rules.
