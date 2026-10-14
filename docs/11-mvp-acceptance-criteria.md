# 11 — MVP Acceptance Criteria

> The MVP is accepted for **public launch** when every criterion marked **[Gate]** passes, with evidence linked in the launch review. Criteria marked [Target] are tracked but don't block launch.
>
> Measurement windows refer to the **closed beta** (≥ 14 days, 100–200 invited fans), unless stated otherwise.

## A. Influencer identity

| # | Criterion | Evidence |
|---|---|---|
| A1 **[Gate]** | One influencer is configured with an **approved, active persona version**: personality, writing style, fictional biography, canon facts, visual identity and conversation rules, each approved by the content manager and compliance | Persona record + approvals |
| A2 **[Gate]** | Character sheet (≥ 12 canonical references) and calibration set (≥ 200 labelled images) exist; face-match threshold set with **false-accept rate ≤ 5%** on hard negatives | Calibration report |
| A3 **[Gate]** | ≥ 90% of human-approved images pass the automated face threshold; 0 published assets failed identity checks | Validation results query |
| A4 **[Gate]** | Real-person resemblance check run on the persona and every published asset; 0 unresolved matches | Validation results |
| A5 **[Gate]** | AI disclosure present on: IG bio + "AI-generated profile" label, every IG caption, TG channel descriptions, bot description, `/start`, `/about`, every TG caption | Checklist + automated disclosure-present checks |

## B. Content pipeline and publishing

| # | Criterion | Evidence |
|---|---|---|
| B1 **[Gate]** | End-to-end flow works for **IG feed image, IG carousel, IG Reel, IG Story, TG free post, TG premium post, bot PPV set**: brief → generate → validate → caption → approve → schedule → publish | Demo + publication records |
| B2 **[Gate]** | **100% of published items** have an approval (or policy authorization) whose hash equals the published revision hash | SQL check: `publications` vs `approval_requests` |
| B3 **[Gate]** | ≥ 95% of scheduled publications executed within 5 min of schedule over the beta, excluding documented platform outages | Publication lateness report |
| B4 **[Gate]** | **0 duplicate publications**, including a fault-injection test with forced timeouts on IG `media_publish` and Telegram sends | Test report + data check |
| B5 **[Gate]** | Every published asset carries provenance (vendor C2PA original retained; rendition re-signed; IPTC digital source type); `is_ai_generated` set on IG containers **if** Phase 0 confirmed the field, otherwise the documented manual label step is followed | Asset sample audit |
| B6 **[Gate]** | Content policy enforced: 0 published items above the channel rating ceiling; 0 adult CTAs/links on Instagram | QA audit of 100% of beta publications |
| B7 [Target] | Median human review time ≤ 3 min per item; cost per published image item ≤ $1.50, per Reel ≤ $6 | Dashboard |

## C. Conversation (Telegram bot)

| # | Criterion | Evidence |
|---|---|---|
| C1 **[Gate]** | **No AI processing without `ai_processing` consent.** Automated test plus beta data shows 0 AI runs for non-consented chats. | Test + query |
| C2 **[Gate]** | AI disclosure shown before the first AI reply, **re-shown at least every 3h** of continuing conversation and after ≥ 24h gaps; truthful answer to "are you human/AI?" in 100% of eval cases | Disclosure log + eval |
| C3 **[Gate]** | Crisis protocol: 100% of crisis eval cases receive the referral template and a critical escalation; AI persona replies pause for that fan; de-identified referral log populated | Eval + test |
| C4 **[Gate]** | Conversation eval suite: **100% on critical cases** (crisis, minors, never claiming to be human, no erotic content, no off-platform payment, injection resistance); ≥ 95% overall | Eval report for the active agent version |
| C5 **[Gate]** | Operator console: inbox, L2 draft approval, takeover (switch to human in ≤ 2 clicks, effective immediately), escalation queue with SLA timers | Demo + test |
| C6 **[Gate]** | Memory: only allowlisted categories with consent; `/memory` shows and `/forget` deletes within 1 min; special-category writes impossible (DB constraint test) | Tests |
| C7 **[Gate]** | Fan message → reply sent (auto mode, staging load test) p95 < 12s; holding message after 15s on LLM slowness | Load test |
| C8 [Target] | Beta L2 drafts: approval-without-edit rate ≥ 90% (input to the L3 promotion decision) | QA metrics |

## D. Monetization and entitlements

| # | Criterion | Evidence |
|---|---|---|
| D1 **[Gate]** | `pre_checkout_query` answered p99 < 2s, with 0 timeouts during the beta | Metrics |
| D2 **[Gate]** | **Every successful payment produces exactly one payment record and the correct entitlements** (p95 < 5s): 100% across E2E scenarios (VIP purchase, renewal, cancellation, failed renewal, expiry, refund, PPV, credits) and in the beta | E2E report + reconciliation |
| D3 **[Gate]** | Daily `getStarTransactions` reconciliation: 0 unexplained discrepancies for 7 consecutive days | Reconciliation log |
| D4 **[Gate]** | Premium channel: only entitled fans approved (100%); expired or refunded fans removed within 1h of grace end; membership audit discrepancies = 0 | Audit job output |
| D5 **[Gate]** | Refund flow (`/paysupport` → L2 approval → `refundStarPayment` → revocation) works end-to-end, idempotently | Test |
| D6 **[Gate]** | Private-chat topics are disabled for the bot (startup assertion), so the 15% fee is never triggered | Config check |
| D7 **[Gate]** | Dashboard shows: revenue (⭐ gross and net), purchases, active subscribers, renewals, churn, conversion funnel, revenue per influencer, AI operating costs by category, **estimated** contribution margin with its valuation method shown | Dashboard review |
| D8 **[Gate]** | Offer caps and "no offers during escalation/crisis" enforced by the policy engine (tests) | Tests |

## E. Agents, autonomy and approvals

| # | Criterion | Evidence |
|---|---|---|
| E1 **[Gate]** | All nine agents are defined, with versioned configs: model, effort, tools allowlist, output schema, allowed action types, max autonomy, budgets. At least Production, Social Media, Conversation, QA & Compliance, Strategist and Analytics are active (others may be shadow/L1). | Agent registry |
| E2 **[Gate]** | Every agent run is traceable: run → steps → proposals → policy trace → approval → execution → audit entry, viewable in the dashboard | Trace demo |
| E3 **[Gate]** | **All sensitive actions require human approval** in the MVP policy set: publications, IG comment replies/DMs, chat replies during beta, offers during beta, price/product changes (2 approvals), refunds, persona/policy changes. An automated policy test enumerates the action catalog against the expected levels. | Policy test |
| E4 **[Gate]** | Kill switches (global / influencer / agent / channel) stop autonomous execution within 60s (tested) | Test |
| E5 **[Gate]** | Agent failures (timeout, refusal, invalid output, budget exceeded) produce no side effects and are visible to humans | Fault-injection tests |
| E6 [Target] | Shadow-mode agreement metrics are collected for chat replies and comment replies | QA dashboard |

## F. Platform, security and operations

| # | Criterion | Evidence |
|---|---|---|
| F1 **[Gate]** | Staging and production fully separated (accounts, DBs, Redis, buckets, secrets, KMS keys, bots, Meta apps); production deploys only by promotion of a staging-tested image digest | Infra review |
| F2 **[Gate]** | SSO + MFA for all staff; RBAC matrix enforced server-side; automated authorization tests for each role × endpoint; cross-tenant isolation tests pass (app + RLS) | CI reports |
| F3 **[Gate]** | Secrets only in Doppler/KMS-wrapped storage; secret scanning clean; no credentials in logs (log sample audit) | Scan + audit |
| F4 **[Gate]** | Audit log covers 100% of commands; append-only privileges verified; sealing job running | Query + privilege test |
| F5 **[Gate]** | Monitoring and alerting per doc 09 §6.2 live; on-call rota and the top-14 runbooks written | Alert test + runbooks |
| F6 **[Gate]** | Retries, DLQ and replay work for each queue (fault-injection); payment DLQ pages on-call | Test |
| F7 **[Gate]** | Backups: PITR enabled; nightly logical dump; **restore drill completed** with RPO ≤ 15 min and RTO ≤ 4h demonstrated | Drill report |
| F8 **[Gate]** | Automated tests: domain coverage ≥ 80% (policy, entitlements, payments, disclosure ≥ 90%); integration and contract suites green; E2E suite green in staging; load test passed; external pen test with no open high/critical findings | CI + reports |
| F9 **[Gate]** | Cost tracking: ≥ 99% of vendor spend attributed to an influencer via `usage_events`; budgets and alerts configured | Reconciliation vs. invoices |

## G. Legal and compliance

| # | Criterion | Evidence |
|---|---|---|
| G1 **[Gate]** | Counsel sign-off on the privacy policy, terms, AI disclosure texts, crisis protocol, refund policy, sponsored-content rules, persona likeness review | Sign-off memo |
| G2 **[Gate]** | DPIA and record of processing completed; DPAs with all sub-processors | Documents |
| G3 **[Gate]** | Static legal and safety page live (privacy, terms, AI disclosure, crisis protocol, sub-processors, takedown/contact, Meta data-deletion instructions); BotFather privacy policy set | URLs |
| G4 **[Gate]** | DSR tooling: access and erasure requests executable end-to-end; erasure cascade test passes | Test |
| G5 **[Gate]** | Takedown intake with a 48h SLA timer operational | Demo |
| G6 **[Gate]** | Accountant engaged for Stars/TON treatment before the first withdrawal | Engagement letter |

## H. Scalability proof (architecture)

| # | Criterion | Evidence |
|---|---|---|
| H1 **[Gate]** | A **second influencer can be created in staging** (persona, channels, bot, products, policies) without code changes, and its data is isolated from the first (tests) | Staging demo |
| H2 **[Gate]** | A **second workspace** can be created in staging with full tenant isolation (RLS tests) | Staging demo |
| H3 **[Gate]** | Swapping the primary image provider to the fallback is a configuration change, demonstrated in staging | Demo |
