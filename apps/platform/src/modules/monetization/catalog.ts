import type pg from 'pg';
import type { Config } from '../../config.js';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import { auditCtx } from '../audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { getInfluencer } from '../identity.js';

/**
 * Product catalog (Telegram Stars). A product is drafted, approved by a second
 * person, and only then sold. Grants describe what a purchase unlocks; the
 * entitlement engine is the single source of truth for access.
 */
export type ProductKind = 'premium_channel_subscription' | 'bot_subscription' | 'paid_media' | 'message_pack' | 'custom_request' | 'tip' | 'bundle';

export type ProductGrant = { kind: 'premium_channel_access'; channel_id: string } | { kind: 'bot_premium_tier' } | { kind: 'message_credits'; quantity: number };

export interface ProductRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  sku: string;
  version: number;
  kind: ProductKind;
  name: string;
  description: string;
  price_stars: string;
  billing_period_seconds: number | null;
  grants: ProductGrant[];
  status: 'draft' | 'pending_approval' | 'active' | 'retired';
  created_by: string | null;
  approved_by: string | null;
}

export interface CreateProductInput {
  sku: string;
  kind: ProductKind;
  name: string;
  description: string;
  price_stars: number;
  grants: ProductGrant[];
}

const SUBSCRIPTION_KINDS: ProductKind[] = ['premium_channel_subscription', 'bot_subscription'];
/** Kinds the runtime can fulfil today; paid media and custom requests need content delivery (later phase). */
const SELLABLE_KINDS: ProductKind[] = ['premium_channel_subscription', 'bot_subscription', 'message_pack', 'tip'];

export function isSubscription(kind: ProductKind): boolean {
  return SUBSCRIPTION_KINDS.includes(kind);
}

async function validateGrants(db: Db, influencerId: string, kind: ProductKind, grants: ProductGrant[]): Promise<void> {
  const kinds = grants.map((g) => g.kind);
  if (new Set(kinds).size !== kinds.length) throw unprocessable('GRANTS_DUPLICATE', 'Each grant kind may appear once');
  for (const g of grants) {
    if (g.kind === 'premium_channel_access') {
      if (!isSubscription(kind)) throw unprocessable('GRANT_KIND_MISMATCH', 'Channel access is sold as a subscription');
      const ch = await maybeOne<{ influencer_id: string; kind: string }>(db, 'SELECT influencer_id, kind FROM publishing.channels WHERE id = $1', [g.channel_id]);
      if (!ch || ch.influencer_id !== influencerId || ch.kind !== 'telegram_premium_channel') {
        throw unprocessable('GRANT_CHANNEL_INVALID', 'premium_channel_access needs a telegram_premium_channel of this influencer');
      }
    } else if (g.kind === 'bot_premium_tier') {
      if (!isSubscription(kind)) throw unprocessable('GRANT_KIND_MISMATCH', 'The premium chat tier is sold as a subscription');
    } else if (g.kind === 'message_credits') {
      if (kind !== 'message_pack' && kind !== 'bundle') throw unprocessable('GRANT_KIND_MISMATCH', 'Message credits are sold as a message pack');
      if (!Number.isInteger(g.quantity) || g.quantity < 1 || g.quantity > 100_000) throw unprocessable('GRANT_INVALID', 'quantity must be 1..100000');
    }
  }
  if (kind === 'premium_channel_subscription' && !kinds.includes('premium_channel_access')) throw unprocessable('GRANTS_REQUIRED', 'A channel subscription must grant channel access');
  if (kind === 'bot_subscription' && !kinds.includes('bot_premium_tier')) throw unprocessable('GRANTS_REQUIRED', 'A bot subscription must grant the premium tier');
  if (kind === 'message_pack' && !kinds.includes('message_credits')) throw unprocessable('GRANTS_REQUIRED', 'A message pack must grant credits');
  if (kind === 'tip' && grants.length) throw unprocessable('GRANT_KIND_MISMATCH', 'A tip grants nothing');
}

export async function createProduct(db: Db, ctx: Ctx, cfg: Config, influencerId: string, input: CreateProductInput): Promise<ProductRow> {
  requirePermission(ctx, 'product.manage');
  await getInfluencer(db, ctx, influencerId);
  if (!SELLABLE_KINDS.includes(input.kind)) throw unprocessable('PRODUCT_KIND_UNSUPPORTED', `${input.kind} products are not supported yet`);
  await validateGrants(db, influencerId, input.kind, input.grants);
  const version = await one<{ v: number }>(db, 'SELECT coalesce(max(version), 0) + 1 AS v FROM monetization.products WHERE influencer_id = $1 AND sku = $2', [influencerId, input.sku]);
  const row = await one<ProductRow>(
    db,
    `INSERT INTO monetization.products (id, workspace_id, influencer_id, sku, version, kind, name, description, price_stars, billing_period_seconds, grants, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      uuidv7(),
      ctx.workspaceId,
      influencerId,
      input.sku,
      version.v,
      input.kind,
      input.name,
      input.description,
      input.price_stars,
      isSubscription(input.kind) ? cfg.payments.subscriptionPeriodSeconds : null,
      JSON.stringify(input.grants),
      ctx.userId,
    ],
  );
  await auditCtx(db, ctx, { influencerId, action: 'product.create', subjectType: 'product', subjectId: row.id, changes: { after: input } });
  return row;
}

async function productFor(db: Db, ctx: Ctx, id: string): Promise<ProductRow> {
  const p = await maybeOne<ProductRow>(db, 'SELECT * FROM monetization.products WHERE id = $1', [id]);
  if (!p) throw notFound('Product', id);
  requireInfluencerAccess(ctx, p.influencer_id);
  return p;
}

export async function submitProduct(db: Db, ctx: Ctx, id: string): Promise<ProductRow> {
  requirePermission(ctx, 'product.manage');
  const p = await productFor(db, ctx, id);
  if (p.status !== 'draft') throw conflict('INVALID_STATE', `Product is ${p.status}`);
  const row = await one<ProductRow>(db, `UPDATE monetization.products SET status = 'pending_approval' WHERE id = $1 RETURNING *`, [id]);
  await auditCtx(db, ctx, { influencerId: p.influencer_id, action: 'product.submit', subjectType: 'product', subjectId: id });
  return row;
}

/** Activates a product; earlier active versions of the same SKU are retired. */
export async function approveProduct(db: Db, ctx: Ctx, id: string): Promise<ProductRow> {
  requirePermission(ctx, 'product.approve');
  const p = await productFor(db, ctx, id);
  if (p.status !== 'pending_approval') throw conflict('INVALID_STATE', `Product is ${p.status}`);
  if (p.created_by && p.created_by === ctx.userId) throw forbidden('A product must be approved by someone other than its author');
  await db.query(`UPDATE monetization.products SET status = 'retired', retired_at = now() WHERE influencer_id = $1 AND sku = $2 AND status = 'active'`, [p.influencer_id, p.sku]);
  const row = await one<ProductRow>(db, `UPDATE monetization.products SET status = 'active', approved_by = $2 WHERE id = $1 RETURNING *`, [id, ctx.userId]);
  await auditCtx(db, ctx, { influencerId: p.influencer_id, action: 'product.approve', subjectType: 'product', subjectId: id, metadata: { price_stars: p.price_stars } });
  return row;
}

export async function retireProduct(db: Db, ctx: Ctx, id: string): Promise<ProductRow> {
  requirePermission(ctx, 'product.manage');
  const p = await productFor(db, ctx, id);
  if (p.status === 'retired') throw conflict('INVALID_STATE', 'Product is already retired');
  const row = await one<ProductRow>(db, `UPDATE monetization.products SET status = 'retired', retired_at = now() WHERE id = $1 RETURNING *`, [id]);
  await auditCtx(db, ctx, { influencerId: p.influencer_id, action: 'product.retire', subjectType: 'product', subjectId: id });
  return row;
}

export async function listProducts(db: Db, ctx: Ctx, influencerId: string, status?: string): Promise<ProductRow[]> {
  requirePermission(ctx, 'influencer.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query<ProductRow>(
    `SELECT * FROM monetization.products WHERE influencer_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY sku, version DESC`,
    [influencerId, status ?? null],
  );
  return rows;
}

export async function activeProducts(db: Db | pg.Pool, influencerId: string): Promise<ProductRow[]> {
  const { rows } = await db.query<ProductRow>(`SELECT * FROM monetization.products WHERE influencer_id = $1 AND status = 'active' ORDER BY price_stars`, [influencerId]);
  return rows;
}
