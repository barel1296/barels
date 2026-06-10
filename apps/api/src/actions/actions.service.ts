import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import type { AuthContext } from '../auth/auth.types';
import type { GuardrailResult, RejectionReasonCode } from '@gros/shared';

interface ActionRow {
  id: string;
  recommendation_id: string | null;
  kind: string;
  status: string;
  diff: Record<string, unknown>;
  diff_hash: string;
  payload: Record<string, unknown>;
  guardrail_eval: GuardrailResult[];
  expires_at: string | null;
  autonomy_level: number;
}

interface PolicyRules {
  requiredPermission?: string;
  maxMagnitudeUsd?: number | null;
  twoPersonAboveUsd?: number | null;
  expiryHours?: number;
}

/**
 * Approval workflow (docs/10 §10.1). Hard rules enforced here, in order:
 *  1. action must be awaiting_approval and unexpired
 *  2. the approver must echo the exact diff hash they saw (stale-render guard)
 *  3. approver must hold actions:approve:<kind>
 *  4. guardrail evaluation must be fully passing
 *  5. the relevant health domain must not be red
 *  6. policy magnitude rules (elevated role above threshold, two-person rule)
 * Approval NEVER executes anything at autonomy level 2 — there is no
 * execution adapter wired in this build, by design.
 */
@Injectable()
export class ActionsService {
  constructor(private readonly db: DbService) {}

  async list(auth: AuthContext, status?: string) {
    const conds = ['a.tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (status) {
      params.push(status);
      conds.push(`a.status = $${params.length}`);
    }
    return this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT a.id, a.kind, a.status, a.diff, a.diff_hash, a.target,
              a.guardrail_eval, a.rollback_plan, a.monitoring_plan,
              a.autonomy_level, a.expires_at, a.created_at,
              a.recommendation_id, a.session_id,
              r.title AS recommendation_title, r.confidence
         FROM actions a
         LEFT JOIN recommendations r ON r.id = a.recommendation_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.created_at DESC LIMIT 100`,
      params,
    );
  }

  async get(auth: AuthContext, id: string) {
    const row = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT a.*, r.title AS recommendation_title, r.summary AS recommendation_summary,
              r.confidence,
         (SELECT json_agg(json_build_object(
             'id', ap.id, 'decision', ap.decision, 'reasonCode', ap.reason_code,
             'note', ap.note, 'userId', ap.user_id, 'decidedAt', ap.decided_at)
             ORDER BY ap.decided_at)
            FROM approvals ap WHERE ap.action_id = a.id) AS approvals
         FROM actions a
         LEFT JOIN recommendations r ON r.id = a.recommendation_id
        WHERE a.id = $1 AND a.tenant_id = $2`,
      [id, auth.tenantId],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  async approve(
    auth: AuthContext,
    actionId: string,
    confirmDiffHash: string,
  ): Promise<{ status: string; note?: string }> {
    if (auth.kind !== 'user') {
      throw new ForbiddenException('Only humans approve actions at autonomy level 2');
    }
    return this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (c) => {
        const action = await this.loadForUpdate(c, actionId, auth.tenantId);

        // (1) state & expiry
        if (action.status !== 'awaiting_approval') {
          throw new ConflictException(`Action is ${action.status}, not awaiting approval`);
        }
        if (action.expires_at && new Date(action.expires_at) < new Date()) {
          await c.query(`UPDATE actions SET status = 'expired', updated_at = now() WHERE id = $1`, [actionId]);
          throw new ConflictException('Action expired; underlying evidence must be re-validated');
        }

        // (2) diff-hash echo — stale-render / approve-what-you-saw guarantee
        if (confirmDiffHash !== action.diff_hash) {
          throw new ConflictException(
            'Diff hash mismatch: the action changed since it was displayed. Reload and review again.',
          );
        }

        // (3) per-kind permission
        const requiredPerm = `actions:approve:${action.kind}`;
        if (!auth.permissions.has(requiredPerm)) {
          throw new ForbiddenException(`Missing permission: ${requiredPerm}`);
        }

        // (4) guardrails must all pass
        const failed = (action.guardrail_eval ?? []).filter((g) => !g.passed);
        if (failed.length > 0) {
          throw new ConflictException(
            `Guardrails failing: ${failed.map((g) => g.key).join(', ')}`,
          );
        }

        // (5) health gate re-check at approval time
        const domain = (action.payload['healthDomain'] as string) ?? 'spend';
        const health = await c.query<{ status: string }>(
          `SELECT status FROM health_status WHERE tenant_id = $1 AND domain = $2`,
          [auth.tenantId, domain],
        );
        if (health.rows[0]?.status === 'red') {
          throw new ConflictException(
            `Data health domain '${domain}' is red; approvals are blocked until resolved or overridden`,
          );
        }

        // (6) policy magnitude rules
        const policyRow = await c.query<{ rules: PolicyRules; autonomy_level: number }>(
          `SELECT rules, autonomy_level FROM approval_policies
            WHERE tenant_id = $1 AND action_kind = $2`,
          [auth.tenantId, action.kind],
        );
        const rules = policyRow.rows[0]?.rules ?? {};
        const magnitude = Number(action.payload['magnitudeUsd'] ?? 0);
        if (
          rules.maxMagnitudeUsd != null &&
          magnitude > rules.maxMagnitudeUsd &&
          !['owner', 'admin'].includes(auth.roleName)
        ) {
          throw new ForbiddenException(
            `Actions above $${rules.maxMagnitudeUsd} require an elevated role`,
          );
        }

        // Record the approval (append-only, with the echoed hash).
        await c.query(
          `INSERT INTO approvals (tenant_id, action_id, user_id, decision, via, policy_snapshot, diff_hash)
           VALUES ($1, $2, $3, 'approve', 'web', $4, $5)`,
          [auth.tenantId, actionId, auth.userId, JSON.stringify(rules), confirmDiffHash],
        );

        // Two-person rule: stay awaiting until a second distinct approver.
        if (rules.twoPersonAboveUsd != null && magnitude > rules.twoPersonAboveUsd) {
          const approvers = await c.query<{ n: string }>(
            `SELECT count(DISTINCT user_id) AS n FROM approvals
              WHERE action_id = $1 AND decision = 'approve'`,
            [actionId],
          );
          if (Number(approvers.rows[0]?.n ?? 0) < 2) {
            return {
              status: 'awaiting_approval',
              note: 'First approval recorded; a second approver is required by policy.',
            };
          }
        }

        await c.query(
          `UPDATE actions SET status = 'approved', updated_at = now() WHERE id = $1`,
          [actionId],
        );
        if (action.recommendation_id) {
          await c.query(
            `UPDATE recommendations SET status = 'approved', updated_at = now()
              WHERE id = $1 AND status = 'proposed'`,
            [action.recommendation_id],
          );
        }
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event, object_type, object_id, after_ref)
           VALUES ($1, 'user', $2, 'action.approved', 'action', $3, $4)`,
          [auth.tenantId, auth.userId, actionId,
           JSON.stringify({ diffHash: confirmDiffHash, kind: action.kind })],
        );

        // Autonomy level 2: approved actions are queued for humans/ops to
        // carry out with the prepared payload; no external execution path
        // exists in this build (docs/10 §10.6).
        return {
          status: 'approved',
          note: 'Execution is not enabled at autonomy level 2 — the prepared payload is ready for operator use.',
        };
      },
    );
  }

  async reject(
    auth: AuthContext,
    actionId: string,
    reasonCode: RejectionReasonCode,
    note?: string,
  ): Promise<void> {
    if (auth.kind !== 'user') throw new ForbiddenException('Only humans reject actions');
    await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (c) => {
        const action = await this.loadForUpdate(c, actionId, auth.tenantId);
        if (action.status !== 'awaiting_approval') {
          throw new ConflictException(`Action is ${action.status}, not awaiting approval`);
        }
        const requiredPerm = `actions:approve:${action.kind}`;
        if (!auth.permissions.has(requiredPerm)) {
          throw new ForbiddenException(`Missing permission: ${requiredPerm}`);
        }
        await c.query(
          `INSERT INTO approvals (tenant_id, action_id, user_id, decision, reason_code, note, via, diff_hash)
           VALUES ($1, $2, $3, 'reject', $4, $5, 'web', $6)`,
          [auth.tenantId, actionId, auth.userId, reasonCode, note ?? null, action.diff_hash],
        );
        await c.query(
          `UPDATE actions SET status = 'rejected', updated_at = now() WHERE id = $1`,
          [actionId],
        );
        if (action.recommendation_id) {
          const remaining = await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM actions
              WHERE recommendation_id = $1 AND status IN ('awaiting_approval', 'approved')`,
            [action.recommendation_id],
          );
          if (Number(remaining.rows[0]?.n ?? 0) === 0) {
            await c.query(
              `UPDATE recommendations SET status = 'rejected',
                      rejection = $2, updated_at = now()
                WHERE id = $1 AND status = 'proposed'`,
              [action.recommendation_id, JSON.stringify({ reasonCode, note, by: auth.userId })],
            );
          }
        }
        await c.query(
          `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, event, object_type, object_id, after_ref)
           VALUES ($1, 'user', $2, 'action.rejected', 'action', $3, $4)`,
          [auth.tenantId, auth.userId, actionId, JSON.stringify({ reasonCode, note })],
        );
      },
    );
  }

  private async loadForUpdate(
    c: PoolClient,
    actionId: string,
    tenantId: string,
  ): Promise<ActionRow> {
    const res = await c.query<ActionRow>(
      `SELECT id, recommendation_id, kind, status, diff, diff_hash, payload,
              guardrail_eval, expires_at, autonomy_level
         FROM actions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [actionId, tenantId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException('Action not found');
    return row;
  }
}
