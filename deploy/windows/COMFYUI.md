# Connecting to the existing ComfyUI

ComfyUI is **already installed** on the workstation and belongs to Track A, which owns its models, custom nodes, workflows and visual quality. This package **discovers it and connects to it**. It never installs, updates, moves or removes anything in ComfyUI, and never changes its settings or how it starts.

> **Status:** the discovery script, the bridge and the conformance run were exercised only against the repository's **simulated ComfyUI**. That simulator imitates the HTTP API; it is not a renderer. The first contact with the real installation is step 3 of [ACCEPTANCE-TESTS.md](ACCEPTANCE-TESTS.md).

```
Platform (127.0.0.1:8080) ──VEC v1──▶ Bridge (127.0.0.1:8190) ──ComfyUI HTTP API──▶ existing ComfyUI (127.0.0.1:8188)
          ▲                                  │
          └──── signed reference URLs ◀──────┘  (bridge downloads references from the platform)
```

## 1. Discover (read-only)

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\discover-comfyui.ps1 -InstallRoot D:\golden
```

What it does:

- Lists running processes whose command line looks like ComfyUI: `python … main.py`, the portable build, ComfyUI Desktop.
- Records the ports they listen on.
- Probes those ports plus 8188 with `GET /system_stats`, which gives the version, Python and PyTorch, the GPU and its VRAM.
- Counts installed node types with `GET /object_info`.

Pass `-Url http://127.0.0.1:<port>` if ComfyUI listens somewhere unusual, and `-OutFile evidence\comfyui.json` to keep the report. Add `-WriteEnv` to store the first working URL as `COMFYUI_URL` in `golden.env`. That is the only file it writes.

If nothing is found, start ComfyUI the usual way and run it again. If ComfyUI was started with `--listen`, it may be reachable from the network; the bridge still uses loopback.

## 2. Workflow packages from Track A

The bridge runs **Track A's** workflows, delivered as packages. The format is in [contracts/visual-engine/comfyui-bridge.md](../../contracts/visual-engine/comfyui-bridge.md). Each package is a folder:

```
D:\golden\packages\<workflow_key>\<version>\manifest.json, workflow_api.json, bindings.json
```

- `workflow_api.json` is the graph exported from ComfyUI in API format, used **exactly as delivered**.
- `bindings.json` names the node inputs that the platform may set per job: scene text, aspect ratio, reference images, adapter slots, seed, batch size, outputs.

Nothing else in the graph is touched. Models, samplers and custom nodes stay as Track A chose them.

Check the packages against this ComfyUI before serving them:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\discover-comfyui.ps1 -InstallRoot D:\golden -CheckPackages -OutFile D:\golden\evidence\packages.json
```

For each package, this reports:

- node types the graph uses that this ComfyUI does not have (a missing custom node);
- model file names that the loader nodes do not list (a missing model).

It only reads `/object_info`. **Missing items are Track A's to install.** This package never installs them.

## 3. The bridge service

`register-services.ps1` creates `GoldenInfluencer-ComfyBridge` (only when `COMFYUI_URL` is set). It reads these keys from `golden.env`:

| Key | Default | Meaning |
|---|---|---|
| `COMFYUI_URL` | — | The existing ComfyUI (from discovery) |
| `VEC_ENGINE_TOKEN` | generated | Shared secret between the platform and the bridge |
| `COMFY_BRIDGE_HOST` / `COMFY_BRIDGE_PORT` | 127.0.0.1 / 8190 | Where the bridge serves VEC v1 (`/vec/v1`) |
| `COMFY_BRIDGE_ENGINE_ID` | ws-comfyui | Engine id reported to the platform |
| `COMFY_BRIDGE_PACKAGES_DIR` | `<InstallRoot>\packages` | Track A packages |
| `COMFY_BRIDGE_DATA_DIR` | `<InstallRoot>\bridge` | Job state and downloaded outputs (survives restarts; backed up) |
| `COMFY_BRIDGE_MAX_CONCURRENT` | 1 | Prompts the bridge keeps in ComfyUI at once. Keep 1 until docs/13 measurements say otherwise |
| `COMFY_BRIDGE_INPUT_SUBFOLDER` | golden-refs | Subfolder of ComfyUI's `input` folder for uploaded reference images |
| `COMFY_BRIDGE_CONFORMANCE` | true | Offers the native `__conformance__.solid_color` test workflow (no ComfyUI, no GPU) |

What the bridge does in ComfyUI. These are the same API calls ComfyUI's own web page makes:

- `POST /prompt` with its own `client_id`, then reads `/queue`, `/history/<id>` and `/view`.
- `POST /upload/image` into `input\golden-refs\`. These are reference images, verified by SHA-256.
- `POST /queue {delete}` and `POST /interrupt {prompt_id}`, **only for its own prompts**. Prompts that a person queued in the ComfyUI UI are never removed or interrupted.
- `POST /free`, only when the platform asks for a GPU release and no prompt is running.

## 4. Register the bridge with the platform

Do this once, as a platform admin. Either:

- run `integration-test.ps1 -InstallRoot D:\golden -RegisterEngine`, which registers `http://127.0.0.1:8190/vec/v1` with `VEC_ENGINE_TOKEN`, refreshes health and syncs workflows; or
- in the dashboard: **Engines → Register**, then **Sync**.

Then, in the dashboard:

1. **Workflows:** review and **approve** each synced workflow version. Unapproved workflows cannot be used.
2. **Influencer → Bindings:** bind a purpose (e.g. `feed_photo`) to a workflow key and version range.
3. Upload and approve reference images (face etc.) and adapters (LoRA references from Track A) for the influencer.

Set `media_lane_vram_mb` on the engine to the VRAM really available to ComfyUI while the LLM is loaded (measure it with `gpu-monitor.ps1`, see [LOCAL-LLM.md](LOCAL-LLM.md) §4). The GPU scheduler uses it together with the manifests' `vram_mb_peak`.

## 5. Conformance and the first real generation

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\conformance.ps1 -InstallRoot D:\golden
$env:GI_API_TOKEN = '<owner token>'
powershell -ExecutionPolicy Bypass -File deploy\windows\integration-test.ps1 -InstallRoot D:\golden -Generate -InfluencerId <id> -Purpose feed_photo
```

- **Conformance** proves the bridge speaks VEC v1 correctly. It uses the native test workflow, so it loads no model.
- **The generation** is the first real image: it runs Track A's workflow on this GPU and records time, outputs and VRAM samples in the evidence folder.
- **Image quality and identity consistency** are judged by Track A and the human reviewer; neither script measures them.

## 6. Check these on the real ComfyUI

These behaviours were only exercised against the simulator. Verify each one and record the result in the acceptance evidence:

1. `/upload/image` with a `subfolder`, and `LoadImage` accepting `golden-refs/<file>`.
2. `/interrupt` with a `prompt_id` body. Older ComfyUI versions interrupt whatever is running; the bridge checks the running prompt first, but a race remains, so keep ComfyUI current.
3. `/history` status messages (`execution_start`, `execution_success`, `execution_error`, `execution_interrupted`) and their timestamps, which give the GPU-seconds.
4. The error texts used for classification: out-of-memory wording, "value not in list".
5. Video output nodes and their keys in `/history` outputs.
6. Throughput with the real queue, and that `COMFY_BRIDGE_MAX_CONCURRENT=1` fits the GPU plan (docs/13).

## 7. People using ComfyUI at the same time

The bridge shares ComfyUI's single queue with anyone using its web UI.

- Their prompts run in queue order.
- The bridge never touches them.
- Its timeouts count from when **its** prompt starts executing.

For predictable scheduling, avoid manual ComfyUI work while the platform is producing content, or pause media generation with the kill switch (dashboard → Ops).
