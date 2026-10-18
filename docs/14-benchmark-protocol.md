# 14 — Hardware & Model Benchmark Protocol

> Status: Proposed · Runs in Stage 0 on the **production workstation itself**, and is repeated on the triggers in §6 · Feeds [13 GPU scheduling & capacity](13-gpu-scheduling-and-capacity.md) and the acceptance gates in [11](11-mvp-acceptance-criteria.md)
>
> **Rule: no benchmark number is copied from the internet, a vendor, or another machine.** Published figures for other hardware (especially desktop RTX 5090s, which have more VRAM and power) don't transfer to a power-limited laptop GPU. Every value used for capacity or a gate comes from a run recorded in `ops.benchmark_runs`, with its environment fingerprint.

## 1. Environment fingerprint (recorded with every run)

| Field | How captured |
|---|---|
| Machine model, BIOS version, RAM size/speed, NVMe model(s) | `wmic`/PowerShell `Get-ComputerInfo`, `Get-PhysicalDisk` |
| GPU name, VBIOS, driver version, CUDA version, **power limit** (`power.limit`, `power.max_limit`), current TGP/performance mode in the OEM control app | `nvidia-smi -q`; screenshot of the OEM performance mode |
| Display attached to iGPU or dGPU (MUX / Advanced Optimus state) | `nvidia-smi` process list; OEM app |
| Windows build, WSL version, WSL kernel, distro, `.wslconfig` contents | `winver`, `wsl --version`, `uname -a`, file hash |
| Engine versions: LLM engine, ComfyUI commit, custom-node commits, PyTorch, CUDA toolkit, attention kernels | Lockfile hashes (`ops/locks/*.lock`) |
| Model keys + file SHA-256 + quantization | `inference.models` |
| Ambient temperature, cooling (stand, fans), AC power adapter rating (W) | Manual entry + photo of the adapter label |
| Git SHA of the benchmark harness | Harness |

**A run without a complete fingerprint is invalid and can't satisfy a gate.**

## 2. Harness (built in Stage 0)

| Component | Function |
|---|---|
| `bench run <suite>` CLI (Python, part of the Inference Host repo) | Executes a suite, writes raw samples to `bench/results/<run_id>/` (CSV/JSONL) and a summary row to `ops.benchmark_runs` |
| GPU sampler | NVML at 200–500 ms: `memory.used`, `power.draw`, `clocks.sm`, `clocks.mem`, `temperature.gpu`, `utilization.gpu`, throttle reasons. Peak and percentile summaries. |
| System sampler | CPU %, RAM used, swap, disk I/O, process RSS (psutil) |
| LLM load generator | Async client that replays **synthetic conversation traces** against the chat engine's OpenAI-compatible endpoint, with fixed concurrency `b` (closed loop) and open-loop arrival-rate modes. It uses the **production prompt shape**: persona prefix, memory block, history, structured-output schema. It records TTFT, total latency, prompt/completion tokens, and cache hits where the engine reports them. |
| ComfyUI driver | Submits versioned workflows from `inference.workflows` through `/prompt`, tracks progress on the websocket, reads `/history`, and records per-node timings where available, wall time and peak VRAM. It calls `/free` between cold-start tests. |
| Energy reader | Smart plug with energy metering (local API or manual reading) at run start and end, plus NVML `power.draw` integration for the GPU share |
| Report generator | Markdown + CSV per run; comparison against the previous run of the same suite |

**Statistics rules:**

- At least 3 warm-up iterations are discarded.
- Latency percentiles need **≥ 200 requests** (p95) and ≥ 1,000 for p99.
- Per-item media timings need **≥ 20 repetitions**.
- Report median, p95, min/max and coefficient of variation.
- A suite is re-run if CV > 15% without an explained cause.

## 3. Benchmark catalog

### 3.1 System

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-SYS-1** | Usable VRAM | Boot, start no engines, record `memory.used` / `memory.total`. Repeat with the display on the dGPU vs. the iGPU. | `V_driver`, `V_display`, `V_usable` |
| **B-SYS-2** | Model load times | For each model in `inference.models`: cold load (after a cache flush or reboot) and warm load (file in OS page cache) into its engine. 10 repetitions. | `T_load_cold(model)`, `T_load_warm(model)` |
| **B-SYS-3** | Engine restart & mode switch | Time from the switch command to health-check pass, for each transition S↔M, S↔T, and for a chat-engine restart and a ComfyUI restart alone. Count delayed chat requests during the switch, with the load generator running at a low rate. 10 repetitions. | `T_restart_llm`, `T_restart_comfy`, `T_switch_*`, delayed-request count |
| **B-IO-1** | Disk & DB | `fio` sequential read on the model volume (WSL ext4 vs. `/mnt/*`); `pgbench` (scale 50, 8 clients) TPS and latency on the production Postgres config; `fsync` latency | Disk MB/s, pgbench TPS/latency |

### 3.2 Language models (per candidate chat model and quantization)

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-LLM-1** | Chat-lane VRAM | Start the engine with KV budgets for target concurrencies (e.g. 4/8/16/32 sequences at the production context length). Record steady-state and peak VRAM after a load burst. | `W_llm + O_engine`, `K_llm(b)`, `V_chat(b)` |
| **B-LLM-2** | Single-stream speed | 50 requests with a 4k/8k-token prompt (cold vs. cached prefix), 200-token output | TTFT (cold/cached), decode tokens/s single stream |
| **B-LLM-3** | **Latency–throughput curve** | Closed-loop replay at `b` = 1, 2, 4, 8, 16, 32 (up to the KV limit), ≥ 300 requests each, production prompt shape, structured output **on**, prefix caching **on**, media lane **idle** | `L_p50(b)`, `L_p95(b)`, `μ(b)`, TTFT p95, **`b*`** for the configured `chat_gen_slo` |
| **B-LLM-4** | Persona prefix caching across many personas | Same as B-LLM-3 at `b*`, but requests spread uniformly over 1, 5, 10, 30 persona prefixes | Cache hit rate, `μ`, `L_p95` vs. persona count |
| **B-LLM-5** | **Interference with media** | Repeat B-LLM-3 at `b*` while (a) the primary image workflow loops, (b) the primary video workflow loops | `φ_media(image)`, `φ_media(video)`, media slowdown factor |
| **B-LLM-6** | Structured-output overhead & validity | 500 requests with JSON-schema-constrained decoding vs. unconstrained + validation | Latency delta; % schema-valid (must be 100% with constrained decoding) |
| **B-AUX-1/2** | Guard model | Guard on GPU (VRAM, latency p95 at the expected rate) and on CPU (latency p95) over the guard eval set | `W_guard`, guard latency GPU/CPU → placement decision |
| **B-AUX-3** | Embeddings | 10k short texts and 1k memory facts: throughput on GPU vs. CPU | Placement decision |
| **B-VLM-1** | Vision judge | 200 generated images through the rubric prompt (attributes, rating, artifacts): latency per image, VRAM if a separate model | `t_val` (VLM part), `W_vlm` |

### 3.3 Image (per workflow version in `inference.workflows`)

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-IMG-1** | Peak VRAM / RAM | Run the workflow at production settings (resolution, steps, sampler, LoRA, detailer) with the chat lane resident at `V_chat(S)` | Peak VRAM, peak system RAM, fits in `V_media(S)`? |
| **B-IMG-2** | Sustained time per image | 60 consecutive generations (same model, alternating 3 persona LoRAs), chat lane resident and idle | `t_img` median/p95, LoRA swap cost |
| **B-IMG-3** | Edit model | Reference-edit workflow (outfit/scene change keeping identity): time, VRAM | `t_edit`, peak VRAM |
| **B-IMG-4** | Upscale / face detail | Per final image at the publication resolution | `t_up` |
| **B-IMG-5** | Campaign switch | Image base → edit model → video model → image base: load/unload timings with `/free` | Feeds `T_load` and the campaign policy |

### 3.4 Video

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-VID-1** | Memory | Image-to-video at production resolution/frames, with the offload/block-swap profiles allowed in Mode S and Mode M | Peak VRAM, peak system RAM, success/OOM per profile |
| **B-VID-2** | Sustained time | 10 clips per profile back-to-back; per-clip wall time ÷ output seconds | `t_vid(profile)` median/p95 |
| **B-VID-3** | Lip-sync / talking (post-MVP) | As B-VID-2 for the chosen lip-sync workflow | `t_lipsync` |

### 3.5 Training

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-TRN-1** | Persona LoRA training | Train one character LoRA with the production recipe (dataset size, steps, resolution) with the fallback chat model resident (Mode T) | Wall time, peak VRAM, VRAM headroom for chat, energy |

### 3.6 Thermal, power and energy

| ID | Measures | Procedure | Output parameters |
|---|---|---|---|
| **B-THERM-1** | Sustained behavior | 60-minute mixed soak: image workflow loop + chat load at 0.7 × `μ*`. Repeat for the video workflow. Same ambient conditions as production. | Time series of temperature, clocks, power, throttle reasons; **throughput in minutes 50–60 ÷ minutes 0–5** (sustained factor); thresholds `T_warn`, `T_crit` |
| **B-PWR-1** | Energy | Smart-plug kWh over 1 h in each state: idle (engines loaded), chat-only at 0.7 × `μ*`, media-only, mixed, training | `P_idle`, `P_chat`, `P_media`, `P_mixed`, `P_train` (W); Wh per final image and per video second |

### 3.7 Resilience drills (timed, pass/fail)

| ID | Drill | Pass condition |
|---|---|---|
| **B-FAIL-1** | Kill the chat engine during load | Auto-restart; 0 lost chat requests; holding messages sent per policy; recovery time recorded |
| **B-FAIL-2** | Kill ComfyUI mid-image and mid-video | Job requeued; outputs not double-registered; recovery time recorded |
| **B-FAIL-3** | Force a media OOM (oversized profile) | Degradation ladder applied; chat lane unaffected (latency within SLO) |
| **B-FAIL-4** | `wsl --shutdown` during load | All services return automatically; Telegram offsets resume; 0 lost updates; RTO recorded |
| **B-FAIL-5** | Hard power cut (unplug AC and battery protection per OEM guidance, or a forced reboot) | Auto-boot → services up; Postgres consistent; RTO recorded |
| **B-FAIL-6** | Internet outage 30 min | Telegram backlog processed; pre-checkouts during the outage fail cleanly (no charge); IG publish retries; backfill polling for IG comments; 0 payment discrepancies after reconciliation |
| **B-FAIL-7** | Restore from backup onto a clean WSL distro | Full restore from local + offsite backup; app smoke test passes; measured RTO and RPO |

### 3.8 End-to-end

| ID | Procedure | Output |
|---|---|---|
| **B-E2E-1** | 24-hour simulated day for the stage's persona count: the weekly-plan slice for each persona, plus a synthetic fan-traffic replay shaped by the measured or assumed diurnal curve, at 1×, 1.5× and 2× of the stage's target load | Content produced vs. plan, chat SLO compliance per hour, mode transitions, GPU utilization `U_mode`, energy |

## 4. Quality benchmarks (decide model choices; not hardware)

| ID | Measures | Procedure | Pass threshold (initial) |
|---|---|---|---|
| **Q-ID-1** | Identity consistency | Per persona: 200 generations across scenes/outfits/lighting; automated face-similarity + VLM attribute checks vs. a blind human panel (3 reviewers) | Human "same person" ≥ 95% on accepted images; automated check agrees with the human panel ≥ 90% |
| **Q-IMG-1** | Commercial quality | Blind review of 100 finals per candidate workflow on a 5-point rubric (anatomy, skin/texture realism, lighting, composition, artifacts) | Median ≥ 4; critical artifacts ≤ 2% after QA |
| **Q-VID-1** | Video quality | 30 clips: identity drift, motion artifacts, temporal flicker (blind rubric) | Median ≥ 4; identity drift flagged ≤ 5% |
| **Q-CHAT-1** | Chat quality & safety | Conversation eval suite (~300 cases: persona fidelity, disclosure, crisis handling, minors signals, no human claims, no erotic content, off-platform payment refusal, injection resistance, multilingual) per candidate chat model + quantization | Critical cases 100%; overall ≥ 95%; persona-fidelity rubric median ≥ 4 |
| **Q-GUARD-1** | Guard accuracy | Labeled set (crisis, minors, sexual, injection, benign), multilingual | Recall on crisis/minors ≥ 98% at ≤ 5% false positives (tuned threshold) |
| **Q-VLM-1** | Judge agreement | VLM rubric vs. human labels on 300 images (rating, attributes, artifacts) | Rating agreement ≥ 95%; any "explicit" disagreement = fail |

**Model selection rule:**

- among candidates that pass all quality thresholds, choose the one with the best measured capacity (`μ*`, `t_img`, `t_vid`);
- quality outranks capacity (goal #1 > goal #3);
- never trade a safety pass for throughput.

## 5. Recording template

Each run writes one row per output parameter, with these fields:

| run_id | suite | test_id | model/workflow key + version | params | metric | value | unit | n | p50 | p95 | CV | env fingerprint id | git sha | operator | date | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | *measured* | — | — | — | — | — | — | — | — | — | — |

The capacity worksheet (doc 13 §7.4) is generated from the latest **valid** run of each referenced test. It shows each value's run id and date.

## 6. Re-benchmark triggers

Re-run the affected suites when any of these changes:

- GPU driver, CUDA, PyTorch, LLM-engine version, ComfyUI commit, or custom node;
- model or quantization;
- workflow version;
- OEM power or performance mode;
- `.wslconfig`;
- RAM or disk hardware;
- ambient conditions (seasonal: re-run the thermal soak each quarter).

**Gates (doc 10) always use runs no older than the last trigger.**
