# Phase 1 vertical slice: test evidence

> **Validation scope: CONTRACT-TESTED.** All of this was produced against the **Visual Engine Contract test adapter** (`engine_kind = contract_mock`). It proves the platform workflow, the contract integration and the governance controls. It proves **nothing** about:
>
> - real ComfyUI generation;
> - image quality or identity consistency (Track A);
> - GPU behaviour;
> - performance on the workstation.
>
> Under the project rules, none of it counts as a production acceptance test.

## Environment that produced it

The evidence was produced in a cloud container, **not on the workstation**.

| Item | Value |
|---|---|
| Date | 2026-10-18 |
| Host | Linux 6.18 x86_64 (cloud container): no GPU, 15.7 GB RAM visible |
| Node.js | v22.22.0 |
| PostgreSQL | 16.15, local throwaway cluster |
| Database roles | `aios_migrator`, `aios_app` (NOBYPASSRLS), `aios_worker`, created by `db/bootstrap.sql` |
| Schema | `db/migrations/0001_baseline.sql` + `0002_visual_engine_contract.sql` |
| Visual engine | `apps/platform/src/mock-engine` (contract test adapter, in-process) |
| Base commit | `86b4a71` plus the working tree that was committed with this folder |

## Files

| File | What it shows |
|---|---|
| `test-report.txt` | Spec output of the full suite: **106 tests, 106 passed, 0 failed** (unit 59, integration 18, e2e 29). |
| `test-report.junit.xml` | The same run in JUnit format. |
| `vertical-slice-lineage.json` | `GET /v1/content-items/{id}/lineage` at the end of the vertical-slice test: one influencer from configuration to scheduled publication. |
| `conformance-contract-mock.txt` / `.json` | Conformance runner C01–C16 against the contract mock over HTTP: 16/16. This validates the fixtures and the runner only. |

## Repeatability

- The committed build produced this evidence run: 106/106 passed.
- The preceding build ran five times, 105/105 each time (an initial run, three back-to-back repeats and one evidence run). It lacked only the idempotency-race fix and its test.
- No test was retried or skipped.
- CI (`.github/workflows/ci.yml`) runs the same suites against a `postgres:16` service container.

## What the vertical slice demonstrates

The lineage file contains each step's record:

1. **Influencer created and configured.** Status `draft`, then `active`. Runtime config holds a GPU quota and quiet hours.
2. **Independent persona identity.**
   - Persona version v1 was authored by the content manager and approved by the compliance officer; self-approval was refused.
   - The owner activated it.
   - One approved reference image (sha256-pinned, fetched by the engine through a signed URL).
   - One approved adapter with an opaque `engine_ref`.
3. **Workflow contract registered.**
   - Engine registered: GET /engine is schema-validated and the token is envelope-encrypted.
   - Workflows synced; `manifest_sha256` verified.
   - `mock.persona_portrait@1.0.0` approved by a platform admin.
   - Per-influencer binding `feed_photo → ^1.0`.
   - QA threshold `mock.identity_similarity ≥ 0.8`.
4. **Generation job submitted** through the contract: idempotent creation, parameters validated against the manifest, persona refs and adapter pinned.
5. **Status tracked and a failure handled.**
   - Attempt 1 failed with injected `RESOURCE_EXHAUSTED`.
   - A retry was scheduled with attempt 2.
   - Attempt 2 succeeded.
   - Events: `created → dispatching → submitted → retry_scheduled → dispatching → submitted → engine_succeeded → output_verified ×2 → succeeded`.
6. **Asset metadata received and stored.**
   - 2 PNG outputs downloaded; sha256, size, MIME and dimensions verified.
   - Stored in the content-addressed media store.
   - Provenance records: persona version, references, adapter, workflow and manifest hash, engine kind, IPTC digital source type.
   - Validation results: technical, engine QA (advisory) and platform threshold.
7. **Reviewed.**
   - Revision 1 was **rejected** with a reason.
   - Revision 2 was **approved**. The decision is bound to the payload hash; a stale hash was refused (409) and the preparer had no approval right (403).
8. **Scheduled for publication** on an Instagram channel.
   - Authorization is bound to the approved content hash, enforced by a DB trigger.
   - `execution.will_execute = false`, `blocked_reason = MOCK_ASSET_NOT_PUBLISHABLE`: contract-mock output can never leave the platform.
9. **Full action history.** The visual job event log (10 events), validation results, approvals with decisions and comments, the publication with its channel and account, GPU-seconds attributed, and 12 audit-log entries for the item's subjects. The influencer's own audit trail is asserted separately in the test.

## What is NOT evidenced here (open items)

See `docs/16-implementation-status.md` §4 for the blocker list. In short:

- no real ComfyUI engine (Track A);
- no workstation hardware verification;
- no Instagram or Telegram adapters;
- no local LLM;
- no OIDC login;
- no admin UI.
