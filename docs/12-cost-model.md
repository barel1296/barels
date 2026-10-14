# 12 — Infrastructure & AI Operating Cost Model

> Status: Estimate · Date: 2026-10-14 · **All vendor prices must be re-verified in Phase 0** (doc 02 §8 #10, #12). The infrastructure pricing pages could not be read in full during research, so those figures come from search excerpts and third-party sources.
>
> **Excluded:** people (operators, reviewers, engineers), legal/accounting, and one-off pen test. In the early stage, people cost will exceed infrastructure and AI cost.

## 1. Pricing inputs

| Item | Unit price used | Evidence |
|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 in / $20 out / $0.20 cache read / $5 cache write (5-min) per MTok | V (Anthropic reference, 2026-10-06) |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 / $0.20 / $2.50 | V |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 / $0.50; cache read/write **assumed** at 0.1× / 1.25× | V (base) / A (cache) |
| Message Batches | −50% on all tokens | V |
| FLUX.2 [pro] (BFL) | $0.03 first MP + $0.015/extra MP; **~$0.05 per 1.5 MP generation with references** (assumed reference-input surcharge) | E / A |
| Nano Banana 2.1 (fallback) | ~$0.034–0.050 per image | E |
| Veo 3.1 Fast | $0.12/s (1080p, audio included) | E |
| Rekognition (CompareFaces, Celebrities, Moderation, Text) | ~$0.001 per image per API | E |
| OpenAI omni-moderation | Free | E |
| Infra (Render, R2, Sentry, Better Stack, Doppler, KMS) | See §4 | R (search excerpts only) |

## 2. Conversation cost per AI reply

**Token profile per reply (assumption, to be measured in the beta):**

- **Static prefix: 4,000 tokens, always a cache read.** Persona card, rules, schemas. One breakpoint, shared by all fans of the influencer.
- **Fan context and recent turns: ~4,100 tokens.** Memory ~600, summary ~600, entitlements/offers ~300, last ~20 messages ~2,500, new input ~100.
  - 60% of replies happen inside an active session (5-min cache warm): ~3,500 tokens are cache reads and ~600 are cache writes.
  - 40% are cold: all ~4,100 tokens are cache writes.
- **Output: ~500 tokens.** Reply, structured fields, and low-effort thinking.
- **Guards:**
  - free moderation endpoint + deterministic checks on every turn;
  - an LLM guard call only on ~10% flagged turns, adding ~5% overhead.
- **Memory and summary:** a nightly Batch job per active fan-day, ~3,000 tokens in and 300 out.

Blended per reply: **6,100 cache-read tokens, 2,000 cache-write tokens, 500 output tokens.**

| Model for the conversation route | Cost per AI reply | Memory per active fan-day | Cost of one free user (150 replies/mo) | Break-even price per reply* |
|---|---|---|---|---|
| **Opus 5.5** (default config) | **$0.0223** | $0.0090 | $3.43 | 1.7 ⭐ |
| Sonnet 5.5 | $0.0118 | $0.0045 | $1.81 | 0.9 ⭐ |
| Haiku 5.5 | $0.0006 | $0.0002 | $0.09 | 0.05 ⭐ |

\* **Illustrative only.** It uses Telegram's quoted developer reward of "an equivalent of 0.013 USD" per Star, which Telegram sets at its sole discretion and is **not** a fixed exchange rate. Formula: `break_even_stars = cost_usd / v`, where *v* is the current `star_valuations` value.

**Decision for the business (not made here).** The model per route is configuration (doc 06 §2). The default configuration is Opus 5.5 everywhere. Moving the conversation route to Sonnet 5.5 or Haiku 5.5 changes chat cost by about 2× or about 35×. That is the single biggest lever on unit economics.

**Recommendation:** in Phase 2, run the conversation eval suite on all three models and choose per route from quality vs. cost per *completed conversation*. The safety cases must stay at 100%. The size of the free allowance should follow from that choice.

## 3. Content production cost per influencer per month

Volume assumption (AS4): IG 16 feed posts (12 single, 4 carousels of 5), 12 Reels, ~60 Story frames (half repurposed), TG free 30 posts (half new), premium 40 items, 4 PPV sets of 8 images. That is **≈185 final images and ≈700 seconds of generated video.**

| Line | Calculation | $/month |
|---|---|---|
| Image generation | ≈1,100 generations (≈5 candidates per final + 20% regenerations) × $0.05 | 55 |
| Image validation | 1,100 × ($0.003 face ×3 refs + $0.003 other Rekognition + ~$0.016 vision rubric on Opus 5.5) | 24 |
| Video generation | 700 s × $0.12 (Veo 3.1 Fast, ~2 attempts per shot already included in seconds) | 84 |
| Video validation | 2 fps frame sampling (~1,400 frames × ~$0.002) + vision checks | 8 |
| Captions & copy checks | ~250 × ~$0.02 | 5 |
| Contingency (30%) | vendor variance, regeneration spikes | 53 |
| **Total content** | | **≈ $230** (range $150–350) |

**One-off per new influencer:**

- character sheet and persona exploration: ~500 generations ≈ $25–50;
- optional LoRA training runs: ≈ $20–100;
- the calibration-set build is mostly human time.

## 4. Agent (non-chat) cost per influencer per month (Opus 5.5)

| Agent | Basis | $/month |
|---|---|---|
| Influencer Manager | ~8 planning runs | ~5 |
| Content Strategist | 4 weekly plans + ~60 briefs | ~10 |
| Production orchestration | ~150 items | ~10 |
| Social Media (comment replies) | ~500 comments | ~5 |
| Community | posts + moderation | ~5 |
| Monetization | weekly reviews + experiments | ~5 |
| Analytics | daily narrative + weekly report (Batch) | ~3 |
| QA & Compliance | pre-screen ~185 items + ~300 conversation samples | ~12 |
| **Total agents** | | **≈ $55** (range $40–100) |

## 5. Infrastructure

The research could not read the vendor pricing pages, so these are **estimates (R)**. Re-verify before budgeting.

| Line item | MVP $/mo | Scale $/mo | Notes |
|---|---|---|---|
| Render workspace (Pro) | 25 | 25 | 7-day PITR on Pro workspaces (R) |
| Production API | 25 | 50 | Standard instance; 2× at scale |
| Production workers (realtime + batch) | 32 | 100 | Starter + Standard → 2×Standard ×2 |
| Production Postgres | 22 | ~140 | Basic-1gb → Pro-4gb with HA (HA billing unconfirmed) |
| Production Key Value (Valkey) | 10 | ≤ 32 | 256 MB → 1 GB (prices cut 1 Oct 2026; new figures unknown) |
| Staging (API, worker, DB, KV) | ~20 | ~20 | Small instances, free KV |
| Cloudflare R2 | ~1 | ~34 | 50 GB → 1 TB, zero egress |
| Sentry Team | 29 | 29+ | Overage at scale |
| Logs/metrics/uptime (Better Stack or Grafana Cloud) | 0 | ~60 | Free tier → paid bundle + on-call seat |
| Doppler | 0 | ~63 | Free → Team (3 users) |
| AWS KMS | ~2 | ~5 | 2 keys + requests |
| Langfuse (optional LLM tracing) | 0 | ~60 | Optional; our own tables are the source of truth |
| Static legal/safety page | ~0 | ~0 | Static hosting |
| **Infra subtotal** | **≈ $165** (range $120–220) | **≈ $620** (range $500–900) | |

## 6. Totals

### 6.1 MVP: 1 influencer, ≤ 1,000 monthly active bot users, 30 AI replies each

| Line | Opus 5.5 chat | Sonnet 5.5 chat | Haiku 5.5 chat |
|---|---|---|---|
| Infrastructure | 165 | 165 | 165 |
| Evals + staging AI spend (capped) | 150 | 150 | 150 |
| Content production | 230 | 230 | 230 |
| Agents (non-chat) | 55 | 55 | 55 |
| Conversation (30k replies + memory) | 740 | 390 | 20 |
| **Monthly total** | **≈ $1,340** | **≈ $990** | **≈ $620** |

### 6.2 Scale: 20 influencers, ~50,000 monthly active bot users, 30 replies each

| Line | Opus 5.5 chat | Sonnet 5.5 chat | Haiku 5.5 chat |
|---|---|---|---|
| Infrastructure | 620 | 620 | 620 |
| Evals + staging | 300 | 300 | 300 |
| Content (20 × $230) | 4,600 | 4,600 | 4,600 |
| Agents (20 × $55) | 1,100 | 1,100 | 1,100 |
| Conversation (1.5M replies + memory) | 37,000 | 19,500 | 1,000 |
| **Monthly total** | **≈ $43,600** | **≈ $26,100** | **≈ $7,600** |
| Per influencer | ≈ $2,180 | ≈ $1,310 | ≈ $380 |
| Revenue needed to cover variable + infra, in Stars (illustrative, *v* = 0.013) | ≈ 3.35M ⭐ (≈ 67 ⭐ per MAU) | ≈ 2.0M ⭐ (≈ 40 ⭐/MAU) | ≈ 0.58M ⭐ (≈ 12 ⭐/MAU) |

## 7. What moves the numbers most

| Lever | Effect |
|---|---|
| **Conversation model per route** | 2–35× on the largest line item (see §2) |
| **Free allowance size** | Free users are the main chat cost driver. 15 → 5 free replies/day cuts free-user cost about 3×. |
| **Prompt-cache hit rate** | Every cold session pays the cache write. Measure `cache_read_input_tokens`. A 1-hour TTL only pays off for gaps of 5–60 minutes. |
| **Output length and effort** | Output tokens cost 5× input on every tier. Short persona replies and low effort on the chat route. |
| **Video volume** | Video is ~40% of content cost. Keyframe-first, ≤ 3 attempts per shot, Veo Fast/Lite drafts. |
| **Stars valuation *v*** | Revenue in fiat scales linearly with *v*, which Telegram sets. Track realized payouts. |
| **Batch API for memory, evals, analytics** | −50% on that slice |

## 8. Cost governance (built in)

- `analytics.usage_events` meters every call; `analytics.price_book` is versioned with source URLs; monthly invoice reconciliation (±5%).
- Daily and monthly budgets per influencer and scope, with warn and hard actions (doc 09 §10).
- Cost per item, per active chatter and per Star are on the dashboard, so model and allowance decisions are made on measured numbers rather than on this estimate.
