# Part 1 — Executive Product Vision

## The pitch

**We are building the first AI Growth Operating System: software that doesn't show you your growth problems — it solves them.**

Every mid-size mobile game studio and subscription app company runs the same broken loop. Spend is live across Meta, Google, and TikTok. Attribution lives in AppsFlyer, revenue in RevenueCat, product behavior in Firebase and a half-maintained ClickHouse. A Head of UA opens six dashboards every morning, spends two hours reconciling numbers that disagree, notices ROAS slipped in two geos, guesses why, posts in Slack, waits for the creative team, and moves budget two days later — after $40K already burned against a fatigued ad. Multiply that by every decision, every day.

The market's answer so far has been **better dashboards**: more charts, faster pivots, prettier cohort curves. That is the wrong answer. Dashboards scale *visibility*. They do not scale *judgment* or *execution*. The bottleneck in growth is not seeing the data — it is the loop from data → diagnosis → decision → action, which today runs entirely through scarce, expensive, distracted humans.

GROS replaces that loop with an **AI Growth Team**:

- A **Tracking/Data Agent** that guards the Single Source of Truth — attribution health, event taxonomy, SKAN sanity, data reconciliation — so every downstream decision stands on solid ground.
- An **Intelligence Agent** that watches every KPI, cohort, funnel, and competitor signal continuously, detects anomalies statistically, and explains them in business terms.
- A **Creative Agent** that detects creative fatigue before ROAS shows it, dissects hook performance, mines competitor creative patterns, and produces new concepts, scripts, and variation briefs.
- An **Operations Agent** that turns decisions into *executable artifacts*: a budget change diff, a ready-to-launch campaign structure, an audience sync spec, a CRM journey change — validated against platform rules before a human ever sees them.
- A **Growth Director Agent** that runs the room: sets priorities, weighs evidence, arbitrates disagreement between agents, allocates budget logic, and signs the final recommendation.

These agents work in a visible **War Room**. When ROAS drops in Germany, the user doesn't get an alert — they get a concluded investigation: what each agent found, where they disagreed, the evidence behind each position (real queries, inspectable), the decision, the prepared action, and an **Approve** button. Ten seconds to understand. One click to act.

## The wow moment, concretely

> *"D7 ROAS in Germany dropped 31% starting June 3. Tracking Agent confirms attribution is healthy — this is real. Intelligence Agent isolated the drop to Google App Campaign 'DE_Android_Value': CPI stable, IPM down 38% — a demand-side creative problem, not an auction problem. Creative Agent confirms: top asset 'Bonus_Hook_v3' is at 9.2 average frequency-weighted exposure days with CTR down 44% from peak; the hook pattern ('free reward reveal') is also declining across competitor ads in the same category. Creative Agent generated 5 variation briefs using the two hook patterns currently rising in DE. Operations Agent prepared: (1) a new asset group with the 5 variations, (2) a 20% budget shift from DE_Android_Value to DE_Android_ROAS while the new creatives ramp, with auto-revert in 7 days if D3 ROAS doesn't recover. Growth Director estimates +$18.4K/month impact, confidence 0.78. Waiting for your approval."*

No existing product does this end-to-end. Triple Whale shows the drop. AppLovin Compass benchmarks it. An agency notices it Thursday. GROS closes the loop in 20 minutes — with audit-grade evidence.

## Why now

1. **LLMs crossed the agentic threshold.** Multi-step reasoning over tools (Claude-class models) makes credible automated investigation possible — Cursor proved users will trust AI that *does work* when its work is inspectable.
2. **Privacy broke human-scale UA.** SKAN, Privacy Sandbox, and modeled attribution made the data too ambiguous for spreadsheet intuition. You now need systematic statistical reasoning just to know what's real. That's machine territory.
3. **Mid-size is squeezed.** Studios at $300K–$5M/month spend can't afford a 10-person growth org and can't get big-publisher tooling. They are exactly the segment where one Head of UA + GROS outperforms a 6-person team.
4. **The platforms went black-box.** Meta Advantage+ and Google ACe took targeting away; the remaining human levers are budget allocation, creative strategy, market selection, and measurement integrity — precisely the four things GROS is built to operate.

## What we are NOT building

- Not a BI tool with an AI chat bolted on.
- Not an auto-bidder (the networks own bidding; we own strategy above it).
- Not a thin GPT wrapper that "summarizes your dashboard."
- Not an agency replacement pitch deck — it ships with audit logs, permissions, and approval workflows because real companies move real money through it.

## Business model and wedge

- **Wedge:** Tracking Health + Command Center + War Room in approval mode. The Tracking/Data Agent alone justifies the contract — every studio has silent attribution rot, and finding it builds the trust required for everything else.
- **Pricing:** platform fee tiered by tracked monthly spend (e.g., $2K–$10K/month), plus usage-based agent compute. Never % of spend — that poisons the incentive to recommend cutting waste.
- **Expansion:** approval mode → supervised autonomy per action type → Level 4 managed growth. Each autonomy upgrade is a price tier, justified by a written track record the system itself accumulates (every recommendation's predicted vs. realized impact is logged — our accuracy *is* the sales deck).
- **Moat:** (1) the evidence/audit substrate — competitors demoing chat-on-data can't retrofit trust; (2) cross-tenant pattern intelligence (privacy-safe benchmarks of what works); (3) the action-outcome dataset: we will own the largest corpus of "growth decision → measured result" pairs in the industry.

## Honest founding-team challenges (stated up front, addressed in Part 14)

- **"Replace a Growth department" is the vision, not the v1 promise.** V1 sells *multiplication*: one Head of UA operating like a team of eight. Selling replacement before earning trust kills deals with the very people who champion us.
- **Eighteen integrations on day one is how startups die.** Phase 1 ships five (AppsFlyer, Meta, Google, RevenueCat, Firebase/events) done to production grade; the rest follow the roadmap.
- **The War Room must never be theater.** Agent debate that isn't grounded in stored, replayable evidence is a party trick that collapses on first contact with a skeptical CMO. The architecture makes ungrounded claims structurally impossible (Part 5, Part 9).
- **Trust is the product.** The first wrong $50K recommendation a customer approves is an extinction event. Confidence scoring, blast-radius limits, auto-revert plans, and predicted-vs-realized tracking are not features — they are the company.
