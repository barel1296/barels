# 02 — Platform Capabilities: Verified vs. Assumed

> Research date: **2026-10-14** · Status: Phase 1 input · **Re-verify every row marked E, R or A in Phase 0** (checklist in §8).

## How to read this document

This environment's network policy blocked direct access to `developers.facebook.com`, `core.telegram.org`, `telegram.org` and most vendor sites. Research therefore relied on:

- verbatim same-day snapshots of the Telegram pages, taken from a public change-tracking mirror;
- official-domain excerpts returned by web search;
- a small number of directly read pages (Anthropic's usage policy, some Google Cloud pages).

Every claim carries an evidence tag:

| Tag | Meaning | Confidence |
|---|---|---|
| **V** | **Verified.** Verbatim text of the official page was read: a direct fetch, or a same-day verbatim snapshot of the page. | High |
| **E** | **Official excerpt.** The official page's wording was seen through a search-engine excerpt, not a full read. Excerpts occasionally conflict. | Medium |
| **R** | **Reported.** Secondary sources only, or official sources contradict each other. | Low |
| **A** | **Assumption.** Our inference or a design assumption. | Must be validated |

**Rule for the build:** the code never relies on an **R** or **A** capability without a feature flag and a fallback.

---

## 1. Instagram (Meta Instagram Platform API)

### 1.1 Access model

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| "Instagram API with Instagram Login" works for **Business and Creator** accounts with **no Facebook Page required** | Supported | E | Use Instagram Login for the MVP. |
| Hashtag search, product tagging and partnership ads require **Facebook Login** (Page-linked) instead | Supported, other flavor | E | Not needed for the MVP. Add Facebook Login later only if needed. |
| **Standard Access** is enough when the app serves only accounts we own or manage and that have roles on the app. **Advanced Access** requires App Review and Business Verification. | Supported | E | One-influencer MVP: Standard Access. SaaS with third-party accounts: start Business Verification early. |
| Graph API version: v26.0 (2026-07-29) | Current | E | Pin the API version per adapter; budget an upgrade roughly every 6 months. |
| Long-lived user token lasts **60 days**. Refresh requires the token to be ≥24h old and unexpired. An expired token cannot be refreshed. | Supported | E | Token refresh job every ~30 days plus an expiry alert at T−10 days. A missed refresh forces a manual re-login. |
| Scopes: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages` | Supported | E | The exact insights scope name is unconfirmed (**A**). Verify it in Phase 0. |
| **Webhook delivery for comments and DMs from the public under Standard Access** | Unclear | A | **Phase 0 blocker:** test with a non-role account. If it doesn't work, App Review is needed before IG engagement features launch. |

### 1.2 Content publishing

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Single image, `CAROUSEL` (≤10 items), `REELS`, `STORIES` (image and video) | Supported | E | All four formats are in scope. |
| **Stories via API are Business-only** (Facebook Login docs). Creator-account Stories via Instagram Login are unresolved. | Conflicting | E/R | **Make the persona account a Business account.** |
| **100 API-published posts per moving 24h**; a carousel counts as 1. Usage is visible via `GET /{ig-id}/content_publishing_limit`. | Supported | E | Check the quota before every publish and record it in `publishing.quota_snapshots`. Our planned volume is far below the cap. |
| ≤400 containers created per rolling 24h; containers expire after 24h | Supported | E | Create the container shortly before publishing, not at scheduling time. |
| Images: **JPEG only**, ≤8 MB, aspect ratio 4:5 to 1.91:1 | Supported | E | Render pipeline outputs a JPEG rendition per placement. Keep the C2PA-signed original separately (see §3.4). |
| Reels: 3s–15min, ≤300 MB, 9:16 recommended. Story video: 3–60s, ≤100 MB. | Supported | E | Validate specs before creating a container. |
| Media fetched by Meta from a **public URL** (`image_url`/`video_url`) | Supported | E | Use short-lived presigned R2 URLs. |
| Resumable upload (`rupload.facebook.com`) with Instagram Login | Unclear | R | Don't depend on it. Use presigned URLs. |
| `alt_text` (images), `collaborators` (≤3, not Stories), `cover_url`/`thumb_offset`, `location_id`, `user_tags`, `share_to_feed`, `trial_params` (trial Reels) | Supported | E | Exposed as optional publication settings. |
| **`is_ai_generated` container parameter** (Meta "AI info" self-disclosure; not on carousel children) | Probably supported | E (single excerpt, corroborated by a third-party wrapper) | **Phase 0 blocker.** If confirmed, set it on every container. If not, disclose in the caption plus C2PA metadata, and a human applies the label in-app for photorealistic video. |
| Profile-level **"AI-generated profile"** label (renamed 2026-08-31). Undisclosed AI profiles can be excluded from recommendations. | Exists (in-app) | R (press, no Meta primary source found) | Turn it on manually in the app at launch. No API found. |
| Music library selection, interactive stickers (link/poll/location), filters, native scheduling | **Not supported / not found** | E (stickers), R (others, absence of evidence) | Reels use original or generated audio only. We schedule in our own system. Expect lower Reel reach than app-native posts; this is a known trade-off. |
| Product tags and paid-partnership tags | Facebook Login only | E/R conflicting | Sponsored posts: disclose in the caption. Add the native tag after moving to Facebook Login if needed. |

### 1.3 Comments, mentions and messaging

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Read comments; reply to top-level comments; hide/unhide; delete; enable/disable comments on a post | Supported | E | Comment inbox in the dashboard. Social Media Agent proposes replies. |
| Webhooks: `comments`, `live_comments`, `mentions`, `story_insights`, `messages`, `messaging_postbacks`, `messaging_seen`, reactions, `messaging_referral` | Supported | E | Webhook receiver plus inbound persistence (doc 04 §5). |
| **Private Reply:** exactly one DM per comment, within **7 days** of the comment; further messages only after the user replies | Supported | E | Comment-to-DM funnel: one private reply, idempotent per comment. |
| **24-hour standard messaging window** after the user's last message | Enforced | E | Per-thread window state. No automated sends outside the window. |
| `HUMAN_AGENT` tag: up to 7 days, **human agents only, no automation**, separate approval | Supported (restricted) | E | Only the human console may use it. Never set it from AI paths. |
| Send API ~300 calls/s per account (text) | Supported | E | Not a constraint at our scale. The "200 DMs/hour" figure is a vendor convention, not documented (R). |
| Message requests: new non-follower threads land in Requests and move to General once we reply | Behavior | E | No special handling needed. |
| Ice breakers and persistent menu | Supported | E | Persistent menu offers "Talk to a human" and "About this AI". |
| Handover Protocol replaced by **Conversation Routing** | Changed | E | Human takeover uses Conversation Routing semantics. |
| Policy: automated chats must disclose automation where the law requires it (Meta cites California and Germany) and **Meta recommends disclosing everywhere** | Policy | E | Disclose at the start of every conversation, after long gaps, and on the switch from human to bot (doc 06 §6). |
| A WhatsApp-style ban on general-purpose AI chatbots for Instagram messaging | Not found | R | Monitor. Our bot is persona-specific, not a general assistant. |

### 1.4 Insights

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Media metrics: `views`, `reach`, `likes`, `comments`, `shares`, `saves`, `total_interactions`; story `replies`, `navigation` | Supported | E | Snapshot at T+1h, T+24h and T+7d. |
| `impressions` deprecated (v22, effective 2025-04-21) | Removed | E | Use `views`. |
| Story insights available only for **24h**; the `story_insights` webhook fires at expiry | Constraint | E | Subscribe to the webhook. Story metrics come only from it. |
| Account data retained **90 days**; some metrics need ≥100 followers | Constraint | E | Store everything in our own `analytics.metric_snapshots`. |
| Rate limit (Business Use Case): calls/24h = 4800 × impressions; the `X-Business-Use-Case` header reports usage | Constraint | E | Gateway honors the header and backs off. |

### 1.5 Instagram content policy

| Rule | Evidence | Design implication |
|---|---|---|
| AI- or computer-generated **nudity and sexual activity is removed** whether or not it looks photorealistic | E | Instagram channel max rating = `suggestive`. |
| **Adult sexual solicitation:** no content offering or linking to pornographic material, including usernames and links | E | **No CTA or link from Instagram to any adult offering.** We may link to the SFW Telegram channel and bot. Every caption, bio, story and DM passes a link-policy check. |
| Sexually suggestive content gets reduced distribution | E | Growth trade-off. Strategy agent optimizes within `general`/`suggestive`. |
| Meta requires its AI-disclosure tool for photorealistic **video or realistic audio** that was digitally created or altered | E | Reels always flagged (`is_ai_generated` or the in-app label). Captions carry the disclosure. |
| Branded content may not promote adult products or services | E | Sponsorship workflow blocks those categories. |

---

## 2. Telegram

### 2.1 Bot API baseline

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Current Bot API: **10.3 (2026-08-24)** | Current | V | Pin the grammY version and track the changelog. |
| Bots **cannot start conversations**; the user must message first | Constraint | V | Acquisition through deep links from channels and Instagram. Re-engagement only for users who started the bot and opted in. |
| Rate limits: ~1 msg/s per chat, 20 msgs/min per group, ~30 msgs/s for bulk sends | Constraint | V | Redis token buckets per bot and per chat. Broadcasts are throttled. |
| Paid broadcasts (up to 1000 msg/s, 0.1 Star per message over 30/s). Eligibility is inconsistent: the API page says ≥10k Stars; the FAQ and ToS say ≥100k Stars **and** ≥100k MAU. | Not available to us early | V (conflicting) | Out of scope for the MVP. |
| Webhooks: secret-token header; `max_connections` 1–100; updates kept for 24h | Supported | V | Webhook mode with the secret header (doc 04 §5). |
| Files: upload ≤50 MB (photos ≤10 MB), `getFile` download ≤20 MB. A local Bot API server lifts the limits to 2000 MB. | Constraint | V | MVP videos stay under 50 MB. A local Bot API server is optional later. |
| **No method to list channel members.** `getChatMember` per user; `chat_member` updates need admin rights plus explicit `allowed_updates`. | Constraint | V | Join-request gating (doc 08) makes us the gatekeeper, so we always know who is in. |
| No Bot API access to **channel post view counts** or channel statistics | Not supported | A (absent from the API reference) | Telegram content analytics are limited to member counts, joins/leaves and bot funnels. MTProto stats would need a user session; not used. |
| `sendMessageDraft` (streamed draft preview) available to all bots since 9.5 | Supported | V | Optional typing-style streaming UX for AI replies. |
| Enabling **topics in private chats** triggers a **15% non-refundable fee on all Stars purchases** | Policy | V | **Never enable private-chat topics.** Add a config assertion. |

### 2.2 Stars payments, subscriptions and paid media

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Digital goods/services in bots **must be paid exclusively in Telegram Stars** (`XTR`); third-party providers are not allowed | Policy | V | Stars is the only payment rail in the MVP. No Stripe links for digital goods inside Telegram. |
| `sendInvoice`/`createInvoiceLink` with `currency="XTR"`, empty `provider_token`, exactly one price item, payload 1–128 bytes | Supported | V | `invoice_payload` = HMAC-signed opaque order id. |
| `pre_checkout_query` must be answered **within 10 seconds** | Constraint | V | Synchronous fast path in `api` (doc 04 §5). |
| `SuccessfulPayment`: `telegram_payment_charge_id`, `invoice_payload`, `subscription_expiration_date`, `is_recurring`, `is_first_recurring` | Supported | V | Unique key = charge id. Idempotent grant. |
| `refundStarPayment(user_id, charge_id)` → `refunded_payment` service message. Chargebacks may be debited from the balance. | Supported | V | Refund flow plus revocation (doc 08). |
| `getStarTransactions` (paged, chronological): **the bot's own transactions only**. `StarTransaction.id` equals the charge id for incoming payments. | Supported | V | Daily reconciliation against `monetization.payments`. |
| `getMyStarBalance` | Supported | V | Balance snapshot for finance. |
| **Bot Star subscriptions:** `createInvoiceLink` with `subscription_period = 2592000` (30 days, fixed), price ≤10,000 Stars; **link-only**; auto-renewed by Telegram | Supported | V | Core premium product rail. |
| **`subscription` update (BotSubscriptionUpdated)**: states `canceled` / `active` / `failed` (Bot API 10.2) | Supported | V | Drives the subscription state machine (cancelled, payment-failed). |
| Whether renewals trigger `pre_checkout_query` | Unclear | A | The handler accepts renewals for any active subscription order. Test in Phase 0. |
| `editUserStarSubscription(user_id, charge_id, is_canceled)` | Supported | V | Cancel renewal on refund, ban or erasure. |
| **Channel subscription invite links** (`createChatSubscriptionInviteLink`, 30 days, 1–10,000 Stars) | Supported | V | **Not the primary rail:** the bot gets **no payment or renewal events**, revenue is not in the bot's ledger, and auto-removal on non-renewal is undocumented (A). Keep as an optional experiment. |
| `sendPaidMedia`: any chat, including channels and business connections; 1–25,000 Stars; ≤10 items (photo, video, live photo); payload ≤128 bytes | Supported | V | PPV content. |
| **Paid media revenue in a channel goes to the channel's balance; elsewhere to the bot's** | Policy | V | **PPV is sold in bot DMs** (attributable, reconcilable). Channel paid media only for teasers, with aggregate-only analytics. |
| `purchased_paid_media` update: only for bot-sent paid media with a non-empty payload **in non-channel chats** | Supported | V | PPV purchase events in bot DMs feed the ledger. |
| Buyers keep access to purchased paid media even after deletion or removal from the channel | Policy | V | Purchased-media entitlements are perpetual. |
| **Stars value:** developers "can receive an equivalent of **0.013 USD** worth of rewards per Star", at Telegram's **sole discretion**, may fluctuate; Stars "have no inherent value"; **21-day hold**; Stars expire after 3 years | Policy | V | Stars are the accounting unit. Fiat is estimated via `star_valuations` and realized only through recorded payouts. |
| Withdrawal via **Fragment** (TON), owner only, 2FA; min/max are client-config values | Supported | V (numbers not documented) | Finance records payouts manually in the MVP. |
| **`/paysupport` command is mandatory**; full refunds without penalty; Telegram discourages real-time sale of non-reclaimable digital services | Policy | V | `/paysupport` → support flow. Message-credit refund policy is defined in doc 08. |
| Bot privacy policy (in BotFather) and **encryption of data at rest** required | Policy | V | Covered in doc 09. |

### 2.3 Telegram Business (the "personal/business account")

| Capability | Status | Evidence | Design implication |
|---|---|---|---|
| Any user can connect **one** business bot (Settings → Chat Automation); **Telegram Premium not required** since Bot API 10.0 | Supported | V | Module 5 = the persona's Telegram account plus our connected bot. |
| `BusinessBotRights`: `can_reply` (only in private chats with incoming messages in the last 24h), `can_read_messages`, delete, edit name/bio/photo/username, gifts/stars, `can_manage_stories`, … | Supported | V | Request the minimum rights: `can_reply`, `can_read_messages`. |
| Owner chooses which chats the bot covers and can pause it per chat | Supported | V | A human operates the account. The AI drafts in the dashboard (L2). |
| Bot can send paid media and create invoice links on behalf of the business account | Supported | V | Phase 4+: offers from the personal account. |
| Whether the counterpart sees a "bot" indicator | Unknown | A | Disclose explicitly in the bio and the first message regardless. |
| Business-bot ToS: truthful representation; data used only for the service; **no sharing with third parties (including third-party APIs) without the user's authorization**; **never conceal activity** | Policy | V | **AI-processing consent is required before the AI reads a counterpart's messages.** Until then, human-only. |
| **MTProto userbots** (automating a regular account via unofficial clients): such accounts are "put under observation"; flooding/spam → permanent ban; actions without the user's knowledge are forbidden | Prohibited/high risk | V | **Not used.** |

### 2.4 Telegram data, AI and content policy

| Rule | Evidence | Design implication |
|---|---|---|
| Using Telegram data for AI training **or deployment** requires the user's **explicit, informed, affirmative and continued consent**, limited to that chat | V | **Hard gate:** no AI processing of a fan's Telegram messages before `crm.consents(purpose='ai_processing')` is granted for that chat. Consent can be withdrawn at any time (`/stopai`). |
| No training on Telegram data | V | Fan conversations are never used to fine-tune models. Evals use synthetic or explicitly consented data. |
| ToS: no illegal pornographic content on publicly viewable channels/bots; Telegram removes porn bots to stay in the app stores; bot devs may not sell "questionable" goods | V (EU ToS) | Combined with Stars' app-store basis, **selling adult content for Stars is high-risk**. Not in the MVP. |
| Telegram age verification exists at the platform level (via a special bot's Mini App) for sensitive content in some jurisdictions; **bots cannot read the result** | V | No platform age signal. Our own age assurance would need a third-party vendor (Phase 4+, only if ever needed). |
| Channel Direct Messages (monoforum) and suggested posts; bots can reply with `can_manage_direct_messages`; the price for paid DMs is set by the admin (no Bot API setter) | V | Optional Phase 4 channel engagement. |

---

## 3. AI vendors

### 3.1 LLM (conversation and agents)

| Capability / rule | Evidence | Design implication |
|---|---|---|
| Claude models and prices: Opus 5.5 `claude-opus-5-5` ($4 / $20 per MTok in/out, cache read $0.20); Sonnet 5.5 `claude-sonnet-5-5` ($2 / $10, cache read $0.20); Haiku 5.5 `claude-haiku-5-5` ($0.10 / $0.50); cache writes 1.25× (5-min) / 2× (1-hour); Batch API −50% | V (Anthropic SDK reference, cached 2026-10-06) | Cost model in doc 12. Model per agent is configuration. |
| Structured outputs (`output_config.format`), strict tool schemas, prompt caching, adaptive thinking; Opus 5.5 cannot disable thinking (control it via `effort`); forced `tool_choice` is rejected on Opus 5.5 | V | Agent runner uses structured outputs and `auto` tool choice with strict schemas (doc 06). |
| `stop_reason: "refusal"` must be handled; server-side `fallbacks` available | V | Conversation engine treats a refusal as a safe-fallback path. |
| **Anthropic Usage Policy** prohibits sexual content, fetish content and **"erotic chats"**, with no verified-adult exception. Consumer chatbots **must disclose AI** at the start of each session or in the interface. | V (read directly) | **The conversation persona's ceiling is warm and friendly, never erotic.** Disclosure is mandatory and is enforced by both the policy engine and the prompt. |

### 3.2 Image generation

| Provider / model | Price | Character consistency | Sexual content policy | Evidence |
|---|---|---|---|---|
| **BFL FLUX.2 [pro]** (BFL API) | $0.03 first MP + $0.015 per extra MP | Up to **8 reference images**; outputs **C2PA-signed** by BFL | Sexual content capped by `safety_tolerance`; NCII/CSAM banned | E |
| BFL FLUX.2 [max] | $0.07 + $0.03/MP | 8 refs | same | E |
| FLUX.2 [klein] 4B (Apache-2.0 weights) / 9B (non-commercial weights) | ~$0.014–0.015/MP; LoRA inference beta | LoRA | same | E |
| LoRA training on fal (FLUX.2 [dev] trainer) | ≈$6.40 per 1,000 steps; klein-9B ≈$4.30 | Identity LoRA | Using [dev]/9B weights commercially needs a BFL license; LoRA output terms unclear | E/R |
| **Google Nano Banana 2.1** (Gemini image, GA 2026-10-06) | ~$0.034 (1K), ~$0.050 (2K); batch ≈ −50% | Up to **14 reference images**; C2PA + SynthID on every image | Sexually explicit content prohibited | E/V |
| Nano Banana Pro | ~$0.134 (1K/2K) | 14 refs, ≤5 consistent characters | same | E |
| OpenAI gpt-image-2 | Token-priced; per-image price unclear (conflicting rates) | Multi-image edits; no fine-tuning | No adult permission found | E/R |
| Seedream 4.5 / 5.0 (BytePlus) | $0.04 / $0.045 | Reference images | Policy text not found; access restricted | E |
| Midjourney | **No official API**; automation prohibited | — | — | E |
| Imagen 4 on the Gemini API | **Shut down** (2026-08-17) | — | — | E |

### 3.3 Video generation

| Provider / model | Price | Notes | Evidence |
|---|---|---|---|
| **Google Veo 3.1 Fast** | $0.10/s (720p), $0.12/s (1080p), audio included | Image-to-video, first/last frame, ≤3 reference images; SynthID; people generation requires `allow_adult` | E |
| Veo 3.1 Standard / Lite | $0.40/s / $0.05–0.08/s | 8s clips, extendable | E |
| **Kling 3.0** | $0.112/s (1080p, no audio), $0.168/s (with audio) | Lip sync $0.07 per 5s; also via fal | E |
| Runway Gen-4.5 / Gen-4 Turbo | $0.12/s / $0.05/s | C2PA; **prohibits even lingerie-type suggestive content**, moderation can't be disabled | E |
| Luma Ray 3.2 | $0.30 (720p) / $1.20 (1080p) per 5s | API customers must run their own moderation | E |
| MiniMax Hailuo 2.3 | $0.28 per 6s at 768p | — | E |
| Seedance 2.0 | Token-priced | "Private virtual portrait library" registers a synthetic character as an asset | E |
| **OpenAI Sora 2 API** | **Discontinued 2026-09-24** | Do not build on it | E |
| Hedra Character-3 (talking head) | $0.05/s (720p) | Lip-sync alternative | E |

### 3.4 Moderation, identity checks, provenance

| Capability | Price | Notes | Evidence |
|---|---|---|---|
| OpenAI `omni-moderation-latest` (text + image) | Free | `sexual/minors` is **text-only** (images score 0). Not a CSAM detector. | E |
| AWS Rekognition `DetectModerationLabels` | ~$0.001/image (tier 1) | Nudity taxonomy; no minor label | E |
| AWS Rekognition `CompareFaces` / `RecognizeCelebrities` | ~$0.001/image | Celebrity recognition is for narrowing down with human review | E |
| Google Vision SafeSearch | $1.50 per 1,000 (first 1,000 free) | — | V |
| InsightFace pretrained models | — | **Non-commercial license.** Not used without a commercial license. | V |
| OpenCV SFace (Apache-2.0) | Self-hosted | Lower accuracy; fallback face matcher | V |
| CSAM hash matching: PhotoDNA (free, vetted), Cloudflare CSAM scanning (cached content only), Thorn Safer (paid) | — | Only relevant if we accept uploaded media. **MVP does not ingest fan uploads into AI or storage.** | E |
| C2PA: BFL API, OpenAI, Google and Runway outputs carry C2PA; **re-encoding strips manifests**; Meta reads C2PA/IPTC to auto-label "AI info" | — | Keep the signed original. Re-sign derived renditions with our own C2PA manifest (see doc 07). | E |

**Cross-vendor conclusion (E/V):** every mainstream image and video vendor researched prohibits sexually explicit output, and Runway prohibits even lingerie-level content. The configurable `content_rating` ceiling is therefore not just a policy choice. It is enforced by **provider eligibility**: each provider adapter declares the maximum rating its terms allow, and the router never sends a job above that.

---

## 4. Payments beyond Telegram

| Item | Status | Evidence | Implication |
|---|---|---|---|
| Fiat card payments for digital content consumed inside Telegram | **Not allowed** (Stars only) | V | Not in the MVP. |
| Off-platform fiat (e.g. Stripe on our own web checkout) | Possible only outside Telegram's digital-goods flow; **conflicts with "no public website"**, so deferred | A | Phase 5 option to reduce platform concentration. |
| Stars → fiat | Fragment → TON → exchange (KYC); 21-day hold | V/R | Treasury and tax process with an accountant (doc 03). |

---

## 5. Legal and regulatory constraints that shape requirements

Full analysis is in [03-risk-register.md](03-risk-register.md). **Not legal advice.** Counsel must confirm before launch.

| Obligation | Applies because | Evidence | Engineering requirement |
|---|---|---|---|
| **EU AI Act Art. 50** (applies since 2026-08-02): disclose AI interaction (50(1)); disclose deepfakes (50(4)). The Commission's guidelines treat a photorealistic image of an invented person as a deepfake. | EU users; photorealistic persona | E/R | AI disclosure on every surface; machine-readable marking (C2PA) plus visible "AI-generated" labels on media. |
| **California SB 243** (effective 2026-01-01): companion-chatbot disclosure; **suicide/self-harm protocol, with its details published on the operator's website**; for known minors, 3-hourly reminders; a "may not be suitable for some minors" notice; annual report from 2027-07-01; private right of action | Persistent-memory persona bot = "companion chatbot" | E/R | Crisis protocol, de-identified referral log, notices. **Needs a public page**, so a minimal legal/safety page is required (see README decisions). |
| **New York GBL Art. 47** (effective 2025-11-05): notice of non-human status at the start of each interaction **and at least every 3 hours**, for all users; self-harm protocol | Same | E | 3-hour re-disclosure timer for everyone. |
| Washington HB 2225 / Oregon SB 1546 (effective 2027-01-01): similar, with hourly reminders for minors in WA | Same | R | Policy engine is jurisdiction-aware; the reminder interval is config. |
| FTC Endorsement Guides cover **virtual influencers**; the Consumer Reviews Rule bans fake testimonials | Sponsored content | E | Sponsored-post workflow enforces disclosure; no product "testimonials" implying real use. |
| GDPR: Art. 9 explicit consent for special-category data; DPIA; erasure; Italy's DPA fined Replika €5M (no legal basis, weak age gating) | EU users, memory | E | Special-category data is never stored (DB constraint); DPIA before launch; erasure cascade. |
| UK OSA: one-to-one chatbot **pornographic** output requires highly effective age assurance; self-declaration doesn't count | UK users | E | Another reason to exclude explicit content entirely. |
| TAKE IT DOWN Act: 48h removal on valid NCII requests (platform duty enforced from 2026-05-19) | Likeness/NCII complaints | E | Takedown intake with a 48h SLA (`approvals.takedown_requests`), even if applicability is unclear. |

---

## 6. What this means: the MVP scope boundary

1. **The MVP is SFW.** Content rating ceiling: `suggestive` on every channel. `mature` exists in the model but is disabled by flag. `explicit` is not achievable on the current stack: it is prohibited or high-risk on Instagram, on Telegram/Stars, at every researched image and video vendor, and in the LLM vendor's usage policy, and it would require highly effective age assurance. An adult tier would be a **different product** with different vendors, legal review and likely different distribution. It is not a toggle.
2. **Premium = exclusive SFW content and closeness**: premium channel, PPV sets in the bot, personalized (non-erotic) AI conversation credits.
3. **Telegram consent gate before AI.** No AI reads a fan's message until explicit consent is recorded.
4. **Instagram is top-of-funnel and must stay squeaky clean.** No adult CTAs; AI labels everywhere; Business account.
5. **The personal account runs on Telegram Business**, human-operated, with AI drafts. No userbots.

---

## 7. Capability matrix → module mapping

| Module | Depends on (evidence) |
|---|---|
| C. Publishing | IG publishing (E), Telegram channel posting (V), quota endpoint (E), `is_ai_generated` (E, unconfirmed) |
| D. Conversation | Telegram bot webhooks (V), IG messaging window (E), Business bots (V), Claude API (V), consent rules (V) |
| E. Monetization | Stars invoices and subscriptions (V), `subscription` updates (V), paid media (V), refunds (V), transactions (V) |
| G. Analytics | IG insights (E), Telegram counts only (V/A), internal events (A: ours) |
| B. Content | FLUX.2 / Nano Banana / Veo / Kling (E), C2PA (E), Rekognition (E) |

---

## 8. Phase 0 verification checklist (must read live primary docs)

| # | Item | Why it matters | Owner |
|---|---|---|---|
| 1 | IG `is_ai_generated` parameter: existence, behavior, video support | AI-label compliance for Reels | Eng |
| 2 | IG webhooks for comments/DMs from non-role users under Standard Access in Live mode | Whether App Review gates the IG engagement features | Eng |
| 3 | IG Stories publishing for Business accounts via Instagram Login | Story format | Eng |
| 4 | IG insights scope name and account metric names | Analytics | Eng |
| 5 | Telegram `core.telegram.org/bots/payments-stars` full read: invoice min/max, renewal flow, test environment for Stars | Payments | Eng |
| 6 | Whether bot subscription renewals send `pre_checkout_query` | Pre-checkout handler | Eng (test env) |
| 7 | Business bot: what the counterpart sees | Disclosure UX | Eng |
| 8 | BFL licensing for LoRA-on-fal outputs; FLUX.2 [klein] fine-tune terms | Identity adapter choice | Legal + Eng |
| 9 | Each vendor's current usage policy on "suggestive" (swimwear, fitness, lingerie) | Provider eligibility table | Compliance |
| 10 | Vendor prices (price-book rows need a `source_url` and a verifier) | Cost model | Finance |
| 11 | SB 243 / NY Art. 47 exact text; WA/OR effective requirements; EU Art. 50 guidelines | Disclosure cadence, crisis protocol | Counsel |
| 12 | Render, Postgres and Valkey pricing (infra research could not reach the pricing pages) | Infra budget | Eng |
