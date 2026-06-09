# Part 9 — Recommendation Engine

The engine is a layered pipeline: **deterministic detection → deterministic diagnosis primitives → LLM reasoning → scored, evidence-bound recommendation → prepared action**. Each layer is independently testable; the LLM never sees raw data, only structured digests; and nothing reaches a user without passing the validator.

```
ClickHouse marts
   │  (scheduled, deterministic, cheap)
   ▼
[1] DETECTION  ── anomalies, fatigue signals, opportunity signals, DQ failures
   ▼  (materiality filter: $ at stake ≥ tenant threshold)
[2] TRIAGE  ── cheap LLM: classify, dedupe/merge, select playbook, set scope
   ▼
[3] DIAGNOSIS PRIMITIVES ── deterministic tools agents call:
       decompose_metric_change · correlate_events · compare_cohorts ·
       fatigue_curve_fit · funnel_analysis · reconciliation drilldown
   ▼
[4] AGENT REASONING ── War Room session (Part 5/6): interpretation, debate, synthesis
   ▼
[5] SCORING ── evidence score, confidence rubric, impact estimation (code, not vibes)
   ▼
[6] VALIDATION ── numbers↔evidence consistency, schema, policy, dedupe vs open recs
   ▼
[7] ACTION PREP ── Operations Agent + dry-run + guardrails (Part 10)
   ▼
Recommendation (+ actions) → Approvals queue → outcome tracking at horizon
```

## 9.1 Layer 1 — Detection (statistics, not LLMs)

Runs hourly/daily per tenant over the marts. All detectors are versioned, parameterized per tenant (volatility differs wildly between a hypercasual title and a fitness app), and emit `anomalies` rows with scope, magnitude, and **materiality in USD**.

**Detector suite (v1):**
- **Robust z-score / MAD** on KPI series (spend, installs, CPI, CPM, CTR, IPM, CVR, ROAS dN, trial starts, trial→paid, refunds) at multiple grains (account, channel, geo×channel, campaign). Median/MAD over trailing 28d, day-of-week adjusted. Threshold |z| ≥ 3 (≥ 2.5 for money metrics).
- **CUSUM / change-point detection** for slow drifts that never trip a daily z-score (the classic "ROAS eroded 1.5%/day for 3 weeks" killer).
- **STL decomposition residuals** for strongly weekly-seasonal series; anomaly = residual beyond tolerance.
- **Creative fatigue curves:** per creative×channel×geo, fit performance decay (CTR/IPM vs. cumulative impressions and days-live) against the tenant's historical fatigue distribution; emit signal when an asset crosses its predicted decay knee or its spend share × decline product exceeds materiality. This fires **before** ROAS visibly drops — the early-warning wow.
- **Cohort quality shift:** sequential test comparing recent cohorts' early-retention/early-revenue distributions to trailing baseline (detects "we're buying worse users" before D30 proves it).
- **Opportunity scanners** (the positive side, equally important): campaigns with marginal-ROAS headroom (high ROAS + budget-constrained delivery + stable saturation curve), geos with above-target ROAS and low share of spend, audiences with rising conversion rates, paywall variants outperforming with low exposure.
- **Data-quality detectors** (feed the Tracking Agent): reconciliation deltas beyond tolerance, sync gaps, event volume cliffs per taxonomy entry, SKAN null-rate shifts, CV-schema changes.

**Noise control:** hierarchical suppression (a campaign anomaly explained by an account-level anomaly merges into it), known-event masking (experiments/LiveOps/release calendar mask expected movement), cool-downs per scope, and the materiality filter — **an anomaly that can't matter $X/month never wakes an agent.** Target: a $500K/month tenant sees ≤ 5 sessions/day, not 50.

## 9.2 Layer 2 — Triage

Cheap-model pass over each surviving anomaly bundle: classify problem shape, merge related anomalies into one session scope, select playbook, estimate priority = `materiality × tractability`. Output is a structured `SessionBrief`. Hard cap on concurrent sessions per tenant; overflow queues by priority.

## 9.3 Playbooks (the rule-based logic, structured)

A playbook is a versioned JSON definition: trigger signature → agent roster → investigation checklist (which diagnosis primitives MUST run) → debate budget → output schema → action templates allowed → confidence priors. V1 ships ~12:

| Playbook | Trigger | Mandatory primitives |
|---|---|---|
| `roas_drop` | ROAS anomaly | health gate, decompose (geo/channel/campaign/creative), correlate_events vs experiments/releases, fatigue check, CPM/auction check |
| `creative_fatigue` | fatigue curve signal | decay fit review, spend-share exposure, hook-pattern comparison, replacement readiness |
| `scale_opportunity` | opportunity scanner | saturation curve, marginal ROAS, inventory/audience headroom, downside sizing |
| `cpi_spike` | CPI/CPM anomaly | auction vs creative split (IPM), competitor activity digest, bid/budget event correlation |
| `cohort_quality_shift` | sequential test | source mix decomposition, funnel step localization, creative/audience correlation |
| `tracking_break` | DQ detector | reconciliation drilldown, taxonomy diff, SKAN forensics → fix instructions |
| `skan_ambiguity` | SKAN detectors | null-rate baseline, CV schema timeline, modeled-vs-deterministic divergence |
| `paywall_experiment_readout` | experiment end | per-source LTV impact, interaction with UA targets |
| `subscription_funnel_leak` | funnel anomaly | step localization by source/geo/version, price/paywall correlation |
| `budget_rebalance_weekly` | schedule | portfolio marginal-ROAS review across channels/geos |
| `liveops_impact` | LiveOps calendar | event lift vs baseline, UA interaction recommendation |
| `aso_conversion_drop` | ASO mart anomaly | listing CVR decomposition, competitor store activity, creative test hypothesis |

Playbooks are data, not code: tunable per tenant, versioned, and the unit of offline evaluation (Part 12).

## 9.4 Layer 3–4 — Diagnosis primitives & agent reasoning

The deterministic primitives do the math; agents do the meaning:
- `decompose_metric_change(metric, range_a, range_b, dims[])` — exact contribution analysis: which dimension values explain the delta, with interaction handling. Output: ranked contributors with shares.
- `correlate_events(metric_series, scope)` — aligns breakpoints against the change registry (experiments, releases, LiveOps, CV-schema changes, platform outages, our own executed actions — *the system must suspect itself first*).
- `fatigue_curve_fit`, `compare_cohorts`, `funnel_analysis`, `saturation_curve` — as in Part 5 tool lists.

Agents receive primitive outputs as compact structured digests, reason over them, and must produce hypothesis messages with the falsification field (Part 5.2). Debate proceeds per Part 5.6.

## 9.5 Evidence scoring

Each evidence artifact gets a deterministic quality score ∈ [0,1]:
`evidence_score = freshness × completeness × source_reliability × sample_adequacy`
- *freshness*: data age vs. metric's expected lag (SKAN-delayed data scores lower for "what happened yesterday" claims).
- *completeness*: did the window include restatement-stable days; any sync gaps in scope.
- *source_reliability*: per-source prior (deterministic attribution > modeled; MMP cost > scraped), degraded by current health status.
- *sample_adequacy*: n vs. minimum detectable effect for the claim's magnitude (a 30% drop on 40 installs/day scores very differently than on 4,000).

## 9.6 Confidence scoring (the rubric — computed, displayed, calibrated)

```
confidence = clamp(
    w_e · evidence_strength          # mean evidence_score over load-bearing evidence
  + w_a · cross_agent_agreement      # 1 − unresolved-contention penalty
  + w_h · playbook_historical_precision   # realized accuracy of this playbook (global prior → tenant posterior)
  + w_m · mechanism_clarity          # did decomposition isolate a dominant driver (>60% contribution) vs diffuse causes
  − p_d · data_health_penalty        # yellow domains in scope
  − p_n · novelty_penalty            # scope/pattern unlike anything in history
, 0.05, 0.97)
```
Weights are versioned config, fitted quarterly against realized outcomes. **Calibration is product**: the per-tenant calibration page (Part 6.6) reports `P(correct | stated confidence)`. Confidence bands gate behavior: < 0.4 → never publish a recommendation, emit "monitor"; 0.4–0.6 → publish only small-blast-radius "test" actions; > 0.85 + Level 3+ policy → auto-execution eligible (future).

## 9.7 Business impact estimation

Every recommendation carries `predicted_impact = {metric, low, mid, high, horizon_days, basis}` computed by typed estimators per action kind, never free-formed by the LLM:
- *Budget shift*: marginal-ROAS difference between source and destination × moved amount, with saturation-curve haircut on the destination; range from the curve-fit uncertainty.
- *Creative refresh*: historical refresh-lift distribution for this tenant/channel (fallback: cross-tenant prior) × affected spend.
- *Pause waste*: current spend × (target ROAS − actual ROAS) shortfall over horizon.
- *Tracking fix*: spend currently being decided on corrupted data × error magnitude (framed as "decision risk removed", not revenue).
Estimators output the basis evidence IDs so the range itself is inspectable. Predicted vs. realized is computed at `horizon_days` by the outcome job and written to `recommendations.outcome` — closing the loop that feeds `playbook_historical_precision`.

## 9.8 Validation gate (last line before humans)

Code, not model: (1) every number in user-facing text must bind to an evidence value within tolerance — the renderer substitutes from evidence, so a drifted/hallucinated number is structurally unrenderable; (2) output schema validity; (3) policy compliance (action kinds allowed, magnitude within guardrails); (4) dedupe/conflict check against open recommendations (no "scale X" while "pause X" is pending); (5) freshness check — if load-bearing evidence has drifted beyond tolerance by publish time, the session re-verifies before publishing.

## 9.9 Learning loop

- **Rejections require reasons** (structured codes: `wrong_diagnosis | right_diagnosis_wrong_action | timing | business_context_missing | dont_trust_data | other+note`). Weekly job aggregates per playbook; recurring `business_context_missing` spawns tenant-memory curation prompts to the user.
- **Outcome records** update playbook precision priors (global and per-tenant).
- **Human modifications** of actions are diffed against the original — systematic deltas (e.g., "humans always halve our budget-move size") become playbook parameter adjustments, proposed to the team explicitly (never silently self-modified: playbook changes are versioned and visible).
