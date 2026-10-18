# Visual Engine Contract — changelog

## 1.0 (draft, 2026-10-18)

- Initial contract:
  - engine info and capabilities;
  - workflow discovery with immutable manifests and SemVer;
  - typed parameters via per-workflow JSON Schema;
  - persona identity, reference assets and adapter references;
  - asynchronous jobs, idempotent on `request_id` + `attempt`;
  - progress, cancellation and timeouts;
  - output download with sha256 verification and provenance;
  - advisory engine-side QA;
  - error codes with failure classes;
  - GPU coordination (priority classes P2–P5, `max_concurrent_jobs`, measured resource figures, resource release);
  - optional HMAC-signed callbacks.
- Normative conformance workflow `__conformance__.solid_color@1.0.0` and conformance scenarios C01–C16.
