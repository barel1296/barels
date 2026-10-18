# 11 — MVP Acceptance Criteria & Stage Gates

> Status: Proposed — **rewritten 2026-10-18 as measured stage gates (G0 → G1 → G2 → G3 → G4.n)** · Plan: [doc 10](10-implementation-plan.md)
>
> **How gates work.**
> - A gate passes only when **every [Gate] test passes**, each with linked evidence: a test run, a benchmark run id, a query result or a signed document.
> - [Target] items are tracked but don't block.
> - Benchmark-based evidence must come from **valid runs on the production workstation** newer than the last re-benchmark trigger (doc 14 §6).
> - **A failed gate means stay at the current stage and fix,** or, if the failure is a measured capacity limit, decide tiers or scale-out (doc 10 §6).

## Test format

| Field | Meaning |
|---|---|
| ID | `AT-<gate>.<n>` |
| Procedure | What is executed (automated CI test, `bench` suite, drill, query, review) |
| Pass | Objective pass condition |
| Evidence | Where the result is recorded (`ops.benchmark_runs`, CI artifact, SQL query, document) |

---

## G0 — Foundations ready (end of Stage 0)

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-0.1 **[Gate]** | Capture the environment fingerprint (doc 14 §1) | All fields present; `complete = true` | `ops.environment_fingerprints` |
| AT-0.2 **[Gate]** | Hardware inventory vs. doc 15 §4 | RAM ≥ 64 GB; NVMe ≥ 2 TB; backup disk ≥ 4 TB; iGPU drives the display | Inventory record |
| AT-0.3 **[Gate]** | Schema invariant suite (`docs/schema/invariants_test.sql`) in CI | All 14 cases behave as specified | CI artifact |
| AT-0.4 **[Gate]** | Licence gate | Every selected model has a reviewed licence with commercial weights and outputs; the trigger refuses an unreviewed licence (I11) | `inference.licenses`, CI test |
| AT-0.5 **[Gate]** | Bake-off decisions | Chosen chat model: Q-CHAT-1 (quick, 100 cases) critical 100%. Chosen image base: Q-IMG-1 median ≥ 4. Guard: Q-GUARD-1 recall on crisis/minors ≥ 98% at ≤ 5% FP. Engine chosen with B-LLM-3/4/5 runs. Decision memo signed. | Benchmark runs + memo |
| AT-0.6 **[Gate]** | Mode S activation | `inference.gpu_modes` row S active with all budgets from valid runs (the DB CHECK prevents otherwise); ComfyUI `--reserve-vram` matches | DB + config |
| AT-0.7 **[Gate]** | **Fail-loud VRAM:** submit an oversized media workflow while chat load runs | Media job fails with OOM and enters the degradation ladder; **chat p95 stays within SLO**; no silent spill to system RAM (GPU memory and throughput telemetry) | B-FAIL-3 run |
| AT-0.8 **[Gate]** | Thermal soak B-THERM-1 | Run completed; sustained factor recorded; `T_warn`/`T_crit` configured; the governor triggers in a forced test | Benchmark run |
| AT-0.9 **[Gate]** | Restore drill B-FAIL-7 | Full restore from the local backup and offsite onto a clean WSL distro; app smoke test passes; measured DB RPO ≤ 15 min | Drill report |
| AT-0.10 **[Gate]** | Exposure scan from the LAN + external check | Nothing listening beyond localhost; tunnel routes protected by Access + SSO except Meta webhooks and signed media URLs; signed URL rejects a tampered signature or expired link | Scan report |
| AT-0.11 **[Gate]** | Platform verification checklist (doc 02 §8) | All 16 items resolved, with each answer recorded and the design adjusted where needed | Checklist |

---

## G1 — One complete persona, end-to-end (end of Stage 1, after a ≥ 14-day closed beta)

### G1.A Identity & content

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-1.1 **[Gate]** | Persona #1 configuration review | Active persona version (personality, style, biography, canon, visual identity, conversation rules) approved by content manager + compliance; runtime config complete | DB records |
| AT-1.2 **[Gate]** | Q-ID-1 for persona #1 | Human "same person" ≥ 95% on accepted images; automated check agrees with the panel ≥ 90%; face threshold FAR ≤ 5% on hard negatives | Benchmark run + panel sheet |
| AT-1.3 **[Gate]** | Real-person safety evidence | Synthetic-origin record + reverse-image review + counsel sign-off stored on the persona version | Documents |
| AT-1.4 **[Gate]** | End-to-end per format: IG feed, carousel, Reel, Story; TG free post, TG premium post, bot PPV set | Each format completes brief → generate → validate → caption → approve → schedule → publish, **using local models only** | Demo + publication records |
| AT-1.5 **[Gate]** | Approval binding (SQL) | 100% of published items have an authorization hash equal to the published revision hash | Query result |
| AT-1.6 **[Gate]** | Punctuality over the beta | ≥ 95% of publications within 5 min of schedule (excluding documented platform outages) | Lateness report |
| AT-1.7 **[Gate]** | Duplicate prevention with fault injection (timeouts on IG `media_publish` and TG sends; ComfyUI crash mid-job) | 0 duplicate publications; 0 double-registered media | Test report + query |
| AT-1.8 **[Gate]** | Provenance audit (sample ≥ 50 published assets) | 100% carry our C2PA manifest (original + rendition ingredient chain) and IPTC digital-source type; `is_ai_generated` set or the documented manual-label step done | Audit sheet |
| AT-1.9 **[Gate]** | Policy compliance (100% of beta publications) | 0 items above the channel ceiling; 0 adult CTAs/links on Instagram; disclosures present everywhere | QA audit |
| AT-1.10 [Target] | Review effort | Median review ≤ 2 min per image item, ≤ 5 min per Reel | Approval timestamps |

### G1.B Conversation

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-1.11 **[Gate]** | Consent gate test + beta data | 0 AI runs for chats without `ai_processing` consent | Test + query |
| AT-1.12 **[Gate]** | Disclosure cadence | Disclosure before the first AI reply; repeats ≥ every 3 h of continuing conversation and after ≥ 24 h gaps; truthful "are you AI?" answers in 100% of eval cases | Disclosure log + eval |
| AT-1.13 **[Gate]** | Q-CHAT-1 full suite (~300 cases) on the production model + quantization | Critical 100%; overall ≥ 95%; persona fidelity median ≥ 4 | Eval run |
| AT-1.14 **[Gate]** | Crisis protocol | 100% of crisis cases → template + critical escalation + AI pause + de-identified referral row | Eval + test |
| AT-1.15 **[Gate]** | **Chat under media load** (B-E2E-1 at 1×, 1.5× and 2× of observed beta peak, with image *and* video jobs running) | p95 fan-message → reply < 12 s at 1× and 1.5×; at 2×, load shedding engages in the specified order and holding messages are correct; **0 lost requests** | Benchmark run |
| AT-1.16 **[Gate]** | Engine crash drills B-FAIL-1/2 during chat load | Automatic recovery; 0 lost chat requests; holding message policy respected; media jobs requeued without double registration | Drill report |
| AT-1.17 **[Gate]** | Operator console | Inbox, L2 draft approval, takeover (≤ 2 clicks, effective immediately), escalation SLA timers | Demo + test |
| AT-1.18 **[Gate]** | Memory | Allowlisted categories only, with consent; `/memory` shows and `/forget` deletes within 1 min; special-category writes impossible (I3) | Tests |

### G1.C Monetization & payment integrity

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-1.19 **[Gate]** | Pre-checkout latency over the beta | p99 < 2 s; 0 timeouts while the host was up | Metrics |
| AT-1.20 **[Gate]** | E2E payment scenarios: VIP purchase, renewal, cancellation, failed renewal, expiry removal, refund, PPV, credit pack, allowance exhaustion | Exactly one payment record per charge and correct entitlements (p95 < 5 s) in 100% of scenarios | E2E report |
| AT-1.21 **[Gate]** | Reconciliation | 7 consecutive days with 0 unexplained discrepancies vs. `getStarTransactions` | Reconciliation log |
| AT-1.22 **[Gate]** | **Outage drills B-FAIL-4/5/6** (WSL restart, power cut, 30-min internet loss) during synthetic purchases | No fan charged without service; all `successful_payment` updates processed after recovery; **0 discrepancies after reconciliation** | Drill reports |
| AT-1.23 **[Gate]** | **> 24 h outage simulation** (staging bot: stop ingestion past the retention window, then recover) | Missed payments are recreated from `getStarTransactions` with correct entitlements; fans notified | Staging drill |
| AT-1.24 **[Gate]** | Premium channel membership | Only entitled fans approved; expired or refunded fans removed within 1 h of grace end; membership audit discrepancies = 0 | Audit output |
| AT-1.25 **[Gate]** | Bot configuration assertions | Private-chat topics disabled; no webhook set; one poller per token | Startup logs |

### G1.D Agents, autonomy, GPU and capacity

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-1.26 **[Gate]** | Agent registry | All 9 agents defined with versioned config (local model key, tools, schema, allowed actions, max autonomy, budgets incl. GPU-seconds); Production, Social Media, QA & Compliance, Strategist and Analytics active | Registry |
| AT-1.27 **[Gate]** | Traceability demo | run → steps → proposal → policy trace → approval → execution → audit, viewable in the dashboard | Demo |
| AT-1.28 **[Gate]** | Policy test enumerating the action catalog | All sensitive actions require human approval at their MVP level (doc 06 §4.2) | CI test |
| AT-1.29 **[Gate]** | Kill switches (global / persona / agent / channel / GPU media lane) | Autonomous execution stops within 60 s; chat falls back as specified | Test |
| AT-1.30 **[Gate]** | Agent failure injection (timeout, invalid output, budget exceeded, engine restart) | No side effects; visible to humans | Test |
| AT-1.31 **[Gate]** | **Capacity worksheet** (doc 13 §7.4) | Every parameter populated from valid runs or beta observations (`Z`, `κ`, `k_img`, `k_vid`, `U_S`); `G_day`, `D_persona` per tier, `N_max` per tier, `A_max`, `DAF_max` computed | `ops.capacity_snapshots` |
| AT-1.32 **[Gate]** | Projection to Stage 2 | Projected media demand for 5 personas at planned tiers ≤ 70% of `G_day`; observed peak `λ` × 5 ≤ 0.6 × `ρ·μ*` (or tier/allowance plan adjusted until true) | Snapshot |
| AT-1.33 **[Gate]** | Fair-share and campaign tests with synthetic personas (10 synthetic personas, mixed tiers, deadlines) | No persona starved > 24 h of simulated time; EDF honored for urgent jobs; model switches ≤ configured max | Test report |

### G1.E Operations, security, legal, cost

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-1.34 **[Gate]** | Stability over the beta | 14 consecutive days with no sev1; no unresolved payment DLQ entries | Incident log |
| AT-1.35 **[Gate]** | Alerting | Every doc 09 §6.2 alert fires in a test, including the external dead-man's switch on host-down | Alert test log |
| AT-1.36 **[Gate]** | Runbooks | Doc 09 runbooks written; two drills performed by someone other than the author | Runbook repo |
| AT-1.37 **[Gate]** | Security | SSO+MFA; RBAC role × endpoint tests; cross-tenant tests; secret scan clean; log sample shows no credentials; custom-node lockfile reviewed | CI + review |
| AT-1.38 **[Gate]** | Legal | Counsel sign-off (privacy policy, terms, disclosures, crisis protocol, refund policy, persona likeness, **model licences**); DPIA; legal page live; DSR + takedown tooling tested; accountant engaged | Documents |
| AT-1.39 **[Gate]** | Monthly operating cost ledger | First full month recorded in `ops.cost_entries` with evidence per line; energy from `ops.energy_readings`; GPU-seconds attributed to the persona ≥ 99% of busy time | Ledger + query |
| AT-1.40 **[Gate]** | Extensibility proof in staging | A second persona and a second workspace created **without code changes**; isolation tests pass; switching the image workflow version is a config change | Demo |

---

## G2 — Five personas (after ≥ 14 days at 5)

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-2.1 **[Gate]** | Q-ID-1 per persona; chat bleed-over (Q-CHAT-1 per persona) | Each persona passes | Eval runs |
| AT-2.2 **[Gate]** | Content delivery, all personas | ≥ 95% on time for each persona; no persona starved > 24 h | Report |
| AT-2.3 **[Gate]** | Fair share | Each persona's delivered GPU-seconds within ±15% of its quota over the period (when it had demand) | Query |
| AT-2.4 **[Gate]** | Chat SLO at observed peak with media | p95 < 12 s; holding-message rate below threshold | Metrics |
| AT-2.5 **[Gate]** | **Chat L3 promotion** for low-risk intents | Doc 06 §5 promotion criteria met and approved; QA sampling live | Promotion record |
| AT-2.6 **[Gate]** | Human workload | Projected reviewer + operator minutes per day for 10 personas fit staffed hours with ≥ 30% margin | Staffing sheet |
| AT-2.7 **[Gate]** | Account health | No enforcement action on any IG account or bot; Meta Business Verification complete | Platform consoles |
| AT-2.8 **[Gate]** | Projection to 10 personas | Media ≤ 80% of `G_day`; chat peak ≤ 0.6 × `ρ·μ*`; storage ≥ 90 days headroom | Capacity snapshot |

## G3 — Ten personas (after ≥ 14 days at 10)

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-3.1 **[Gate]** | All G2 tests at 10 personas | Pass | As G2 |
| AT-3.2 **[Gate]** | Mode transitions (only if Mode M enabled) | 20 consecutive transitions: 0 lost chat requests; measured `T_switch` ≤ configured max; chat SLO held in M windows | `inference.mode_transitions` + metrics |
| AT-3.3 **[Gate]** | Full-size restore drill (B-FAIL-7 with production data volume) | RTO within the documented target; RPO ≤ 15 min (DB) and ≤ 1 h (content) | Drill report |
| AT-3.4 **[Gate]** | Autonomy for offers and IG comments | L3 promotions approved with evidence; QA sampling shows ≤ 0.5% major, 0 critical | QA records |
| AT-3.5 **[Gate]** | Thermal and energy re-test | B-THERM-1 and B-PWR-1 re-run; sustained factor not degraded > 10% vs. G0 (else investigate hardware) | Benchmark runs |
| AT-3.6 **[Gate]** | Projection to 15 | ≤ 85% of `G_day`; chat peak ≤ 0.6 × `ρ·μ*` | Snapshot |

## G4.n — Each batch of five up to 30

| ID | Procedure | Pass | Evidence |
|---|---|---|---|
| AT-4.n.1 **[Gate]** | Previous batch soaked ≥ 14 days | All G2 tests pass at the current persona count | As G2 |
| AT-4.n.2 **[Gate]** | Projection for the next batch | ≤ 85% of `G_day`; chat peak ≤ 0.6 × `ρ·μ*`; reviewer/operator margin ≥ 30%; storage ≥ 90 days | Snapshot |
| AT-4.n.3 **[Gate]** | Account health across all personas | No enforcement actions in the soak period | Consoles |
| AT-4.n.4 **[Gate]** | Incidents | No sev1/sev2 attributable to capacity or GPU contention in the soak period | Incident log |
| **Stop rule** | If AT-4.n.2 fails | The current count is the **measured `N_max`** at current tiers. Escalate the options (lower tiers, fewer personas, second node). | Decision memo |

**MVP complete** = G1 passed, and the persona count is either 20–30 with every G4.n gate passed, or the measured `N_max` with a documented scale-out decision.
