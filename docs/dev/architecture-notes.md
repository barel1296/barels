# Implementation Architecture Notes

What was built, where it lives, and every deliberate deviation from the
founding spec (docs/01–15) with its justification.

## Map

| Concern | Location |
|---|---|
| Shared contracts (protocol, actions, permissions, evidence binding, canonical JSON) | `packages/shared/src` |
| API (auth, RBAC, RLS context, audit, semantic metrics, ingestion, sessions, recommendations, approvals, costs, dashboard) | `apps/api/src` |
| Postgres schema (6 forward-only migrations, RLS FORCEd, append-only triggers, DB-level evidence rule) | `apps/api/migrations` |
| ClickHouse schema | `infra/clickhouse/schema` |
| Orchestrator state machine + repos | `workers/py/gros_workers/orchestrator` |
| Protocol validator (evidence rule, falsification, raw-number guard) | `workers/py/gros_workers/protocol.py` |
| Five super-agents + prompt packs | `workers/py/gros_workers/agents` |
| LLM gateway (tiering, failover, budgets, transcripts, injection fencing) | `workers/py/gros_workers/llm` |
| Tools + evidence pipeline | `workers/py/gros_workers/tools.py`, `evidence.py` |
| Detection (z-score, CUSUM, fatigue fit) | `workers/py/gros_workers/detection` |
| Confidence rubric, impact estimators, guardrails, publish gate | `workers/py/gros_workers/recommend` |
| Golden-incident harness + 4 incidents | `workers/py/gros_workers/evals` |
| Web app (Command Center, War Room, Approvals, Health, Creative, Audit, Settings) | `apps/web/src` |
| Dev seed (PG entities + synthetic CH + demo session) | `apps/api/src/db/seed.ts`, `workers/py/gros_workers/seed` |

## The enforcement stack (anti-hallucination, in depth order)

1. **Agents physically can't fetch data outside tools** — tool registry with
   per-agent allowlists; every tool result becomes a frozen evidence artifact.
2. **Protocol validator (Python)** rejects: claims without resolvable evidence
   ids, hypotheses without falsification, challenges without a reply target,
   and any claim asserting raw numeric literals (`$x`, `x%`, decimals) outside
   `{ev:<id>:<path>}` binding tokens.
3. **Database trigger** (`enforce_evidence_rule`) re-checks evidence
   references on every `agent_messages` insert — even a buggy writer path
   cannot persist an unbacked finding. Verified live.
4. **UI renderer** substitutes numbers from evidence digests; an unresolvable
   token renders as an explicit `[unverified value]` chip. A number that
   bypasses the evidence layer is structurally unrenderable.
5. **Golden harness** runs a fabrication incident on every test run;
   `fabrications_published == 0` is release-blocking.

## Approval safety (verified end-to-end over HTTP)

Order of checks in `ActionsService.approve`: state/expiry → **diff-hash echo**
(client must echo the hash of the diff it rendered; mismatch = 409) → per-kind
permission → all guardrails passing → health-domain re-check → policy
magnitude rules (elevated role above cap, two-person rule). Approval at L2
never executes anything — there is no execution adapter in the codebase, and
the approve response says so explicitly.

## Deliberate deviations from the founding spec

| Spec said | Built | Why |
|---|---|---|
| BullMQ/Redis queues | Postgres job queue (`FOR UPDATE SKIP LOCKED`) + outbox table | One fewer moving part; jobs are transactional with the rows they produce; Redis stays in compose for caching/future BullMQ. Revisit at volume. |
| argon2id password hashing | argon2id (@node-rs/argon2, OWASP params); legacy bcrypt hashes verify and upgrade transparently on login | Implemented in the hardening pass; bcryptjs retained only for legacy verification. |
| `metric_definitions.formula_sql` raw SQL templates | Structured `formula` JSONB (`{table,timeCol,valueExpr}`) | Safe composition: value expressions live only in reviewed migrations; runtime only binds parameters against allowlisted dimensions. |
| S3/MinIO artifact store | FS store by default; S3-compatible store selected by `ARTIFACT_S3_BUCKET` (boto3 via the `s3` extra) | Same `ArtifactStoreProtocol`; FS remains the zero-dependency dev default. |
| SSE via `/v1/stream` per tenant | Per-session SSE + 2.5s polling fallback in the UI | Simpler first cut; LISTEN/NOTIFY upgrade path noted in code. |
| One in-flight action per entity | Per entity **and kind** | A recommendation legitimately pairs budget_change + creative_rotation on one campaign (found in live testing). |
| Anthropic/OpenAI SDKs | httpx REST adapters | No SDK version churn; ~80 lines each; identical failover semantics. |
| Temporal "maybe later" | Not introduced | Per spec Part 4 §4.7 — resumable PG state machine covers Phases 0–5. |

## Findings from live verification (sandbox Postgres 16)

- **Superuser bypasses RLS** — hence the `gros_app` non-superuser role
  (`infra/postgres/init/01-app-role.sh`, migration 006 grants). The dev
  compose's `POSTGRES_USER` must never be the app's connection.
- **Login-time tenant visibility**: the `tenants` RLS policy needed a
  membership-based clause because login resolves memberships→tenants before
  any tenant context exists.
- **psycopg returns `uuid.UUID` objects** — normalized to strings at the repo
  boundary.
- **Thread seq must be session-relative** for agent references; the global
  identity column orders, `row_number()` numbers.
- Append-only triggers and the DB evidence rule both fire as designed
  (verified with direct SQL as the app role).
