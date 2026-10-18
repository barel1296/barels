# Admin dashboard review: demo influencers "Luna Vale" and "Nova Reyes" (2026-10-18)

These are full-page screenshots of every dashboard screen. They were taken in a real headless Chromium, signed in with password + TOTP, against the **real platform build**. The platform used its own database (`golden_demo`) on a local PostgreSQL 16 server in the development container.

All external systems were **SIMULATED**: Telegram (including Stars payments), Instagram, the local LLM and ComfyUI. ComfyUI sat behind the real VEC bridge. Nothing touched Telegram, Meta, a model, the RTX 5090 workstation or production.

**Use it interactively:** [`deploy/demo/`](../../../deploy/demo/README.md) starts the same demo in a GitHub Codespace (a private HTTPS URL) or on your own computer.

**Reproduce the screenshots (any machine with Node 22 and a development PostgreSQL 16):**

```bash
cd apps/platform && npm ci && npm run build
npm run demo -- --admin-url postgres://postgres:<pw>@127.0.0.1:5432/postgres --out /tmp/golden-demo --reset
#   → prints the dashboard URL (http://127.0.0.1:8090/admin/); the sign-in details are in /tmp/golden-demo/demo-credentials.txt (mode 600)
npm run demo:screenshots -- --out /tmp/golden-demo     # in a second terminal: these 22 PNGs
```

The demo resets the passwords of the `aios_*` roles on the server it is given, so only point it at a development server.

## Demo data

| Area | What is seeded (all through the real API, except where marked) |
|---|---|
| Influencer | **Luna Vale**, active, Europe/Lisbon. Persona v1 active (authored by the content manager, approved by compliance, activated by the owner); v2 waiting for review |
| Identity | Reference images: face approved, outfit pending. One LoRA adapter, approved. Binding `feed_photo` → test workflow `sim.portrait` |
| Channels | Telegram bot, public channel, premium "Luna VIP" channel; Instagram account `luna.vale.ai` |
| Media | 4 generations through platform → bridge → simulated ComfyUI. The images are **solid-colour placeholders** made by the simulator |
| Content | 1 post published to Instagram (with insights and 4 comments), 1 published to Telegram, 1 scheduled for tomorrow, 1 waiting for review (QA passed), 1 held by automated QA (claims to be human + off-platform payment) |
| Strategy | Strategist plan for next week approved (4 briefed calendar items); the week after waiting for approval |
| Fans | 6 Telegram fans with consent. Drafts waiting in the inbox (Mia, Priya); an auto-reply conversation (Kenji); 4 memories; 2 escalations (a request for a human, a refund request) |
| Money | 3 active products + 1 draft; 5 Stars payments (750 ⭐) matched 1:1 in the simulated Stars ledger; 3 subscriptions; 1 refund waiting for finance approval |
| Analytics | 14 days of KPIs. **Synthetic (inserted directly for the demo):** the Instagram follower and Telegram member history, and older dates on some fans' activity |
| Second influencer | **Nova Reyes**, Europe/Madrid, cloned from Luna (bindings, runtime settings and draft copies of Luna's products), then given her own identity: persona v1 active (same three-person approval), face reference approved, bot `novareyes_demo_bot` and a public channel, an active product "Nova Chat Plus" (120 ⭐), one generated image published to her channel, and 2 fans (Lucía with memory consent; Mateo, who bought the subscription) |
| Ops | GPU samples from a **simulated `nvidia-smi`**; realistic open alerts (no backup yet; QA hold) |
| People | Owner, content manager, reviewer, compliance officer, finance and chat operator, each with their own permissions |

## Walkthrough

| # | Screen | What it shows / what you can do there |
|---|---|---|
| 01 | Sign in | Email + password + authenticator code (TOTP is mandatory). Lockout after repeated failures |
| 02 | Overview | Pending approvals, open escalations, open alerts, 30-day revenue (Stars), AI share of replies, new fans; per-influencer KPI table; alerts with Ack/Resolve |
| 03 | Influencers | All influencers with status, disclosure, time zone; **New influencer** form |
| 04 | Influencer | Runtime settings (free/premium daily replies, default chat mode, fan memory, paused); kill switches (autonomy, conversations, publishing); channels; links to setup, calendar, money, analytics |
| 05 | Setup | Status (activate/pause/archive); persona versions with submit → approve (another person) → activate, and a JSON editor for the next draft; reference image upload/approval; adapters; workflow bindings; Telegram bot connection and profile sync; **Clone configuration** |
| 06 | Approvals | Everything waiting for a human decision: content, agent plans |
| 07 | Approval detail | The exact revision (image, caption, hashtags, AI disclosure) and the automated QA verdict; approve/reject bound to the content hash |
| 08 | Inbox | Conversations needing attention: pending AI drafts and escalations per fan |
| 09 | Conversation | Full chat with consent and disclosure messages; editable AI drafts (Approve & send / Reject); chat mode (ai_draft / ai_auto / human / paused); operator messages |
| 10 | Escalations | Open escalations with severity, SLA due time; acknowledge/resolve with a note |
| 11 | Calendar | Strategist plans (approve via Approvals); planned, scheduled and published items with QA status and publications; "Ask the strategist to plan next week" |
| 12 | Media | Generated, derived (JPEG for Instagram) and uploaded images with validation status and origin |
| 13 | Agents | Enabled agents and their maximum autonomy level; proposals and their policy decisions; autonomy policies (the second-person approval is pending here) |
| 14 | Money | Products (submit/approve/retire); reconciliation with the Telegram Stars ledger; payments; refund requests (the requester is shown "awaiting another approver"); subscriptions |
| 15 | Analytics | Revenue per day; daily KPIs (followers, reach, new fans, messages, revenue, subscribers, estimated margin); per-post metrics |
| 16 | Engines | Visual engines (health, sync), engine registration, workflow registry with approve/reject/disable |
| 17 | Ops | Component health; alerts; dead-lettered jobs with retry; GPU samples (last hour); backups |
| 18 | Users | Members, roles, MFA status; invite with a one-time setup token |
| 19 | Setup (second influencer) | Nova Reyes: her own active persona and face reference; the `feed_photo` binding copied from Luna |
| 20 | Overview at phone width | The layout at 390 px |
| 21 | Influencer (second) | Nova Reyes: runtime settings, kill switches, her bot and public channel |
| 22 | Money (second) | Nova's active product plus the two draft products copied by the clone; one payment matched in the Stars ledger; one subscription |

## Fixed while preparing this review

These were found in the screenshots and fixed in the same change:

- The alert "Since" column was empty: it read `first_seen_at`; the column is `opened_at`.
- Plan periods showed raw ISO timestamps; they now show dates.
- The refund Approve button was offered to the person who requested the refund. The server already refused it (four-eyes); the button is now hidden, with "awaiting another approver".
- GPU sampling stopped completely when a GPU name contained a comma, because the CSV fields shifted (a numeric overflow on insert). The parser now reads the numbers from the end, with a unit test.

## Frontend features not implemented yet

The API supports all of these; the dashboard does not offer them yet. Today they need API calls or the CLI.

| Area | Missing in the UI |
|---|---|
| **Content production** | Create a content item, write or edit a caption and revision, attach media, request approval, schedule or cancel a publication. The calendar is read-only apart from "ask the strategist" |
| **Image generation** | "Generate" from a binding, the visual job queue (progress, errors, cancel, retry), workflow parameter forms |
| **Fans / CRM** | Fan directory and profile; view or delete a fan's memories; erase a fan; send a product offer in a chat |
| **Instagram comments** | Moderation queue (held comments, reply, ignore) |
| **Catalog** | Create or edit products (only submit, approve and retire exist) |
| **Channels & integrations** | Connect an Instagram account; add Telegram public or premium channels (only the bot connection exists) |
| **Policies** | Create autonomy policies (only approval exists); QA thresholds; content policies; business objectives |
| **Audit** | Audit log viewer, content lineage view, "verify audit chain" button |
| **Users** | Change a role, deactivate a user, reset credentials (only invite exists) |
| **Engines** | Edit an engine after registration (`media_lane_vram_mb`, `dispatch_limit`), view a workflow manifest |
| **Persona** | A structured persona form and a diff between versions (today: a JSON editor) |
| **Analytics** | Axes and labels on the chart, date-range picker, CSV export, portfolio comparison, cost breakdown, capacity/usage view |
| **General** | Live updates (pages refresh on navigation only); push notification of critical alerts; search, filters and pagination on long tables; a real phone layout (navigation wraps and wide tables scroll at 390 px); fan names on payments and escalations; English only; no formal accessibility audit |

Small UX notes from the review:

- Draft messages show the text twice (as text and in the edit box).
- The Approvals list has no influencer name or preview.
- The Ops health "Detail" column shows raw JSON.
