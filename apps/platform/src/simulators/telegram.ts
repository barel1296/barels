/**
 * SIMULATED Telegram Bot API server for automated tests. It implements the
 * subset of methods the platform calls, keeps per-bot update queues for
 * getUpdates, and records everything bots send. It is NOT Telegram: behaviour
 * that must be confirmed against the real API (docs/02, docs/08 Stage-0 items)
 * is not proven by tests that use it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { TgStarTransaction, TgUpdate, TgUser } from '../integrations/telegram/client.js';

interface SimBot {
  token: string;
  id: number;
  username: string;
  updates: TgUpdate[];
  nextUpdateId: number;
  nextMessageId: number;
  starTransactions: TgStarTransaction[];
}

export interface SentCall {
  bot: string;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface TelegramSimulator {
  app: FastifyInstance;
  baseUrl: string;
  calls: SentCall[];
  addBot(username: string): { token: string; id: number };
  /** Queues an update for a bot (update_id assigned). */
  push(token: string, update: Omit<TgUpdate, 'update_id'>): number;
  userMessage(token: string, user: TgUser, text: string): number;
  callback(token: string, user: TgUser, data: string): number;
  preCheckout(token: string, user: TgUser, payload: string, amount: number): number;
  successfulPayment(token: string, user: TgUser, p: { payload: string; amount: number; chargeId: string; subscriptionExpiration?: number; isRecurring?: boolean; isFirstRecurring?: boolean }): number;
  joinRequest(token: string, chatId: number, user: TgUser): number;
  addStarTransaction(token: string, tx: TgStarTransaction): void;
  sent(token: string, method?: string): SentCall[];
  /** Results of answerPreCheckoutQuery calls by query id. */
  preCheckoutAnswers: Map<string, { ok: boolean; error_message?: string }>;
  failNext(method: string, code: number, description: string, retryAfter?: number): void;
  close(): Promise<void>;
}

/** Minimal multipart reader: text fields as strings, files as {filename, bytes}. Enough to assert what was uploaded. */
function parseMultipart(contentType: string, body: Buffer): Record<string, unknown> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const out: Record<string, unknown> = { multipart_bytes: body.length };
  if (!boundary) return out;
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const files: { field: string; filename: string; bytes: number; mime: string }[] = [];
  let pos = body.indexOf(sep);
  while (pos >= 0) {
    const next = body.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = body.subarray(pos + sep.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const content = part.subarray(headerEnd + 4);
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/.exec(headers)?.[1];
      const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? 'application/octet-stream';
      if (name && filename !== undefined) files.push({ field: name, filename, bytes: content.length, mime });
      else if (name) out[name] = content.toString('utf8');
    }
    pos = next;
  }
  out.files = files;
  if (typeof out.media === 'string') {
    try {
      out.media_count = (JSON.parse(out.media) as unknown[]).length;
    } catch {
      // leave as text
    }
  }
  return out;
}

export async function startTelegramSimulator(): Promise<TelegramSimulator> {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  const bots = new Map<string, SimBot>();
  const calls: SentCall[] = [];
  const preCheckoutAnswers = new Map<string, { ok: boolean; error_message?: string }>();
  const failures: { method: string; code: number; description: string; retryAfter?: number }[] = [];
  let nextBotId = 7_000_000_001;
  let nextQuery = 1;

  // Multipart uploads (sendPhoto) are accepted and recorded by size only.
  app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer' }, (req, body, done) => done(null, parseMultipart(String(req.headers['content-type']), body as Buffer)));

  const ok = (result: unknown) => ({ ok: true, result });
  const err = (code: number, description: string, retryAfter?: number) => ({ ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) });

  app.post<{ Params: { token: string; method: string } }>('/bot:token/:method', async (req, reply) => {
    const bot = bots.get(req.params.token);
    if (!bot) return reply.status(401).send(err(401, 'Unauthorized'));
    const method = req.params.method;
    const params = (req.body ?? {}) as Record<string, unknown>;
    const failIdx = failures.findIndex((f) => f.method === method);
    if (failIdx >= 0) {
      const f = failures.splice(failIdx, 1)[0]!;
      return reply.status(f.code).send(err(f.code, f.description, f.retryAfter));
    }
    if (method !== 'getUpdates') calls.push({ bot: bot.token, method, params, at: Date.now() });
    const self: TgUser = { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username };
    switch (method) {
      case 'getMe':
        return ok(self);
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0);
        bot.updates = bot.updates.filter((u) => u.update_id >= offset);
        const timeout = Math.min(Number(params.timeout ?? 0), 1);
        if (bot.updates.length === 0 && timeout > 0) await new Promise((r) => setTimeout(r, timeout * 200));
        return ok(bot.updates.slice(0, 100));
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendVideo': {
        const chatId = Number(params.chat_id);
        return ok({ message_id: bot.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId < 0 ? 'channel' : 'private' }, from: self, text: params.text ?? undefined });
      }
      case 'sendMediaGroup': {
        const chatId = Number(params.chat_id);
        const n = Math.max(1, Number(params.media_count ?? 2));
        return ok(Array.from({ length: n }, () => ({ message_id: bot.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'channel' }, from: self })));
      }
      case 'answerPreCheckoutQuery':
        preCheckoutAnswers.set(String(params.pre_checkout_query_id), { ok: Boolean(params.ok), ...(params.error_message ? { error_message: String(params.error_message) } : {}) });
        return ok(true);
      case 'createInvoiceLink':
        return ok(`https://t.me/$sim_invoice_${bot.id}_${calls.length}`);
      case 'createChatInviteLink':
        return ok({ invite_link: `https://t.me/+sim${bot.id}_${calls.length}`, creates_join_request: Boolean(params.creates_join_request) });
      case 'getChatMember':
        return ok({ status: 'member', user: { id: Number(params.user_id), is_bot: false, first_name: 'fan' } });
      case 'getChatMemberCount':
        return ok(42);
      case 'getStarTransactions': {
        const off = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 100);
        return ok({ transactions: bot.starTransactions.slice(off, off + limit) });
      }
      case 'sendChatAction':
      case 'answerCallbackQuery':
      case 'setMyCommands':
      case 'setMyDescription':
      case 'setMyShortDescription':
      case 'approveChatJoinRequest':
      case 'declineChatJoinRequest':
      case 'banChatMember':
      case 'unbanChatMember':
      case 'refundStarPayment':
      case 'editUserStarSubscription':
        return ok(true);
      default:
        return reply.status(404).send(err(404, `Not Found: method ${method} not simulated`));
    }
  });

  const push = (token: string, update: Omit<TgUpdate, 'update_id'>): number => {
    const bot = bots.get(token)!;
    const id = bot.nextUpdateId++;
    bot.updates.push({ ...update, update_id: id } as TgUpdate);
    return id;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  return {
    app,
    baseUrl: address,
    calls,
    preCheckoutAnswers,
    addBot(username) {
      const id = nextBotId++;
      const token = `${id}:SIM${Math.random().toString(36).slice(2, 14)}${'x'.repeat(20)}`;
      bots.set(token, { token, id, username, updates: [], nextUpdateId: 1, nextMessageId: 1, starTransactions: [] });
      return { token, id };
    },
    push,
    userMessage: (token, user, text) => push(token, { message: { message_id: Math.floor(Math.random() * 1e9), date: now(), chat: { id: user.id, type: 'private' }, from: user, text } }),
    callback: (token, user, data) =>
      push(token, { callback_query: { id: `cbq-${nextQuery++}`, from: user, data, message: { message_id: 1, date: now(), chat: { id: user.id, type: 'private' } } } }),
    preCheckout: (token, user, payload, amount) => push(token, { pre_checkout_query: { id: `pcq-${nextQuery++}`, from: user, currency: 'XTR', total_amount: amount, invoice_payload: payload } }),
    successfulPayment: (token, user, p) =>
      push(token, {
        message: {
          message_id: Math.floor(Math.random() * 1e9),
          date: now(),
          chat: { id: user.id, type: 'private' },
          from: user,
          successful_payment: {
            currency: 'XTR',
            total_amount: p.amount,
            invoice_payload: p.payload,
            telegram_payment_charge_id: p.chargeId,
            ...(p.subscriptionExpiration ? { subscription_expiration_date: p.subscriptionExpiration } : {}),
            ...(p.isRecurring !== undefined ? { is_recurring: p.isRecurring } : {}),
            ...(p.isFirstRecurring !== undefined ? { is_first_recurring: p.isFirstRecurring } : {}),
          },
        },
      }),
    joinRequest: (token, chatId, user) => push(token, { chat_join_request: { chat: { id: chatId, type: 'channel' }, from: user, user_chat_id: user.id, date: now() } }),
    addStarTransaction: (token, tx) => bots.get(token)!.starTransactions.push(tx),
    sent: (token, method) => calls.filter((c) => c.bot === token && (!method || c.method === method)),
    failNext: (method, code, description, retryAfter) => failures.push({ method, code, description, ...(retryAfter ? { retryAfter } : {}) }),
    close: () => app.close(),
  };
}
