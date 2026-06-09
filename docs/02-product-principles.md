# Part 2 — Product Principles

These principles are binding. Every feature, PR, and design review is judged against them. When a shortcut violates a principle, the shortcut loses.

## What this product IS

### P1. An AI Growth Team, not a dashboard
The unit of value is a **concluded investigation with a prepared action**, not a chart. Charts exist only as evidence attached to claims. If a screen shows data without an attached interpretation and a next step, it is unfinished.

### P2. Evidence-native
Every claim any agent makes must reference stored evidence: a persisted query, its result snapshot, its timestamp, and the data sources it touched. Users can open any sentence in the War Room and see the SQL behind it. **An agent message without evidence references is rejected by the orchestrator at the protocol level** — this is enforced in code, not in prompts.

### P3. Action-terminal
Every investigation terminates in one of exactly three states: a **prepared action** awaiting approval, an explicit **"monitor — no action"** decision with re-check conditions, or an **escalation** naming what's missing (data, permission, human input). "Interesting insight" is not a terminal state.

### P4. Approval-first, autonomy-ready
V1 executes nothing without human approval — no budget moves, no campaign changes, no creative uploads, no audience syncs. But the execution layer is built as if autonomy were on: every action carries guardrails, idempotency keys, rollback plans, and blast-radius limits from day one. Moving from Level 2 to Level 4 is a per-tenant, per-action-type **policy change**, never a code change.

### P5. Product-aware growth
UA numbers without product context are noise. ROAS analysis must join against retention, monetization, paywall, economy, LiveOps, and A/B test state. "ROAS dropped" with a live paywall experiment running is a different investigation than "ROAS dropped" in steady state — the system must know the difference before opening its mouth.

### P6. Distrust the data first
The Tracking/Data Agent reviews data health before any other agent reasons over the affected data. A conclusion drawn from broken attribution is worse than no conclusion. Data-health status is a first-class gate in every investigation.

### P7. Statistically detected, LLM-interpreted
Anomaly detection, baselines, fatigue curves, and cohort math are deterministic statistics in ClickHouse. LLMs interpret, contextualize, debate, and write. This keeps detection reproducible, cheap, and testable — and keeps LLM cost proportional to the number of *interesting* events, not the volume of data.

### P8. Confidence is honest and consequential
Every recommendation carries a confidence score with a defined rubric (Part 9), and the system records predicted impact vs. realized impact for every approved action. Confidence calibration is reported to the customer. We would rather say "0.55, thin evidence, small test recommended" than be impressively wrong.

### P9. Ten seconds to situational awareness
The Command Center answers, above the fold, in priority order: business status today, what changed, where money is burning, where to scale, what the agents recommend, what awaits approval. Linear-grade speed and sharpness: keyboard-first, sub-200ms perceived interactions, zero decorative chrome.

### P10. Audit-grade by construction
Every agent run, every message, every recommendation, every approval, every execution, every config change writes an immutable audit record. A customer's finance team or a platform policy review can reconstruct any action's full causal chain: trigger → evidence → debate → decision → approver → execution → outcome.

### P11. Multi-tenant, least-privilege, from the first commit
Tenant isolation at the query layer (enforced, not conventional), role-based permissions on every endpoint, scoped integration credentials, per-tenant encryption of secrets. Design partner #1 runs on the same multi-tenant architecture as customer #100.

### P12. The system learns
Playbooks (typed investigation/recommendation templates) improve from outcomes. Rejected recommendations require a reason; reasons feed back into agent context. Tenant-specific memory (business model, margins, seasonal patterns, past decisions) makes month 6 dramatically better than week 1 — and creates switching costs.

## What this product IS NOT

- **Not a BI/analytics tool.** We will not compete on chart-building, custom report builders, or SQL notebooks. If a user wants exploratory analytics, they keep Looker; we are the layer that *acts*.
- **Not an auto-bidder or bid optimizer.** We do not micro-manage bids against Meta/Google's own optimizers — that war is lost. We operate the strategic layer: allocation across campaigns/geos/channels, creative strategy, structure, measurement.
- **Not a creative production studio.** The Creative Agent produces concepts, hooks, scripts, variation briefs, and (later) generation-assisted drafts — it does not replace the studio's art pipeline; it feeds and prioritizes it.
- **Not an MMP or attribution provider.** We validate, reconcile, and interpret attribution; we never claim to replace AppsFlyer.
- **Not a chat interface to your data.** Chat exists as one input surface, but the system's core loop is proactive: it investigates without being asked.
- **Not a black box.** Any product decision that hides reasoning to seem smarter is rejected. Inspectability beats mystique, especially with technical buyers.
- **Not a demo company.** No synthetic insights, no hardcoded narratives, no "sample data mode" that fakes intelligence. The sales demo runs on a real (anonymized design-partner or genuinely simulated-economy) dataset with the real pipeline.

## Decision tiebreakers

When principles conflict in practice:

1. **Trust beats wow.** Cut the impressive feature before the honest one.
2. **Depth beats breadth.** One channel analyzed to action-grade beats five channels summarized.
3. **Deterministic beats clever.** If a rule or a statistic does the job, the LLM doesn't get the job.
4. **The Head of UA's Monday morning beats everything.** When prioritization stalls, optimize the daily loop of the primary persona.
