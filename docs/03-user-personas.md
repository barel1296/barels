# Part 3 — User Personas

Four primary personas. The product is designed around Persona 1's daily loop; the others are weekly/strategic surfaces over the same substrate.

---

## Persona 1 — Dana, Head of UA (primary, daily driver)

**Context:** Mid-size game studio, $800K/month spend across Meta, Google, TikTok. Team: herself + 1 junior UA manager + shared creative team. Reports to CMO/founder weekly. Lives in AppsFlyer, Ads Managers, and a Google Sheet called `MASTER_ROAS_v14_FINAL_real`.

**Pains**
- Mornings lost to reconciliation: AppsFlyer, MMP cost data, and ad network dashboards disagree daily; she doesn't fully trust any single number.
- Detects problems late: creative fatigue shows up in her workflow ~5–7 days after it starts costing money.
- Decision latency: diagnosis → Slack thread → creative request → budget change takes 2–4 days.
- SKAN/modeled data ambiguity: can't tell real iOS performance changes from attribution noise.
- Scaling fear: knows some campaigns could absorb more budget but can't quantify the risk, so she under-scales.
- Constant interruption: the CMO asks "why is ROAS down?" and she drops everything for 3 hours.

**Jobs-to-be-done**
- *When I start my day*, tell me what actually changed and what's real, so I act in minutes, not hours.
- *When performance shifts*, give me a diagnosed root cause with evidence, so I defend decisions to the CMO without building decks.
- *When creatives fatigue*, warn me before the spend curve shows it and hand my creative team a prioritized brief.
- *When there's headroom*, quantify the scale opportunity and the downside so I can take it confidently.
- *When I approve a change*, prepare it perfectly (structure, naming, budgets, targeting) so execution is one click, not 40 minutes in Ads Manager.

**Success metrics (how Dana judges GROS)**
- Morning routine ≤ 10 minutes (from ~2 hours).
- Fatigue detected ≥ 3 days before her old workflow would have caught it.
- ≥ 70% of GROS recommendations she approves without modification.
- Measured wasted-spend reduction ≥ 8% in the first 90 days.
- Zero incidents where an approved action did something other than what the preview showed.

**Trust profile:** Skeptical expert. Will try to catch the system being wrong in week 1. Wins her by showing the SQL, admitting low confidence honestly, and never overclaiming. Loses her forever with one hallucinated number.

---

## Persona 2 — Michael, CMO (weekly strategist, economic buyer influence)

**Context:** Subscription app company (fitness), $400K/month spend, owns P&L for growth. Manages UA lead, lifecycle/CRM manager, ASO contractor, creative team.

**Pains**
- No single trusted picture: every team brings its own numbers; board prep takes days.
- Can't connect marketing to product: UA reports ROAS, product reports retention, nobody owns the join.
- Suspects 10–20% of spend is wasted but can't locate it.
- Team capacity caps strategy: ideas die in the backlog because execution hours don't exist.

**Jobs-to-be-done**
- *When I plan the week*, show me the 3 decisions that matter most, pre-analyzed with options and trade-offs.
- *When I report to the board/founder*, give me defensible numbers with a causal story.
- *When I delegate to the system*, enforce my guardrails: budget caps, approval chains, audit logs — I am accountable for what it does.
- *When LTV assumptions shift*, re-evaluate every active budget allocation against the new reality automatically.

**Success metrics:** blended CAC/LTV trend, % of spend with an active "thesis" attached (why this money is deployed here), time-to-decision on cross-functional problems, audit completeness when finance asks.

**Trust profile:** Buys outcomes and control. The approval workflow, permissions, and audit log are *purchase requirements*, not features. Will champion internally if GROS makes his weekly meeting shorter and his board story sharper.

---

## Persona 3 — Tomer, Founder (occasional, decisive)

**Context:** 40-person studio, technical founder, growth is the #1 lever and the #1 anxiety. Checks numbers at 11pm.

**Pains**
- Doesn't know if the growth team is good — no benchmark, no second opinion.
- Binary visibility: either a 30-slide monthly deck or a raw dashboard he can't interpret.
- Worries about single-person dependency: if the Head of UA quits, growth knowledge walks out.

**Jobs-to-be-done**
- *When I open the app at 11pm*, answer "are we okay?" in one screen with honest uncertainty bounds.
- *When I evaluate the growth function*, give me an independent, evidence-based read of where we're strong/weak vs. achievable.
- *When key people leave*, retain the institutional decision memory (every decision, rationale, and outcome is in the system).

**Success metrics:** confidence in growth numbers, reduced key-person risk, growth output per headcount.

**Trust profile:** Will poke the system with hard questions ("why is this confidence 0.78 and not 0.9?"). The decision-memory archive is an emotional hook: GROS becomes the studio's growth brain.

---

## Persona 4 — Lena, Growth/Lifecycle Lead (CRM, paywall, product-growth seam)

**Context:** Subscription app, owns onboarding funnel, paywall experiments, CRM journeys, win-back. Constantly fighting UA for attention on "what happens after the install."

**Pains**
- UA optimizes to installs/trials that her funnel data says don't convert; nobody closes that loop.
- Paywall/pricing experiments interact with UA performance and nobody models the interaction.
- CRM actions (win-back, upsell) are planned quarterly because analysis is expensive.

**Jobs-to-be-done**
- *When UA quality shifts*, show the cohort-level funnel impact and push the insight INTO the UA strategy automatically.
- *When I run a paywall test*, guard the UA agents from misreading it as organic performance change — and tell me its true LTV impact per acquisition source.
- *When a churn-risk segment emerges*, prepare the CRM action (segment, journey, message angles) for my approval.

**Success metrics:** trial→paid rate by source, experiment velocity, churn saves from system-prepared CRM actions.

**Trust profile:** The product-growth insights module (Part 4 module list, Part 9 playbooks) is hers. She is the proof that GROS is not "just a UA tool."

---

## Anti-persona (explicitly not designed for, v1)

- **Indie dev spending $5K/month:** not enough data for the statistical layer; not enough money for the price; would force toy-grade simplifications.
- **Enterprise publisher with a 40-person UA org and in-house data science:** procurement cycle and customization demands would distort the roadmap. Revisit at Phase 7+.
- **Pure ecommerce/DTC:** Triple Whale's home turf; our product-context advantage (retention, LiveOps, game economy, subscription funnels) is wasted there.

## Persona-driven surface map

| Surface | Dana (UA) | Michael (CMO) | Tomer (Founder) | Lena (Lifecycle) |
|---|---|---|---|---|
| Command Center | Daily, 10s loop | Weekly summary view | 11pm check | Funnel slice |
| War Room | Participant/approver | Arbiter on big calls | Observer | Participant on product-growth sessions |
| Approvals queue | Owner (UA actions) | Owner (>$X threshold) | Escalation only | Owner (CRM actions) |
| Tracking Health | Reviews | Cares it's green | Ignores until red | Reviews event taxonomy |
| Creative Intelligence | Daily | Weekly | No | No |
| Audit log | Rarely | Monthly + finance asks | Trust spot-checks | Rarely |
