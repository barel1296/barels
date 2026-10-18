import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne } from '../../db/tx.js';
import { ACTIONS, type Risk, riskCeiling } from './catalog.js';

/**
 * Policy Engine (docs/06 §4.3). Every proposal resolves to ALLOW (execute
 * now), REQUIRE_APPROVAL (an approval request bound to the exact payload) or
 * DENY, with the full evaluation trace stored on the proposal.
 */
export interface PolicyInput {
  workspaceId: string;
  influencerId: string;
  agentKey: string;
  actionType: string;
  risk: Risk;
  agentMaxLevel: number;
  agentAllowedActions: string[];
}

export interface PolicyResult {
  decision: 'allow' | 'require_approval' | 'deny';
  level: number;
  approverRole: string;
  requiredApprovals: number;
  trace: { rule: string; value: unknown; outcome: string }[];
}

async function killSwitch(db: Db | pg.Pool, workspaceId: string, influencerId: string): Promise<string | null> {
  const flag = await maybeOne<{ key: string }>(
    db,
    `SELECT key FROM core.feature_flags WHERE key = 'kill_switch.autonomy' AND value = 'true'::jsonb
        AND (workspace_id IS NULL OR workspace_id = $1) AND (influencer_id IS NULL OR influencer_id = $2) LIMIT 1`,
    [workspaceId, influencerId],
  );
  if (flag) return 'kill_switch.autonomy';
  const inf = await maybeOne<{ autonomy_paused: boolean }>(db, 'SELECT autonomy_paused FROM identity.influencers WHERE id = $1', [influencerId]);
  return inf?.autonomy_paused ? 'influencer.autonomy_paused' : null;
}

export async function resolvePolicy(db: Db | pg.Pool, p: PolicyInput): Promise<PolicyResult> {
  const trace: PolicyResult['trace'] = [];
  const spec = ACTIONS[p.actionType];
  const deny = (rule: string, value: unknown): PolicyResult => {
    trace.push({ rule, value, outcome: 'deny' });
    return { decision: 'deny', level: 0, approverRole: spec?.approverRole ?? 'admin', requiredApprovals: 1, trace };
  };
  if (!spec) return deny('action_known', p.actionType);
  if (!p.agentAllowedActions.includes(p.actionType)) return deny('agent_allowed_action', p.actionType);
  trace.push({ rule: 'agent_allowed_action', value: p.actionType, outcome: 'pass' });
  if (spec.alwaysAllowed) {
    trace.push({ rule: 'safety_action_always_allowed', value: p.actionType, outcome: 'allow' });
    return { decision: 'allow', level: 4, approverRole: spec.approverRole, requiredApprovals: 1, trace };
  }
  const ks = await killSwitch(db, p.workspaceId, p.influencerId);
  if (ks) return deny('kill_switch', ks);
  trace.push({ rule: 'kill_switch', value: null, outcome: 'pass' });

  // Most specific active policy wins: influencer+agent > influencer > workspace+agent > workspace.
  const policy = await maybeOne<{ id: string; level: number; conditions: { max_per_day?: number }; required_approver_role: string | null; required_approvals: number }>(
    db,
    `SELECT id, level, conditions, required_approver_role, required_approvals FROM agents.autonomy_policies
      WHERE workspace_id = $1 AND status = 'active' AND action_type = $2
        AND (influencer_id IS NULL OR influencer_id = $3) AND (agent_key IS NULL OR agent_key = $4)
        AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY (influencer_id IS NOT NULL) DESC, (agent_key IS NOT NULL) DESC LIMIT 1`,
    [p.workspaceId, p.actionType, p.influencerId, p.agentKey],
  );
  const policyLevel = policy?.level ?? spec.defaultLevel;
  trace.push({ rule: 'autonomy_policy', value: policy ? { id: policy.id, level: policy.level } : { default_level: spec.defaultLevel }, outcome: String(policyLevel) });
  let level = Math.min(p.agentMaxLevel, policyLevel, spec.maxLevel, riskCeiling(p.risk));
  trace.push({ rule: 'level_min(agent_max, policy, action_max, risk_ceiling)', value: { agent_max: p.agentMaxLevel, policy: policyLevel, action_max: spec.maxLevel, risk: p.risk }, outcome: String(level) });
  const cap = policy?.conditions?.max_per_day;
  if (level >= 3 && typeof cap === 'number') {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agents.action_proposals WHERE influencer_id = $1 AND action_type = $2 AND status = 'executed'
          AND resolved_level >= 3 AND executed_at > date_trunc('day', now())`,
      [p.influencerId, p.actionType],
    );
    if ((rows[0]?.n ?? 0) >= cap) {
      level = 2;
      trace.push({ rule: 'condition.max_per_day', value: { cap, executed_today: rows[0]?.n }, outcome: 'fallback_to_approval' });
    }
  }
  const approverRole = policy?.required_approver_role ?? spec.approverRole;
  const requiredApprovals = policy?.required_approvals ?? 1;
  if (level >= 3) {
    trace.push({ rule: 'resolution', value: level, outcome: 'allow' });
    return { decision: 'allow', level, approverRole, requiredApprovals, trace };
  }
  if (level === 2) {
    trace.push({ rule: 'resolution', value: level, outcome: 'require_approval' });
    return { decision: 'require_approval', level, approverRole, requiredApprovals, trace };
  }
  return deny('resolution', `L${level}: recommendation only`);
}
