# Part 6 — War Room Design

The War Room is the product's soul: where users watch their AI Growth Team think, judge its reasoning, and approve its actions. Design DNA: Linear's density and speed, Cursor's "watch the work happen" transparency, a trading-desk's seriousness. No avatars-having-a-chat gimmick — this is a decision record, not a chatbot theater.

## 6.1 Information architecture

```
/war-room                 → Session list (live, awaiting approval, monitoring, closed)
/war-room/:sessionId      → Session view (the core screen)
/war-room/:sessionId/evidence/:evidenceId → Evidence inspector (drawer/modal)
```

### Session list
Dense table, keyboard-navigable (j/k, enter, a to jump to approval):
`severity dot · title ("ROAS drop — Germany / Google") · $ at stake · phase chip (investigating / debating / awaiting approval / monitoring) · confidence · agents involved (small glyphs) · age · unread-change indicator`. Filters: status, channel, geo, playbook, magnitude. Live-updating via SSE.

### Session view — three-pane layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HEADER: title · $ at stake · phase progress (triage→health→investigate→      │
│ debate→decision→action) · confidence gauge · participants · watch/share      │
├───────────────────────────────┬──────────────────────────────────────────────┤
│                               │  RIGHT RAIL (sticky)                         │
│  CENTER: DEBATE THREAD        │  ┌────────────────────────────────────────┐  │
│                               │  │ DECISION PANEL                          │  │
│  Chronological, grouped by    │  │ status · chosen option · rejected       │  │
│  phase. Each message:         │  │ alternatives (expandable) · predicted   │  │
│   [agent chip] [type tag]     │  │ impact range · risk statement ·         │  │
│   claim text                  │  │ re-evaluation conditions                │  │
│   evidence chips [ev_8f2a ▸]  │  ├────────────────────────────────────────┤  │
│   confidence bar              │  │ ACTION PANEL (one card per action)      │  │
│   ↳ replies/challenges nested │  │ diff preview (before → after)           │  │
│                               │  │ guardrails: ✓✓✓ (each named)            │  │
│  Disagreements rendered as    │  │ rollback plan ▸ · monitoring plan ▸     │  │
│  side-by-side CONTENTION      │  │ dry-run: PASSED 09:41 ▸                 │  │
│  CARDS (see 6.3)              │  │ [ Approve ] [ Modify ] [ Reject ]       │  │
│                               │  ├────────────────────────────────────────┤  │
│  Live mode: messages stream   │  │ EVIDENCE INDEX                          │  │
│  in with phase ticker         │  │ all artifacts, grouped by agent,        │  │
│                               │  │ click → Evidence Inspector              │  │
├───────────────────────────────┴──┴────────────────────────────────────────┴──┤
│ FOOTER BAR: ask-the-room input (user can inject a question/constraint —      │
│ becomes a directive message the Growth Director must address)                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 6.2 The debate thread (center pane)

- **Phase-grouped, collapsible.** Default view collapses investigation detail and shows: health gate result → key findings (top 3–5) → contentions → decision. Power users expand everything. The 10-second read lives at the top as an auto-generated **session abstract** (3 sentences, written by the Growth Director at close).
- **Message anatomy:** agent identity chip (each agent has a fixed color + icon, no cute avatars), type tag (`finding/hypothesis/challenge/concession/proposal`), claim in plain business English, evidence chips inline exactly where a number is asserted, confidence bar, timestamp. Numbers in claims are **rendered from the evidence artifact** (not from LLM text) — the UI binds `{metric:...}` tokens in the message to evidence values, so a displayed number can never be a hallucination.
- **Live sessions** stream messages via SSE with a subtle phase ticker ("Intelligence running dimensional decomposition… 3 queries"). Watching it think is the Cursor moment — but replay is the default consumption mode (most sessions conclude before a human looks).

## 6.3 Contention cards (where agents disagree)

Disagreement is a first-class UI object, not buried thread replies:

```
┌─ CONTENTION: What caused the DE ROAS drop? ────────────────────────────────┐
│  INTELLIGENCE (0.62)              │  CREATIVE (0.81)                        │
│  Auction pressure: CPM +9% w/w    │  Fatigue: IPM −38% began 2 days        │
│  in DE gaming category            │  BEFORE the CPM rise; top asset        │
│  ev_2231 ▸  ev_2238 ▸             │  CTR −44% from peak                    │
│                                   │  ev_8f2a ▸  ev_8f2b ▸  ev_8f30 ▸       │
│  RESOLUTION — Growth Director: timeline favors fatigue as primary cause;   │
│  CPM rise is real but secondary. Action robust to both. (concession ▸)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Unresolved contentions at decision time are shown prominently with both positions — honesty over forced consensus (P8).

## 6.4 Evidence Inspector

Opens as a right-side drawer over any evidence chip:
- **Result view:** the frozen snapshot rendered as table/chart (this exact data, as of this timestamp).
- **Definition view:** metric name, version, plain-language formula, caveats, lineage (sources → tables → mart).
- **Query view:** the actual SQL (collapsed by default), parameters, execution time, row count, data freshness at execution.
- **Re-run button:** executes the same query against current data, diffs against the snapshot ("evidence drift") — key for judging stale sessions before approving.

This drawer is the trust engine. A skeptical Head of UA spends week 1 in it; by week 4 she opens it 10% as often.

## 6.5 Decision & Action panels (right rail)

**Decision panel:** terminal state badge (`ACTION PROPOSED / MONITOR / ESCALATED`), chosen option, **rejected alternatives** with one-line reasons (critical for trust — shows the room considered the obvious moves), predicted impact as a range with the estimation basis linked, risk statement (authored by the Risk Officer specialist), re-evaluation conditions ("re-open if D3 ROAS not recovered by Jun 16").

**Action panel** (per prepared action):
- **Diff preview** — exact before→after (e.g., `DE_Android_Value daily budget: $1,200 → $960 (−20%)` plus the receiving campaign's `+$240`), structure diagrams for campaign creation.
- **Guardrail strip** — every policy evaluated, named, pass/fail (`✓ ≤25% daily change · ✓ blast radius 4.1% < 10% · ✓ data health green · ✓ no entity lock`).
- **Dry-run badge** — platform validation passed, when, with the platform's response digest.
- **Rollback & monitoring plans** — expandable; auto-revert conditions in plain language.
- **Buttons:** `Approve` (permission-gated; high-magnitude → confirmation step restating the diff; optional two-person rule shows co-approver state) · `Modify` (opens parameter editor bounded by guardrails; produces a new action version, marked "modified by human") · `Reject` (mandatory reason — structured picklist + free text; feeds learning loop).
- **Expiry:** stale actions (evidence drift beyond tolerance or TTL) flip to `expired` with a one-click "re-validate" that re-runs evidence + dry-run.

## 6.6 Confidence scoring display

Confidence appears at three levels (message, finding, decision) with a consistent visual grammar: a 5-segment bar + number (0–1). Hovering explains the rubric contribution (evidence strength, source agreement, historical playbook precision, data-health penalty — per Part 9.6). **Calibration page** (in settings/analytics): "when we say 0.8, we've been right 78% of the time" — shown per tenant once n≥30 resolved recommendations. We display calibration even when unflattering; this is a deliberate trust strategy.

## 6.7 History & audit view

- Every session permanently replayable: full thread, evidence snapshots (immutable), decision, approvals, execution results, and the **outcome record** (predicted vs. realized impact, auto-computed at the monitoring horizon, displayed as a banner on closed sessions: `Predicted +$15–22K/mo · Realized +$17.8K/mo ✓`).
- Session timeline export (PDF/Markdown) for board decks and finance reviews.
- The closed-sessions archive doubles as the studio's institutional growth memory (Persona 3's hook) — searchable by entity, geo, playbook, outcome.

## 6.8 User participation

Users are participants, not spectators:
- **Ask the room** (footer bar): a question or constraint ("we can't add creative production capacity this month") becomes a directive message; the orchestrator routes it; the Growth Director must address it before finalizing.
- **Start a session** from anywhere: any metric chip, campaign row, or anomaly card has "Investigate →" which opens a session pre-scoped to that entity.
- **Override with reason:** humans can override vetoes/gates; the override is logged and displayed in the thread (audit-grade, P10).

## 6.9 Failure-mode honesty (designed, not accidental)

- Inconclusive sessions say so: `MONITOR — evidence insufficient to act. Watching: [metrics]. Re-check: Jun 12.`
- Budget-exhausted sessions (token/time caps hit) state what was and wasn't examined.
- Data-gated sessions show the red health banner and the parked question, with the tracking-fix recommendation linked.
A War Room that occasionally says "we don't know yet" is what makes its "we know" believable.
