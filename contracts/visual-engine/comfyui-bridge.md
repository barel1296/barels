# ComfyUI bridge and workflow packages

**Status:** Implemented in `apps/platform/src/comfy-bridge/` · **Tested only against a simulated ComfyUI** (`apps/platform/src/simulators/comfyui.ts`). It has not yet run against the real ComfyUI installation on the workstation.

The bridge is an optional, generic VEC v1 engine. It sits in front of the **existing** ComfyUI installation and talks to it only through ComfyUI's HTTP API. Track A can use it instead of writing its own engine server, or ignore it. It contains no image or video workflows, chooses no models, and never installs, modifies or removes models, custom nodes, workflows or settings.

## 1. What Track A supplies: workflow packages

One directory per workflow version:

```text
<COMFY_BRIDGE_PACKAGES_DIR>/
  <workflow_key>/
    <version>/
      manifest.json        VEC workflow manifest (schemas/workflow-manifest.schema.json)
      workflow_api.json    the ComfyUI graph in API format ("Save (API)" / "Export (API)")
      bindings.json        where the contract inputs go in that graph
```

The bridge uses `workflow_api.json` exactly as delivered. Per job it replaces **only** the inputs named in `bindings.json`; everything else (models, samplers, steps, custom nodes, LoRA choices not bound) stays Track A's choice.

### bindings.json

```json
{
  "parameters": {
    "scene": [{ "node": "6", "input": "text", "template": "photo of the persona, {scene}, {mood}" }],
    "aspect_ratio": [
      { "node": "5", "input": "width",  "map": { "1:1": 1024, "4:5": 896,  "9:16": 768 },  "type": "integer" },
      { "node": "5", "input": "height", "map": { "1:1": 1024, "4:5": 1120, "9:16": 1344 }, "type": "integer" }
    ]
  },
  "references":   { "face": [{ "node": "11", "input": "image" }] },
  "adapters":     [{ "node": "10", "input": "lora_name", "weight_inputs": ["strength_model", "strength_clip"] }],
  "seed":         [{ "node": "3", "input": "seed" }],
  "output_count": [{ "node": "5", "input": "batch_size" }],
  "outputs":      [{ "node": "9", "kind": "image" }]
}
```

| Key | Meaning |
|---|---|
| `parameters.<name>[]` | Sets a node input from a manifest parameter. `template` composes a string from several parameters (`{name}` placeholders); `map` translates a value (e.g. an aspect ratio) into an input value; `type` coerces. An absent optional parameter leaves the graph's value unchanged. |
| `references.<role>[]` | Reference images by contract role (`face`, `identity`, `outfit`, `pose`, `environment`, `style`, `source`, `mask`). The bridge downloads each signed URL, verifies its `sha256`, uploads it with `/upload/image` into the `COMFY_BRIDGE_INPUT_SUBFOLDER` subfolder of ComfyUI's input directory (default `golden-refs`) and sets the input to `golden-refs/<file>`. Slots are filled in order. |
| `adapters[]` | Adapter slots, filled in order with each adapter's opaque `engine_ref` (e.g. a LoRA file name registered by Track A). Unused slots get their `weight_inputs` set to `0`. |
| `seed[]` | Receives `parameters.seed`, or a random seed that is reported in provenance. |
| `output_count[]` | Receives `output.count` (e.g. `batch_size`). Required when the manifest allows more than one output. |
| `outputs[]` | Nodes whose files are returned (`images`, `gifs` or `videos` entries of type `output`). |

The bridge validates every package at start-up and refuses packages whose bindings point at missing nodes or inputs, at links instead of values, or that leave a required parameter unbound. Rejected packages are logged and not exposed.

Optional: `manifest.engine_metadata.provenance_models` (array of `{role, ref, sha256, license_ref}`) is copied into each output's provenance, so the platform records which models produced it without the bridge knowing anything about them.

## 2. Contract behaviour

| Contract item | How the bridge does it |
|---|---|
| Auth | `Authorization: Bearer $VEC_ENGINE_TOKEN` on every endpoint |
| Idempotency | `request_id:attempt`; identical body → same job, different body → `409` |
| Job state | Persisted under `COMFY_BRIDGE_DATA_DIR/jobs`; survives bridge restarts (prompts in ComfyUI are re-read from `/history` and `/queue`) |
| Outputs | Downloaded from `/view`, stored under `COMFY_BRIDGE_DATA_DIR/outputs`, served with exact `sha256` |
| Errors | Out of memory → `RESOURCE_EXHAUSTED` (retryable); missing model/file or "value not in list" → `MODEL_UNAVAILABLE`; other execution errors → `EXECUTION_FAILED` (permanent); vanished prompt → `EXECUTION_FAILED` (transient) |
| Cancellation | Pending → removed from the queue; running → targeted `/interrupt` with its own `prompt_id`, only if that prompt is running. Prompts queued by people using the ComfyUI UI are never touched. |
| Timeouts | `min(timeout_s, manifest max_runtime_s)` → interrupt/remove and `TIMEOUT` |
| GPU usage | `gpu_seconds` = ComfyUI execution time of the prompt (from `/history` timestamps) |
| Resources / release | `/system_stats` VRAM (device level); `/free` only when no prompt is running |
| Conformance | `__conformance__.solid_color` is rendered natively (no ComfyUI, no GPU) |

## 3. Running it

```bash
cd apps/platform
# Read-only: find the existing ComfyUI and check packages against its installed nodes and model lists.
npm run comfy-bridge -- discover --url http://127.0.0.1:8188
npm run comfy-bridge -- check-packages --url http://127.0.0.1:8188 --packages "$COMFY_BRIDGE_PACKAGES_DIR"
# Serve VEC v1 (configuration from the environment; see .env.example).
npm run comfy-bridge -- serve
# Conformance against it:
npm run conformance -- --engine-url http://127.0.0.1:8190/vec/v1 --token "$VEC_ENGINE_TOKEN"
```

## 4. Verify on the workstation before relying on it

These were only exercised against the simulator:

1. `/upload/image` with a `subfolder`, and `LoadImage` accepting `golden-refs/<file>` values.
2. `/interrupt` with a `prompt_id` body (older ComfyUI versions interrupt whatever is running; the bridge checks the running prompt first, but a race remains).
3. `/history` message names (`execution_start`, `execution_success`, `execution_error`, `execution_interrupted`) and their `timestamp` fields.
4. The error texts used for classification (out-of-memory wording, "value not in list").
5. Video output nodes and the keys they use in `/history` outputs.
6. Throughput with the real queue, and that `max_concurrent_jobs = 1` matches the GPU plan (docs/13).
