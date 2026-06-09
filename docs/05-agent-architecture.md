# Part 5 — Agent Architecture

Five super-agents. Each is a **capability cluster** — one agent identity with internal specialist sub-prompts and a dedicated tool belt — not a swarm of micro-agents. The orchestrator is deterministic code; agents reason, code governs.

## 5.0 Shared substrate (applies to all agents)

**Message protocol.** All inter-agent communication is persisted, structured, and typed:

```json
{
  "session_id": "uuid",
  "agent": "intelligence",
  "type": "finding | hypothesis | challenge | concession | proposal | vote | request",
  "claim": "IPM for campaign DE_Android_Value dropped 38% over 6 days while CPM stayed flat",
  "evidence_ids": ["ev_8f2a", "ev_8f2b"],
  "confidence": 0.86,
  "directed_to": ["creative"],
  "in_reply_to": "msg_91c4"
}
```

The protocol layer **rejects** any `finding/hypothesis/challenge` without `evidence_ids` resolving to stored evidence artifacts. Evidence = persisted query (metric definition + params + SQL hash) + frozen result snapshot + timestamp. This is the anti-hallucination spine of the whole product.

**Memory model (three layers, all tenant-scoped):**
1. **Working memory** — current session state (messages, evidence digests), managed by the orchestrator with token budgets per phase.
2. **Tenant business memory** — curated, structured facts: business model, margin assumptions, target ROAS by geo/channel, seasonal patterns, known platform quirks, org preferences ("CMO hates TikTok", "never touch brand campaigns"), past decisions and their outcomes. Stored as versioned structured records + embeddings for retrieval; updated via explicit "memory commit" steps reviewed in agent QA, never via silent accumulation.
3. **Playbook memory** — cross-tenant, anonymized pattern knowledge baked into versioned playbooks (Part 9), improved offline from outcome data — not learned live.

**Decision logic pattern (all agents):** deterministic pre-computation (stats/SQL produce candidate signals) → LLM interpretation over structured digests → structured output (Pydantic-validated) → protocol checks → next phase. An agent never free-writes a number; numbers come from tool results and are cross-checked against evidence by a validator before a message is accepted.

**Model tiering:** triage/extraction/formatting → fast cheap model; investigation/debate/synthesis → frontier model (Claude primary, multi-provider failover via the LLM Gateway).

---

## 5.1 Growth Director Agent

**Role:** The strategist and final arbiter. Owns priorities, budget logic, trade-offs, and the final recommendation. Never analyzes raw data itself — it weighs evidence and arguments produced by the others, the way a great VP Growth runs a meeting.

**Inputs:** session brief (trigger + triage digest), all agent messages and evidence digests, tenant business memory (targets, margins, constraints, guardrail policies, past decisions), portfolio state (current allocation across channels/geos/campaigns), open recommendations and in-flight actions (to avoid conflicting advice).

**Outputs:** session priorities and investigation directives; arbitration messages during debate (what would change my mind, what evidence is missing); final **Decision** object (chosen option, rejected alternatives with reasons, confidence, predicted impact range, risk statement, re-evaluation conditions); weekly portfolio review (allocation thesis for every major budget line).

**Tools:** `query_metrics` (portfolio-level only), `get_open_recommendations`, `get_action_history_outcomes` (predicted vs realized for this tenant), `get_guardrail_policies`, `request_agent_input`, `finalize_decision`.

**Internal specialists (sub-prompts within the agent):**
- *Portfolio Allocator* — marginal-ROAS reasoning across channels/geos; where does the next/last $1K belong.
- *Risk Officer* — downside quantification, blast radius, reversibility; authors the risk statement on every decision.
- *Prioritizer* — scores competing investigations/opportunities by expected $ impact × confidence × effort.
- *Devil's Advocate* — mandatory pass before finalization: strongest case *against* the chosen action; if it lands above threshold, the decision is downgraded to "monitor" or sent back for more evidence.

**Decision logic specifics:** must explicitly resolve every unresolved `challenge` in the session (accept, reject with reason, or downgrade confidence) before finalizing — enforced by the orchestrator. Decisions exceeding tenant-defined magnitude bounds are auto-tagged for senior-role approval chains.

**Communicates:** receives from everyone; directs questions to specific agents; is the only agent allowed to emit `finalize_decision`; hands the decision to Operations for action prep.

---

## 5.2 Intelligence Agent

**Role:** The analyst. Owns "what is happening and why" — KPIs, cohorts, funnels, anomalies, segments, competitive context, and the business interpretation of all of it.

**Inputs:** anomaly records from the detection layer (it does not detect anomalies itself — see P7), metric access via semantic layer, cohort/funnel marts, experiment registry (critical: must check for running A/B tests, paywall changes, LiveOps events, price changes *before* interpreting any movement), tenant business memory, market/competitor digests.

**Outputs:** root-cause analyses as evidence-backed finding/hypothesis chains; dimensional decompositions ("the drop is 80% explained by: geo=DE × channel=Google × campaign=X"); cohort quality readings (are recent cohorts structurally better/worse, not just noisier); funnel diagnoses; "what changed" daily digest powering the Command Center; challenges to other agents' interpretations.

**Tools:** `query_metrics`, `decompose_metric_change` (deterministic contribution analysis across dimensions — the workhorse), `compare_cohorts`, `funnel_analysis`, `get_experiments`, `get_liveops_calendar`, `correlate_events` (timeline alignment of metric breakpoints vs. known change events), `get_competitor_digest`.

**Internal specialists:**
- *Cohort Analyst* — retention/LTV curve shape analysis, payer-mix shifts, early-signal LTV projection deltas.
- *Funnel Analyst* — install→activation→trial→paid step conversion, by source/geo/version.
- *Anomaly Interpreter* — takes statistical anomaly records and classifies: real vs. tracking artifact vs. known-event-explained vs. seasonal.
- *Market Analyst* — competitive context: category trends, competitor launches/promotions that could explain auction-side movement.
- *Economist* — unit economics: blended CAC/LTV integrity, margin-aware ROAS targets, payback windows.

**Decision logic specifics:** hypothesis discipline — every root-cause claim must name (a) the mechanism, (b) the evidence supporting it, (c) at least one observation that *would falsify it* and whether that observation was checked. The orchestrator enforces the falsification field on hypothesis messages.

**Communicates:** primary supplier of findings to everyone; routinely directed by Growth Director; must request Tracking Agent sign-off (`request → tracking`) before asserting any conclusion that the data-health gate flagged as at-risk; hands creative-shaped problems (IPM/CTR-driven) to Creative Agent.

---

## 5.3 Operations Agent

**Role:** The executor's hands. Converts decisions into *fully prepared, platform-valid, guard-checked actions* — and owns execution workflow design (sequencing, ramp plans, revert conditions).

**Inputs:** finalized Decision objects, entity registry (current campaign/adset/ad/audience structures per platform), platform capability specs (what each network allows: budget min/max, learning-phase rules, structure constraints, naming rules), guardrail policies, action history (avoid thrash: don't propose reversing last week's approved change without flagging it).

**Outputs:** **Action drafts** — typed payloads per action kind (`budget_change`, `pause_entity`, `create_campaign`, `audience_sync`, `creative_rotation`, `crm_journey_change`, `aso_change`) each containing: exact diff (before→after), platform-validated payload, execution plan (steps, ordering, ramp schedule), guardrail evaluation, rollback plan, verification spec (what to read back and when), monitoring plan (which metrics to watch post-execution, with auto-revert thresholds). Also: campaign structure designs, workflow templates, feasibility vetoes ("that budget move violates Meta learning-phase best practice; counter-propose 20%/day ramp").

**Tools:** `get_entity`, `get_platform_capabilities`, `draft_action`, `evaluate_guardrails`, `dry_run_action` (calls the platform adapter's validate/dry-run — real API validation, no execution), `get_action_history`, `simulate_ramp` (deterministic ramp schedule generator).

**Internal specialists:**
- *Campaign Architect* — structure design per network's current meta (consolidated structures, Advantage+/ACe constraints).
- *Budget Mechanic* — change sizing that respects learning phases and pacing; ramp/de-ramp schedules.
- *Audience Engineer* — segment definitions, sync specs, exclusion logic, frequency strategy.
- *CRM Operator* — journey/segment changes, message scheduling windows, holdout design for CRM actions.
- *Safety Engineer* — authors rollback plans and verification specs; an action draft without both is invalid (schema-enforced).

**Decision logic specifics:** Operations may **veto on feasibility** but never on strategy — strategy disputes go back to the Growth Director as a `challenge`. Every action draft must pass `dry_run` before it can be attached to a recommendation shown to users.

**Communicates:** downstream of Growth Director decisions; consults Tracking Agent for any action whose verification depends on attribution (e.g., "we can't measure this geo split with current SKAN setup — flag it"); consults Creative Agent for asset readiness on creative rotations.

---

## 5.4 Creative Agent

**Role:** The creative strategist. Owns creative performance lifecycle: fatigue detection interpretation, hook/angle analysis, concept generation, variation briefs, ASO creative, and competitor-inspired opportunities.

**Inputs:** creative metrics mart (per-asset daily: impressions, CTR, IPM, CVR, spend share, frequency where available, first/last seen), fatigue-curve outputs from the detection layer, creative asset metadata (tagged: format, hook type, theme, duration, language — tagging pipeline uses cheap vision/LLM models at ingest), competitor creative digests (ad library mining), ASO assets and store metrics, tenant brand constraints.

**Outputs:** fatigue diagnoses with remaining-useful-life estimates per asset; **hook/angle performance maps** ("'reward reveal' hooks: CTR −44% over 30d in DE; 'fail/retry rage bait' rising"); creative briefs (concept, hook line, first-3-seconds script, format, variation matrix) ready for the studio's pipeline; rotation recommendations (kill/scale/refresh lists); ASO creative insights (icon/screenshot test hypotheses); competitor opportunity reports.

**Tools:** `query_metrics` (creative mart), `get_creative_assets`, `get_fatigue_curves`, `tag_creative` (taxonomy enrichment), `search_competitor_creatives`, `generate_brief`, `draft_action` (creative_rotation kind only).

**Internal specialists:**
- *Fatigue Analyst* — interprets decay-curve fits; separates fatigue from auction shifts (cross-checks CPM) and seasonal dips.
- *Hook Scientist* — pattern-level performance attribution across the tagged creative taxonomy.
- *Concept Writer* — briefs/scripts/variations grounded in the tenant's winning patterns + rising market patterns.
- *ASO Specialist* — store listing creative hypotheses tied to conversion-rate data.
- *Competitor Scout* — mines ad libraries for pattern shifts worth testing (always labeled as *inspiration*, never copy instructions).

**Decision logic specifics:** all generation is **grounded**: a brief must cite the evidence for why this pattern (tenant historical performance or competitor-trend evidence). Ungrounded "creative ideas" are rejected by schema (briefs require `rationale_evidence_ids`).

**Communicates:** answers Intelligence's IPM/CTR findings; supplies Operations with asset specs for rotations; challenges Growth Director when a proposed budget fix masks a creative root cause ("more budget into a fatigued ad set is buying decay").

---

## 5.5 Tracking/Data Agent

**Role:** The guardian of truth. Owns data quality, tracking health, attribution validity, taxonomy integrity, SKAN/MMP sanity, reconciliation, and the right to **gate** other agents' conclusions.

**Inputs:** `data_quality_checks` results (reconciliation jobs), `sync_runs` health, event taxonomy registry vs. observed event streams, SKAN postback patterns (null rates, coarse-value distributions, conversion-value schema), MMP config snapshots, platform diagnostic APIs (e.g., dataset/pixel quality), schema-drift detections.

**Outputs:** **Data Health Status** per domain (attribution, spend, revenue, events, SKAN) — green/yellow/red with specifics, powering the Tracking Health Center and the orchestrator's data-health gate; reconciliation reports (network vs. MMP vs. RevenueCat deltas with drilldowns); taxonomy violation reports (missing/renamed/duplicated events, parameter drift); SKAN sanity reads ("DE iOS drop coincides with conversion-value schema change on June 2 — treat iOS ROAS as unmeasurable for 72h"); fix-it recommendations (tracking fixes are recommendations too, with prepared instructions); **vetoes**: formal challenge that blocks a finding from reaching decision stage until resolved or explicitly overridden by a human.

**Tools:** `get_sync_health`, `run_reconciliation`, `get_taxonomy_diff`, `get_skan_diagnostics`, `get_platform_diagnostics`, `query_metrics` (data-quality marts), `declare_health_status`, `veto_finding`.

**Internal specialists:**
- *Attribution Auditor* — MMP config sanity, attribution-window consistency, self-attributing-network overlap logic.
- *SKAN Forensic* — postback math, null-rate baselines, crowd-anonymity tier shifts, CV-schema change detection.
- *Taxonomy Warden* — canonical event dictionary enforcement; detects silent client-release event changes.
- *Reconciler* — cross-source deltas with tolerance bands; distinguishes restatement lag from real breakage.

**Decision logic specifics:** runs **first** in every session (data-health gate phase). Its health declarations have hard authority: a `red` on a domain blocks decisions relying on that domain (orchestrator-enforced); humans can override with a logged justification. It is also the only agent with standing scheduled sessions independent of anomalies (daily health review).

**Communicates:** gates everyone; most frequent dialogue partner of Intelligence ("is this drop real?"); informs Operations of measurement constraints on proposed actions.

---

## 5.6 Orchestration & debate flow (how they work together)

```
TRIGGER (anomaly | schedule | user question | opportunity scan)
   │
   ▼
TRIAGE (cheap model): classify, pick playbook, estimate $ at stake
   │            └── below materiality threshold → log & merge into daily digest (no session)
   ▼
DATA HEALTH GATE: Tracking Agent declares domain health for the affected scope
   │            └── red → tracking-fix session instead; original question parked with banner
   ▼
PARALLEL INVESTIGATION: relevant agents investigate concurrently (tool budget per agent),
   each emits findings/hypotheses with evidence
   ▼
DEBATE (bounded rounds, default ≤3): agents read each other's messages; emit
   challenges/concessions; Growth Director directs ("Creative: does the IPM drop
   predate the CPM rise?"); orchestrator enforces evidence rules & budgets
   ▼
SYNTHESIS: Growth Director resolves challenges, runs Devil's Advocate pass,
   emits Decision (or "monitor" / escalation)
   ▼
ACTION PREP: Operations drafts actions, dry-runs them, attaches guardrail eval,
   rollback & monitoring plans
   ▼
REVIEW & PUBLISH: validator checks (numbers↔evidence consistency, schema, policy),
   recommendation + actions published → Approvals queue → human
   ▼
POST-DECISION: monitoring plan armed; predicted-vs-realized tracking scheduled
```

**Budgets and termination:** every phase has wall-clock, token, and tool-call budgets (per playbook). Debate ends early on convergence (no new challenges) or at round cap with disagreement *preserved and surfaced* — an honest "Creative and Intelligence disagree on cause; recommended action is robust to both readings" beats forced consensus.

**Concurrency:** sessions are per-scope; a distributed lock prevents two sessions from proposing actions on the same entity simultaneously; the Growth Director sees open recommendations to prevent contradictory advice.
