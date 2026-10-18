import type { Db } from '../db/tx.js';
import { one } from '../db/tx.js';
import { auditCtx } from './audit.js';
import type { Ctx } from './context.js';
import { requirePermission } from './context.js';
import { type CreateInfluencerInput, type InfluencerRow, createInfluencer, getInfluencer } from './identity.js';

/**
 * Golden template replication: a validated influencer's CONFIGURATION is
 * copied to a new influencer so 20–30 personas share proven settings on the
 * same infrastructure. Nothing that belongs to a person or to the template's
 * identity is copied: no fans, conversations, memories, consents, payments,
 * entitlements, credentials, channels, content, persona, canon, references or
 * adapters. Policies that grant autonomy or define offers arrive as drafts
 * that need their normal approvals again.
 */
export const NEVER_COPIED = [
  'persona versions and canon facts (each influencer has its own identity)',
  'reference assets and adapters (identity material)',
  'integration accounts, bot tokens and channels (credentials and audiences)',
  'fans, consents, conversations, messages and memories',
  'orders, payments, subscriptions, entitlements and credits',
  'content items, revisions, media and publications',
] as const;

export async function cloneInfluencer(
  db: Db,
  ctx: Ctx,
  templateId: string,
  input: Omit<CreateInfluencerInput, 'runtime'>,
  defaults: { gpuQuotaSecondsPerDay: number },
): Promise<{ influencer: InfluencerRow; template_id: string; copied: Record<string, number>; not_copied: readonly string[] }> {
  requirePermission(ctx, 'influencer.create');
  requirePermission(ctx, 'influencer.update');
  await getInfluencer(db, ctx, templateId);
  const rt = await one<Record<string, unknown>>(db, 'SELECT * FROM identity.persona_runtime_config WHERE influencer_id = $1', [templateId]);
  const inf = await createInfluencer(db, ctx, input, defaults);
  // Runtime configuration (the new influencer starts paused until its own persona and channels are approved).
  await db.query(
    `UPDATE identity.persona_runtime_config SET
        content_tier = $2, gpu_quota_seconds_day = $3, free_replies_per_day = $4, premium_replies_per_day = $5, quiet_hours = $6,
        languages = $7, default_conversation_mode = $8, redisclosure_every_messages = $9,
        redisclosure_every_hours = $10, memory_enabled = $11, paused = true, updated_by = $12, updated_at = now()
      WHERE influencer_id = $1`,
    [
      inf.id,
      rt.content_tier,
      rt.gpu_quota_seconds_day,
      rt.free_replies_per_day,
      rt.premium_replies_per_day,
      JSON.stringify(rt.quiet_hours ?? {}),
      rt.languages,
      rt.default_conversation_mode,
      rt.redisclosure_every_messages,
      rt.redisclosure_every_hours,
      rt.memory_enabled,
      ctx.userId,
    ],
  );
  const copied: Record<string, number> = { runtime_config: 1 };
  const run = async (name: string, sql: string, params: unknown[]) => {
    copied[name] = (await db.query(sql, params)).rowCount ?? 0;
  };
  await run(
    'workflow_bindings',
    `INSERT INTO identity.workflow_bindings (workspace_id, influencer_id, purpose, workflow_key, version_range, default_parameters, priority_class, output_count, created_by)
     SELECT workspace_id, $2, purpose, workflow_key, version_range, default_parameters, priority_class, output_count, $3
       FROM identity.workflow_bindings WHERE influencer_id = $1 AND status = 'active'`,
    [templateId, inf.id, ctx.userId],
  );
  await run(
    'qa_thresholds',
    `INSERT INTO identity.qa_thresholds (workspace_id, influencer_id, check_key, min_score, max_score, required, on_fail, created_by)
     SELECT workspace_id, $2, check_key, min_score, max_score, required, on_fail, $3 FROM identity.qa_thresholds WHERE influencer_id = $1 AND status = 'active'`,
    [templateId, inf.id, ctx.userId],
  );
  await run(
    'content_policies_as_draft',
    `INSERT INTO identity.content_policies (workspace_id, influencer_id, version, status, max_rating, rules)
     SELECT workspace_id, $2, 1, 'draft', max_rating, rules FROM identity.content_policies WHERE influencer_id = $1 AND status = 'active'`,
    [templateId, inf.id],
  );
  await run(
    'business_objectives_as_draft',
    `INSERT INTO identity.business_objectives (workspace_id, influencer_id, period_start, period_end, metric, target_value, priority, notes, status, created_by)
     SELECT workspace_id, $2, period_start, period_end, metric, target_value, priority, notes, 'draft', $3
       FROM identity.business_objectives WHERE influencer_id = $1 AND status = 'active'`,
    [templateId, inf.id, ctx.userId],
  );
  await run(
    'autonomy_policies_as_draft',
    `INSERT INTO agents.autonomy_policies (workspace_id, influencer_id, action_type, agent_key, level, conditions, required_approver_role, required_approvals, status, created_by)
     SELECT workspace_id, $2, action_type, agent_key, level, conditions, required_approver_role, required_approvals, 'draft', $3
       FROM agents.autonomy_policies WHERE influencer_id = $1 AND status = 'active'`,
    [templateId, inf.id, ctx.userId],
  );
  // Offers without channel grants (credits, premium chat) are reusable; channel offers need the new influencer's own channels.
  await run(
    'products_as_draft',
    `INSERT INTO monetization.products (workspace_id, influencer_id, sku, version, kind, name, description, price_stars, billing_period_seconds, grants,
       min_age_status, content_rating, status, created_by)
     SELECT workspace_id, $2, sku, 1, kind, name, description, price_stars, billing_period_seconds, grants, min_age_status, content_rating, 'draft', $3
       FROM monetization.products WHERE influencer_id = $1 AND status = 'active' AND NOT (grants::text LIKE '%premium_channel_access%')`,
    [templateId, inf.id, ctx.userId],
  );
  await auditCtx(db, ctx, {
    influencerId: inf.id,
    action: 'influencer.clone_from_template',
    subjectType: 'influencer',
    subjectId: inf.id,
    metadata: { template_id: templateId, copied, never_copied: NEVER_COPIED },
  });
  return { influencer: inf, template_id: templateId, copied, not_copied: NEVER_COPIED };
}
