# Part 15 — Final Recommendation

## The verdict

Build it. The thesis is sound: the growth bottleneck has moved from *seeing* to *deciding and doing*, LLMs just crossed the agentic-credibility threshold, and the mid-size studio segment is squeezed hard enough to pay for multiplication. But the order of construction decides everything. Most teams attacking this space will build the demo (agents talking over charts) and skip the substrate (data correctness, evidence enforcement, guardrails). They will demo better than us for six months and then die at the first $50K mistake. We build the substrate first and let the demo emerge from it — that's the entire strategy in one sentence.

## The three decisions I'd lock today

1. **Wedge = Tracking Health + Command Center, sold to mobile game studios first.** The Tracking/Data Agent finds real, embarrassing, expensive problems within hours of connecting — that's the fastest trust-builder in the design and it's a capability the MMPs are structurally conflicted out of offering. Gaming before subscription apps: deeper product-context moat (economy, LiveOps), denser network for referrals.
2. **Evidence enforcement at the protocol layer is non-negotiable and built before any agent speaks** (Prompt 8 before Prompt 9). It's the difference between a product and a liability.
3. **Two design partners signed before the data layer is finished**, with written data-access agreements and a weekly debrief ritual. Their historical incidents become the golden evaluation suite — without it, agent quality is unmeasurable and every prompt change is a gamble.

## How to start building in Claude Code, concretely

**Step 0 — today.** Commit this `docs/` spec to the repo. It is the contract every build session reads. Set up the repo with branch protection and required CI checks from the first PR.

**Step 1 — week 1.** Run Prompt 1 (monorepo) and Prompt 2 (tenancy/auth/RLS/audit) from Part 13, one session each, reviewing every diff. Do not let velocity excitement compress these: the isolation test suite built in Prompt 2 is the foundation everything multi-tenant stands on.

**Step 2 — weeks 2–8.** Prompts 3–6: job plane + LLM gateway, then the data layer. **Spend your founder time here on design partners, not code**: get their AppsFlyer/Meta/Google/RevenueCat credentials flowing into staging the moment Prompt 4's framework exists. Every reconciliation discrepancy you resolve with them in these weeks is product knowledge competitors can't shortcut.

**Step 3 — weeks 8–13.** Prompt 7 (detection + Command Center) and ship the wedge to design partners. Measure the only thing that matters at this stage: do they open it every morning unprompted? If not, fix that before building agents — agents on top of an ignored dashboard are agents in an empty room.

**Step 4 — weeks 12–24.** Prompts 8–10: substrate → Tracking/Intelligence/Director agents → War Room. Build the golden-incident harness *with* the first agents (it's inside Prompt 9, deliberately). Run the shadow-operations ritual (Part 12.6) from the first real session onward.

**Step 5 — weeks 23–34.** Prompts 11–13: Operations Agent, approvals, creative intelligence, then sandbox execution. Charge money at the end of Prompt 11 — Level-2 prepared actions on a trusted SSOT is a complete, sellable product; execution and autonomy are expansion revenue, not launch requirements.

**Working agreement with Claude Code (from Part 13, worth restating):** one prompt = one session = one reviewed PR; the spec in `/docs` is the contract; the "WHAT WAS NOT DONE" report section is read first, not last; exit criteria from Part 11 gate phase transitions, never the calendar.

## What I would *not* do

- Don't build TikTok/ASO/CRM/agency features before Phase 2 exit criteria pass. (Part 14, R12.)
- Don't demo agent debate to prospects before the fabrication-rate-zero gate holds on the golden suite. One hallucinated screenshot in this industry's group chats outweighs fifty good demos.
- Don't take a "% of managed spend" pricing deal, ever — it poisons the incentive to recommend spending less, and recommending less is half our credibility.
- Don't promise Level 4 in sales conversations. Sell Level 2 outcomes and let the autonomy ladder's written track record do the upselling.

## The first 14 days, as a checklist

1. ☐ Commit `docs/` (this spec) — done if you're reading this in the repo.
2. ☐ Run Prompt 1; review; merge. Infra up via `make dev`.
3. ☐ Run Prompt 2; review hard (RLS, isolation suite); merge.
4. ☐ Open design-partner conversations (target: 5 conversations → 2 signed LOIs with data access).
5. ☐ Provision cloud envs + KMS + staging; wire CI/CD to staging.
6. ☐ Run Prompt 3; verify a traced LLM call lands in the cost ledger.
7. ☐ Run Prompt 4; connect the first real Meta sandbox; see real rows in ClickHouse.
8. ☐ Write the first golden incident from a design partner's war story — even before the harness exists, in a markdown file. Start the collection now.

The system this spec describes is buildable by a small senior team in roughly a year to supervised autonomy — *if* the discipline holds: data before intelligence, evidence before debate, approval before execution, trust before scale. That ordering is the company.
