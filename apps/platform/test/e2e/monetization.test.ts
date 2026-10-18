/**
 * Telegram Stars monetization end to end — SIMULATED Telegram Bot API and
 * SIMULATED LLM. Proves catalog approval, signed invoices, pre-checkout
 * validation, idempotent payment recording, subscriptions and renewals,
 * credits, premium-channel join gating and removal, refunds with four-eyes
 * approval, Telegram-initiated refunds, expiry and ledger reconciliation.
 * Real Telegram payment behaviour (Stars, subscriptions, refunds) must still be
 * verified against Telegram itself before launch.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TgUser } from '../../src/integrations/telegram/client.js';
import { signInvoicePayload } from '../../src/modules/monetization/payments.js';
import { buildRegistry } from '../../src/registry.js';
import { type Client, type Stack, addMember, setupInfluencer, startStack } from '../helpers/stack.js';

const CHANNEL_CHAT_ID = '-1001234567890';

describe('monetization (SIMULATED Telegram Stars + SIMULATED LLM)', () => {
  let stack: Stack;
  let influencerId: string;
  let botToken: string;
  let channelId: string;
  let finance: { id: string; client: Client };
  const products: Record<string, string> = {};
  let nextUser = 500_000;
  let charge = 1;

  const tg = () => stack.telegram!;
  const db = () => stack.svc.workerPool;
  const pump = (passes = 4) => stack.drive(async () => false, passes).catch(() => undefined);
  const newUser = (name: string): TgUser => ({ id: ++nextUser, is_bot: false, first_name: name, language_code: 'en' });
  const textsTo = (chatId: number) =>
    tg()
      .sent(botToken, 'sendMessage')
      .filter((c) => Number(c.params.chat_id) === chatId)
      .map((c) => c.params);
  const fanId = async (u: TgUser) => (await db().query(`SELECT fan_id FROM crm.fan_identities WHERE platform_user_id = $1`, [String(u.id)])).rows[0]?.fan_id as string;
  const periodic = async (name: string) => {
    const t = buildRegistry(stack.svc).periodic.find((p) => p.name === name)!;
    return t.run();
  };

  async function onboard(u: TgUser): Promise<void> {
    tg().userMessage(botToken, u, '/start');
    await pump(2);
    tg().callback(botToken, u, 'consent:accept');
    await pump(2);
  }

  /** Buys a product through /vip → invoice → pre-checkout → payment. Returns the invoice payload and charge id. */
  async function buy(u: TgUser, productId: string, opts: { expiration?: number } = {}): Promise<{ payload: string; chargeId: string }> {
    tg().callback(botToken, u, `buy:${productId}`);
    await pump(2);
    const invoice = tg().sent(botToken, 'createInvoiceLink').at(-1)!.params;
    const payload = String(invoice.payload);
    const amount = (invoice.prices as { amount: number }[])[0]!.amount;
    tg().preCheckout(botToken, u, payload, amount);
    await pump(1);
    const pcq = [...tg().preCheckoutAnswers.values()].at(-1)!;
    assert.equal(pcq.ok, true, JSON.stringify(pcq));
    const chargeId = `stxSIM${charge++}`;
    tg().successfulPayment(botToken, u, {
      payload,
      amount,
      chargeId,
      ...(opts.expiration ? { subscriptionExpiration: opts.expiration, isRecurring: true, isFirstRecurring: true } : {}),
    });
    await stack.drive(async () => (await db().query(`SELECT 1 FROM monetization.payments WHERE telegram_payment_charge_id = $1`, [chargeId])).rowCount === 1);
    return { payload, chargeId };
  }

  before(async () => {
    stack = await startStack({ llm: true, telegram: true });
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    botToken = tg().addBot('golden_pay_bot').token;
    const bot = await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: botToken });
    assert.equal(bot.status, 201, JSON.stringify(bot.body));
    const ch = await owner.post(`/v1/influencers/${influencerId}/channels`, {
      integration_account_id: bot.body.account_id,
      kind: 'telegram_premium_channel',
      external_id: CHANNEL_CHAT_ID,
      title: 'Golden VIP',
    });
    assert.equal(ch.status, 201, JSON.stringify(ch.body));
    channelId = ch.body.id;
    finance = await addMember(stack, stack.ws.workspaceId, 'finance', 'finance');
  });
  after(async () => {
    await stack?.close();
  });

  it('catalog: manager drafts, a second person approves; self-approval and invalid grants are refused', async () => {
    const m = stack.ws.manager.client;
    const bad = await m.post(`/v1/influencers/${influencerId}/products`, {
      sku: 'vip',
      kind: 'premium_channel_subscription',
      name: 'VIP channel',
      description: 'x',
      price_stars: 250,
      grants: [{ kind: 'bot_premium_tier' }],
    });
    assert.equal(bad.status, 422);
    const defs = [
      { sku: 'vip', kind: 'premium_channel_subscription', name: 'VIP channel', description: 'Premium channel with exclusive AI-generated posts.', price_stars: 250, grants: [{ kind: 'premium_channel_access', channel_id: channelId }] },
      { sku: 'chat-plus', kind: 'bot_subscription', name: 'Chat Plus', description: 'More daily messages with the AI character.', price_stars: 150, grants: [{ kind: 'bot_premium_tier' }] },
      { sku: 'pack-100', kind: 'message_pack', name: '100 messages', description: '100 extra messages with the AI character.', price_stars: 50, grants: [{ kind: 'message_credits', quantity: 100 }] },
    ];
    for (const d of defs) {
      const p = await m.post(`/v1/influencers/${influencerId}/products`, d);
      assert.equal(p.status, 201, JSON.stringify(p.body));
      assert.equal((await m.post(`/v1/products/${p.body.id}/submit`)).status, 200);
      assert.equal((await m.post(`/v1/products/${p.body.id}/approve`)).status, 403, 'managers cannot approve products');
      const ok = await stack.ws.owner.client.post(`/v1/products/${p.body.id}/approve`);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.status, 'active');
      products[d.sku] = p.body.id;
    }
    assert.equal(Number((await db().query(`SELECT billing_period_seconds FROM monetization.products WHERE id = $1`, [products.vip])).rows[0].billing_period_seconds), 2592000);
    const own = await stack.ws.owner.client.post(`/v1/influencers/${influencerId}/products`, { ...defs[2], sku: 'pack-x' });
    await stack.ws.owner.client.post(`/v1/products/${own.body.id}/submit`);
    const self = await stack.ws.owner.client.post(`/v1/products/${own.body.id}/approve`);
    assert.equal(self.status, 403, 'four-eyes: the author cannot approve');
  });

  it('/vip lists products; invoices carry a signed payload and the 30-day subscription period', async () => {
    const u = newUser('Ari');
    await onboard(u);
    tg().userMessage(botToken, u, '/vip');
    await pump(2);
    const list = textsTo(u.id).at(-1)!;
    assert.match(String(list.text), /VIP channel — ⭐ 250 \/ 30 days/);
    assert.match(JSON.stringify(list.reply_markup), new RegExp(`buy:${products.vip}`));
    tg().callback(botToken, u, `buy:${products.vip}`);
    await pump(2);
    const inv = tg().sent(botToken, 'createInvoiceLink').at(-1)!.params;
    assert.equal(inv.currency, 'XTR');
    assert.equal(inv.subscription_period, 2592000);
    assert.match(String(inv.payload), /^o1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    assert.ok(String(inv.payload).length <= 128);
    assert.match(JSON.stringify(textsTo(u.id).at(-1)!.reply_markup), /sim_invoice/);
  });

  it('pre-checkout rejects tampered payloads, wrong amounts, other payers and restricted fans', async () => {
    const u = newUser('Bo');
    await onboard(u);
    tg().callback(botToken, u, `buy:${products['pack-100']}`);
    await pump(2);
    const payload = String(tg().sent(botToken, 'createInvoiceLink').at(-1)!.params.payload);
    const answer = async (user: TgUser, p: string, amount: number) => {
      tg().preCheckout(botToken, user, p, amount);
      await pump(1);
      return [...tg().preCheckoutAnswers.values()].at(-1)!;
    };
    const tampered = payload.slice(0, -2) + (payload.endsWith('AA') ? 'BB' : 'AA');
    assert.equal((await answer(u, tampered, 50)).ok, false);
    assert.equal((await answer(u, payload, 49)).ok, false, 'amount must match the order');
    // The order is now rejected; a fresh invoice is needed.
    tg().callback(botToken, u, `buy:${products['pack-100']}`);
    await pump(2);
    const fresh = String(tg().sent(botToken, 'createInvoiceLink').at(-1)!.params.payload);
    const stranger = newUser('Stranger');
    await onboard(stranger);
    assert.equal((await answer(stranger, fresh, 50)).ok, false, 'another account cannot pay this invoice');
    tg().callback(botToken, u, `buy:${products['pack-100']}`);
    await pump(2);
    const third = String(tg().sent(botToken, 'createInvoiceLink').at(-1)!.params.payload);
    await db().query(`UPDATE crm.fans SET age_status = 'suspected_minor', status = 'restricted' WHERE id = $1`, [await fanId(u)]);
    const minor = await answer(u, third, 50);
    assert.equal(minor.ok, false);
    assert.match(minor.error_message!, /not available|adults/);
  });

  it('channel subscription: payment recorded once, entitlement with grace, join link; join requests are gated', async () => {
    const u = newUser('Cyd');
    await onboard(u);
    const expiration = Math.floor(Date.now() / 1000) + 30 * 86400;
    const { chargeId, payload } = await buy(u, products.vip!, { expiration });
    // Redelivery of the same payment (same charge id) is a no-op.
    tg().successfulPayment(botToken, u, { payload, amount: 250, chargeId, subscriptionExpiration: expiration, isRecurring: true, isFirstRecurring: true });
    await pump(3);
    const fan = await fanId(u);
    const pays = await db().query(`SELECT kind, amount_stars FROM monetization.payments WHERE fan_id = $1`, [fan]);
    assert.equal(pays.rows.length, 1);
    assert.equal(pays.rows[0].kind, 'subscription_initial');
    const sub = await db().query(`SELECT status, current_period_end FROM monetization.subscriptions WHERE fan_id = $1`, [fan]);
    assert.equal(sub.rows[0].status, 'active');
    assert.equal(Math.round(sub.rows[0].current_period_end.getTime() / 1000), expiration);
    const ent = await db().query(`SELECT valid_until FROM monetization.entitlements WHERE fan_id = $1 AND kind = 'premium_channel_access' AND status = 'active'`, [fan]);
    assert.equal(Math.round(ent.rows[0].valid_until.getTime() / 1000), expiration + 48 * 3600, 'access lasts through the renewal grace period');
    const thanks = textsTo(u.id).at(-1)!;
    assert.match(String(thanks.text), /Thank you! Your payment of ⭐ 250/);
    assert.match(JSON.stringify(thanks.reply_markup), /t\.me\/\+sim/);
    assert.equal(tg().sent(botToken, 'createChatInviteLink')[0]!.params.creates_join_request, true);
    const profile = await db().query(`SELECT lifetime_stars, lifecycle_stage FROM crm.fan_influencer_profiles WHERE fan_id = $1`, [fan]);
    assert.equal(Number(profile.rows[0].lifetime_stars), 250);
    assert.equal(profile.rows[0].lifecycle_stage, 'subscriber');

    tg().joinRequest(botToken, Number(CHANNEL_CHAT_ID), u);
    const outsider = newUser('Outsider');
    tg().joinRequest(botToken, Number(CHANNEL_CHAT_ID), outsider);
    await pump(3);
    assert.ok(tg().sent(botToken, 'approveChatJoinRequest').some((c) => Number(c.params.user_id) === u.id));
    assert.ok(tg().sent(botToken, 'declineChatJoinRequest').some((c) => Number(c.params.user_id) === outsider.id));
    assert.ok(!tg().sent(botToken, 'approveChatJoinRequest').some((c) => Number(c.params.user_id) === outsider.id));
    const mem = await db().query(`SELECT status FROM monetization.channel_memberships WHERE telegram_user_id = $1`, [u.id]);
    assert.equal(mem.rows[0].status, 'member');

    // A second purchase of a live subscription is refused before payment.
    tg().callback(botToken, u, `buy:${products.vip}`);
    await pump(2);
    assert.match(String(textsTo(u.id).at(-1)!.text), /already have this subscription/);
  });

  it('renewal extends the subscription and the same entitlement; /subscription cancels renewal', async () => {
    const u = newUser('Dee');
    await onboard(u);
    const first = Math.floor(Date.now() / 1000) + 30 * 86400;
    const { payload } = await buy(u, products['chat-plus']!, { expiration: first });
    const fan = await fanId(u);
    const entBefore = await db().query(`SELECT id FROM monetization.entitlements WHERE fan_id = $1 AND kind = 'bot_premium_tier' AND status = 'active'`, [fan]);
    const second = first + 30 * 86400;
    tg().successfulPayment(botToken, u, { payload, amount: 150, chargeId: 'stxRENEW1', subscriptionExpiration: second, isRecurring: true, isFirstRecurring: false });
    await stack.drive(async () => (await db().query(`SELECT 1 FROM monetization.payments WHERE telegram_payment_charge_id = 'stxRENEW1'`)).rowCount === 1);
    const sub = await db().query(`SELECT id, renewal_count, current_period_end FROM monetization.subscriptions WHERE fan_id = $1`, [fan]);
    assert.equal(sub.rows.length, 1);
    assert.equal(sub.rows[0].renewal_count, 1);
    assert.equal(Math.round(sub.rows[0].current_period_end.getTime() / 1000), second);
    const entAfter = await db().query(`SELECT id, valid_until FROM monetization.entitlements WHERE fan_id = $1 AND kind = 'bot_premium_tier' AND status = 'active'`, [fan]);
    assert.equal(entAfter.rows.length, 1);
    assert.equal(entAfter.rows[0].id, entBefore.rows[0].id, 'renewal extends instead of duplicating');
    assert.equal((await db().query(`SELECT kind FROM monetization.payments WHERE telegram_payment_charge_id = 'stxRENEW1'`)).rows[0].kind, 'subscription_renewal');

    tg().userMessage(botToken, u, '/subscription');
    await pump(2);
    assert.match(JSON.stringify(textsTo(u.id).at(-1)!.reply_markup), /sub:cancel:/);
    tg().callback(botToken, u, `sub:cancel:${sub.rows[0].id}`);
    await pump(2);
    const edit = tg().sent(botToken, 'editUserStarSubscription').at(-1)!.params;
    assert.equal(edit.is_canceled, true);
    assert.equal(Number(edit.user_id), u.id);
    assert.equal((await db().query(`SELECT status, auto_renew FROM monetization.subscriptions WHERE id = $1`, [sub.rows[0].id])).rows[0].status, 'cancelled');
    assert.match(String(textsTo(u.id).at(-1)!.text), /keep access until/);
  });

  it('message pack: credits are added and consumed once the free allowance is used up', async () => {
    const u = newUser('Eli');
    await onboard(u);
    await buy(u, products['pack-100']!);
    const fan = await fanId(u);
    const bal = async () => (await db().query(`SELECT balance FROM monetization.credit_balances WHERE fan_id = $1`, [fan])).rows[0].balance;
    assert.equal(await bal(), 100);
    const conv = (await db().query(`SELECT id FROM conversation.conversations WHERE fan_id = $1`, [fan])).rows[0].id;
    await stack.ws.owner.client.patch(`/v1/conversations/${conv}`, { mode: 'ai_auto' });
    // free_replies_per_day defaults to 0 for a new influencer: every reply uses a credit.
    tg().userMessage(botToken, u, 'hello from a paying fan');
    await stack.drive(async () => (await bal()) === 99);
    const ledger = await db().query(`SELECT reason, delta FROM monetization.credit_ledger WHERE fan_id = $1 ORDER BY id`, [fan]);
    assert.deepEqual(
      ledger.rows.map((r) => [r.reason, r.delta]),
      [
        ['purchase', 100],
        ['consumption', -1],
      ],
    );
  });

  it('refunds need a second approver; execution revokes access and removes the fan from the channel', async () => {
    const u = newUser('Fox');
    await onboard(u);
    const { chargeId } = await buy(u, products.vip!, { expiration: Math.floor(Date.now() / 1000) + 30 * 86400 });
    tg().joinRequest(botToken, Number(CHANNEL_CHAT_ID), u);
    await pump(3);
    const pay = (await db().query(`SELECT id FROM monetization.payments WHERE telegram_payment_charge_id = $1`, [chargeId])).rows[0];
    const owner = stack.ws.owner.client;
    const req = await owner.post(`/v1/payments/${pay.id}/refunds`, { reason: 'Fan reported they bought by mistake' });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal((await owner.post(`/v1/payments/${pay.id}/refunds`, { reason: 'again' })).status, 409);
    assert.equal((await owner.post(`/v1/refunds/${req.body.id}/approve`, {})).status, 403, 'requester cannot approve');
    assert.equal((await stack.ws.manager.client.post(`/v1/refunds/${req.body.id}/approve`, {})).status, 403);
    const ok = await finance.client.post(`/v1/refunds/${req.body.id}/approve`, { note: 'verified' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await stack.drive(async () => (await db().query(`SELECT status FROM monetization.refunds WHERE id = $1`, [req.body.id])).rows[0].status === 'completed');
    const call = tg().sent(botToken, 'refundStarPayment').at(-1)!.params;
    assert.equal(call.telegram_payment_charge_id, chargeId);
    assert.equal(Number(call.user_id), u.id);
    const fan = await fanId(u);
    assert.equal((await db().query(`SELECT status FROM monetization.subscriptions WHERE fan_id = $1`, [fan])).rows[0].status, 'refunded');
    await stack.drive(async () => (await db().query(`SELECT status FROM monetization.channel_memberships WHERE telegram_user_id = $1`, [u.id])).rows[0].status === 'removed');
    assert.ok(tg().sent(botToken, 'banChatMember').some((c) => Number(c.params.user_id) === u.id));
    assert.ok(tg().sent(botToken, 'unbanChatMember').some((c) => Number(c.params.user_id) === u.id && c.params.only_if_banned === true), 'removal is not a permanent ban');
    assert.ok(textsTo(u.id).some((t) => /premium channel access has ended \(refunded\)/.test(String(t.text))));
    const op = await db().query(`SELECT status FROM core.external_operations WHERE idempotency_key = $1`, [`telegram.refund:${req.body.id}`]);
    assert.equal(op.rows[0].status, 'succeeded');
  });

  it('a refund initiated by Telegram is recorded once and reverses unused credits', async () => {
    const u = newUser('Gus');
    await onboard(u);
    const { chargeId, payload } = await buy(u, products['pack-100']!);
    const refunded = () =>
      tg().push(botToken, {
        message: {
          message_id: Math.floor(Math.random() * 1e9),
          date: Math.floor(Date.now() / 1000),
          chat: { id: u.id, type: 'private' },
          from: u,
          refunded_payment: { currency: 'XTR', total_amount: 50, invoice_payload: payload, telegram_payment_charge_id: chargeId },
        },
      });
    refunded();
    refunded();
    const fan = await fanId(u);
    await stack.drive(async () => (await db().query(`SELECT count(*)::int AS n FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id WHERE p.fan_id = $1 AND r.status = 'completed'`, [fan])).rows[0].n === 1);
    await pump(3);
    const n = await db().query(`SELECT count(*)::int AS n FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id WHERE p.fan_id = $1`, [fan]);
    assert.equal(n.rows[0].n, 1);
    assert.equal((await db().query(`SELECT balance FROM monetization.credit_balances WHERE fan_id = $1`, [fan])).rows[0].balance, 0);
  });

  it('expiry: past period plus grace ends the subscription, expires access and removes channel members', async () => {
    const u = newUser('Hal');
    await onboard(u);
    await buy(u, products.vip!, { expiration: Math.floor(Date.now() / 1000) + 30 * 86400 });
    tg().joinRequest(botToken, Number(CHANNEL_CHAT_ID), u);
    await pump(3);
    const fan = await fanId(u);
    await db().query(`UPDATE monetization.subscriptions SET current_period_start = now() - interval '40 days', current_period_end = now() - interval '3 days' WHERE fan_id = $1`, [fan]);
    await db().query(`UPDATE monetization.entitlements SET valid_from = now() - interval '40 days', valid_until = now() - interval '1 hour' WHERE fan_id = $1`, [fan]);
    await periodic('monetization.subscription_expiry');
    await periodic('monetization.entitlement_sweep');
    assert.equal((await db().query(`SELECT status FROM monetization.subscriptions WHERE fan_id = $1`, [fan])).rows[0].status, 'expired');
    await stack.drive(async () => (await db().query(`SELECT status FROM monetization.channel_memberships WHERE telegram_user_id = $1`, [u.id])).rows[0].status === 'removed');
  });

  it('a payment that matches no order is still recorded and raises a critical alert', async () => {
    const u = newUser('Ivy');
    await onboard(u);
    tg().successfulPayment(botToken, u, { payload: 'not-a-valid-payload', amount: 77, chargeId: 'stxORPHAN' });
    await stack.drive(async () => (await db().query(`SELECT 1 FROM monetization.payments WHERE telegram_payment_charge_id = 'stxORPHAN'`)).rowCount === 1);
    const alert = await db().query(`SELECT severity FROM ops.alerts WHERE code = 'PAYMENT_UNMATCHED' AND status = 'open'`);
    assert.equal(alert.rows[0].severity, 'critical');
  });

  it('reconciliation matches the ledger, heals a lost payment update and a lost refund, ignores withdrawals', async () => {
    const pays = await db().query<{ telegram_payment_charge_id: string; amount_stars: string; raw: { telegram_user_id: number; invoice_payload: string } }>(
      `SELECT telegram_payment_charge_id, amount_stars, raw FROM monetization.payments`,
    );
    const old = Math.floor(Date.now() / 1000) - 600;
    for (const p of pays.rows) {
      tg().addStarTransaction(botToken, {
        id: p.telegram_payment_charge_id,
        amount: Number(p.amount_stars),
        date: old,
        source: { type: 'user', user: { id: p.raw.telegram_user_id, is_bot: false, first_name: 'x' }, invoice_payload: p.raw.invoice_payload },
      });
    }
    const refunded = await db().query<{ telegram_payment_charge_id: string; amount_stars: string; telegram_user_id: string }>(
      `SELECT p.telegram_payment_charge_id, p.amount_stars, p.raw->>'telegram_user_id' AS telegram_user_id FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id WHERE r.status = 'completed'`,
    );
    for (const r of refunded.rows) {
      tg().addStarTransaction(botToken, { id: r.telegram_payment_charge_id, amount: Number(r.amount_stars), date: old, receiver: { type: 'user', user: { id: Number(r.telegram_user_id), is_bot: false, first_name: 'x' } } });
    }
    // A payment whose update was lost: valid order, money in the ledger, nothing recorded.
    const u = newUser('Jo');
    await onboard(u);
    tg().callback(botToken, u, `buy:${products['pack-100']}`);
    await pump(2);
    const lostPayload = String(tg().sent(botToken, 'createInvoiceLink').at(-1)!.params.payload);
    tg().addStarTransaction(botToken, { id: 'stxLOST', amount: 50, date: old, source: { type: 'user', user: u, invoice_payload: lostPayload } });
    // A refund done by Telegram support whose update was lost.
    const victim = pays.rows.find((p) => Number(p.amount_stars) === 150)!;
    tg().addStarTransaction(botToken, { id: victim.telegram_payment_charge_id, amount: 150, date: old, receiver: { type: 'user', user: { id: victim.raw.telegram_user_id, is_bot: false, first_name: 'x' } } });
    tg().addStarTransaction(botToken, { id: 'wd-1', amount: 1000, date: old, receiver: { type: 'fragment' } });

    const run = await stack.ws.owner.client.post(`/v1/influencers/${influencerId}/reconciliation/run`);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.healed, 2);
    assert.equal(run.body.unmatched, 0);
    const fan = await fanId(u);
    assert.equal((await db().query(`SELECT balance FROM monetization.credit_balances WHERE fan_id = $1`, [fan])).rows[0].balance, 100, 'the lost payment was fulfilled');
    const recovered = await db().query(`SELECT 1 FROM ops.alerts WHERE code = 'PAYMENT_RECOVERED_FROM_LEDGER'`);
    assert.equal(recovered.rowCount, 1);
    const report = await finance.client.get(`/v1/influencers/${influencerId}/reconciliation`);
    assert.equal(report.status, 200);
    assert.equal(report.body.ledger.unmatched, 0);
    assert.equal(report.body.ledger.ignored, 1);
    assert.equal(report.body.net_stars_platform, report.body.net_stars_ledger, 'platform and Telegram ledger agree');
    // Running again fetches nothing new (cursor) and changes nothing.
    const again = await stack.ws.owner.client.post(`/v1/influencers/${influencerId}/reconciliation/run`);
    assert.equal(again.body.fetched, 0);
  });

  it('signed payloads cannot be forged without the secret', () => {
    const p = signInvoicePayload(Buffer.from('another-secret'), '01234567-89ab-cdef-0123-456789abcdef');
    assert.match(p, /^o1\./);
    assert.notEqual(p, signInvoicePayload(stack.svc.config.payments.invoiceSecret, '01234567-89ab-cdef-0123-456789abcdef'));
  });
});
