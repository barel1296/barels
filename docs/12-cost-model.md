# 12 — Operating Cost Model (single workstation, local inference)

> Status: Proposed — **rewritten 2026-10-18.** The previous cloud model (API fees per token and per image, managed hosting) is superseded and kept in §8 for comparison.
>
> **Measurement first.** Every recurring cost line is recorded monthly in `ops.cost_entries` with evidence (invoice, meter reading, asset record). The only dollar figures stated below are **researched list prices** (tagged) and **arithmetic bounds**. No consumption figures are assumed; they are measured (doc 14 B-PWR-1, smart-plug readings).
>
> **Excluded:** people (operators, reviewers, engineers), counsel and accountant fees. Once AI is local, people are likely the largest cost. Track them in the business P&L.

## 1. What changes when inference is local

| Before (cloud design) | Now (local) |
|---|---|
| Per-call AI fees (tokens, images, video seconds) were the largest, volume-driven line | **$0 per call.** AI cost becomes **electricity + hardware wear + GPU capacity** (an opportunity cost, managed in doc 13) |
| Managed hosting, Postgres, Redis, object storage, observability subscriptions | Self-hosted on the workstation; free tiers for tunnel, access and heartbeats; **only offsite backup storage is a recurring per-GB fee** |
| Chat model choice drove cost 2–35× | Chat model choice drives **GPU capacity** (`μ*`, doc 13 §7.3), not cash |

## 2. Recurring monthly cost lines (measured)

| Category (`ops.cost_entries.category`) | What | How it is measured | Researched prices / bounds |
|---|---|---|---|
| `electricity` | Workstation + router/ONT + backup disk + UPS losses | **Smart plug with energy metering** on the workstation circuit (kWh per month in `ops.energy_readings`) × contract tariff; router/peripherals on a second metered plug | **Upper bound for the workstation** (arithmetic): `P_adapter_label_W × 720 h / 1000` kWh per month, because the laptop can't draw more than its adapter delivers. Read the wattage from the adapter label (doc 14 fingerprint). Actual draw comes from the plug. |
| `connectivity` | Share of the site's broadband; optional 4G/5G failover plan | Invoice × allocation share (policy, e.g. 100% if dedicated) | — |
| `backup_storage` | Offsite encrypted backups: Postgres base backups + WAL, restic content snapshots, audit WORM bucket | Stored TB from provider usage reports / restic stats × price | **Backblaze B2:** $6.95 per TB-month; free egress up to 3× stored, then $0.01/GB (E, 2026-10). **Cloudflare R2 Standard:** $0.015 per GB-month, zero egress; Infrequent Access $0.01/GB-month + $0.01/GB retrieval (V). |
| `phone_numbers` | Numbers for Telegram Business accounts (opt-in personas) and account recovery | Invoices | Fragment +888 anonymous numbers exist; current price unverified (R) |
| `domain_dns` | Domain for the legal page and tunnel hostnames | Registrar invoice ÷ 12 | Cloudflare Pages and Tunnel: free (E/V) |
| `monitoring` | External heartbeats | Plan invoice | **Healthchecks.io Hobbyist:** free, 20 checks; Business $20/month for 100 checks (E). Our design needs ~10 checks (host, WSL, 6 services, 2 backup jobs). |
| `software` | Licences | Invoices | All stack components are OSS or free tiers; Cloudflare Access free ≤ 50 users (E). **Optional:** an InsightFace commercial licence (doc 15 L2) or an Ultralytics licence (not needed with MediaPipe/YuNet). |
| `hardware_amortization` | Workstation, backup disk, UPS, RAM/NVMe upgrades | Straight-line: purchase price ÷ useful life (policy default **36 months** for a laptop under 24/7 load) | From asset records |
| `hardware_reserve` | Wear parts under 24/7 duty: battery, fans, SSD | Policy accrual (e.g. a % of purchase price per year), reviewed against actual repairs | Policy |
| `other` | Smart plugs, cooling stand (one-time → amortized), postage for hardware swaps | Invoices | — |

**Monthly cash formula:**

```text
C_month = Σ_lines amount  (each with evidence in ops.cost_entries)
        = kWh_measured × tariff
        + connectivity_share
        + TB_offsite × price_per_TB
        + phone_numbers + domain/12 + monitoring + software
        + amortization + reserve
```

## 3. Unit costs (derived from measurements)

```text
P_idle, P_chat, P_media, P_mixed, P_train      [W]   ← B-PWR-1 (wall plug, per state)
c_kWh                                          [$/kWh] tariff
c_gpu_s_energy  = (P_media − P_idle) / 3.6e6 × c_kWh            [$ per media GPU-second, energy only]
c_gpu_s_hw      = (amortization + reserve) / GPU_busy_seconds_month   [$ per GPU-second, hardware]
c_gpu_s         = c_gpu_s_energy + c_gpu_s_hw

cost_per_final_image   = c_img_final × c_gpu_s           (c_img_final from doc 13 §7.2)
cost_per_video_second  = c_vid_second × c_gpu_s
cost_per_chat_reply    = (GPU-seconds of chat lane per reply, apportioned by tokens) × c_gpu_s_chat
                         where c_gpu_s_chat uses (P_chat − P_idle)
```

- These are computed monthly by the analytics job and written to `analytics.usage_events.cost_usd` as **attributed internal cost**.
- **Note:** the hardware component falls as utilization rises. Idle capacity is the most expensive capacity.

## 4. Attribution to personas (for contribution margin)

| Cost pool | Allocation rule |
|---|---|
| Electricity above idle | By attributed GPU-seconds (media jobs exactly; chat by tokens processed per persona; agents by run) |
| Idle electricity, amortization, reserve, connectivity, monitoring, domain | Equal share per **active** persona, or by GPU-second share (config `allocation_rule`) |
| Backup storage | By stored bytes per persona (content store prefix sizes) |
| Phone numbers | Directly to the persona that uses the number |

**Per-persona contribution margin (monthly, estimated):**

```text
CM_persona = net_revenue_stars × v  −  attributed_costs_persona
```

- `v` is the Star valuation (doc 08 §5): never a fixed rate; method recorded.
- Realized margin uses actual payouts (finance view).

## 5. Monthly cost report (template generated from `ops.cost_entries`)

| Line | Amount | Basis | Evidence | Δ vs. last month |
|---|---|---|---|---|
| Electricity (workstation) | *measured* | kWh × tariff | plug readings id range | — |
| Electricity (network/peripherals) | *measured* | kWh × tariff | plug readings | — |
| Connectivity | *invoice* | allocation | invoice id | — |
| Offsite backups | *usage × price* | TB stored | provider report | — |
| Phone numbers | *invoice* | direct | invoice ids | — |
| Domain/DNS | *invoice/12* | amortized | invoice | — |
| Monitoring | *invoice or $0* | plan | — | — |
| Hardware amortization | *asset schedule* | straight-line | asset ids | — |
| Hardware reserve | *policy* | accrual | policy | — |
| **Total** | | | | |
| GPU-busy seconds; utilization by mode | *measured* | `ops.gpu_daily` | — | — |
| Cost per final image / video second / chat reply | *derived* | §3 | — | — |

**Acceptance (doc 11 AT-1.39):** the first full month is recorded with evidence for every line.

## 6. One-time costs (Stage 0)

| Item | Why | Notes |
|---|---|---|
| RAM upgrade to ≥ 64 GB (96–128 GB if supported) | Video offload, training, everything sharing RAM (doc 15 §4) | Only if the inventory falls short |
| Second internal NVMe or external NVMe backup disk (≥ 4 TB) | Local backups + model cache | — |
| Small UPS for router/ONT | The laptop battery covers itself; the network needs its own | — |
| Smart plugs with energy metering (×2) | Cost and benchmark measurement (B-PWR-1) | Required for doc 12 to be measurable |
| Cooling stand, ventilated placement | Sustained-load thermals (B-THERM-1) | — |
| Optional dual-WAN router + 4G/5G plan | Internet resilience | Recurring plan goes to `connectivity` |
| Counsel review (licences, DPIA, policies), accountant setup | Gates G0/G1 | Excluded from the operating ledger |

## 7. Cost governance

- **Budgets:** GPU-second quotas per persona per day (fair share). A monthly cash budget per category, with alerts at 80%/100% (`analytics.budgets`, scope `total`).
- **Reviews:** monthly cost review with the report above. Quarterly re-check of backup price and storage growth.
- **Avoid paying twice:** no cloud AI or GPU fallback is built (scope C3). If capacity is short, the decision is tiers or a second node (doc 13 §10), recorded in a decision memo.

## 8. Superseded: cloud cost estimate (2026-10-14), kept for comparison

- The cloud design estimated ≈ **$620–1,340/month** at MVP volume (1 influencer, ~1,000 monthly active chatters; infra + AI APIs).
- It estimated ≈ **$7.6k–43.6k/month** at 20 influencers / 50k active chatters, depending mainly on the chat model tier.
- Those figures used vendor list prices researched on 2026-10-14. The local design replaces most of that per-volume spend with fixed hardware, energy and capacity limits.
- The trade-off is now **capacity, availability and quality risk** (doc 03 §1a), not cash per message.
