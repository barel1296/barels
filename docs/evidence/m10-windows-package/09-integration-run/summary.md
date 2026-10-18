# Integration run 20261018-141751

Execution: **SIMULATED backends: comfyui, llm (script exercise, NOT hardware acceptance)** on vm (Unix 6.18.44.139); GPU: none detected; ComfyUI: 0.0.0-simulated on SIMULATED GPU (no hardware); LLM: sim-chat-model; commit 722a179602a1db558306d5d23b37c82ff3e91e7d.

| Step | Status | Detail | Evidence |
|---|---|---|---|
| health | passed | critical services up | health.json |
| comfyui | passed | existing ComfyUI at http://127.0.0.1:42441 (read-only probe) | comfyui-discovery.json |
| conformance | passed | bridge is VEC v1 conformant | conformance.log |
| llm | passed | persona_reply p50 10 ms, p95 35 ms, 314.3 tok/s | llm-bench-20261018-141757.json |
| api | passed | authenticated as 01a14f5f-fe20-7c55-a56b-925683386708 (platform admin: True) | api-smoke.json |
| engine | passed | engine ws-comfyui: health ok; sync ok | engine.json |
| generate | passed | job succeeded in 6 s, platform validation_scope=real_engine; 1 media asset(s); the ComfyUI behind the bridge is SIMULATED | generation.json |

Result: **PASSED** (7 step(s) ran, 0 failed, 0 skipped). Simulated backends were used: this is NOT acceptance evidence.
