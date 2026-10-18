# 03 — Risk Register

> Status: Proposed · Review cadence: monthly, and on any platform policy change · Likelihood/Impact: L(ow) / M(edium) / H(igh)
>
> This is engineering and business risk analysis, **not legal advice**. Items marked ⚖️ need counsel sign-off before launch.

## 1. Top 10 (executive view) — revised 2026-10-18 for the single-workstation, local-inference design

| # | Risk | L | I | Primary mitigation |
|---|---|---|---|---|
| 1 | **Single workstation is a single point of failure** (hardware fault, theft, power/internet loss, Windows update or driver regression) | M | H | Payments never depend on the GPU. Telegram's 24 h update retention + `getStarTransactions` reconciliation. Tested restore (B-FAIL-7). Controlled update windows. Optional warm standby (D10). See §1a. |
| 2 | **GPU capacity insufficient for 30 personas' content plans** on a power-limited laptop GPU | H | H | Measured `N_max` per tier (doc 13 §7). Content tiers. Gated rollout 1→5→10→20–30. Second inference node as the scale-out path. **The plan accepts "measured maximum < 30" as a valid outcome.** |
| 3 | **Local model quality below the commercial bar** (photorealism, identity consistency, chat persona quality) | M | H | Licence-clean bake-off with blind human panels (Q-IMG-1, Q-ID-1, Q-CHAT-1). Persona LoRAs. Human approval of all content. Quality outranks throughput. |
| 4 | **Licence traps** in local models and ComfyUI add-ons (non-commercial weights despite "commercial outputs" wording, territory exclusions, revenue caps, AGPL tools, upstream licence changes) | H | H | `inference.licenses` + DB trigger blocks approval; counsel review (doc 15 §6); excluded list; monthly licence-hash checks |
| 5 | Instagram enforcement, now across **30 accounts run by one operator** (AI content, solicitation policy, coordinated-network patterns) | M | H | Business accounts, AI labels, `suggestive` ceiling, no adult CTAs, **no cross-persona engagement automation**, Business Verification, staggered onboarding |
| 6 | Companion-chatbot law non-compliance (CA SB 243, NY Art. 47, WA/OR 2027, EU Art. 50) ⚖️ | M | H | Unchanged: disclosure engine, crisis protocol, referral log, counsel review |
| 7 | **No vendor safety layer**: local models will generate what they're asked | H | H | Prompt-layer bans; strict local validators (doc 07 W2); guard model; human approval; only approved models loadable; Q-CHAT-1 critical cases 100% |
| 8 | Harm to vulnerable users / minors interacting | M | H | Unchanged: crisis and minors protocols, 18+ service, ethical monetization, QA |
| 9 | **Chat degraded by GPU contention** (media jobs, mode switches, engine crashes) | M | H | Resident chat lane, admission control, paid-first priority, load shedding, holding messages, interference factor measured (B-LLM-5) |
| 10 | Operator/reviewer workload grows with persona count (L2 chat drafts, content approvals) | H | M | Autonomy promotion is a rollout gate (doc 06 §5.1); review time measured; staffing plan per stage |

## 1a. Risks introduced or changed by the single-workstation local-inference design

| ID | Risk | L | I | Mitigation | Residual |
|---|---|---|---|---|---|
| W1 | Hardware failure or theft of the workstation | L | H | Encrypted offsite backups; rebuild runbook (target ≤ 24 h on replacement hardware); BitLocker; physical security; optional warm standby | M |
| W2 | Power loss / internet loss | M | M | Laptop battery bridges short power cuts; router on UPS; optional 4G/5G failover; outbound-only design reconnects automatically; Telegram retains updates 24 h | L |
| W3 | Sustained-load thermal throttling and component wear (fans, battery swelling at 100% charge, VRM) from 24/7 GPU duty | H | M | Capacity from **sustained** benchmarks; thermal governor (duty-cycling media); ~80% battery charge cap; cooling stand; quarterly thermal re-test; hardware reserve in the budget | M |
| W4 | VRAM budget errors → OOM in the chat engine | M | H | Measured budgets only (DB-enforced); fail-loud sysmem policy; OOM ladder for media; chat OOM = incident + safer KV budget | L |
| W5 | Windows Update / NVIDIA driver / WSL updates break CUDA, ComfyUI or the engine | M | H | Update deferrals; monthly planned window; re-benchmark trigger; previous driver and WSL distro snapshot kept for rollback | L |
| W6 | Software immaturity on Blackwell laptop + WSL2 (engine kernels, attention libraries, custom nodes) | M | M | Stage-0 bake-off of two engines; pin versions; native-Windows ComfyUI fallback; avoid exotic kernels unless benchmarked | M |
| W7 | ComfyUI custom nodes / model files as a supply-chain attack vector (arbitrary code, pickles) | M | H | Pinned, reviewed custom nodes; ComfyUI Manager disabled in production; safetensors-only models with SHA-256 pins; engines run as unprivileged users bound to localhost | L |
| W8 | Storage exhaustion (media library, candidates, model versions, WAL) | M | M | Retention of rejected candidates (30 days); disk alerts at 85%; storage growth tracked per persona; second disk for backups | L |
| W9 | Data protection on a physical machine (local access, backups) | L | H | BitLocker, per-user services, localhost-only engines, client-side encrypted backups, access logging | L |
| W10 | Upstream model abandonment or licence change after adoption | M | M | Pinned weights archived locally; licence text archived with its hash at approval time; alternatives kept benchmarked | L |
| P14 | Meta treats the 30-account portfolio as a coordinated network → enforcement cascades | M | H | Transparent operator identity, AI labels, Business Verification, no cross-account engagement, staggered account onboarding, distinct content per persona | M |
| P15 | Telegram flags mass account/bot creation; phone-number sourcing for Business accounts | M | M | Two owner accounts for bots; Business accounts only for selected personas, with genuine company numbers; staggered creation | L |
| C1 | Capacity misjudged from non-representative benchmarks (desktop figures, burst runs, idle chat) | M | H | Doc 14 rules: production machine only, sustained runs, interference tests, environment fingerprints; gates require fresh runs | L |

**Changed rows below (2026-10-18):**

- **T1** (vendor discontinuation) now applies to *upstream open models*; see W10.
- **B2** (LLM cost per chatter) is now a **GPU-capacity** risk, not a cash risk; see Top-10 #2/#9.
- **R11** (AI vendor usage policies) is replaced by model **licence** risk (Top-10 #4) and the absence of vendor safety layers (Top-10 #7).

## 2. Platform risks

| ID | Risk | L | I | Mitigation | Residual |
|---|---|---|---|---|---|
| P1 | IG removes or demotes AI content; "AI-generated profile" label missing → excluded from recommendations | M | H | Turn on the profile label at launch; `is_ai_generated` on posts (if confirmed); C2PA; disclosure in captions and bio | M |
| P2 | IG adult-solicitation policy triggered by funnel CTAs | M | H | Link-policy check on captions, bios, stories and DMs; Telegram assets linked from IG are SFW only; reviewer checklist | L |
| P3 | Meta App Review / Business Verification delays (needed for webhooks from non-role users, or for SaaS) | M | M | Stage 0 test; start Business Verification in week 1; MVP launch does not depend on IG DMs | L |
| P4 | Graph API version deprecations (roughly 2-year lifecycle) and metric changes (e.g. `impressions` → `views`) | H | L | Pinned version per adapter; contract tests; upgrade calendar | L |
| P5 | IG publishing limits (100/24h, 400 containers) or API outages | L | M | Quota check before publish; retries; manual fallback runbook | L |
| P6 | IG token expiry (60 days, unrecoverable if missed) | M | M | Refresh every ~30 days; alert at T−10 days; re-auth runbook | L |
| P7 | Telegram removes the bot or channels (reports, policy) | L | H | SFW content; prompt `/paysupport`; low refund-dispute rate; responsive moderation; documented ToS compliance | M |
| P8 | Telegram economics: Stars reward rate changes (currently "0.013 USD equivalent" at sole discretion), 21-day hold, 3-year expiry, chargebacks debited | M | M | Stars-native accounting; withdraw regularly; keep the 21-day float in treasury planning | M |
| P9 | Accidentally enabling private-chat topics triggers a 15% fee on all Stars purchases | L | M | Config assertion + startup check + runbook | L |
| P10 | Native channel subscription behavior is opaque (no payment events, unclear auto-removal) | — | — | Avoided by design: bot-managed subscriptions + join-request gating | L |
| P11 | Telegram AI-data consent rule violated (AI processing without explicit per-chat consent) | M | H | Hard consent gate in the conversation pipeline; tests; `/stopai` withdrawal | L |
| P12 | Business-bot ToS: concealing automation or sharing data with third-party APIs without authorization | M | H | Human-operated account; AI drafts only after the counterpart consents; disclosure in bio and first message | L |
| P13 | Platform concentration: all revenue on Telegram | H | H | Accept for the MVP; Stage 5 diversification (web checkout, other platforms) | H (accepted) |

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
| R11 | ~~AI vendor usage policies~~ (superseded 2026-10-18: no AI vendors). Replaced by model **licence** risk (Top-10 #4) and the absence of vendor safety layers (Top-10 #7). | — | — | See §1 and §1a | — |

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
