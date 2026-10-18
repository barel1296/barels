# Evidence: full automated test run (2026-10-18)

`test-report.txt` is the unedited output of `npm test` in `apps/platform`.

**Result:** 216 tests in 50 suites, 216 passed, 0 failed, 0 skipped.

**Environment:**

- Linux cloud container, without a GPU;
- Node.js 22.22.0;
- PostgreSQL 16.15, with a throwaway database per test file and the roles from `db/bootstrap.sql`;
- Chromium (Playwright `playwright-core` 1.56.1) for the dashboard.

| Suite group | Real | Simulated (labelled in the suite names) |
|---|---|---|
| Unit (13 files) | Pure functions: crypto, TOTP, canonical JSON, hashing, semver, scheduler policy, state machine, QA decisions, guards, prompt builder, invoice payloads, captions, media, nvidia-smi parsing, configuration | — |
| Integration (2 files) | PostgreSQL 16: RLS, roles, triggers, four-eyes rules, append-only audit, audit seals, outbox, job queue, sessions | — |
| E2E (11 files) | API + worker + PostgreSQL in-process; the dashboard in real Chromium | LLM, Telegram Bot API (including Stars), Instagram Graph API, ComfyUI (behind the real bridge), and the contract-mock visual engine |

None of these runs touched a real ComfyUI, a real model, Telegram, Meta or the workstation. Real-hardware acceptance is [`deploy/windows/ACCEPTANCE-TESTS.md`](../../../deploy/windows/ACCEPTANCE-TESTS.md).
