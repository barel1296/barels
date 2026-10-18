# Local LLM setup

The platform uses **one local language model, shared by every influencer**. It writes:

- fan chat replies (Telegram);
- fan-memory extraction;
- agent proposals (strategy, captions, scheduling);
- the language half of caption QA.

Persona differences come from the prompt (persona version, memories, rules), not from separate models. No paid API is used, and nothing leaves the workstation.

The platform talks to any **OpenAI-compatible** server through two endpoints:

- `GET <LLM_BASE_URL>/models`, used for health: the configured model must be listed;
- `POST <LLM_BASE_URL>/chat/completions` with `stream: false`. JSON tasks add `response_format: {"type":"json_object"}`.

The model name is configuration only (`LLM_CHAT_MODEL`); no model is hard-coded anywhere.

> **Status:** the gateway, prompts, guards, queueing and benchmark are tested against the repository's **simulated** LLM server. No real model has been run or measured yet; that happens on the workstation with `llm-bench.ps1`.

## 1. Choose the model

Candidates, licences and VRAM arithmetic are in [docs/15 §2.1 and §3](../../docs/15-local-model-stack.md):

- the resident chat/agent candidate is a ~9B instruct model at Q4_K_M–Q8_0 (about 6–10 GB of weights plus KV cache);
- a 3–4B model is the fallback for windows when ComfyUI needs most of the VRAM.

Before using any model:

1. Read its licence text and record it (docs/15 §5).
2. Download the GGUF (for llama.cpp) from the model's official page.
3. Record its SHA-256 with `Get-FileHash <file> -Algorithm SHA256`.

The final choice is made by measurement on this machine (step 5), not from published numbers.

## 2. Install a server

Use **one** of these options.

### Option A (recommended): native llama.cpp server, run as a scheduled task

1. Download a Windows CUDA build of llama.cpp from its GitHub releases page:
   - the `bin-win-cuda-<version>-x64` zip;
   - and the matching `cudart-...` zip.

   RTX 50-series GPUs need a build for **CUDA 12.8 or newer**. Unzip both into one folder, e.g. `D:\golden\llm\llama.cpp\`.
2. Put the model file somewhere stable, e.g. `D:\golden\llm\models\<file>.gguf`.
3. Check that the build sees the GPU: `D:\golden\llm\llama.cpp\llama-server.exe --list-devices`.
4. Add to `D:\golden\config\golden.env`:

   ```ini
   LLM_BASE_URL=http://127.0.0.1:8081/v1
   LLM_CHAT_MODEL=golden-chat              # any name; the server is started with --alias <this>
   LLM_SERVER_EXE=D:/golden/llm/llama.cpp/llama-server.exe
   LLM_MODEL_PATH=D:/golden/llm/models/<file>.gguf
   LLM_SERVER_CTX=16384                    # TOTAL context, split across the parallel slots
   LLM_SERVER_PARALLEL=2                   # slots = simultaneous requests
   LLM_SERVER_GPU_LAYERS=999               # all layers on the GPU
   LLM_MAX_CONCURRENCY=2                   # the platform never sends more than this at once (= slots)
   # LLM_SERVER_EXTRA_ARGS=--reasoning-budget 0   # e.g. disable "thinking" on hybrid models (check llama-server --help)
   ```

5. Run `register-services.ps1 -InstallRoot D:\golden -Start`. It adds the `GoldenInfluencer-LLM` task, which runs:

   ```
   llama-server -m <LLM_MODEL_PATH> --host 127.0.0.1 --port 8081 --alias <LLM_CHAT_MODEL> --jinja -c <CTX> -np <PARALLEL> -ngl <LAYERS>
   ```

   The output goes to `logs\llm-YYYYMMDD.log`. If `LLM_API_KEY` is set, it is passed as `--api-key`. That key is visible in the local process list; the server listens on loopback only.

`llama-server` divides `-c` evenly between the `-np` slots. Each conversation therefore gets `CTX / PARALLEL` tokens. The platform sends the persona prompt, memories and the last `LLM_CONTEXT_MESSAGES` (default 20) messages. Keep `CTX / PARALLEL` comfortably above that: llama-server logs each request's prompt size (`logs\llm-*.log`); depending on the build, a prompt that does not fit is either rejected or shifted, and neither is acceptable.

### Option B: Ollama

- Install Ollama for Windows.
- Set the user environment variables:
  - `OLLAMA_HOST=127.0.0.1:11434`;
  - `OLLAMA_KEEP_ALIVE=-1` (stay loaded);
  - `OLLAMA_NUM_PARALLEL=2`;
  - `OLLAMA_CONTEXT_LENGTH=8192` or more. Ollama's default context is small and its OpenAI endpoint cannot raise it per request.
- `ollama pull <model>`.
- In `golden.env`: `LLM_BASE_URL=http://127.0.0.1:11434/v1` and `LLM_CHAT_MODEL=<model name exactly as ollama list shows it>`. Leave `LLM_SERVER_EXE` empty: Ollama runs as its own service.

### Option C: Docker (llama.cpp server-cuda image)

Use this only if Docker Desktop with WSL2 GPU support already works (`docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi`). Add `LLM_MODEL_DIR`, `LLM_MODEL_FILE` and `LLM_SERVER_PORT=8081` to `golden.env`, then run:

```powershell
docker compose -f deploy\windows\compose.llm.yml --env-file D:\golden\config\golden.env up -d
```

Pin the image by digest after the first pull (see the comments in [compose.llm.yml](compose.llm.yml)).

LM Studio and vLLM (in WSL2) also expose OpenAI-compatible servers. Any of them works if `/models` lists `LLM_CHAT_MODEL` and JSON mode is honoured; step 5 checks both.

## 3. Platform settings

| Key | Default | Meaning |
|---|---|---|
| `LLM_BASE_URL` | — (AI off) | Server base URL ending in `/v1` |
| `LLM_CHAT_MODEL` | — | Model name sent in every request; must appear in `/models` |
| `LLM_API_KEY` | — | Bearer key if the server requires one |
| `LLM_MAX_CONCURRENCY` | 2 | Requests in flight. Fan replies jump ahead of background agent work; the rest wait in a queue |
| `LLM_TIMEOUT_MS` | 60000 | Per request |
| `LLM_MAX_REPLY_TOKENS` | 300 | Fan reply length cap |
| `LLM_TEMPERATURE` | 0.7 | Chat temperature (JSON tasks use 0.2) |
| `LLM_CONTEXT_MESSAGES` | 20 | Conversation history sent per reply |
| `CONVERSATION_REPLY_DEBOUNCE_MS` | 2500 | Waits for a fan to finish typing several messages before replying once |

Inbound messages are classified first by deterministic rules (self-harm risk, minor signals, explicit requests, refunds and payment disputes, threats, requests for a human); the serious ones stop the AI and open an escalation. Every generated reply is then checked before it is sent: no claiming to be human, no sexual content, no off-platform payment, contact details, links or meetings, and length limits. The default conversation mode is `ai_draft`: an operator approves drafts until you switch an influencer to `ai_auto`.

## 4. VRAM: sharing the card with ComfyUI

ComfyUI and the LLM share 24 GB. The LLM's weights and KV cache stay resident; ComfyUI loads and unloads models per workflow.

- Start the LLM, run `gpu-monitor.ps1 -DurationSec 120`, and note its steady VRAM: it is the `llama-server` or `ollama` row in `gpu-procs-*.csv`.
- Give the remainder to media. When you register the bridge (`integration-test.ps1 -RegisterEngine`, or the dashboard), set `media_lane_vram_mb` to what is really free for ComfyUI. The platform's GPU scheduler then admits media jobs against that figure and Track A's measured `vram_mb_peak`.
- How ComfyUI itself manages memory (`--reserve-vram`, low-VRAM modes) is Track A's configuration. This package does not change it.

## 5. Measure it (acceptance)

```powershell
# ComfyUI idle:
powershell -ExecutionPolicy Bypass -File deploy\windows\llm-bench.ps1 -InstallRoot D:\golden -Runs 50 -Concurrency 2 -WithGpu
# Again while a ComfyUI generation runs (start one from the dashboard or integration-test.ps1 -Generate):
powershell -ExecutionPolicy Bypass -File deploy\windows\llm-bench.ps1 -InstallRoot D:\golden -Runs 50 -Concurrency 2 -WithGpu
```

The report (`evidence\llm-bench-*.json`) gives, per workload:

- latency p50/p95/max;
- completion tokens/s;
- the output-guard pass rate (persona replies);
- the JSON validity rate (memory extraction).

Acceptance thresholds are the chat SLOs in [docs/11](../../docs/11-mvp-acceptance-criteria.md) and the benchmark protocol in [docs/14](../../docs/14-benchmark-protocol.md) (B-LLM-1…6). Commit the JSON reports as evidence. `integration-test.ps1` fails the LLM step when JSON validity or guard pass rate is below 90% (`-MinRate`).

## 6. Switching models later

1. Change `LLM_MODEL_PATH` (and, if you like, `LLM_CHAT_MODEL`).
2. Restart `GoldenInfluencer-LLM`, then the platform task.
3. Re-run `llm-bench.ps1`.

Agents record the model name with every run, so analytics can compare models. Nothing else needs to change.
