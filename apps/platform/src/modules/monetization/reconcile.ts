import type pg from 'pg';
import type { Db } from '../../db/tx.js';
import { maybeOne, one } from '../../db/tx.js';
import type { TgStarTransaction, TelegramClient } from '../../integrations/telegram/client.js';
import type { Services } from '../../services.js';
import { raiseAlert } from '../alerts.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from '../context.js';
import { upsertTelegramFan } from '../crm.js';
import { recordPayment, recordTelegramRefund } from './payments.js';

/**
 * Reconciliation against Telegram's own ledger (getStarTransactions). Every
 * incoming Stars transaction must match a recorded payment; every outgoing
 * one to a user must match a completed refund. Gaps caused by lost updates
 * are healed from the ledger and reported; anything that cannot be healed
 * raises an alert. Withdrawals and other partners are recorded as ignored.
 */
export interface ReconcileBot {
  account_id: string;
  workspace_id: string;
  influencer_id: string;
}

const PAGE = 100;

export async function reconcileBot(svc: Services, bot: ReconcileBot, client: TelegramClient): Promise<{ fetched: number; healed: number; unmatched: number }> {
  const db = svc.workerPool;
  const cur = await maybeOne<{ cursor: string }>(db, `SELECT cursor FROM core.poll_cursors WHERE source = 'telegram_star_transactions' AND account_ref = $1`, [bot.account_id]);
  let offset = cur ? Number(cur.cursor) : 0;
  let fetched = 0;
  for (;;) {
    const page = await client.getStarTransactions(offset, PAGE);
    for (const tx of page.transactions) await storeTransaction(db, bot, tx);
    fetched += page.transactions.length;
    offset += page.transactions.length;
    await db.query(
      `INSERT INTO core.poll_cursors (source, account_ref, cursor) VALUES ('telegram_star_transactions', $1, $2)
       ON CONFLICT (source, account_ref) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [bot.account_id, String(offset)],
    );
    if (page.transactions.length < PAGE) break;
  }
  const { healed, unmatched } = await matchTransactions(svc, bot);
  await reportPaymentsMissingFromLedger(db, bot);
  return { fetched, healed, unmatched };
}

function direction(tx: TgStarTransaction): 'in' | 'out' {
  return tx.source ? 'in' : 'out';
}

async function storeTransaction(db: pg.Pool, bot: ReconcileBot, tx: TgStarTransaction): Promise<void> {
  const dir = direction(tx);
  const partner = dir === 'in' ? tx.source : tx.receiver;
  // Only user payments and refunds are reconciled; withdrawals (fragment), ads etc. are recorded as ignored.
  const relevant = partner?.type === 'user';
  await db.query(
    `INSERT INTO monetization.star_transactions (workspace_id, integration_account_id, external_tx_id, amount_stars, nanostar_amount, direction, partner, occurred_at, match_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9)
     ON CONFLICT (integration_account_id, external_tx_id) DO NOTHING`,
    [bot.workspace_id, bot.account_id, `${dir}:${tx.id}`, tx.amount, tx.nanostar_amount ?? null, dir, JSON.stringify(redactPartner(partner)), tx.date, relevant ? 'unmatched' : 'ignored'],
  );
}

/** Keeps ids and invoice payloads; drops names and usernames. */
function redactPartner(p: TgStarTransaction['source']): Record<string, unknown> | null {
  if (!p) return null;
  const { user, ...rest } = p;
  return { ...rest, ...(user ? { user_id: user.id } : {}) };
}

async function matchTransactions(svc: Services, bot: ReconcileBot): Promise<{ healed: number; unmatched: number }> {
  const db = svc.workerPool;
  const { rows } = await db.query<{ id: string; external_tx_id: string; direction: 'in' | 'out'; amount_stars: string; partner: Record<string, unknown> | null; occurred_at: Date }>(
    `SELECT id, external_tx_id, direction, amount_stars, partner, occurred_at FROM monetization.star_transactions
      WHERE integration_account_id = $1 AND match_status = 'unmatched' ORDER BY occurred_at`,
    [bot.account_id],
  );
  let healed = 0;
  let unmatched = 0;
  for (const t of rows) {
    const chargeId = t.external_tx_id.slice(t.external_tx_id.indexOf(':') + 1);
    if (t.direction === 'in') {
      let pay = await maybeOne<{ id: string }>(db, 'SELECT id FROM monetization.payments WHERE telegram_payment_charge_id = $1', [chargeId]);
      if (!pay && t.occurred_at.getTime() < Date.now() - 5 * 60_000) {
        pay = await healPayment(svc, bot, t, chargeId);
        if (pay) healed++;
      }
      if (pay) {
        await db.query(`UPDATE monetization.star_transactions SET match_status = 'matched', matched_payment_id = $2 WHERE id = $1`, [t.id, pay.id]);
        continue;
      }
    } else {
      const pay = await maybeOne<{ id: string }>(db, 'SELECT id FROM monetization.payments WHERE telegram_payment_charge_id = $1', [chargeId]);
      if (pay) {
        let refund = await maybeOne<{ id: string }>(db, `SELECT id FROM monetization.refunds WHERE payment_id = $1 AND status = 'completed'`, [pay.id]);
        if (!refund) {
          // Refunded on Telegram's side but not recorded here (lost update or support refund).
          await recordTelegramRefund(db, bot.workspace_id, chargeId);
          refund = await maybeOne<{ id: string }>(db, `SELECT id FROM monetization.refunds WHERE payment_id = $1 AND status = 'completed'`, [pay.id]);
          if (refund) healed++;
        }
        if (refund) {
          await db.query(`UPDATE monetization.star_transactions SET match_status = 'matched', matched_refund_id = $2 WHERE id = $1`, [t.id, refund.id]);
          continue;
        }
      }
    }
    unmatched++;
    if (t.occurred_at.getTime() < Date.now() - 60 * 60_000) {
      await raiseAlert(db, {
        workspaceId: bot.workspace_id,
        severity: 'critical',
        source: 'payments',
        code: 'STAR_TX_UNMATCHED',
        dedupKey: `star_tx_unmatched:${t.id}`,
        message: `Telegram ledger ${t.direction === 'in' ? 'payment' : 'refund'} of ${t.amount_stars} Stars has no matching record`,
        details: { star_transaction_id: t.id, external_tx_id: t.external_tx_id },
      });
    }
  }
  return { healed, unmatched };
}

/** Records a payment that Telegram's ledger shows but whose update never arrived. */
async function healPayment(
  svc: Services,
  bot: ReconcileBot,
  t: { amount_stars: string; partner: Record<string, unknown> | null },
  chargeId: string,
): Promise<{ id: string } | null> {
  const userId = Number(t.partner?.user_id);
  const payload = typeof t.partner?.invoice_payload === 'string' ? t.partner.invoice_payload : null;
  if (!userId || !payload) return null;
  const { fan } = await upsertTelegramFan(svc.workerPool, bot.workspace_id, bot.influencer_id, { id: userId });
  const isSub = typeof t.partner?.subscription_period === 'number';
  const live = isSub
    ? await maybeOne(svc.workerPool, `SELECT 1 FROM monetization.subscriptions WHERE fan_id = $1 AND status IN ('active', 'cancelled', 'payment_failed')`, [fan.id])
    : null;
  const out = await recordPayment(svc, {
    workspaceId: bot.workspace_id,
    influencerId: bot.influencer_id,
    fanId: fan.id,
    telegramUserId: userId,
    payment: { currency: 'XTR', total_amount: Number(t.amount_stars), invoice_payload: payload, telegram_payment_charge_id: chargeId, is_recurring: isSub, is_first_recurring: isSub && !live },
  });
  if (!out.paymentId) return null;
  await raiseAlert(svc.workerPool, {
    workspaceId: bot.workspace_id,
    severity: 'warning',
    source: 'payments',
    code: 'PAYMENT_RECOVERED_FROM_LEDGER',
    dedupKey: `payment_recovered:${out.paymentId}`,
    message: `A ${t.amount_stars}-Star payment was recovered from Telegram's ledger (its update never arrived)`,
    details: { payment_id: out.paymentId, charge_id: chargeId },
  });
  return { id: out.paymentId };
}

async function reportPaymentsMissingFromLedger(db: pg.Pool, bot: ReconcileBot): Promise<void> {
  const { rows } = await db.query<{ id: string; amount_stars: string }>(
    `SELECT p.id, p.amount_stars FROM monetization.payments p
      WHERE p.influencer_id = $1 AND p.received_at < now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM monetization.star_transactions t WHERE t.matched_payment_id = p.id)`,
    [bot.influencer_id],
  );
  for (const p of rows) {
    await raiseAlert(db, {
      workspaceId: bot.workspace_id,
      severity: 'warning',
      source: 'payments',
      code: 'PAYMENT_NOT_IN_LEDGER',
      dedupKey: `payment_not_in_ledger:${p.id}`,
      message: `Payment of ${p.amount_stars} Stars is not in Telegram's ledger after 24 hours`,
      details: { payment_id: p.id },
    });
  }
}

export async function reconciliationReport(db: Db, ctx: Ctx, influencerId: string): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'payment.read');
  requireInfluencerAccess(ctx, influencerId);
  const accounts = await db.query<{ id: string }>(`SELECT id FROM core.integration_accounts WHERE influencer_id = $1 AND provider = 'telegram_bot'`, [influencerId]);
  const ids = accounts.rows.map((a) => a.id);
  const ledger = await one<{ in_stars: string; out_stars: string; matched: number; unmatched: number; ignored: number; last_synced: Date | null }>(
    db,
    `SELECT coalesce(sum(amount_stars) FILTER (WHERE direction = 'in' AND match_status <> 'ignored'), 0) AS in_stars,
            coalesce(sum(amount_stars) FILTER (WHERE direction = 'out' AND match_status <> 'ignored'), 0) AS out_stars,
            count(*) FILTER (WHERE match_status = 'matched')::int AS matched,
            count(*) FILTER (WHERE match_status = 'unmatched')::int AS unmatched,
            count(*) FILTER (WHERE match_status = 'ignored')::int AS ignored,
            max(synced_at) AS last_synced
       FROM monetization.star_transactions WHERE integration_account_id = ANY($1::uuid[])`,
    [ids],
  );
  const payments = await one<{ count: number; stars: string; not_in_ledger: number }>(
    db,
    `SELECT count(*)::int AS count, coalesce(sum(amount_stars), 0) AS stars,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM monetization.star_transactions t WHERE t.matched_payment_id = p.id))::int AS not_in_ledger
       FROM monetization.payments p WHERE p.influencer_id = $1`,
    [influencerId],
  );
  const refunds = await one<{ count: number; stars: string }>(
    db,
    `SELECT count(*)::int AS count, coalesce(sum(r.amount_stars), 0) AS stars FROM monetization.refunds r JOIN monetization.payments p ON p.id = r.payment_id
      WHERE p.influencer_id = $1 AND r.status = 'completed'`,
    [influencerId],
  );
  const unmatched = await db.query(
    `SELECT id, external_tx_id, direction, amount_stars, occurred_at FROM monetization.star_transactions
      WHERE integration_account_id = ANY($1::uuid[]) AND match_status = 'unmatched' ORDER BY occurred_at LIMIT 100`,
    [ids],
  );
  return {
    ledger: { ...ledger, in_stars: Number(ledger.in_stars), out_stars: Number(ledger.out_stars) },
    payments: { ...payments, stars: Number(payments.stars) },
    refunds: { ...refunds, stars: Number(refunds.stars) },
    net_stars_platform: Number(payments.stars) - Number(refunds.stars),
    net_stars_ledger: Number(ledger.in_stars) - Number(ledger.out_stars),
    unmatched_transactions: unmatched.rows,
    note: 'Stars are valued in fiat only when withdrawn (monetization.payouts); no fixed exchange rate is applied.',
  };
}
