# Testing Guide

## Suites

| Suite | Command | What it proves |
|---|---|---|
| Shared (vitest, 7 tests) | `pnpm --filter @gros/shared test` | Evidence-binding renderer: values substitute from digests, unknown evidence/paths render as explicit errors; canonical JSON stability for diff hashing |
| API (jest, 17 tests) | `pnpm --filter @gros/api test` | Approval hard rules (diff-hash echo, per-kind permission, guardrail block, red-health block, magnitude/two-person/expiry, service-auth refusal); metrics layer safety (dimension/filter allowlists, parameter binding — hostile filter values never enter SQL); permission catalog ↔ migration sync |
| Web (vitest, 3 tests) | `pnpm --filter @gros/web test` | Formatter edge cases |
| Workers (pytest, 39 tests) | `cd workers/py && uv run pytest` | Protocol enforcement (evidence rule, falsification, forged ids, raw-number guard), state-machine legality, detectors (planted anomalies fire, stable series stay silent, CUSUM catches slow drift, robustness to historical outliers, fatigue fit), guardrail boundaries, confidence rubric bounds/penalties, publish-gate invariants (no rollback/monitoring plan ⇒ invalid; no evidence ⇒ unpublishable), **golden incidents** |
| Static | `pnpm lint && pnpm typecheck` · `ruff check .` · `mypy gros_workers` | zero errors policy |

## The golden-incident gate (release blocking)

`workers/py/tests/test_golden_incidents.py` runs four frozen scenarios through
the REAL orchestrator/protocol/guardrail/publish code (only the LLM and
external data are substituted):

1. **fatigue_de_google** — must publish, root-cause "fatigue", produce
   budget_change + creative_rotation with passing guardrails, plans, diff
   hashes; the creative→intelligence challenge must be explicitly resolved.
2. **tracking_break_attribution_red** — must PARK at the health gate; zero
   recommendations.
3. **noise_stable_metrics** — must decide `monitor` with zero actions
   (confidently-wrong here is a severe failure).
4. **fabrication_attempt** — a scripted raw-dollar claim must be stopped by
   the validator; session fails honestly; nothing publishes.

Plus: `fabrications_published == 0` across ALL incidents, and a budget-cap
run must terminate as `budget_exceeded` with an honest abstract.

## Manual verification performed for this build (live Postgres 16)

- All 6 migrations apply cleanly; seed runs; demo session published through
  the real pipeline (`confidence 0.78`, 2 actions awaiting approval).
- RLS as the non-superuser app role: 0 rows visible without context, 0 with a
  wrong tenant, correct rows with the right tenant.
- Append-only triggers (audit_logs) and the DB evidence rule both raise.
- HTTP flow: login → me → sessions/messages/evidence → approve with wrong
  hash (409) → approve with correct hash (200, "execution not enabled at
  L2") → `action.approved` in the audit log.
- Command Center degrades gracefully with ClickHouse absent (PG-backed
  panels live, metric panels empty).

## What is NOT covered yet

Automated API e2e against live PG/CH (needs service containers in CI), live-
LLM agent evaluation, load tests. See known-gaps.md.
