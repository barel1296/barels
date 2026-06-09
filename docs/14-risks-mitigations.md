# Part 14 — Risks & Mitigations

Ordered by expected damage (likelihood × severity), not by category. The first three are existential.

## R1 — Trust collapse from one bad consequential recommendation (PRODUCT / EXISTENTIAL)
A customer approves a $50K budget shift on our confident-but-wrong diagnosis. They tell every Head of UA they know. In a small, tightly networked industry, this is how the company dies.
**Mitigations:** confidence gates on action magnitude (Part 9.6: low confidence can only propose small "test" actions); blast-radius guardrails default-on; auto-revert monitoring armed on every action; predicted-vs-realized tracking shown honestly (calibration page) so trust is earned on a written record; Devil's Advocate pass + preserved disagreement instead of forced consensus; the negative-suite QA gate (confidently-wrong on ambiguous data blocks release). **Residual stance:** we will still be wrong sometimes — the product's contract is "wrong small, honest, and reversible," and that must be in the sales narrative from day one.

## R2 — Agent hallucination / ungrounded claims (AI / EXISTENTIAL)
An LLM invents a number or a causal story; a screenshot of it circulates.
**Mitigations:** structural, not promissory — protocol-level rejection of claims without evidence references; renderer substitutes numbers from evidence artifacts (a hallucinated number is unrenderable, not just discouraged); validation gate before publish; fabrication rate = 0 as a release-blocking metric in the golden harness; full LLM trace retention for forensics. **Residual:** subtly wrong *interpretation* of correct numbers — mitigated by falsification-field discipline, debate, and human approval; never fully eliminated.

## R3 — The SSOT is wrong (DATA / EXISTENTIAL)
Our reconciled numbers disagree with the customer's dashboards and we lose the "source of truth" claim — everything above the data layer becomes worthless.
**Mitigations:** reconciliation as a continuously running product feature, not a setup step; per-tenant certification protocol with documented tolerances before "trusted" status; restatement-safe architecture (re-pull windows, ReplacingMergeTree, marts rebuilt from facts); Tracking Agent surfaces discrepancies *to the customer first* — being the one who tells you your data is broken converts the failure mode into the wedge. **Residual:** sources that are simply unreconcilable (SKAN vs. network-reported) — handled by explicit caveat metadata on metrics rather than false precision.

## R4 — Platform API dependency and policy risk (TECHNICAL / HIGH)
Meta/Google/TikTok APIs change versions, tighten rate limits, restate data semantics, or restrict automated management; an app review rejects our write scopes.
**Mitigations:** adapter isolation (one module per platform, capability-declared); raw-zone replayability (normalizer fixes never need re-pulls); read-only scopes for all of v1 (smallest possible review surface, structural safety); nightly live sandbox tests catch breakage before customers do; version-upgrade playbook rehearsed (Phase 6 exit criterion); diversified value (SSOT + intelligence remain valuable even if a write path is temporarily lost). **Watch item:** platform ToS on automated changes — execution features get per-platform legal review at Phase 6, and our human-approval regime is itself the compliance story.

## R5 — SKAN/privacy ambiguity makes confident attribution claims impossible (DATA / HIGH)
On iOS, the honest answer is often a wide interval; users want a number.
**Mitigations:** model uncertainty as product (evidence scores degrade for modeled data; caveats are rendered, not buried); SKAN Forensic specialist treats measurement limits as first-class findings ("iOS DE is unmeasurable for 72h — here's why and what we *can* know"); recommendations on iOS default to smaller, reversible steps. **Opportunity inside the risk:** competitors fake confidence here; honest uncertainty handling is differentiation with sophisticated buyers.

## R6 — LLM cost blowout (TECHNICAL-ECONOMIC / HIGH)
Agent debates are token-hungry; at scale, COGS could eat the margin.
**Mitigations:** statistics detect / LLMs interpret (the architecture's core cost decision); materiality filter — no session below $-at-stake threshold; per-phase token budgets with graceful termination; model tiering + prompt caching + digest-only context (raw data never enters prompts); per-tenant hard budgets in the gateway; session cost as a first-class QA metric (p50 < $3). **Target economics:** LLM COGS < 10% of ACV; measured monthly from the ledger.

## R7 — War Room theater: debates that look smart but add nothing (PRODUCT / MEDIUM-HIGH)
Multi-agent debate can devolve into expensive, correlated agreement — same model, five hats.
**Mitigations:** agents differ by *evidence access and tools*, not just prompts (Creative sees fatigue curves Intelligence doesn't; Tracking sees reconciliation Intelligence doesn't) — disagreement emerges from information asymmetry, which is real; debate rounds bounded with early convergence exit; the golden harness measures whether debate *changes outcomes* vs. single-agent baseline — if a playbook's debate adds no accuracy, it gets a leaner roster (measured, not assumed); contention cards make genuine disagreement visible value.

## R8 — "Dashboard with extra steps": users ignore recommendations and use us as BI (PRODUCT / MEDIUM-HIGH)
Approval rates languish; we become a nicer Triple Whale; pricing power evaporates.
**Mitigations:** action-terminal principle (P3) keeps the product opinionated; approval/edit/rejection rates are *the* north-star metrics reviewed weekly; rejection reasons mined for systematic causes (wrong size? missing context? bad timing?); design partners chosen for willingness to act, not just look; the one-click execution phase (6) is the structural answer — when acting is easier than ignoring, behavior flips.

## R9 — Onboarding cliff: weeks to value (GTM / MEDIUM-HIGH)
SSOT products historically die in implementation: credentials, taxonomy mapping, backfills, reconciliation disputes.
**Mitigations:** value ladder during onboarding — Tracking Health findings appear within hours of the first connector (the system finds *their* data problems before full SSOT exists); taxonomy mapping assistant (observed events → suggested canonical mapping); backfill prioritized most-recent-first so the Command Center lights up same-day; white-glove for the first ten tenants with every manual step converted to product.

## R10 — Security breach of ad credentials or tenant data (SECURITY / SEVERE, LOWER LIKELIHOOD)
We hold OAuth tokens to accounts spending millions, plus competitive performance data.
**Mitigations:** envelope encryption per tenant, KMS-held keys; read-only scopes v1; RLS + adversarial isolation suite in CI; secrets never in logs (canary-tested); pentest before GA; SOC 2 controls from Phase 0; prompt-injection corpus (hostile ad names/reviews must be inert); kill switch + scoped credential revocation runbooks. **Note:** an attacker with our write-scoped tokens could move budgets — another reason the scope upgrade is per-tenant, late, and guarded.

## R11 — Key-person/model dependency (AI-VENDOR / MEDIUM)
A single LLM provider outage or capability regression degrades the product overnight.
**Mitigations:** multi-provider gateway with failover; pinned model versions with shadow-mode evaluation before upgrades (the golden harness is the regression net); deterministic layers (detection, decomposition, guardrails) keep the dashboard and signals fully functional with zero LLM availability — the product degrades to its wedge, not to nothing.

## R12 — Scope seduction (EXECUTION / MEDIUM, SELF-INFLICTED)
Eighteen integrations, six personas, agencies, autonomy — the roadmap invites trying to build everything at once.
**Mitigations:** phase exit criteria in writing (Part 11) with go/no-go reviews; five connectors before any sixth; one design-partner vertical (pick: mobile gaming first — deeper product context moat) before subscription-app surface area; the prompt chain (Part 13) enforces sequence; founders re-read Part 2's tiebreakers when tempted.

## R13 — Regulatory/privacy drift (LEGAL / MEDIUM)
GDPR/DMA/state privacy laws around audience syncs and user-level data; AI-decision accountability rules emerging in the EU.
**Mitigations:** pseudonymous IDs only in analytics; audience syncs carry consent/legal-basis flags and hashed-ID-only payloads; deletion pipeline with proof; the audit/approval architecture is precisely what AI-accountability regimes are converging on — compliance becomes a sales asset; DPA + subprocessor list maintained from first paying tenant.

## R14 — Incumbent response (MARKET / MEDIUM-LONG)
AppsFlyer, Adjust, or Triple Whale ships "AI agents" above their existing data.
**Mitigations:** they are structurally conflicted (MMPs can't honestly audit their own attribution; our Tracking Agent can), org-slow, and dashboard-DNA'd; our moats compound where they can't follow quickly: cross-source neutrality, the action-outcome dataset, autonomy track record per tenant, and audit-grade execution infrastructure. Speed through Phases 3–6 is the real defense — the moat is the loop, and the loop takes years to retrofit onto a BI product.
