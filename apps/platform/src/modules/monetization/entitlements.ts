import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { uuidv7 } from '../../lib/ids.js';
import { outbox } from '../audit.js';

/**
 * Entitlement engine (docs/08 §3): the single source of truth for "who may
 * access what". Grants are idempotent per (source, resource, period); every
 * change emits an outbox event that enforcement adapters consume.
 */
export type EntitlementKind = 'premium_channel_access' | 'bot_premium_tier' | 'media_unlock' | 'custom_request';

export async function hasEntitlement(db: Db | pg.Pool, fanId: string, kind: EntitlementKind, resourceId: string, at = new Date()): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM monetization.entitlements
      WHERE fan_id = $1 AND kind = $2 AND resource_id = $3 AND status = 'active'
        AND valid_from <= $4 AND (valid_until IS NULL OR valid_until > $4) LIMIT 1`,
    [fanId, kind, resourceId, at],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface GrantInput {
  workspaceId: string;
  influencerId: string;
  fanId: string;
  kind: EntitlementKind;
  resourceType: 'channel' | 'content_item' | 'tier';
  resourceId: string;
  sourceType: 'subscription' | 'order' | 'grant' | 'promo' | 'compensation';
  sourceId: string;
  validFrom: Date;
  validUntil: Date | null;
  grantedBy: { type: 'system' | 'user'; id: string };
}

/** Idempotent grant: an identical active grant for the same source and period is not duplicated. */
export async function grantEntitlement(db: Db | pg.Pool, g: GrantInput): Promise<{ id: string; created: boolean }> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM monetization.entitlements
      WHERE fan_id = $1 AND kind = $2 AND resource_id = $3 AND source_id = $4 AND status = 'active'
        AND valid_from = $5 AND valid_until IS NOT DISTINCT FROM $6`,
    [g.fanId, g.kind, g.resourceId, g.sourceId, g.validFrom, g.validUntil],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  const id = uuidv7();
  await db.query(
    `INSERT INTO monetization.entitlements (id, workspace_id, influencer_id, fan_id, kind, resource_type, resource_id, source_type, source_id,
       valid_from, valid_until, granted_by_type, granted_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, g.workspaceId, g.influencerId, g.fanId, g.kind, g.resourceType, g.resourceId, g.sourceType, g.sourceId, g.validFrom, g.validUntil, g.grantedBy.type, g.grantedBy.id],
  );
  await outbox(db as Db, {
    workspaceId: g.workspaceId,
    eventType: 'monetization.entitlement_granted',
    aggregateType: 'entitlement',
    aggregateId: id,
    payload: { fan_id: g.fanId, influencer_id: g.influencerId, kind: g.kind, resource_id: g.resourceId, valid_until: g.validUntil?.toISOString() ?? null },
  });
  return { id, created: true };
}

export async function revokeEntitlements(
  db: Db | pg.Pool,
  where: { sourceId?: string; fanId?: string; ids?: string[] },
  reason: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string; workspace_id: string; fan_id: string; influencer_id: string; kind: string; resource_id: string }>(
    `UPDATE monetization.entitlements SET status = 'revoked', revoked_at = now(), revoke_reason = $4
      WHERE status = 'active' AND ($1::uuid IS NULL OR source_id = $1) AND ($2::uuid IS NULL OR fan_id = $2) AND ($3::uuid[] IS NULL OR id = ANY($3))
      RETURNING id, workspace_id, fan_id, influencer_id, kind, resource_id`,
    [where.sourceId ?? null, where.fanId ?? null, where.ids ?? null, reason],
  );
  for (const r of rows) {
    await outbox(db as Db, {
      workspaceId: r.workspace_id,
      eventType: 'monetization.entitlement_revoked',
      aggregateType: 'entitlement',
      aggregateId: r.id,
      payload: { fan_id: r.fan_id, influencer_id: r.influencer_id, kind: r.kind, resource_id: r.resource_id, reason },
    });
  }
  return rows.map((r) => r.id);
}

/** Sweeper (every 5 minutes): active entitlements past valid_until become expired. */
export async function sweepExpiredEntitlements(db: Db | pg.Pool): Promise<number> {
  const { rows } = await db.query<{ id: string; workspace_id: string; fan_id: string; influencer_id: string; kind: string; resource_id: string }>(
    `UPDATE monetization.entitlements SET status = 'expired'
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until <= now()
      RETURNING id, workspace_id, fan_id, influencer_id, kind, resource_id`,
  );
  for (const r of rows) {
    // Another active entitlement for the same access (e.g. a renewal) means access continues.
    await outbox(db as Db, {
      workspaceId: r.workspace_id,
      eventType: 'monetization.entitlement_expired',
      aggregateType: 'entitlement',
      aggregateId: r.id,
      payload: { fan_id: r.fan_id, influencer_id: r.influencer_id, kind: r.kind, resource_id: r.resource_id },
    });
  }
  return rows.length;
}
