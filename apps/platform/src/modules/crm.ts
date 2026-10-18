import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { maybeOne, one } from '../db/tx.js';
import { uuidv7 } from '../lib/ids.js';
import { audit } from './audit.js';
import type { Actor } from './context.js';

/**
 * Fans, cross-platform identities and the consent ledger (docs/05, docs/08 §4.1).
 * Fan data is strictly per workspace and per influencer relationship; nothing
 * here is ever copied when a new influencer is created.
 */
export type ConsentPurpose = 'terms_acceptance' | 'ai_processing' | 'memory_personalization' | 'marketing_messages' | 'age_attestation_18' | 'mature_content_optin';

export interface FanRow {
  id: string;
  workspace_id: string;
  display_name: string | null;
  primary_language: string | null;
  age_status: string;
  status: 'active' | 'restricted' | 'blocked' | 'erased';
  risk_flags: string[];
}

/** Finds or creates the fan for a Telegram user, and the fan↔influencer profile. */
export async function upsertTelegramFan(
  db: Db | pg.Pool,
  workspaceId: string,
  influencerId: string,
  user: { id: number; first_name?: string; username?: string; language_code?: string },
): Promise<{ fan: FanRow; created: boolean }> {
  const identity = await maybeOne<{ fan_id: string }>(
    db,
    `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'telegram' AND scope_ref = 'global' AND platform_user_id = $2`,
    [workspaceId, String(user.id)],
  );
  let created = false;
  let fanId = identity?.fan_id;
  if (!fanId) {
    fanId = uuidv7();
    await db.query(`INSERT INTO crm.fans (id, workspace_id, display_name, primary_language, last_seen_at) VALUES ($1, $2, $3, $4, now())`, [
      fanId,
      workspaceId,
      user.first_name?.slice(0, 80) ?? null,
      user.language_code ?? null,
    ]);
    const inserted = await db.query(
      `INSERT INTO crm.fan_identities (workspace_id, fan_id, platform, scope_ref, platform_user_id, username, linked_via)
       VALUES ($1, $2, 'telegram', 'global', $3, $4, 'first_contact')
       ON CONFLICT (workspace_id, platform, scope_ref, platform_user_id) DO NOTHING`,
      [workspaceId, fanId, String(user.id), user.username ?? null],
    );
    if (!inserted.rowCount) {
      // Concurrent first contact: the other insert won.
      const winner = await one<{ fan_id: string }>(
        db,
        `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'telegram' AND scope_ref = 'global' AND platform_user_id = $2`,
        [workspaceId, String(user.id)],
      );
      fanId = winner.fan_id;
    } else {
      created = true;
    }
  } else {
    await db.query(`UPDATE crm.fan_identities SET last_seen_at = now(), username = coalesce($3, username) WHERE fan_id = $1 AND platform_user_id = $2`, [
      fanId,
      String(user.id),
      user.username ?? null,
    ]);
    await db.query(`UPDATE crm.fans SET last_seen_at = now() WHERE id = $1`, [fanId]);
  }
  await db.query(
    `INSERT INTO crm.fan_influencer_profiles (workspace_id, fan_id, influencer_id, last_interaction_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (fan_id, influencer_id) DO UPDATE SET last_interaction_at = now()`,
    [workspaceId, fanId, influencerId],
  );
  const fan = await one<FanRow>(db, 'SELECT id, workspace_id, display_name, primary_language, age_status, status, risk_flags FROM crm.fans WHERE id = $1', [fanId]);
  return { fan, created };
}

export async function telegramUserIdOf(db: Db | pg.Pool, fanId: string): Promise<number | null> {
  const r = await maybeOne<{ platform_user_id: string }>(
    db,
    `SELECT platform_user_id FROM crm.fan_identities WHERE fan_id = $1 AND platform = 'telegram' ORDER BY first_seen_at LIMIT 1`,
    [fanId],
  );
  return r ? Number(r.platform_user_id) : null;
}

export async function activeConsent(db: Db | pg.Pool, fanId: string, influencerId: string | null, purpose: ConsentPurpose): Promise<{ id: string } | null> {
  return maybeOne(
    db,
    `SELECT id FROM crm.consents WHERE fan_id = $1 AND influencer_id IS NOT DISTINCT FROM $2 AND purpose = $3 AND status = 'granted'`,
    [fanId, influencerId, purpose],
  );
}

/** Records consent (idempotent while granted). */
export async function grantConsent(
  db: Db | pg.Pool,
  c: {
    workspaceId: string;
    fanId: string;
    influencerId: string | null;
    purpose: ConsentPurpose;
    method: 'bot_button' | 'bot_command' | 'ig_dm' | 'operator_recorded';
    evidence: Record<string, unknown>;
    policyDocumentId?: string | null;
  },
): Promise<string> {
  const existing = await activeConsent(db, c.fanId, c.influencerId, c.purpose);
  if (existing) return existing.id;
  const id = uuidv7();
  await db.query(
    `INSERT INTO crm.consents (id, workspace_id, fan_id, influencer_id, purpose, status, method, evidence, granted_at, policy_document_id)
     VALUES ($1, $2, $3, $4, $5, 'granted', $6, $7, now(), $8)
     ON CONFLICT DO NOTHING`,
    [id, c.workspaceId, c.fanId, c.influencerId, c.purpose, c.method, JSON.stringify(c.evidence), c.policyDocumentId ?? null],
  );
  if (c.purpose === 'age_attestation_18') {
    await db.query(
      `UPDATE crm.fans SET age_status = 'self_attested_adult', age_status_updated_at = now() WHERE id = $1 AND age_status = 'unknown'`,
      [c.fanId],
    );
  }
  return (await activeConsent(db, c.fanId, c.influencerId, c.purpose))?.id ?? id;
}

export async function withdrawConsent(db: Db | pg.Pool, fanId: string, influencerId: string | null, purpose: ConsentPurpose): Promise<boolean> {
  const res = await db.query(
    `UPDATE crm.consents SET status = 'withdrawn', withdrawn_at = now()
      WHERE fan_id = $1 AND influencer_id IS NOT DISTINCT FROM $2 AND purpose = $3 AND status = 'granted'`,
    [fanId, influencerId, purpose],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Restricts a fan flagged as a possible minor: no AI processing, no offers, escalated to staff. */
export async function flagSuspectedMinor(db: Db | pg.Pool, fanId: string): Promise<void> {
  await db.query(
    `UPDATE crm.fans SET age_status = CASE WHEN age_status = 'confirmed_minor' THEN age_status ELSE 'suspected_minor' END,
            age_status_updated_at = now(), status = CASE WHEN status = 'active' THEN 'restricted' ELSE status END,
            risk_flags = (SELECT array_agg(DISTINCT f) FROM unnest(risk_flags || ARRAY['minor_signal']) f)
      WHERE id = $1`,
    [fanId],
  );
}

/**
 * Right to erasure (/deletemydata or staff action). Personal data and message
 * content are removed; payment records are retained only as legally required
 * accounting entries (amounts, ids) without names or message content.
 */
export async function eraseFan(db: Db | pg.Pool, fanId: string, actor: Actor, via: string): Promise<{ dsr_id: string }> {
  const fan = await one<{ workspace_id: string }>(db, 'SELECT workspace_id FROM crm.fans WHERE id = $1', [fanId]);
  const dsrId = uuidv7();
  await db.query(
    `INSERT INTO crm.data_subject_requests (id, workspace_id, fan_id, kind, received_via, status, due_at)
     VALUES ($1, $2, $3, 'erasure', $4, 'in_progress', now() + interval '30 days')`,
    [dsrId, fan.workspace_id, fanId, via],
  );
  await db.query(`UPDATE conversation.messages SET body = NULL, media = NULL, original_body = NULL, status = 'deleted' WHERE fan_id = $1`, [fanId]);
  await db.query(`UPDATE conversation.fan_memories SET status = 'deleted', statement = '[erased]', deleted_at = now() WHERE fan_id = $1`, [fanId]);
  await db.query(
    `UPDATE conversation.conversation_summaries SET summary = '[erased]' WHERE conversation_id IN (SELECT id FROM conversation.conversations WHERE fan_id = $1)`,
    [fanId],
  );
  // The chat id is released so a new conversation (a new fan, no history) can start if the person writes again.
  await db.query(`UPDATE conversation.conversations SET status = 'closed', mode = 'paused', external_chat_id = 'erased:' || id WHERE fan_id = $1`, [fanId]);
  await db.query(`UPDATE crm.consents SET status = 'withdrawn', withdrawn_at = now() WHERE fan_id = $1 AND status = 'granted'`, [fanId]);
  await db.query(`UPDATE crm.fan_influencer_profiles SET preferences = '{}', marketing_opt_in = false WHERE fan_id = $1`, [fanId]);
  // The platform user id is replaced by a one-way hash: if the person writes again they start as a new fan with no history.
  await db.query(`UPDATE crm.fan_identities SET username = NULL, platform_user_id = 'erased:' || encode(digest(platform_user_id, 'sha256'), 'hex') WHERE fan_id = $1`, [fanId]);
  await db.query(`UPDATE crm.fans SET display_name = NULL, primary_language = NULL, country_code = NULL, status = 'erased', erased_at = now() WHERE id = $1`, [fanId]);
  await db.query(`UPDATE crm.data_subject_requests SET status = 'completed', completed_at = now() WHERE id = $1`, [dsrId]);
  await audit(db as Db, { workspaceId: fan.workspace_id, actor, action: 'fan.erased', subjectType: 'fan', subjectId: fanId, metadata: { dsr_id: dsrId, via } });
  return { dsr_id: dsrId };
}

export async function trackEvent(db: Db | pg.Pool, e: { workspaceId: string; influencerId: string | null; fanId: string | null; name: string; properties?: Record<string, unknown>; source: string }): Promise<void> {
  await db.query(
    `INSERT INTO analytics.events (occurred_at, workspace_id, influencer_id, fan_id, name, properties, source) VALUES (now(), $1, $2, $3, $4, $5, $6)`,
    [e.workspaceId, e.influencerId, e.fanId, e.name, JSON.stringify(e.properties ?? {}), e.source],
  );
}

export async function latestPolicy(db: Db | pg.Pool, workspaceId: string, kind: 'terms' | 'privacy' | 'ai_disclosure' | 'content_rules' | 'refund_policy'): Promise<{ id: string; url: string; version: string } | null> {
  return maybeOne(
    db,
    `SELECT id, url, version FROM crm.policy_documents WHERE workspace_id = $1 AND kind = $2 AND published_at <= now() ORDER BY published_at DESC LIMIT 1`,
    [workspaceId, kind],
  );
}
