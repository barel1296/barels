# Workstation acceptance tests (real hardware)

This is the checklist for the first deployment on the RTX 5090 workstation, and for every later upgrade.

**Nothing in this list has been executed yet.** Everything so far ran in a Linux cloud container without a GPU, ComfyUI, a real LLM, Telegram or Meta. The automated suite uses simulators and the contract mock, and all of them are labelled. Every run below must be real, and its evidence goes to `D:\golden\evidence\` (then into `docs/evidence/` in the repository).

> **Rules**
> - A step passes only on the workstation, against the real services. Simulated or contract-mock results never count.
> - `integration-test.ps1` refuses to call a run acceptance evidence when it detects a simulator: `acceptance_evidence: false` in `summary.json`.
> - Record failures as they are. Do not edit evidence files.
> - Nothing is published to a public audience during acceptance:
>   - Telegram tests use `TELEGRAM_ALLOWLIST_USER_IDS` and a private test channel;
>   - Instagram tests use a test account.
> - Production use starts only after explicit approval.

Result columns: **P**ass / **F**ail / **B**locked, with the evidence file name.

## W0 — Workstation fingerprint

| # | Step | Expected | Evidence |
|---|---|---|---|
| W0.1 | `powershell -ExecutionPolicy Bypass -File ops\scripts\verify-host.ps1 -OutFile D:\golden\evidence\fingerprint.json` | RAM, disks, GPU, driver, CUDA, power limit, running services recorded; `complete: true` | `fingerprint.json` |
| W0.2 | Record the OEM performance mode, AC adapter rating, cooling (docs/14 §1) | Written down with photos | `fingerprint-notes.md` |

## W1 — Install and automated suite on Windows

| # | Step | Expected | Evidence |
|---|---|---|---|
| W1.1 | `install.ps1 -InstallRoot D:\golden -Postgres native -OwnerEmail ...` | All steps OK; owner token and TOTP shown once; `MASTER_KEY` copied offline | console transcript (redact the token) |
| W1.2 | Re-run `install.ps1 -Postgres existing` | Idempotent: nothing regenerated, `applied: []` | transcript |
| W1.3 | Automated suite against the workstation's PostgreSQL. In `apps\platform`: `$env:TEST_PG_ADMIN_URL='postgres://postgres:<pw>@127.0.0.1:5432/postgres'; npm test` (optional for the browser test: `npx playwright-core install chromium`) | All tests pass on Windows (they still use simulators: this proves the platform on Windows, not the integrations) | `npm-test-windows.txt` |

## W2 — Services and health

| # | Step | Expected | Evidence |
|---|---|---|---|
| W2.1 | `register-services.ps1 -InstallRoot D:\golden -Start` | Tasks created and running | screenshot of Task Scheduler |
| W2.2 | `health-check.ps1 -Json` | `healthy: true`; `component:migrations ok` | `health.json` |
| W2.3 | Reboot the workstation; wait 3 minutes; health check | Platform and bridge are back without logging in | `health-after-reboot.json` |
| W2.4 | Kill the platform's `node.exe` in Task Manager | Task restarts it within ~1 minute; no data lost | log excerpt |
| W2.5 | Dashboard sign-in with password + TOTP | Overview loads | screenshot |

## W3 — Existing ComfyUI (read-only) and the bridge

| # | Step | Expected | Evidence |
|---|---|---|---|
| W3.1 | `discover-comfyui.ps1 -InstallRoot D:\golden -WriteEnv -OutFile evidence\comfyui.json` | The running ComfyUI is found; version, GPU and VRAM are reported; `COMFYUI_URL` is written | `comfyui.json` |
| W3.2 | Compare ComfyUI's folders before and after the whole acceptance run. Use `Get-ChildItem -Recurse <ComfyUI>\models,<ComfyUI>\custom_nodes \| Get-FileHash` and save it to a file; `input\golden-refs\` is the only expected addition | **No change** to models, custom nodes, workflows or settings | `comfyui-hashes-before.txt`, `-after.txt` |
| W3.3 | Track A packages copied to `D:\golden\packages`; `discover-comfyui.ps1 -CheckPackages` | Every package can run; anything missing is reported to Track A, never installed by us | `packages.json` |
| W3.4 | `conformance.ps1 -InstallRoot D:\golden` | 16/16, CONFORMANT, `engine_kind=comfyui` | `vec-conformance-*.json` |
| W3.5 | The six "check on the real ComfyUI" items in [COMFYUI.md §6](COMFYUI.md) | Each confirmed, or a bridge fix is filed | `bridge-checks.md` |

## W4 — Local LLM

| # | Step | Expected | Evidence |
|---|---|---|---|
| W4.1 | Model licence read and recorded; GGUF SHA-256 recorded (docs/15 §5) | Done | `llm-model.md` |
| W4.2 | `health-check.ps1` → `llm ok` (model listed) | ok | `health.json` |
| W4.3 | `llm-bench.ps1 -Runs 50 -Concurrency 2 -WithGpu`, ComfyUI idle | No errors; JSON validity ≥ 0.9; guard pass ≥ 0.9; latency within the chat SLO (docs/11) | `llm-bench-*.json`, `gpu-*.csv` |
| W4.4 | Same while a ComfyUI generation runs (W6) | Chat latency still within SLO; no out-of-memory on either side | `llm-bench-*.json`, `gpu-procs-*.csv` |
| W4.5 | B-LLM-1…6 per docs/14 (full benchmark protocol) | Figures recorded in `ops.benchmark_runs` | benchmark report |

## W5 — The Golden Influencer (dashboard)

| # | Step | Expected | Evidence |
|---|---|---|---|
| W5.1 | Engines page: bridge registered (or `integration-test.ps1 -RegisterEngine`), synced; Track A workflows approved with a note | Workflows `approved`; `media_lane_vram_mb` set from W4.4 measurements | screenshot |
| W5.2 | Influencers → New influencer; Setup: persona draft → submit → **a second account** approves → activate; influencer activated | Four-eyes enforced (the author has no Approve button) | audit log excerpt |
| W5.3 | Reference images uploaded and approved; adapter (Track A LoRA reference) registered and approved by a second account; binding `feed_photo` → Track A workflow | All approved | screenshot |
| W5.4 | Runtime configuration: free replies/day, `ai_draft` mode | Saved | screenshot |

## W6 — First real generation

| # | Step | Expected | Evidence |
|---|---|---|---|
| W6.1 | `integration-test.ps1 -InstallRoot D:\golden -Generate -InfluencerId <id> -Purpose feed_photo` | All steps PASSED; generation `succeeded`, `validation_scope=real_engine`, ≥ 1 media asset; `acceptance_evidence: true` | `integration-*\summary.md` + folder |
| W6.2 | Media page: the image is shown; provenance lists the workflow and Track A's models | Visible | screenshot |
| W6.3 | **Human review of quality and identity consistency** (Track A + reviewer) | Accepted, or rework filed with Track A | review note |
| W6.4 | Cancel a running generation from the API | Only the platform's prompt is interrupted; a prompt queued by hand in the ComfyUI UI is untouched | job events + ComfyUI history |
| W6.5 | Restart ComfyUI during a generation | Job retries or fails cleanly (`ENGINE_JOB_LOST`/retry); nothing hangs | job events |

## W7 — Content pipeline

| # | Step | Expected | Evidence |
|---|---|---|---|
| W7.1 | Content item from the generated image, caption, automated caption QA | QA findings shown; critical findings block | screenshot |
| W7.2 | Approval by a second account; schedule to a **private** Telegram test channel (`PUBLISHING_ADAPTERS=telegram`) | Posted with the AI disclosure in the caption | channel screenshot |
| W7.3 | Calendar and lineage for the item | Full history visible | lineage JSON |

## W8 — Telegram conversations (allowlisted testers)

| # | Step | Expected | Evidence |
|---|---|---|---|
| W8.1 | Connect the real bot (Setup page); `/start` from a tester | Disclosure + consent buttons | screenshot |
| W8.2 | Consent, then chat: draft appears in Inbox, operator approves | Reply delivered in persona voice, disclosure respected | screenshots |
| W8.3 | Switch to `ai_auto` (needs `conversation.manage`); chat for 20 messages | Replies automatic; memory facts extracted and used later | memory list screenshot |
| W8.4 | Self-harm phrase; "I'm 15"; "talk to a human" | AI stops; escalation with SLA; restricted handling | Escalations screenshot |
| W8.5 | `/forget`, then `/deletemydata` from a tester | Memories deleted, then all fan data erased; audit entries | audit excerpt |

## W9 — Telegram Stars (real Stars, smallest prices)

| # | Step | Expected | Evidence |
|---|---|---|---|
| W9.1 | Product (subscription to a private premium channel), approved by a second account | Product active | screenshot |
| W9.2 | Tester buys with real Stars | Payment recorded once; entitlement granted; join request to the premium channel approved | Money page |
| W9.3 | Refund: request + approval by a second account | Stars returned; entitlement revoked; removed from channel | Money page, Telegram |
| W9.4 | Stop the platform, pay, start again | Reconciliation recovers the payment from the Stars ledger | `PAYMENT_RECOVERED_FROM_LEDGER` alert |

## W10 — Instagram (after Meta app setup and review)

| # | Step | Expected | Evidence |
|---|---|---|---|
| W10.1 | `PUBLIC_MEDIA_BASE_URL` tunnel exposes only `/v1/assets/*/content` | Other paths not reachable from outside | curl transcript |
| W10.2 | Publish one approved image to the **test** account (`PUBLISHING_ADAPTERS=instagram,telegram`) | Published with the disclosure; PNG converted to JPEG | post URL |
| W10.3 | Comments ingested; a risky comment is held | Held comment visible | screenshot |
| W10.4 | Next day: insights ingested; KPIs rolled up | Analytics page shows reach/likes | screenshot |

## W11 — Agents and autonomy

| # | Step | Expected | Evidence |
|---|---|---|---|
| W11.1 | Run the `content_strategist` agent for the influencer | Schema-valid proposals with the real model; policy decides allow / approval / deny | Agents page |
| W11.2 | Approve a proposal | Executed with least privilege; audit entry | audit excerpt |
| W11.3 | Kill switch `autonomy` | No agent actions until resumed | screenshot |

## W12 — Backup and recovery on Windows

| # | Step | Expected | Evidence |
|---|---|---|---|
| W12.1 | `backup.ps1 -InstallRoot D:\golden`; schedule the daily task | Manifest `succeeded`; robocopy mirror; dump readable; ACL restricted | `manifest.json` |
| W12.2 | `restore.ps1 -BackupDir <newest>` (Test mode) | Counts match; test database dropped; `restore_test` recorded | `restore_test-*.json` |
| W12.3 | Replace drill (optional, after W12.1, on a quiet day) | Change after backup rolled back; previous database kept; services restart | `restore-*.json` |

## W13 — Second influencer from the golden template

| # | Step | Expected | Evidence |
|---|---|---|---|
| W13.1 | Setup page → **Clone configuration** | New influencer, paused, with bindings, QA thresholds, draft policies and products; **no** persona, references, bot, fans, conversations, memories or payments | DB query + screenshot |
| W13.2 | Give it its own persona, references, bot; run W6.1 for it | Independent identity; GPU fair share between the two | job evidence |

## W14 — Toward 20–30 influencers

Repeat W13 in batches of five, and pass the gates G2–G4 in [docs/11](../../docs/11-mvp-acceptance-criteria.md):

- fair share;
- chat SLOs under load;
- cost ledger.

Use measured capacity only (docs/13 §7 worksheet with W4/W6 measurements).

## Sign-off

| Gate | Steps | Approved by | Date |
|---|---|---|---|
| Platform on Windows | W0–W2, W12 | | |
| Visual integration (with Track A) | W3, W5, W6 | | |
| Conversations and money | W4, W8, W9 | | |
| Publishing | W7, W10 | | |
| Golden Influencer operational | all of the above + W11 | | |
| Replication | W13–W14 | | |
