import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import { type BotRow, type ChatContext, activeBots, botForInfluencer, clientForAccount, telegramHooks } from '../../integrations/telegram/bot.js';
import { TelegramApiError, type TelegramClient } from '../../integrations/telegram/client.js';
import { AppError, notFound } from '../../lib/errors.js';
import { uuidv7 } from '../../lib/ids.js';
import type { Registry } from '../../registry.js';
import type { Services } from '../../services.js';
import { auditCtx } from '../audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { openConversation, sendSystemMessage } from '../conversation/engine.js';
import { type FanRow, telegramUserIdOf, upsertTelegramFan } from '../crm.js';
import { PRIORITY } from '../jobs-queue.js';
import { claimEvent } from '../outbox.js';
import { type ProductRow, activeProducts } from './catalog.js';
import { hasEntitlement } from './entitlements.js';
import {
  type OrderRow,
  attachInvoiceLink,
  createOrder,
  executeRefund,
  expireSubscriptions,
  invoiceText,
  recordPayment,
  recordTelegramRefund,
  setSubscriptionRenewal,
  validatePreCheckout,
} from './payments.js';
import { reconcileBot } from './reconcile.js';

/**
 * Selling through the influencer's Telegram bot: /vip catalog, invoices,
 * pre-checkout validation, payment and refund updates, premium channel
 * join-request gating and access enforcement when entitlements end.
 */
const stars = (n: number | string) => `⭐ ${Number(n)}`;

async function invoiceFor(svc: Services, client: TelegramClient, order: OrderRow, product: ProductRow): Promise<string> {
  const t = invoiceText(product);
  const link = await client.createInvoiceLink({
    title: t.title,
    description: t.description,
    payload: order.invoice_payload,
    amountStars: Number(order.price_stars),
    ...(product.billing_period_seconds ? { subscriptionPeriodS: product.billing_period_seconds } : {}),
  });
  await attachInvoiceLink(svc.workerPool, order.id, link);
  return link;
}

const PURCHASE_NOTE = 'Digital goods from an AI-generated character. Paid in Telegram Stars. Help: /paysupport · Terms: /terms';

async function sendInvoice(c: ChatContext, productId: string): Promise<void> {
  let created;
  try {
    created = await createOrder(c.svc, { fanId: c.fan.id, productId });
  } catch (err) {
    await c.reply(err instanceof AppError ? err.message : 'This offer is not available right now.');
    return;
  }
  const link = await invoiceFor(c.svc, c.client, created.order, created.product);
  await c.reply(`${created.product.name} — ${stars(created.product.price_stars)}${created.product.billing_period_seconds ? ' / 30 days' : ''}\n${created.product.description}\n\n${PURCHASE_NOTE}`, [
    [{ text: `Pay ${stars(created.product.price_stars)}`, url: link }],
  ]);
}

async function liveSubscriptions(db: pg.Pool, fanId: string, influencerId: string) {
  const { rows } = await db.query<{ id: string; status: string; current_period_end: Date; name: string; product_id: string }>(
    `SELECT s.id, s.status, s.current_period_end, p.name, s.product_id FROM monetization.subscriptions s JOIN monetization.products p ON p.id = s.product_id
      WHERE s.fan_id = $1 AND s.influencer_id = $2 AND s.status IN ('active', 'cancelled', 'payment_failed') ORDER BY s.current_period_end`,
    [fanId, influencerId],
  );
  return rows;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function registerTelegramSales(): void {
  telegramHooks.onPreCheckout((u, q) => validatePreCheckout(u.svc, q, u.bot.workspace_id));

  telegramHooks.command('vip', 'Premium access and subscriptions', async (c) => {
    const products = await activeProducts(c.svc.workerPool, c.bot.influencer_id);
    if (!products.length) {
      await c.reply('There is nothing to buy yet.');
      return;
    }
    const subs = await liveSubscriptions(c.svc.workerPool, c.fan.id, c.bot.influencer_id);
    const lines = products.map((p) => {
      const sub = subs.find((s) => s.product_id === p.id);
      return `• ${p.name} — ${stars(p.price_stars)}${p.billing_period_seconds ? ' / 30 days' : ''}${sub ? ` (active until ${day(sub.current_period_end)})` : ''}\n  ${p.description}`;
    });
    await c.reply(`${lines.join('\n')}\n\n${PURCHASE_NOTE}`, products.filter((p) => !subs.some((s) => s.product_id === p.id)).map((p) => [{ text: `${p.name} · ${stars(p.price_stars)}`, callback_data: `buy:${p.id}` }]));
  });

  telegramHooks.command('subscription', 'Manage your subscription', async (c) => {
    const subs = await liveSubscriptions(c.svc.workerPool, c.fan.id, c.bot.influencer_id);
    if (!subs.length) {
      await c.reply('You have no active subscription. See /vip.');
      return;
    }
    for (const s of subs) {
      const renews = s.status === 'active';
      await c.reply(`${s.name}: ${renews ? `renews on ${day(s.current_period_end)}` : `cancelled — access until ${day(s.current_period_end)}`}.`, [
        [renews ? { text: 'Cancel renewal', callback_data: `sub:cancel:${s.id}` } : { text: 'Resume renewal', callback_data: `sub:resume:${s.id}` }],
      ]);
    }
  });

  telegramHooks.callback('buy', async (c, data) => {
    const productId = data.slice(4);
    if (!/^[0-9a-f-]{36}$/.test(productId)) return;
    await sendInvoice(c, productId);
  });

  telegramHooks.callback('sub', async (c, data) => {
    const [, action, id] = data.split(':');
    if (!id || (action !== 'cancel' && action !== 'resume')) return;
    try {
      const s = await setSubscriptionRenewal(c.svc.workerPool, id, c.fan.id, action === 'cancel', (uid, charge, cancel) => c.client.editUserStarSubscription(uid, charge, cancel));
      await c.reply(action === 'cancel' ? `Renewal cancelled. You keep access until ${day(s.current_period_end)}.` : `Renewal resumed. Next renewal on ${day(s.current_period_end)}.`);
    } catch (err) {
      await c.reply(err instanceof TelegramApiError ? 'Telegram could not update the subscription; please try again later.' : 'Subscription not found.');
    }
  });

  telegramHooks.onUpdate('successful_payment', async (u) => {
    const m = u.update.message!;
    const user = m.from!;
    const { fan } = await upsertTelegramFan(u.svc.workerPool, u.bot.workspace_id, u.bot.influencer_id, user);
    const out = await recordPayment(u.svc, { workspaceId: u.bot.workspace_id, influencerId: u.bot.influencer_id, fanId: fan.id, telegramUserId: user.id, payment: m.successful_payment! });
    if (out.status !== 'recorded') return out.status;
    const lines = [`Thank you! Your payment of ${stars(m.successful_payment!.total_amount)} was received.`];
    if (out.credits) lines.push(`${out.credits} messages were added to your balance.`);
    if (out.subscriptionEnd && out.product?.grants.some((g) => g.kind === 'bot_premium_tier')) lines.push(`Premium chat is active until ${day(out.subscriptionEnd)}.`);
    const buttons = [];
    for (const channelId of out.channelIds ?? []) {
      const link = await ensureJoinLink(u.svc, channelId);
      if (link) buttons.push([{ text: 'Join the premium channel', url: link }]);
    }
    if (buttons.length) lines.push('Tap below to join the premium channel; your request is approved automatically while your subscription is active.');
    await notifyFan(u.svc, u.bot, fan.id, lines.join('\n'), buttons.length ? buttons : undefined);
    return 'payment_recorded';
  });

  telegramHooks.onUpdate('refunded_payment', async (u) => {
    const r = u.update.message!.refunded_payment!;
    const outcome = await recordTelegramRefund(u.svc.workerPool, u.bot.workspace_id, r.telegram_payment_charge_id);
    if (outcome === 'completed') {
      const fan = await maybeOne<{ fan_id: string }>(u.svc.workerPool, 'SELECT fan_id FROM monetization.payments WHERE telegram_payment_charge_id = $1', [r.telegram_payment_charge_id]);
      if (fan) await notifyFan(u.svc, u.bot, fan.fan_id, `Your refund of ${stars(r.total_amount)} was processed.`);
    }
    return `refund_${outcome}`;
  });

  telegramHooks.onUpdate('chat_join_request', async (u) => {
    const jr = u.update.chat_join_request!;
    const channel = await premiumChannel(u.svc.workerPool, u.bot, String(jr.chat.id));
    if (!channel) return 'ignored';
    const identity = await maybeOne<{ fan_id: string }>(
      u.svc.workerPool,
      `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'telegram' AND platform_user_id = $2`,
      [u.bot.workspace_id, String(jr.from.id)],
    );
    const fan = identity ? await one<FanRow>(u.svc.workerPool, 'SELECT * FROM crm.fans WHERE id = $1', [identity.fan_id]) : null;
    const entitled = fan && fan.status === 'active' && (await hasEntitlement(u.svc.workerPool, fan.id, 'premium_channel_access', channel.id));
    if (!entitled) {
      await u.client.declineChatJoinRequest(jr.chat.id, jr.from.id).catch(ignoreHandled);
      await u.client.sendMessage(jr.user_chat_id, 'The premium channel is for subscribers. Open the bot and send /vip to subscribe.').catch(() => undefined);
      return 'join_declined';
    }
    await u.client.approveChatJoinRequest(jr.chat.id, jr.from.id).catch(ignoreHandled);
    await upsertMembership(u.svc.workerPool, channel, fan.id, jr.from.id, 'member');
    return 'join_approved';
  });

  telegramHooks.onUpdate('chat_member', async (u) => {
    const cm = u.update.chat_member!;
    const channel = await premiumChannel(u.svc.workerPool, u.bot, String(cm.chat.id));
    if (!channel) return 'ignored';
    const status = cm.new_chat_member.status;
    const userId = cm.new_chat_member.user.id;
    const identity = await maybeOne<{ fan_id: string }>(
      u.svc.workerPool,
      `SELECT fan_id FROM crm.fan_identities WHERE workspace_id = $1 AND platform = 'telegram' AND platform_user_id = $2`,
      [u.bot.workspace_id, String(userId)],
    );
    if (['left', 'kicked'].includes(status)) {
      await u.svc.workerPool.query(
        `UPDATE monetization.channel_memberships SET status = CASE WHEN $3 = 'kicked' THEN 'removed' ELSE 'left' END, left_at = now() WHERE channel_id = $1 AND telegram_user_id = $2 AND status = 'member'`,
        [channel.id, userId, status],
      );
      return 'member_left';
    }
    if (['member', 'restricted'].includes(status)) {
      await upsertMembership(u.svc.workerPool, channel, identity?.fan_id ?? null, userId, 'member');
      // Anyone who got in without an entitlement (e.g. an old link) is removed by the access audit.
      return 'member_joined';
    }
    return 'ignored';
  });
}

function ignoreHandled(err: unknown): void {
  // HIDE_REQUESTER_MISSING / USER_ALREADY_PARTICIPANT: the request was already handled.
  if (err instanceof TelegramApiError && err.code === 400) return;
  throw err;
}

registerTelegramSales();

interface ChannelRow {
  id: string;
  workspace_id: string;
  influencer_id: string;
  external_id: string;
  integration_account_id: string;
}

async function premiumChannel(db: pg.Pool, bot: BotRow, chatId: string): Promise<ChannelRow | null> {
  return maybeOne<ChannelRow>(
    db,
    `SELECT id, workspace_id, influencer_id, external_id, integration_account_id FROM publishing.channels
      WHERE kind = 'telegram_premium_channel' AND external_id = $1 AND integration_account_id = $2`,
    [chatId, bot.account_id],
  );
}

async function upsertMembership(db: pg.Pool, ch: ChannelRow, fanId: string | null, userId: number, status: 'member'): Promise<void> {
  await db.query(
    `INSERT INTO monetization.channel_memberships (workspace_id, channel_id, fan_id, telegram_user_id, status, joined_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (channel_id, telegram_user_id) DO UPDATE SET status = EXCLUDED.status, fan_id = coalesce(EXCLUDED.fan_id, monetization.channel_memberships.fan_id),
       joined_at = CASE WHEN monetization.channel_memberships.status = 'member' THEN monetization.channel_memberships.joined_at ELSE now() END,
       left_at = NULL, last_verified_at = now()`,
    [ch.workspace_id, ch.id, fanId, userId, status],
  );
}

/** One join-request link per premium channel; approval is decided per request by entitlement. */
export async function ensureJoinLink(svc: Services, channelId: string): Promise<string | null> {
  const db = svc.workerPool;
  const existing = await maybeOne<{ invite_link: string }>(
    db,
    `SELECT invite_link FROM monetization.invite_links WHERE channel_id = $1 AND kind = 'join_request' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [channelId],
  );
  if (existing) return existing.invite_link;
  const ch = await maybeOne<ChannelRow>(db, `SELECT id, workspace_id, influencer_id, external_id, integration_account_id FROM publishing.channels WHERE id = $1`, [channelId]);
  if (!ch) return null;
  const client = await clientForAccount(svc, ch.integration_account_id);
  const link = await client.createChatInviteLink(ch.external_id, { name: 'premium (approval)', createsJoinRequest: true });
  await db.query(
    `INSERT INTO monetization.invite_links (workspace_id, channel_id, kind, invite_link, name) VALUES ($1, $2, 'join_request', $3, 'premium (approval)') ON CONFLICT (invite_link) DO NOTHING`,
    [ch.workspace_id, ch.id, link.invite_link],
  );
  return link.invite_link;
}

/** Sends a recorded service message to a fan in the influencer's bot chat. */
async function notifyFan(svc: Services, bot: BotRow, fanId: string, text: string, buttons?: { text: string; url?: string; callback_data?: string }[][]): Promise<boolean> {
  const userId = await telegramUserIdOf(svc.workerPool, fanId);
  if (!userId || Number.isNaN(userId)) return false;
  const conv = await openConversation(svc.workerPool, {
    workspaceId: bot.workspace_id,
    influencerId: bot.influencer_id,
    channelId: bot.channel_id,
    fanId,
    externalChatId: String(userId),
  });
  if (conv.fan_id !== fanId) return false;
  await sendSystemMessage(svc, conv, text, 'service', buttons ? { buttons } : {});
  return true;
}

/** Removes a member from a channel without a permanent ban (ban + unban). */
async function removeFromChannel(svc: Services, ch: ChannelRow, userId: number, reason: string): Promise<void> {
  const client = await clientForAccount(svc, ch.integration_account_id);
  await client.banChatMember(ch.external_id, userId);
  await client.unbanChatMember(ch.external_id, userId);
  await svc.workerPool.query(
    `UPDATE monetization.channel_memberships SET status = 'removed', left_at = now(), removed_reason = $3 WHERE channel_id = $1 AND telegram_user_id = $2`,
    [ch.id, userId, reason],
  );
}

/** Job `monetization.access_changed`: an entitlement ended; enforce it on Telegram and tell the fan. */
async function accessChanged(svc: Services, p: { event_id: string; payload: { fan_id: string; influencer_id: string; kind: string; resource_id: string; reason?: string } }): Promise<unknown> {
  const db = svc.workerPool;
  const e = p.payload;
  if (await hasEntitlement(db, e.fan_id, e.kind as 'premium_channel_access', e.resource_id)) return { skipped: 'still_entitled' };
  const bot = await botForInfluencer(db, e.influencer_id);
  let removed = 0;
  if (e.kind === 'premium_channel_access') {
    const ch = await maybeOne<ChannelRow>(db, `SELECT id, workspace_id, influencer_id, external_id, integration_account_id FROM publishing.channels WHERE id = $1`, [e.resource_id]);
    const members = ch
      ? await db.query<{ telegram_user_id: string }>(`SELECT telegram_user_id FROM monetization.channel_memberships WHERE channel_id = $1 AND fan_id = $2 AND status = 'member'`, [ch.id, e.fan_id])
      : { rows: [] };
    for (const m of members.rows) {
      await removeFromChannel(svc, ch!, Number(m.telegram_user_id), e.reason ?? 'entitlement_ended');
      removed++;
    }
  }
  // Notify once per event (the job may be retried after a partial failure).
  if (bot && (await claimEvent(db, 'monetization.access_notice', p.event_id))) {
    const what = e.kind === 'premium_channel_access' ? 'premium channel access' : 'premium chat';
    await notifyFan(svc, bot, e.fan_id, `Your ${what} has ended${e.reason === 'refunded' ? ' (refunded)' : ''}. You can subscribe again with /vip.`).catch(() => false);
  }
  return { removed };
}

/** Hourly: anyone in a premium channel without an active entitlement is removed. */
async function channelAccessAudit(svc: Services): Promise<{ removed: number }> {
  const { rows } = await svc.workerPool.query<ChannelRow & { telegram_user_id: string; fan_id: string | null }>(
    `SELECT c.id, c.workspace_id, c.influencer_id, c.external_id, c.integration_account_id, m.telegram_user_id, m.fan_id
       FROM monetization.channel_memberships m JOIN publishing.channels c ON c.id = m.channel_id
      WHERE m.status = 'member' AND c.kind = 'telegram_premium_channel' AND c.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM monetization.entitlements e WHERE e.fan_id = m.fan_id AND e.kind = 'premium_channel_access' AND e.resource_id = c.id
                          AND e.status = 'active' AND e.valid_from <= now() AND (e.valid_until IS NULL OR e.valid_until > now()))
      LIMIT 500`,
  );
  let removed = 0;
  for (const r of rows) {
    try {
      await removeFromChannel(svc, r, Number(r.telegram_user_id), 'no_entitlement');
      removed++;
    } catch (err) {
      console.error(`[monetization] could not remove ${r.telegram_user_id} from ${r.external_id}: ${(err as Error).message}`);
    }
  }
  return { removed };
}

async function reconcileAll(svc: Services): Promise<unknown[]> {
  const out = [];
  for (const bot of await activeBots(svc.workerPool)) {
    const client = await clientForAccount(svc, bot.account_id);
    out.push({ bot: bot.bot_id, ...(await reconcileBot(svc, bot, client)) });
  }
  return out;
}

async function refundJob(svc: Services, refundId: string): Promise<unknown> {
  const pay = await maybeOne<{ influencer_id: string }>(
    svc.workerPool,
    'SELECT p.influencer_id FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id WHERE r.id = $1',
    [refundId],
  );
  if (!pay) return { skipped: 'not_found' };
  const bot = await botForInfluencer(svc.workerPool, pay.influencer_id);
  if (!bot) throw new Error('no active Telegram bot for the refund');
  const client = await clientForAccount(svc, bot.account_id);
  return executeRefund(svc, refundId, (userId, chargeId) => client.refundStarPayment(userId, chargeId));
}

// -----------------------------------------------------------------------------
// Staff: offers in a conversation, manual reconciliation
// -----------------------------------------------------------------------------
export async function staffOffer(_svc: Services, db: Db, ctx: Ctx, conversationId: string, productId: string): Promise<{ offerId: string }> {
  requirePermission(ctx, 'offer.send');
  const conv = await maybeOne<{ id: string; influencer_id: string; fan_id: string; channel_id: string }>(db, 'SELECT id, influencer_id, fan_id, channel_id FROM conversation.conversations WHERE id = $1', [conversationId]);
  if (!conv) throw notFound('Conversation', conversationId);
  requireInfluencerAccess(ctx, conv.influencer_id);
  const product = await maybeOne<ProductRow>(db, `SELECT * FROM monetization.products WHERE id = $1 AND influencer_id = $2`, [productId, conv.influencer_id]);
  if (!product) throw notFound('Product', productId);
  const offerId = uuidv7();
  await db.query(
    `INSERT INTO monetization.offers (id, workspace_id, influencer_id, product_id, fan_id, channel_id, conversation_id, price_stars, status, created_by_type, created_by_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', 'user', $9, now() + interval '24 hours')`,
    [offerId, ctx.workspaceId, conv.influencer_id, productId, conv.fan_id, conv.channel_id, conversationId, product.price_stars, ctx.userId],
  );
  await auditCtx(db, ctx, { influencerId: conv.influencer_id, action: 'offer.send', subjectType: 'offer', subjectId: offerId, metadata: { product_id: productId } });
  return { offerId };
}

/** Second half of a staff offer, after the tenant transaction committed the offer row. */
export async function deliverOffer(svc: Services, offerId: string): Promise<{ offer_id: string; order_id: string; invoice_link: string }> {
  const offer = await one<{ product_id: string; fan_id: string; conversation_id: string; influencer_id: string }>(
    svc.workerPool,
    'SELECT product_id, fan_id, conversation_id, influencer_id FROM monetization.offers WHERE id = $1',
    [offerId],
  );
  const { order, product } = await createOrder(svc, { fanId: offer.fan_id, productId: offer.product_id, offerId });
  const bot = await botForInfluencer(svc.workerPool, offer.influencer_id);
  if (!bot) throw new AppError(409, 'NO_BOT', 'The influencer has no active Telegram bot');
  const client = await clientForAccount(svc, bot.account_id);
  const link = await invoiceFor(svc, client, order, product);
  const conv = await one<import('../conversation/engine.js').ConversationRow>(svc.workerPool, 'SELECT * FROM conversation.conversations WHERE id = $1', [offer.conversation_id]);
  await sendSystemMessage(svc, conv, `${product.name} — ${stars(product.price_stars)}\n${product.description}\n\n${PURCHASE_NOTE}`, 'service', {
    buttons: [[{ text: `Pay ${stars(product.price_stars)}`, url: link }]],
  });
  await svc.workerPool.query(`UPDATE monetization.offers SET status = 'sent', invoice_link = $2 WHERE id = $1`, [offerId, link]);
  return { offer_id: offerId, order_id: order.id, invoice_link: link };
}

export async function reconcileNow(svc: Services, ctx: Ctx, influencerId: string): Promise<unknown> {
  requirePermission(ctx, 'payment.read');
  requireInfluencerAccess(ctx, influencerId);
  const bot = await botForInfluencer(svc.workerPool, influencerId);
  if (!bot || bot.workspace_id !== ctx.workspaceId) throw notFound('Telegram bot for influencer', influencerId);
  return reconcileBot(svc, bot, await clientForAccount(svc, bot.account_id));
}

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------
export function monetizationContribution(svc: Services, r: Registry): void {
  r.handlers.set('monetization.refund_execute', (job) => refundJob(svc, String(job.payload.refund_id)));
  r.handlers.set('monetization.access_changed', (job) => accessChanged(svc, job.payload as Parameters<typeof accessChanged>[1]));
  for (const event of ['monetization.entitlement_revoked', 'monetization.entitlement_expired']) {
    r.subscriptions.push({ event, job: 'monetization.access_changed', queue: 'payments', priority: PRIORITY.payments });
  }
  r.periodic.push(
    { name: 'monetization.subscription_expiry', intervalSeconds: 300, run: async () => ({ expired: await expireSubscriptions(svc.workerPool, svc.config.payments.subscriptionGraceHours) }) },
    { name: 'monetization.channel_access_audit', intervalSeconds: 3600, run: () => channelAccessAudit(svc) },
    { name: 'monetization.star_reconcile', intervalSeconds: 900, run: () => reconcileAll(svc) },
  );
}
