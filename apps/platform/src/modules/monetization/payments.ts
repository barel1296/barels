import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one, withTx } from '../../db/tx.js';
import { sha256Bytes } from '../../lib/canonical-json.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../alerts.js';
import { audit, auditCtx, outbox } from '../audit.js';
import { type Actor, type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { trackEvent } from '../crm.js';
import { enqueue, PRIORITY, RetryLaterError } from '../jobs-queue.js';
import { type ProductGrant, type ProductRow, isSubscription } from './catalog.js';
import { grantEntitlement, revokeEntitlements } from './entitlements.js';

/**
 * Telegram Stars payments: orders with signed invoice payloads, pre-checkout
 * validation, idempotent payment recording, subscriptions and renewals,
 * credits, and refunds (staff-requested with four-eyes approval, or initiated
 * by Telegram). Money is never moved by an agent.
 */

// -----------------------------------------------------------------------------
// Invoice payloads: opaque, HMAC-signed order references (≤ 128 bytes, no PII)
// -----------------------------------------------------------------------------
export function signInvoicePayload(secret: Buffer, orderId: string): string {
  const id = orderId.replace(/-/g, '');
  const mac = createHmac('sha256', secret).update(`order:${id}`).digest().subarray(0, 16).toString('base64url');
  return `o1.${id}.${mac}`;
}

export function verifyInvoicePayload(secret: Buffer, payload: string): string | null {
  const m = /^o1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{22})$/.exec(payload);
  if (!m) return null;
  // Compare canonical encodings: base64url padding bits must not yield alternative valid payloads.
  const expected = Buffer.from(createHmac('sha256', secret).update(`order:${m[1]}`).digest().subarray(0, 16).toString('base64url'));
  const given = Buffer.from(m[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// -----------------------------------------------------------------------------
// Orders
// -----------------------------------------------------------------------------
export interface OrderRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  fan_id: string;
  product_id: string;
  offer_id: string | null;
  price_stars: string;
  invoice_payload: string;
  status: string;
  invoice_link: string | null;
  expires_at: Date | null;
}

const ADULT = ['self_attested_adult', 'verified_adult'];
const ORDER_TTL_HOURS = 24;

/** Why a fan may not buy a product right now (null = eligible). */
export async function purchaseBlocker(db: Db | pg.Pool, fanId: string, product: ProductRow, amount: number): Promise<string | null> {
  const fan = await one<{ status: string; age_status: string }>(db, 'SELECT status, age_status FROM crm.fans WHERE id = $1', [fanId]);
  if (fan.status !== 'active') return 'This purchase is not available for your account.';
  if (!ADULT.includes(fan.age_status)) return 'Purchases are for adults (18+) who accepted the terms. Send /start first.';
  if (product.status !== 'active') return 'This offer is no longer available.';
  if (isSubscription(product.kind)) {
    const live = await maybeOne(
      db,
      `SELECT 1 FROM monetization.subscriptions WHERE fan_id = $1 AND product_id IN (SELECT id FROM monetization.products WHERE influencer_id = $2 AND sku = $3)
          AND status IN ('active', 'cancelled', 'payment_failed') AND current_period_end > now()`,
      [fanId, product.influencer_id, product.sku],
    );
    if (live) return 'You already have this subscription. See /subscription.';
  }
  const cap = await maybeOne<{ monthly_spend_cap_stars: string | null }>(
    db,
    'SELECT monthly_spend_cap_stars FROM crm.fan_influencer_profiles WHERE fan_id = $1 AND influencer_id = $2',
    [fanId, product.influencer_id],
  );
  if (cap?.monthly_spend_cap_stars) {
    const spent = await one<{ s: string }>(
      db,
      `SELECT coalesce(sum(amount_stars), 0) AS s FROM monetization.payments WHERE fan_id = $1 AND influencer_id = $2 AND received_at > now() - interval '30 days'`,
      [fanId, product.influencer_id],
    );
    if (Number(spent.s) + amount > Number(cap.monthly_spend_cap_stars)) return 'This purchase would exceed your monthly spending limit.';
  }
  return null;
}

export async function createOrder(
  svc: Services,
  o: { fanId: string; productId: string; offerId?: string | null },
): Promise<{ order: OrderRow; product: ProductRow }> {
  const db = svc.workerPool;
  const product = await maybeOne<ProductRow>(db, 'SELECT * FROM monetization.products WHERE id = $1', [o.productId]);
  if (!product) throw notFound('Product', o.productId);
  const blocker = await purchaseBlocker(db, o.fanId, product, Number(product.price_stars));
  if (blocker) throw unprocessable('NOT_PURCHASABLE', blocker);
  const id = uuidv7();
  const order = await one<OrderRow>(
    db,
    `INSERT INTO monetization.orders (id, workspace_id, influencer_id, fan_id, product_id, offer_id, price_stars, invoice_payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9)) RETURNING *`,
    [id, product.workspace_id, product.influencer_id, o.fanId, product.id, o.offerId ?? null, product.price_stars, signInvoicePayload(svc.config.payments.invoiceSecret, id), ORDER_TTL_HOURS],
  );
  return { order, product };
}

/** Telegram invoice titles are ≤ 32 characters and descriptions ≤ 255. */
export function invoiceText(product: ProductRow): { title: string; description: string } {
  return { title: product.name.slice(0, 32), description: `${product.description}`.slice(0, 255) };
}

export async function attachInvoiceLink(db: Db | pg.Pool, orderId: string, link: string): Promise<void> {
  await db.query('UPDATE monetization.orders SET invoice_link = $2 WHERE id = $1', [orderId, link]);
}

// -----------------------------------------------------------------------------
// Pre-checkout (answered inline by the poller; must be fast)
// -----------------------------------------------------------------------------
export async function validatePreCheckout(
  svc: Services,
  q: { from: { id: number }; currency: string; total_amount: number; invoice_payload: string },
  workspaceId: string,
): Promise<{ ok: boolean; error?: string; orderId?: string }> {
  const db = svc.workerPool;
  const orderId = verifyInvoicePayload(svc.config.payments.invoiceSecret, q.invoice_payload);
  if (!orderId) return { ok: false, error: 'This invoice is not valid.' };
  const order = await maybeOne<OrderRow>(db, 'SELECT * FROM monetization.orders WHERE id = $1 AND workspace_id = $2', [orderId, workspaceId]);
  if (!order) return { ok: false, error: 'This invoice is not valid.' };
  const reject = async (error: string) => {
    await db.query(`UPDATE monetization.orders SET status = 'pre_checkout_rejected', pre_checkout_answered_at = now() WHERE id = $1 AND status IN ('created', 'pre_checkout_ok')`, [orderId]);
    return { ok: false, error, orderId };
  };
  if (!['created', 'pre_checkout_ok'].includes(order.status)) return reject('This invoice was already used or has expired.');
  if (order.expires_at && order.expires_at.getTime() < Date.now()) return reject('This invoice has expired. Please request a new one.');
  if (q.currency !== 'XTR' || q.total_amount !== Number(order.price_stars)) return reject('The price changed. Please request a new invoice.');
  const payer = await maybeOne<{ fan_id: string }>(
    db,
    `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'telegram' AND platform_user_id = $2`,
    [workspaceId, String(q.from.id)],
  );
  if (!payer || payer.fan_id !== order.fan_id) return reject('This invoice belongs to another account.');
  const product = await one<ProductRow>(db, 'SELECT * FROM monetization.products WHERE id = $1', [order.product_id]);
  const blocker = await purchaseBlocker(db, order.fan_id, product, q.total_amount);
  if (blocker) return reject(blocker);
  await db.query(`UPDATE monetization.orders SET status = 'pre_checkout_ok', pre_checkout_answered_at = now() WHERE id = $1`, [orderId]);
  return { ok: true, orderId };
}

// -----------------------------------------------------------------------------
// Successful payments (job on the payments queue)
// -----------------------------------------------------------------------------
export interface StarPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
}

export interface PaymentOutcome {
  status: 'recorded' | 'duplicate' | 'unmatched';
  paymentId?: string;
  fanId: string;
  influencerId: string;
  product?: ProductRow;
  subscriptionEnd?: Date;
  credits?: number;
  channelIds?: string[];
}

async function extendOrGrant(tx: Db, g: Parameters<typeof grantEntitlement>[1]): Promise<void> {
  const extended = await tx.query<{ id: string }>(
    `UPDATE monetization.entitlements SET valid_until = $5
      WHERE fan_id = $1 AND kind = $2 AND resource_id = $3 AND source_id = $4 AND status = 'active'
        AND valid_until IS NOT NULL AND valid_until < $5 RETURNING id`,
    [g.fanId, g.kind, g.resourceId, g.sourceId, g.validUntil],
  );
  if (extended.rowCount) {
    await outbox(tx, {
      workspaceId: g.workspaceId,
      eventType: 'monetization.entitlement_extended',
      aggregateType: 'entitlement',
      aggregateId: extended.rows[0]!.id,
      payload: { fan_id: g.fanId, influencer_id: g.influencerId, kind: g.kind, resource_id: g.resourceId, valid_until: g.validUntil?.toISOString() ?? null },
    });
    return;
  }
  const covering = await tx.query(
    `SELECT 1 FROM monetization.entitlements WHERE fan_id = $1 AND kind = $2 AND resource_id = $3 AND source_id = $4 AND status = 'active' AND (valid_until IS NULL OR valid_until >= $5)`,
    [g.fanId, g.kind, g.resourceId, g.sourceId, g.validUntil],
  );
  if (covering.rowCount) return;
  await grantEntitlement(tx, g);
}

/**
 * Records a successful Stars payment exactly once (dedup by charge id) and
 * fulfils it: subscription start or renewal, entitlements, credits. A payment
 * that cannot be matched to an order is still recorded and raises a critical
 * alert: money must never be lost silently.
 */
export async function recordPayment(svc: Services, p: { workspaceId: string; influencerId: string; fanId: string; telegramUserId: number; payment: StarPayment }): Promise<PaymentOutcome> {
  const sp = p.payment;
  const base = { fanId: p.fanId, influencerId: p.influencerId };
  const existing = await maybeOne<{ id: string }>(svc.workerPool, 'SELECT id FROM monetization.payments WHERE external_dedup_key = $1', [`tg:${sp.telegram_payment_charge_id}`]);
  if (existing) return { status: 'duplicate', paymentId: existing.id, ...base };
  const orderId = verifyInvoicePayload(svc.config.payments.invoiceSecret, sp.invoice_payload);
  const order = orderId ? await maybeOne<OrderRow>(svc.workerPool, 'SELECT * FROM monetization.orders WHERE id = $1 AND workspace_id = $2', [orderId, p.workspaceId]) : null;
  const raw = { ...sp, telegram_user_id: p.telegramUserId };
  const receivedAt = new Date();

  if (!order || order.fan_id !== p.fanId || sp.currency !== 'XTR') {
    const paymentId = uuidv7();
    await withTx(svc.workerPool, async (tx) => {
      await tx.query(
        `INSERT INTO monetization.payments (id, workspace_id, influencer_id, fan_id, order_id, kind, amount_stars, external_dedup_key, telegram_payment_charge_id,
           is_recurring, is_first_recurring, raw, received_at)
         VALUES ($1, $2, $3, $4, NULL, 'one_time', $5, $6, $7, $8, $9, $10, $11)`,
        [paymentId, p.workspaceId, p.influencerId, p.fanId, sp.total_amount, `tg:${sp.telegram_payment_charge_id}`, sp.telegram_payment_charge_id, sp.is_recurring ?? null, sp.is_first_recurring ?? null, JSON.stringify(raw), receivedAt],
      );
      await raiseAlert(tx, {
        workspaceId: p.workspaceId,
        severity: 'critical',
        source: 'payments',
        code: 'PAYMENT_UNMATCHED',
        dedupKey: `payment_unmatched:${paymentId}`,
        message: `Received ${sp.total_amount} Stars that match no order for this fan; review and refund or fulfil manually`,
        details: { payment_id: paymentId, order_id: orderId, charge_id: sp.telegram_payment_charge_id },
      });
    });
    return { status: 'unmatched', paymentId, ...base };
  }

  const product = await one<ProductRow>(svc.workerPool, 'SELECT * FROM monetization.products WHERE id = $1', [order.product_id]);
  const cfg = svc.config.payments;
  return withTx(svc.workerPool, async (tx) => {
    // Serialise payments per fan and product (renewals vs. concurrent initial payments).
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('golden.payment:' || $1 || ':' || $2))`, [p.fanId, product.sku]);
    const dup = await maybeOne<{ id: string }>(tx, 'SELECT id FROM monetization.payments WHERE external_dedup_key = $1', [`tg:${sp.telegram_payment_charge_id}`]);
    if (dup) return { status: 'duplicate' as const, paymentId: dup.id, ...base };
    const paymentId = uuidv7();
    let subscriptionId: string | null = null;
    let periodEnd: Date | undefined;
    let kind: 'one_time' | 'subscription_initial' | 'subscription_renewal' = 'one_time';
    if (isSubscription(product.kind)) {
      periodEnd = sp.subscription_expiration_date ? new Date(sp.subscription_expiration_date * 1000) : new Date(receivedAt.getTime() + (product.billing_period_seconds ?? cfg.subscriptionPeriodSeconds) * 1000);
      const live = await maybeOne<{ id: string; current_period_end: Date }>(
        tx,
        `SELECT id, current_period_end FROM monetization.subscriptions WHERE fan_id = $1 AND product_id = $2 AND status IN ('active', 'cancelled', 'payment_failed') FOR UPDATE`,
        [p.fanId, product.id],
      );
      if (live && sp.is_recurring && !sp.is_first_recurring) {
        kind = 'subscription_renewal';
        subscriptionId = live.id;
        const start = live.current_period_end < periodEnd ? live.current_period_end : receivedAt;
        await tx.query(
          `UPDATE monetization.subscriptions SET status = 'active', current_period_start = $2, current_period_end = $3, renewal_count = renewal_count + 1, updated_at = now()
            WHERE id = $1`,
          [live.id, start, periodEnd],
        );
      } else {
        kind = 'subscription_initial';
        subscriptionId = uuidv7();
        if (live) await tx.query(`UPDATE monetization.subscriptions SET status = 'expired', ended_at = now(), updated_at = now() WHERE id = $1`, [live.id]);
        await tx.query(
          `INSERT INTO monetization.subscriptions (id, workspace_id, influencer_id, fan_id, product_id, rail, status, started_at, current_period_start, current_period_end, external_ref)
           VALUES ($1, $2, $3, $4, $5, 'bot_star_subscription', 'active', $6, $6, $7, $8)`,
          [subscriptionId, p.workspaceId, p.influencerId, p.fanId, product.id, receivedAt, periodEnd, sp.telegram_payment_charge_id],
        );
      }
    }
    await tx.query(
      `INSERT INTO monetization.payments (id, workspace_id, influencer_id, fan_id, order_id, subscription_id, kind, amount_stars, external_dedup_key,
         telegram_payment_charge_id, is_recurring, is_first_recurring, subscription_expiration_at, raw, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        paymentId,
        p.workspaceId,
        p.influencerId,
        p.fanId,
        order.id,
        subscriptionId,
        kind,
        sp.total_amount,
        `tg:${sp.telegram_payment_charge_id}`,
        sp.telegram_payment_charge_id,
        sp.is_recurring ?? null,
        sp.is_first_recurring ?? null,
        sp.subscription_expiration_date ? new Date(sp.subscription_expiration_date * 1000) : null,
        JSON.stringify(raw),
        receivedAt,
      ],
    );
    if (kind !== 'subscription_renewal') {
      await tx.query(`UPDATE monetization.orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.id]);
      if (order.offer_id) await tx.query(`UPDATE monetization.offers SET status = 'purchased' WHERE id = $1`, [order.offer_id]);
    }
    let credits = 0;
    const channelIds: string[] = [];
    for (const g of product.grants as ProductGrant[]) {
      if (g.kind === 'message_credits') {
        credits += g.quantity;
        continue;
      }
      if (!subscriptionId || !periodEnd) continue;
      const validUntil = new Date(periodEnd.getTime() + cfg.subscriptionGraceHours * 3_600_000);
      if (g.kind === 'premium_channel_access') channelIds.push(g.channel_id);
      await extendOrGrant(tx, {
        workspaceId: p.workspaceId,
        influencerId: p.influencerId,
        fanId: p.fanId,
        kind: g.kind,
        resourceType: g.kind === 'premium_channel_access' ? 'channel' : 'tier',
        resourceId: g.kind === 'premium_channel_access' ? g.channel_id : p.influencerId,
        sourceType: 'subscription',
        sourceId: subscriptionId,
        validFrom: receivedAt,
        validUntil,
        grantedBy: { type: 'system', id: 'payments' },
      });
    }
    if (credits > 0) {
      const bal = await one<{ balance: number }>(
        tx,
        `INSERT INTO monetization.credit_balances (workspace_id, fan_id, influencer_id, balance, version) VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (fan_id, influencer_id) DO UPDATE SET balance = monetization.credit_balances.balance + EXCLUDED.balance,
           version = monetization.credit_balances.version + 1 RETURNING balance`,
        [p.workspaceId, p.fanId, p.influencerId, credits],
      );
      await tx.query(
        `INSERT INTO monetization.credit_ledger (workspace_id, fan_id, influencer_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'purchase', 'payment', $6, $7)`,
        [p.workspaceId, p.fanId, p.influencerId, credits, bal.balance, paymentId, `purchase:${paymentId}`],
      );
    }
    await tx.query(
      `UPDATE crm.fan_influencer_profiles SET lifetime_stars = lifetime_stars + $3,
              lifecycle_stage = CASE WHEN $4 THEN 'subscriber' WHEN lifecycle_stage = 'subscriber' THEN lifecycle_stage ELSE 'customer' END
        WHERE fan_id = $1 AND influencer_id = $2`,
      [p.fanId, p.influencerId, sp.total_amount, subscriptionId !== null],
    );
    await outbox(tx, {
      workspaceId: p.workspaceId,
      eventType: 'monetization.payment_received',
      aggregateType: 'payment',
      aggregateId: paymentId,
      payload: { fan_id: p.fanId, influencer_id: p.influencerId, product_id: product.id, kind, amount_stars: sp.total_amount },
    });
    await trackEvent(tx, {
      workspaceId: p.workspaceId,
      influencerId: p.influencerId,
      fanId: p.fanId,
      name: 'payment_received',
      properties: { product_kind: product.kind, payment_kind: kind, amount_stars: sp.total_amount },
      source: 'payments',
    });
    await audit(tx, {
      workspaceId: p.workspaceId,
      influencerId: p.influencerId,
      actor: { type: 'external', id: 'telegram' },
      action: 'payment.received',
      subjectType: 'payment',
      subjectId: paymentId,
      metadata: { kind, amount_stars: sp.total_amount, product_id: product.id },
    });
    return {
      status: 'recorded' as const,
      paymentId,
      ...base,
      product,
      ...(periodEnd ? { subscriptionEnd: periodEnd } : {}),
      ...(credits ? { credits } : {}),
      channelIds,
    };
  });
}

// -----------------------------------------------------------------------------
// Refunds
// -----------------------------------------------------------------------------
export async function requestRefund(db: Db, ctx: Ctx, paymentId: string, reason: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'refund.request');
  const pay = await maybeOne<{ influencer_id: string; amount_stars: string }>(db, 'SELECT influencer_id, amount_stars FROM monetization.payments WHERE id = $1', [paymentId]);
  if (!pay) throw notFound('Payment', paymentId);
  requireInfluencerAccess(ctx, pay.influencer_id);
  const done = await maybeOne(db, `SELECT 1 FROM monetization.refunds WHERE payment_id = $1 AND status IN ('requested', 'pending_approval', 'processing', 'completed')`, [paymentId]);
  if (done) throw conflict('REFUND_EXISTS', 'A refund for this payment is already in progress or completed');
  const id = uuidv7();
  const row = await one(
    db,
    `INSERT INTO monetization.refunds (id, workspace_id, payment_id, amount_stars, reason, requested_by, status, requested_by_user)
     VALUES ($1, $2, $3, $4, $5, 'operator', 'pending_approval', $6) RETURNING *`,
    [id, ctx.workspaceId, paymentId, pay.amount_stars, reason, ctx.userId],
  );
  await auditCtx(db, ctx, { influencerId: pay.influencer_id, action: 'refund.request', subjectType: 'refund', subjectId: id, metadata: { payment_id: paymentId, reason } });
  return row;
}

export async function decideRefund(db: Db, ctx: Ctx, refundId: string, decision: 'approve' | 'reject', note: string | null): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'refund.approve');
  const r = await maybeOne<{ status: string; requested_by_user: string | null; payment_id: string; influencer_id: string }>(
    db,
    `SELECT r.status, r.requested_by_user, r.payment_id, p.influencer_id FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id WHERE r.id = $1`,
    [refundId],
  );
  if (!r) throw notFound('Refund', refundId);
  requireInfluencerAccess(ctx, r.influencer_id);
  if (r.status !== 'pending_approval') throw conflict('INVALID_STATE', `Refund is ${r.status}`);
  if (r.requested_by_user && r.requested_by_user === ctx.userId) throw forbidden('A refund must be approved by someone other than the requester');
  const row = await one(
    db,
    `UPDATE monetization.refunds SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
    [refundId, decision === 'approve' ? 'processing' : 'rejected', ctx.userId, note],
  );
  if (decision === 'approve') {
    await enqueue(db, {
      workspaceId: ctx.workspaceId,
      queue: 'payments',
      name: 'monetization.refund_execute',
      key: `refund:${refundId}`,
      payload: { refund_id: refundId },
      priority: PRIORITY.payments,
      maxAttempts: 10,
    });
  }
  await auditCtx(db, ctx, { influencerId: r.influencer_id, action: `refund.${decision}`, subjectType: 'refund', subjectId: refundId, metadata: { note } });
  return row;
}

interface PaymentForRefund {
  id: string;
  workspace_id: string;
  influencer_id: string;
  fan_id: string;
  order_id: string | null;
  subscription_id: string | null;
  amount_stars: string;
  telegram_payment_charge_id: string;
  raw: { telegram_user_id?: number };
}

const lockPayment = (tx: Db, paymentId: string) => tx.query(`SELECT pg_advisory_xact_lock(hashtext('golden.refund:' || $1))`, [paymentId]);

/** Applies a completed refund once (status transition guards against double effects). */
export async function finalizeRefund(db: pg.Pool, refundId: string, actor: Actor): Promise<boolean> {
  return withTx(db, async (tx) => {
    const r = await maybeOne<{ payment_id: string }>(tx, 'SELECT payment_id FROM monetization.refunds WHERE id = $1', [refundId]);
    if (!r) return false;
    await lockPayment(tx, r.payment_id);
    return finalizeRefundTx(tx, refundId, actor);
  });
}

async function finalizeRefundTx(tx: Db, refundId: string, actor: Actor): Promise<boolean> {
  const r = await maybeOne<{ payment_id: string }>(
    tx,
    `UPDATE monetization.refunds SET status = 'completed', completed_at = now() WHERE id = $1 AND status <> 'completed' RETURNING payment_id`,
    [refundId],
  );
  if (!r) return false;
  const pay = await one<PaymentForRefund>(tx, 'SELECT * FROM monetization.payments WHERE id = $1', [r.payment_id]);
  await applyRefundEffects(tx, pay, refundId, actor);
  return true;
}

async function applyRefundEffects(tx: Db, pay: PaymentForRefund, refundId: string, actor: Actor): Promise<void> {
  if (pay.subscription_id) {
    await tx.query(`UPDATE monetization.subscriptions SET status = 'refunded', auto_renew = false, ended_at = now(), updated_at = now() WHERE id = $1`, [pay.subscription_id]);
    await revokeEntitlements(tx, { sourceId: pay.subscription_id }, 'refunded');
  }
  if (pay.order_id) {
    await tx.query(`UPDATE monetization.orders SET status = 'refunded' WHERE id = $1`, [pay.order_id]);
    const purchased = await maybeOne<{ delta: number }>(tx, `SELECT delta FROM monetization.credit_ledger WHERE idempotency_key = $1`, [`purchase:${pay.id}`]);
    if (purchased) {
      const bal = await maybeOne<{ balance: number }>(tx, 'SELECT balance FROM monetization.credit_balances WHERE fan_id = $1 AND influencer_id = $2 FOR UPDATE', [pay.fan_id, pay.influencer_id]);
      const reverse = Math.min(purchased.delta, bal?.balance ?? 0);
      if (reverse > 0) {
        const after = await one<{ balance: number }>(
          tx,
          `UPDATE monetization.credit_balances SET balance = balance - $3, version = version + 1 WHERE fan_id = $1 AND influencer_id = $2 RETURNING balance`,
          [pay.fan_id, pay.influencer_id, reverse],
        );
        await tx.query(
          `INSERT INTO monetization.credit_ledger (workspace_id, fan_id, influencer_id, delta, balance_after, reason, ref_type, ref_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'refund_reversal', 'refund', $6, $7) ON CONFLICT (idempotency_key) DO NOTHING`,
          [pay.workspace_id, pay.fan_id, pay.influencer_id, -reverse, after.balance, refundId, `refund:${refundId}`],
        );
      }
    }
  }
  await tx.query(
    `UPDATE crm.fan_influencer_profiles SET lifetime_stars = greatest(0, lifetime_stars - $3) WHERE fan_id = $1 AND influencer_id = $2`,
    [pay.fan_id, pay.influencer_id, pay.amount_stars],
  );
  await outbox(tx, {
    workspaceId: pay.workspace_id,
    eventType: 'monetization.payment_refunded',
    aggregateType: 'payment',
    aggregateId: pay.id,
    payload: { fan_id: pay.fan_id, influencer_id: pay.influencer_id, refund_id: refundId, amount_stars: Number(pay.amount_stars) },
  });
  await audit(tx, { workspaceId: pay.workspace_id, influencerId: pay.influencer_id, actor, action: 'refund.completed', subjectType: 'refund', subjectId: refundId, metadata: { payment_id: pay.id } });
}

/** Telegram reports a refund (initiated by us or by Telegram support). Idempotent and safe under concurrent delivery. */
export async function recordTelegramRefund(db: pg.Pool, workspaceId: string, chargeId: string): Promise<'completed' | 'duplicate' | 'unknown_payment'> {
  return withTx(db, async (tx) => {
    const pay = await maybeOne<PaymentForRefund>(tx, 'SELECT * FROM monetization.payments WHERE telegram_payment_charge_id = $1 AND workspace_id = $2', [chargeId, workspaceId]);
    if (!pay) return 'unknown_payment';
    await lockPayment(tx, pay.id);
    const open = await maybeOne<{ id: string; status: string }>(
      tx,
      `SELECT id, status FROM monetization.refunds WHERE payment_id = $1 AND status IN ('requested', 'pending_approval', 'processing', 'completed') ORDER BY created_at DESC LIMIT 1`,
      [pay.id],
    );
    if (open?.status === 'completed') return 'duplicate';
    let refundId = open?.id;
    if (!refundId) {
      refundId = uuidv7();
      await tx.query(
        `INSERT INTO monetization.refunds (id, workspace_id, payment_id, amount_stars, reason, requested_by, status) VALUES ($1, $2, $3, $4, 'refunded by Telegram', 'platform', 'processing')`,
        [refundId, workspaceId, pay.id, pay.amount_stars],
      );
    }
    return (await finalizeRefundTx(tx, refundId, { type: 'external', id: 'telegram' })) ? 'completed' : 'duplicate';
  });
}

/** Executes an approved refund against Telegram (job `monetization.refund_execute`). */
export async function executeRefund(svc: Services, refundId: string, refund: (userId: number, chargeId: string) => Promise<unknown>): Promise<unknown> {
  const db = svc.workerPool;
  const r = await maybeOne<{ status: string; payment_id: string; workspace_id: string }>(db, 'SELECT status, payment_id, workspace_id FROM monetization.refunds WHERE id = $1', [refundId]);
  if (!r) return { skipped: 'not_found' };
  if (r.status !== 'processing') return { skipped: r.status };
  const pay = await one<PaymentForRefund>(db, 'SELECT * FROM monetization.payments WHERE id = $1', [r.payment_id]);
  const userId = pay.raw.telegram_user_id;
  if (!userId) throw new Error('payment has no Telegram user id');
  const key = `telegram.refund:${refundId}`;
  await db.query(
    `INSERT INTO core.external_operations (workspace_id, idempotency_key, provider, operation, subject_type, subject_id, request_hash, status)
     VALUES ($1, $2, 'telegram', 'telegram.refund_star_payment', 'refund', $3, $4, 'pending') ON CONFLICT (idempotency_key) DO NOTHING`,
    [r.workspace_id, key, refundId, sha256Bytes(`${userId}:${pay.telegram_payment_charge_id}`)],
  );
  const op = await one<{ status: string }>(db, 'SELECT status FROM core.external_operations WHERE idempotency_key = $1', [key]);
  if (op.status !== 'succeeded') {
    await db.query(`UPDATE core.external_operations SET status = 'in_flight', attempts = attempts + 1, updated_at = now() WHERE idempotency_key = $1`, [key]);
    try {
      await refund(userId, pay.telegram_payment_charge_id);
    } catch (err) {
      const e = err as Error & { retryable?: boolean; description?: string };
      const alreadyRefunded = /CHARGE_ALREADY_REFUNDED/i.test(e.description ?? e.message);
      if (!alreadyRefunded) {
        const retryable = e.retryable === true;
        await db.query(`UPDATE core.external_operations SET status = $2, last_error = $3, updated_at = now() WHERE idempotency_key = $1`, [
          key,
          retryable ? 'failed_retryable' : 'failed_permanent',
          JSON.stringify({ message: e.message }),
        ]);
        if (retryable) throw new RetryLaterError(`refund retry: ${e.message}`, 30_000);
        await db.query(`UPDATE monetization.refunds SET status = 'failed', last_error = $2 WHERE id = $1`, [refundId, JSON.stringify({ message: e.message })]);
        await raiseAlert(db, {
          workspaceId: r.workspace_id,
          severity: 'warning',
          source: 'payments',
          code: 'REFUND_FAILED',
          dedupKey: `refund_failed:${refundId}`,
          message: `Refund ${refundId} was rejected by Telegram: ${e.message}`,
          details: { refund_id: refundId, payment_id: pay.id },
        });
        return { failed: e.message };
      }
    }
    await db.query(`UPDATE core.external_operations SET status = 'succeeded', completed_at = now(), updated_at = now() WHERE idempotency_key = $1`, [key]);
  }
  await finalizeRefund(db, refundId, { type: 'system', id: 'refund_executor' });
  return { refunded: true };
}

// -----------------------------------------------------------------------------
// Subscriptions: fan cancellation and expiry
// -----------------------------------------------------------------------------
export async function setSubscriptionRenewal(
  db: pg.Pool,
  subscriptionId: string,
  fanId: string,
  cancel: boolean,
  edit: (userId: number, chargeId: string, isCanceled: boolean) => Promise<unknown>,
): Promise<{ status: string; current_period_end: Date }> {
  const sub = await maybeOne<{ status: string; external_ref: string; workspace_id: string; influencer_id: string }>(
    db,
    `SELECT status, external_ref, workspace_id, influencer_id FROM monetization.subscriptions WHERE id = $1 AND fan_id = $2`,
    [subscriptionId, fanId],
  );
  if (!sub || !['active', 'cancelled'].includes(sub.status)) throw notFound('Subscription', subscriptionId);
  const pay = await one<{ raw: { telegram_user_id?: number } }>(db, 'SELECT raw FROM monetization.payments WHERE telegram_payment_charge_id = $1', [sub.external_ref]);
  await edit(pay.raw.telegram_user_id!, sub.external_ref, cancel);
  const row = await one<{ status: string; current_period_end: Date }>(
    db,
    `UPDATE monetization.subscriptions SET status = $2, auto_renew = $3, cancelled_at = CASE WHEN $3 THEN NULL ELSE now() END, updated_at = now()
      WHERE id = $1 RETURNING status, current_period_end`,
    [subscriptionId, cancel ? 'cancelled' : 'active', !cancel],
  );
  await audit(db as unknown as Db, {
    workspaceId: sub.workspace_id,
    influencerId: sub.influencer_id,
    actor: { type: 'external', id: `fan:${fanId}` },
    action: cancel ? 'subscription.cancel' : 'subscription.resume',
    subjectType: 'subscription',
    subjectId: subscriptionId,
  });
  return row;
}

/** Ends subscriptions whose paid period plus grace has passed (entitlements expire through the sweeper). */
export async function expireSubscriptions(db: pg.Pool, graceHours: number): Promise<number> {
  const { rows } = await db.query<{ id: string; workspace_id: string; fan_id: string; influencer_id: string }>(
    `UPDATE monetization.subscriptions SET status = 'expired', ended_at = now(), updated_at = now()
      WHERE status IN ('active', 'cancelled', 'payment_failed') AND current_period_end + make_interval(hours => $1) < now()
      RETURNING id, workspace_id, fan_id, influencer_id`,
    [graceHours],
  );
  for (const s of rows) {
    await outbox(db as unknown as Db, {
      workspaceId: s.workspace_id,
      eventType: 'monetization.subscription_expired',
      aggregateType: 'subscription',
      aggregateId: s.id,
      payload: { fan_id: s.fan_id, influencer_id: s.influencer_id },
    });
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Staff views
// -----------------------------------------------------------------------------
export async function listPayments(db: Db, ctx: Ctx, influencerId: string, limit = 200): Promise<unknown[]> {
  requirePermission(ctx, 'payment.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT p.id, p.fan_id, p.kind, p.amount_stars, p.telegram_payment_charge_id, p.received_at, p.order_id, p.subscription_id, pr.name AS product_name,
            (SELECT status FROM monetization.refunds r WHERE r.payment_id = p.id ORDER BY created_at DESC LIMIT 1) AS refund_status
       FROM monetization.payments p LEFT JOIN monetization.orders o ON o.id = p.order_id LEFT JOIN monetization.products pr ON pr.id = o.product_id
      WHERE p.influencer_id = $1 ORDER BY p.received_at DESC LIMIT $2`,
    [influencerId, Math.min(limit, 1000)],
  );
  return rows;
}

export async function listSubscriptions(db: Db, ctx: Ctx, influencerId: string): Promise<unknown[]> {
  requirePermission(ctx, 'payment.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query(
    `SELECT s.*, p.name AS product_name, p.price_stars FROM monetization.subscriptions s JOIN monetization.products p ON p.id = s.product_id
      WHERE s.influencer_id = $1 ORDER BY s.created_at DESC LIMIT 1000`,
    [influencerId],
  );
  return rows;
}

export async function listRefunds(db: Db, ctx: Ctx, status?: string): Promise<unknown[]> {
  requirePermission(ctx, 'payment.read');
  const scope = ctx.influencerScope ? [...ctx.influencerScope] : null;
  const { rows } = await db.query(
    `SELECT r.*, p.influencer_id, p.fan_id, p.kind AS payment_kind FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id
      WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid[] IS NULL OR p.influencer_id = ANY($2)) ORDER BY r.created_at DESC LIMIT 500`,
    [status ?? null, scope],
  );
  return rows;
}
