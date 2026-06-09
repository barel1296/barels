# Part 10 — Execution Layer

The execution layer is built **as if autonomy were already on**, then gated by policy. V1 ships the full pipeline with the gate locked at Level 2 (approval required for everything) and read-only platform credentials as a structural backstop. This is what makes "prepared actions" real rather than mockups: every action shown to a user has already been validated against the live platform.

## 10.1 Action lifecycle

```
draft ──(validate + dry_run pass)──▶ awaiting_approval ──(human approves; diff-hash echo)──▶ approved
  │                                        │ reject/expire                                      │
  ▼                                        ▼                                                    ▼ (outbox → execution job)
invalid (back to Operations Agent)   rejected / expired                                   executing
                                                                                              │
                              rolled_back ◀──(auto-revert / manual)── verify_failed ◀──┐      ▼
                                                                                       └─ executed ──▶ verified ──▶ monitoring ──▶ closed
```

Hard rules: an action cannot enter `awaiting_approval` without a passing dry-run and guardrail evaluation; cannot execute without an approval row (L2) or a policy authorization record (L3+); cannot execute if its evidence has drifted beyond tolerance or its TTL passed (re-validation required); cannot execute while the relevant health domain is red.

## 10.2 ExecutionAdapter contract (per platform)

```python
class ExecutionAdapter(Protocol):
    def capabilities(self) -> PlatformCapabilities      # entity types, limits, rate rules, learning-phase semantics
    def validate(self, action: Action) -> ValidationResult   # local schema + platform-rule checks
    def dry_run(self, action: Action) -> DryRunResult        # platform-side validation where API supports it;
                                                             # else read-current-state + simulate diff
    def execute(self, action: Action, idem_key: str) -> ExecutionResult
    def verify(self, action: Action) -> VerificationResult   # read back, compare to intended state
    def rollback(self, action: Action) -> ExecutionResult    # apply stored inverse
```

Adapters v1 (validate/dry-run only): Meta Marketing API, Google Ads, AppsFlyer (audiences), TikTok. Execute/verify/rollback implemented and integration-tested against sandbox accounts in Phase 6, enabled per tenant per kind by policy.

**Idempotency:** every external mutation carries our idempotency key; where the platform lacks native support, the adapter performs read-modify-write with a pre-execution state check (abort if current state ≠ expected `before`, i.e., someone changed it in Ads Manager since approval — this **drift check** prevents the worst class of execution accidents).

## 10.3 Guardrail engine

Evaluated at draft, at approval, and again at execution (TOCTOU-safe). Policies are per-tenant data:

| Guardrail | Example default |
|---|---|
| Max budget change per entity per day | ±25% |
| Max absolute budget change without elevated approval | $5,000/day |
| Blast radius: % of tenant daily spend affected by one action / by all actions per day | 10% / 20% |
| Change frequency per entity | 1 budget change / 24h (learning-phase respect) |
| Entity locks | `managed_state = locked` ⇒ untouchable |
| Data-health gate | no execution while scope domain is red |
| Spend floor protection | never reduce a campaign below platform minimums / kill delivery accidentally |
| Action conflict | no two in-flight actions on the same entity |
| Time windows | optional "no executions outside business hours" per tenant |

A guardrail failure at any stage demotes the action to `draft` with the failure attached; agents may re-propose within bounds.

## 10.4 Per-kind preparation specs

**Budget changes** — diff (`current → target`, absolute + %), ramp schedule if |Δ| > ramp threshold (e.g., +60% requested ⇒ 3 × +20%/day steps, each its own verifiable execution), learning-phase impact note, monitoring plan (CPI/ROAS thresholds → auto-revert proposal), inverse stored (`rollback = restore $1,200`).

**Campaign pause/resume** — pre-pause snapshot of delivery settings; downstream effects listed (scheduled budget shifts referencing it are flagged); resume plan optional.

**Campaign creation** — full structure document (campaign → ad sets/asset groups → ads), naming per tenant convention template, budgets, targeting, attached creatives (asset IDs verified present), bid strategy, platform pre-validation via dry-run; created **paused** always — going live is a separate explicit step (even at L4).

**Audience sync** — segment definition (semantic-layer query), estimated size, hash/PII handling statement (only platform-permitted identifiers, hashed per platform spec), destination(s), refresh schedule, deletion mirror (sync removal when users leave segment), consent/legal-basis flag check.

**Creative upload/rotation** — assets (S3 refs, platform spec validation: duration, ratio, size), placement mapping, rotation plan (which ads pause as variants ramp), brand-safety checklist flag (human creative approval is ALWAYS required for new assets, every autonomy level — creative is reputational, not just financial).

**ASO changes** — store listing diff (screenshots order, icon, text), prepared as a checklist + asset bundle for manual store submission in v1 (store APIs are limited); experiment design attached (which metric proves it).

**CRM actions** — segment + journey diff (entry conditions, messages, schedule), holdout group design (default 10%) so impact is measurable, message content marked as draft requiring lifecycle-owner approval.

## 10.5 Post-execution: verify, monitor, revert

- **Verify**: read-back within minutes; mismatch ⇒ `verify_failed`, alert, and (policy) auto-rollback.
- **Monitoring plan armed**: each action's watch metrics get temporary high-frequency detection; threshold breach (e.g., "CPI +35% within 48h of budget increase") raises an **auto-revert proposal** — at L2 this is a one-click approval; at L4 it self-executes and notifies.
- **Outcome record** at horizon: realized impact vs. predicted, written to the recommendation and the calibration loop.

## 10.6 The autonomy ladder (how L2 becomes L4 safely)

Autonomy is **per tenant × per action kind × magnitude band**, stored in `approval_policies`:

| Level | Behavior | Unlock criteria (per kind, suggested) |
|---|---|---|
| L0 | Observe only — no action drafts | default for unsupported kinds |
| L1 | Recommend (no executable payload) | — |
| **L2** | **Prepare + approve (v1 default)** | — |
| L3 | Auto-execute small-magnitude within guardrails; notify + 4h undo window; approval for the rest | ≥ 90% approval-without-edit over trailing 30 actions of this kind AND calibration error < 10% AND tenant opt-in |
| L4 | Auto-execute within guardrails; approvals only for threshold breaches; daily digest + weekly human review ritual | sustained L3 track record, two-person policy sign-off, insurance/contractual review |

The system itself presents the unlock case ("budget_change has run 47 actions, 94% approved unmodified, realized impact within predicted range 89% — eligible for L3 up to $2K/day"). The human turns the dial; the audit log records it. **No level removes**: creative-asset approval, guardrails, audit, drift checks, auto-revert arming, or the kill switch (`pause all agent activity` — one button, always visible, instant).
