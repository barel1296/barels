# 15 — Local Model Stack & Licensing

> Status: Proposed · Research date: 2026-10-18 · Evidence tags as in [doc 02](02-platform-capabilities.md): **V** (primary text read; mostly LICENSE/README files on GitHub), **E** (official wording in a search extract), **R** (secondary), **A** (our inference)
>
> **Scope rules.**
> - **Every model must be commercially usable** for both its weights (running it in a revenue-generating service) and its outputs. This is enforced by `inference.licenses` and the approval trigger on `inference.models` (doc 05 I11).
> - **No paid AI APIs.**
> - **No performance claims.** Sizes below are author-stated or arithmetic and marked as such. Throughput and quality come from doc 14 on our hardware.
> - **Counsel reviews every licence row** before production approval. This document is engineering triage, not legal advice.

## 1. Selection principles

1. **Licence first.** A model that is great but non-commercial, territory-restricted, or revenue-capped below our plan is excluded from the default path, however good it is.
2. **Quality second, measured.** Choose among licence-clean candidates by blind quality tests (Q-ID-1, Q-IMG-1, Q-VID-1, Q-CHAT-1) on our prompts and personas.
3. **Fit the shared GPU third.** Prefer models that let the chat lane stay resident (doc 13 §4). Quantized variants (fp8 / NVFP4 / GGUF / Nunchaku 4-bit) count as separate candidates, because quantization changes quality and must be evaluated.
4. **One model, many jobs where possible.** A natively vision-language chat model can also serve as the image judge, which saves a resident model.
5. **Training-data hygiene.** Persona LoRA datasets are generated only with Apache/MIT models. Several licences forbid using their outputs to train other models: FLUX outputs may not train a competing model, and Hunyuan outputs may not improve any other model (V).

## 2. Recommended stack (candidates enter the Stage-0 bake-off)

### 2.1 Language: chat, agents, vision QA

| Role | Primary candidate | Alternatives in bake-off | Licence | Notes |
|---|---|---|---|---|
| **Chat + agents + image judge** (resident) | **Qwen3.5-9B** (instruct, non-thinking mode for chat) | **Ministral 3** 8B/14B (Apache-2.0, R), **Gemma 4 12B** (reported Apache-2.0; **licence text must be read**, R), Qwen3-VL-8B (Apache-2.0, V) as a separate judge | Apache-2.0 (E) | Natively vision-language (V). Quantized sizes reported: Q4_K_M ≈ 6.2 GB, Q8_0 ≈ 9.8 GB (R). **Risk:** its hybrid (Gated-DeltaNet) attention currently gets **no prefix-cache hits for prompts < 528 tokens in vLLM**, and llama.cpp reprocesses full prompts (V/R). Persona-prefix caching must be measured (B-LLM-4); this can decide the model. |
| Small fallback chat (Mode T / Safe) | Qwen3-4B-Instruct-2507 or Qwen3.5-4B | Ministral 3 3B | Apache-2.0 (R) | Keeps fans answered during training windows |
| Heavy agent reasoning (planning, analytics narratives) | **gpt-oss-20b** (MXFP4, "runs within 16 GB", V) | Same chat model at higher reasoning effort | Apache-2.0 + usage policy (V) | Loaded only in class-A/T windows when the media lane is idle; never resident with ComfyUI |
| Serving engine | Bake-off: **llama.cpp server** (MIT, V) vs **vLLM** in WSL2 (Apache-2.0, V) | — | — | Both OpenAI-compatible; both offer JSON-schema structured output (V). vLLM: `kv_cache_memory_bytes` fixes the KV budget; sleep mode (V). llama.cpp: native Windows CUDA 13.x builds, NVFP4 GGUF types, sleep-on-idle (V). |

**Excluded or avoided:**

| Model | Why |
|---|---|
| Gemma 3 family (incl. ShieldGemma, EmbeddingGemma derivatives) | Gemma Prohibited Use Policy cites "sexual chatbots" (E). Our product is SFW, but persona companionship invites dispute. Classifier use needs counsel review. |
| Llama 3.x/4 family (incl. Llama Guard, Prompt Guard) | Community licence + AUP; Llama 4 multimodal rights not granted to EU-domiciled companies (V) |
| Qwen3.8-2.4T | Custom licence with revenue thresholds (R) |
| Phi-4 | 16K context (R) |

### 2.2 Safety classifiers

| Role | Primary | Alternatives | Licence | Coverage gaps and mitigation |
|---|---|---|---|---|
| Text guard (input + output) | **Qwen3Guard-Gen-0.6B or 4B** | gpt-oss-safeguard-20b (Apache-2.0, E; policy-as-prompt, window-only), Granite Guardian 4.1-8B (Apache-2.0, V; English only, no self-harm category) | Apache-2.0 (R) | Categories include Suicide & Self-Harm, Sexual Content, Jailbreak (input), with severity levels; 119 languages (V). **No minors-specific category** (V). |
| Minors signals | Deterministic rules (age statements, school context, grooming patterns) + chat-model classification prompt with structured output | Nemotron Safety Guard 8B v3 ("Sexual (minor)" category, E): **licence = NVIDIA Open Model License + Llama 3.1 base**, so counsel review first | — | Any minors signal → restricted mode + human review (doc 06). Q-GUARD-1 recall target ≥ 98%. |
| Prompt injection | ProtectAI `deberta-v3-…-prompt-injection-v2` | Qwen3Guard jailbreak category | Apache-2.0 (E) | English-only, injection-only (E). Defense in depth: no high-risk tools in conversation paths (doc 06). |
| Image NSFW / rating | **Ensemble:** opennsfw2 (MIT code, BSD-style weights, V) + Falconsai nsfw_image_detection (Apache-2.0, E/R) + **VLM rubric** (§2.1) | Nemotron 3.5 Content Safety / ShieldGemma 2 (Gemma terms, E) only after review | — | No classifier detects teenagers reliably (from the cloud research). Mitigations: persona is defined as an adult, age-presentation attribute check, prompt-level bans, human approval. |
| Aesthetic score (ranking only) | LAION improved-aesthetic-predictor on CLIP | — | Apache-2.0 + MIT (V) | Avoid aesthetic-predictor-v2-5 (AGPL, V) and pyiqa (PolyForm Noncommercial, V) |

### 2.3 Embeddings

| Role | Primary | Alternative | Licence | Notes |
|---|---|---|---|---|
| Memory / asset retrieval | **Qwen3-Embedding-0.6B** (1024 dims) + Qwen3-Reranker-0.6B | bge-m3 (MIT, R) | Apache-2.0 (R) | 1024 dims are indexable by pgvector HNSW/IVFFlat (≤ 2000 for `vector`, V). Avoid Jina v3/v4 (non-commercial, R). Placement on CPU vs. GPU decided by B-AUX-3. |

### 2.4 Image generation & editing (ComfyUI)

| Role | Primary | Bake-off candidates | Licence | Notes |
|---|---|---|---|---|
| **Base generator (photoreal)** | **Z-Image-Turbo** for production renders; **persona LoRAs trained on Z-Image Base** | **Qwen-Image-2512** (Apache-2.0, 20B, V), **ERNIE-Image / Turbo** (Apache-2.0, 8B, "consumer GPUs with 24G", V), **HiDream-O1-Image** (MIT, 8B, V), **FLUX.2 [klein] 4B** (Apache-2.0, "~8 GB", V) | Apache-2.0 (V) | Z-Image: 6B, "fits comfortably within 16G VRAM" (V), native in ComfyUI (V), Nunchaku 4-bit variant (V). The winner is chosen by Q-IMG-1 + Q-ID-1. |
| **Reference editor** (outfit/scene/pose changes keeping identity) | **Qwen-Image-Edit-2511** | FLUX.2 [klein] 4B multi-reference (V), LongCat-Image-Edit (Apache-2.0, V) | Apache-2.0 (V) | Up to 3 reference images officially (V). 20B, so it needs fp8 or Nunchaku 4-bit to fit beside the chat lane; measure (B-IMG-3). |
| Upscale | **Real-ESRGAN** | SeedVR2-3B (Apache-2.0, V/E) | BSD-3 (V) | 4x-UltraSharp licence unverified, so not used |
| Face detail (detection for the detailer) | **MediaPipe** face detection or **OpenCV YuNet** | SAM 2 (Apache-2.0, V) | Apache-2.0 / MIT (V) | **Not** Ultralytics YOLO face models (AGPL-3.0, V) unless an Ultralytics Enterprise licence is bought |
| Pose / control | **DWPose** | — | Apache-2.0 (V) | **Not** CMU OpenPose (non-commercial, V) |
| Segmentation | SAM 2 | SAM 3 ("SAM License": worldwide grant, plus trade-control/AUP terms, V) after review | Apache-2.0 | — |

**Conditional (licence-gated by revenue, not the default):**

| Model | Gate |
|---|---|
| FLUX.3 Image Klein | "FLUX Kommunity License": free only below **$5M** revenue (R) |
| Krea 2 | Community licence: below **$1M** trailing revenue, content filters required (E) |
| SD 3.5 | Stability Community Licence: below **$1M** revenue (E) |
| Juggernaut XL | Commercial licence required (E) |

If any of these is ever approved, `inference.licenses.revenue_threshold` is set, and a finance check alerts at 70% of the threshold.

**Excluded from the commercial path:**

| Excluded | Reason |
|---|---|
| FLUX.1 [dev], FLUX.1 Kontext [dev], Fill/Redux, FLUX.2 [dev], FLUX.2 [klein] 9B | **Weights licensed "solely for Non-Commercial Purposes"**, and revenue-generating use is not non-commercial (V). The permissive "outputs" clause doesn't cure running the model for a business (A). |
| Qwen-Image-2.1 / 2.1-Turbo | Qwen Research Licence, "for non-commercial purposes only" (V) |
| HunyuanImage 2.1/3.0 | Licence excludes EU/UK/South Korea, **including displaying outputs** there (V); our posts are globally visible |
| Ideogram 4 | Non-commercial (R) |
| SUPIR, CodeFormer | Non-commercial (V) |
| InsightFace pretrained models (buffalo_l, antelopev2, inswapper) **and everything that depends on them**: IP-Adapter FaceID, InstantID, PuLID, InfiniteYou (also CC BY-NC weights), ReActor | Non-commercial research only (V) |
| ACE++, DreamO, UNO/USO | Depend on FLUX.1 dev/Fill bases (V/A) |
| NudeNet | AGPL repo + Ultralytics models (V) |

### 2.5 Video, lip-sync, voice (ComfyUI)

| Role | Primary | Alternatives | Licence | Notes |
|---|---|---|---|---|
| **Image-to-video** (from an approved still) | **Wan2.2-I2V-A14B**, fp8_scaled, with Wan2.2-Lightning / lightx2v step-distill LoRAs | — | Apache-2.0, "no rights over your generated contents" (V) | MoE with 2 × ~14B experts (V). Authors' reference command targets 80 GB GPUs (V). On 24 GB it relies on ComfyUI offloading, so **system RAM is a hard requirement (§4)** and feasibility is decided by B-VID-1/2. Default 16 fps, 81 frames ≈ 5 s (V); RIFE to 30 fps. |
| Draft / volume video | **Wan2.2-TI2V-5B** | — | Apache-2.0 (V) | 720p, 24 fps, 121 frames (V); ComfyUI says it "should fit well on 8GB vram" with offloading (V) |
| Talking head / lip-sync | **InfiniteTalk** (native ComfyUI node) | LatentSync (post-hoc, Apache-2.0, V), Wan2.2-S2V (Apache-2.0, V) | Apache-2.0 (V) | Post-MVP feature (Stage 4) |
| Motion transfer / dance | Wan-Animate-2 | — | Apache-2.0 (V) | Post-MVP |
| Voice (TTS) | **Qwen3-TTS** voice *design*: synthetic persona voices, no cloning of real people | Kokoro (Apache-2.0, V), CosyVoice (Apache-2.0, V), Chatterbox (MIT, Perth-watermarked, V) | Apache-2.0 (V repo) | Post-MVP |
| Interpolation / upscaling | RIFE (MIT, V) / FILM (Apache-2.0, V); SeedVR2 or FlashVSR (Apache-2.0, V) | — | — | — |

**Conditional:**

- **LTX-2.5:** joint audio+video. Free below **$10M** revenue; watermark and provenance features must be kept (V). Its stated need is "32GB+" (V), so it is unlikely to be practical beside the chat lane. Evaluate only if Wan fails Q-VID-1.

**Excluded:**

| Excluded | Reason |
|---|---|
| Hunyuan video family | EU/UK/KR exclusion including display (V) |
| MiniMax H3 | Commercial use of local outputs needs a paid MiniMax licence (V); territory limits reported (R) |
| CausVid-derived LoRAs | CC BY-NC-SA (V) |
| F5-TTS pretrained, XTTS-v2 | Non-commercial (V/R) |
| Higgs Audio v3 | Non-commercial + grant terms (R) |
| CogVideoX-5B / Hallo3 | Registration + 1M visits cap (V) |
| Fish Audio | < $500k revenue (V) |
| Kandinsky 6 | Weights licence unverified + sanctions/compliance review (A). Re-evaluate later. |
| Wan 2.5 / 2.6 / 2.7 / 3.0 | Not open weights (cloud-only) (E/R) |

### 2.6 Training & tooling

| Tool | Licence | Use |
|---|---|---|
| **ai-toolkit** (ostris) | MIT (V) | Persona LoRA training for Z-Image Base, Qwen-Image, FLUX.2 klein 4B, Wan 2.2 (configs for 24 GB exist; Qwen-Image needs 3-bit at 24 GB, V); Windows launcher (V) |
| musubi-tuner | Apache-2.0 (Hunyuan subfolders under the Hunyuan licence) (V) | Alternative trainer (Z-Image, Qwen-Image, Wan); "64GB system RAM recommended" (V) |
| DiffSynth-Studio | Apache-2.0 (V) | Alternative (Z-Image LoRA/full training) |
| OneTrainer | AGPL-3.0 (V) | Allowed for internal use only (no distribution); not default |
| **ComfyUI** | GPL-3.0 (V) | Run as a separate process driven over HTTP/WebSocket. We don't distribute it, so GPL obligations aren't triggered by internal use (A, counsel to confirm). Custom nodes pinned. |
| **C2PA:** c2pa-rs / c2patool / c2pa-python | MIT + Apache-2.0 (V) | Sign every output with an "AI-generated" (trainedAlgorithmicMedia) assertion with our own certificate |
| Face identity scoring | **OpenCV YuNet (MIT) + SFace (Apache-2.0)** (V) | SFace's training-data terms are unaddressed (A), so counsel reviews it. Alternative: buy an InsightFace commercial licence for buffalo_l. |

## 3. VRAM fit — planning arithmetic only (replace with B-*-1 measurements)

| Component | Basis for planning | Planning figure | Measured (B-id) |
|---|---|---|---|
| Qwen3.5-9B Q4_K_M weights | Reported GGUF size (R) | ≈ 6.2 GB + KV + engine overhead | B-LLM-1 |
| Qwen3.5-9B Q8_0 weights | Reported GGUF size (R) | ≈ 9.8 GB + KV + overhead | B-LLM-1 |
| Qwen3Guard-Gen-0.6B | params × 2 bytes (bf16), arithmetic | ≈ 1.2 GB (or CPU) | B-AUX-1 |
| Qwen3-Embedding-0.6B | arithmetic | ≈ 1.2 GB bf16 (or CPU) | B-AUX-3 |
| Z-Image-Turbo (6B) + text encoder | Author statement "fits within 16 GB" (V) | ≤ 16 GB unquantized, less with fp8 / Nunchaku | B-IMG-1 |
| Qwen-Image-Edit-2511 (20B) | arithmetic: fp8 ≈ 20 GB weights → needs Nunchaku 4-bit or offload beside the chat lane | ≈ 10–12 GB at 4-bit + encoders | B-IMG-3 |
| Wan2.2-I2V-A14B fp8 | arithmetic: 2 experts × ~14 GB fp8 + text encoder; only one expert active at a time | GPU: offload/block-swap dependent; **system RAM ≫ 32 GB** | B-VID-1 |

**Consequence for the resident chat lane:** with Q4-class chat weights (~6 GB) plus a modest KV budget and a CPU-placed guard and embedder, roughly 14–16 GB remains for the media lane, enough for the Z-Image class by the authors' statement. The 20B editor and the 14B video experts need quantization or offload. **This is planning arithmetic.** Mode S/M budgets are set only from measurements.

## 4. Workstation hardware requirements derived from the stack

These are arithmetic requirements, not benchmarks.

| Resource | Minimum | Recommended | Why |
|---|---|---|---|
| System RAM | **64 GB** | **96–128 GB** if the chassis supports it | Wan A14B offloading keeps the non-active expert and encoders in RAM. musubi-tuner recommends 64 GB for training (V). Postgres, WSL, Windows, ComfyUI caches and the chat engine also share RAM. **If the laptop is capped at 64 GB, video throughput (Mode M) is the first casualty;** measure it in B-VID-1. |
| NVMe (internal) | 2 TB | 4 TB | Model library (several 10–30 GB checkpoints + LoRAs), Postgres, content store, local backup staging |
| Secondary disk (USB-C/TB external NVMe) | 4 TB | 4–8 TB | Local backup target (pgBackRest, restic) + model cache for rebuilds |
| GPU power mode | OEM "performance" mode with maximum TGP | Fixed and recorded | The RTX 5090 Laptop's TGP is 95–150 W, set by the OEM (E); sustained behavior is chassis-specific, so measure it (B-THERM-1) |
| Display | Integrated GPU drives the display (Optimus/hybrid) | — | Keeps dGPU VRAM for inference |

## 5. Licence review workflow (enforced)

1. Record an `inference.licenses` row with:
   - the exact licence name and URL;
   - `weights_commercial` / `outputs_commercial`;
   - territory exclusions, revenue threshold and use restrictions;
   - an `evidence_ref` pointing to where the text was read.
2. Counsel reviews and sets `reviewed_by`/`reviewed_at`.
3. Register the model in `inference.models` with pinned revision and file SHA-256s.
4. Benchmark (doc 14) → quality evals → approve. **The DB trigger refuses approval for unreviewed or non-commercial licences.**
5. Re-review on any licence change upstream. `ops` checks licence-file hashes monthly for approved models.

## 6. Open items for counsel

| # | Item |
|---|---|
| L1 | Read the actual licence text for Qwen3.5, Qwen3Guard, Qwen3-Embedding, Qwen-Image-Edit-2511 and Gemma 4 (Hugging Face model cards were not readable during research) |
| L2 | SFace training-data provenance vs. commercial identity scoring; or budget for an InsightFace commercial licence |
| L3 | SAM 3 licence AUP/trade terms; Nemotron licences (if used for minors classification) |
| L4 | GPL-3.0 ComfyUI and AGPL tools: confirm that internal, non-distributed use creates no obligations for our proprietary code |
| L5 | The "AI-generated" C2PA assertion and visible labels vs. EU AI Act Art. 50 deployer duties (unchanged from doc 03) |
| L6 | Whether persona voice design (TTS) raises any likeness/voice-rights issues (synthetic voices only) |
