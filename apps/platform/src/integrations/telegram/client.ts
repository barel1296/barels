/**
 * Minimal, typed Telegram Bot API client (JSON over HTTPS). Only the methods the
 * platform uses. The base URL is configurable so tests run against the
 * SIMULATED Bot API server; production uses https://api.telegram.org.
 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    readonly description: string,
    readonly retryAfterS: number | null,
    readonly network = false,
  ) {
    super(`Telegram ${method} failed${code ? ` (${code})` : ''}: ${description}`);
    this.name = 'TelegramApiError';
  }

  /** 429, 5xx and network errors are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.network || this.code === 429 || (this.code !== null && this.code >= 500);
  }
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: unknown[];
  video?: unknown;
  voice?: unknown;
  sticker?: unknown;
  successful_payment?: TgSuccessfulPayment;
  refunded_payment?: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string };
}

export interface TgSuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
  pre_checkout_query?: { id: string; from: TgUser; currency: string; total_amount: number; invoice_payload: string };
  chat_join_request?: { chat: TgChat; from: TgUser; user_chat_id: number; date: number; invite_link?: { invite_link: string } };
  my_chat_member?: unknown;
  chat_member?: { chat: TgChat; from: TgUser; new_chat_member: { user: TgUser; status: string }; old_chat_member: { user: TgUser; status: string } };
  [key: string]: unknown;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export class TelegramClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {}

  /** Bot id is the numeric prefix of the token. */
  get botId(): string {
    return this.token.split(':')[0] ?? '';
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TelegramApiError(method, null, (err as Error).message, null, true);
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!body?.ok) {
      throw new TelegramApiError(method, body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`, body?.parameters?.retry_after ?? null);
    }
    return body.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe');
  }

  getUpdates(offset: number | null, timeoutS: number, allowed: string[]): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset: offset ?? undefined, timeout: timeoutS, allowed_updates: allowed }, (timeoutS + 10) * 1000);
  }

  sendMessage(chatId: number | string, text: string, opts: { buttons?: InlineButton[][]; replyTo?: number; disablePreview?: boolean } = {}): Promise<TgMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(opts.buttons ? { reply_markup: { inline_keyboard: opts.buttons } } : {}),
      ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo } } : {}),
      ...(opts.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
    });
  }

  sendChatAction(chatId: number | string, action: 'typing' | 'upload_photo'): Promise<boolean> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }

  setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    return this.call('setMyCommands', { commands });
  }

  setMyDescription(description: string): Promise<boolean> {
    return this.call('setMyDescription', { description });
  }

  setMyShortDescription(shortDescription: string): Promise<boolean> {
    return this.call('setMyShortDescription', { short_description: shortDescription });
  }

  createInvoiceLink(p: { title: string; description: string; payload: string; amountStars: number; subscriptionPeriodS?: number }): Promise<string> {
    return this.call('createInvoiceLink', {
      title: p.title,
      description: p.description,
      payload: p.payload,
      currency: 'XTR',
      prices: [{ label: p.title, amount: p.amountStars }],
      ...(p.subscriptionPeriodS ? { subscription_period: p.subscriptionPeriodS } : {}),
    });
  }

  answerPreCheckoutQuery(id: string, ok: boolean, errorMessage?: string): Promise<boolean> {
    return this.call('answerPreCheckoutQuery', { pre_checkout_query_id: id, ok, ...(ok ? {} : { error_message: errorMessage ?? 'This offer is no longer available.' }) });
  }

  refundStarPayment(userId: number, chargeId: string): Promise<boolean> {
    return this.call('refundStarPayment', { user_id: userId, telegram_payment_charge_id: chargeId });
  }

  editUserStarSubscription(userId: number, chargeId: string, isCanceled: boolean): Promise<boolean> {
    return this.call('editUserStarSubscription', { user_id: userId, telegram_payment_charge_id: chargeId, is_canceled: isCanceled });
  }

  getStarTransactions(offset: number, limit = 100): Promise<{ transactions: TgStarTransaction[] }> {
    return this.call('getStarTransactions', { offset, limit });
  }

  createChatInviteLink(chatId: number | string, opts: { name?: string; createsJoinRequest?: boolean; expireDate?: number; memberLimit?: number }): Promise<{ invite_link: string }> {
    return this.call('createChatInviteLink', {
      chat_id: chatId,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.createsJoinRequest ? { creates_join_request: true } : {}),
      ...(opts.expireDate ? { expire_date: opts.expireDate } : {}),
      ...(opts.memberLimit ? { member_limit: opts.memberLimit } : {}),
    });
  }

  approveChatJoinRequest(chatId: number | string, userId: number): Promise<boolean> {
    return this.call('approveChatJoinRequest', { chat_id: chatId, user_id: userId });
  }

  declineChatJoinRequest(chatId: number | string, userId: number): Promise<boolean> {
    return this.call('declineChatJoinRequest', { chat_id: chatId, user_id: userId });
  }

  banChatMember(chatId: number | string, userId: number): Promise<boolean> {
    return this.call('banChatMember', { chat_id: chatId, user_id: userId });
  }

  unbanChatMember(chatId: number | string, userId: number): Promise<boolean> {
    return this.call('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: true });
  }

  getChatMember(chatId: number | string, userId: number): Promise<{ status: string; user: TgUser }> {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getChatMemberCount(chatId: number | string): Promise<number> {
    return this.call('getChatMemberCount', { chat_id: chatId });
  }

  /** Multipart call for uploads: `files` are attached by field name; JSON-valued fields are serialised. */
  async callMultipart<T>(method: string, fields: Record<string, unknown>, files: { field: string; bytes: Buffer; filename: string; mime: string }[], timeoutMs = 120_000): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    for (const f of files) form.set(f.field, new Blob([f.bytes], { type: f.mime }), f.filename);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TelegramApiError(method, null, (err as Error).message, null, true);
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!body?.ok) throw new TelegramApiError(method, body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`, body?.parameters?.retry_after ?? null);
    return body.result as T;
  }

  /** Sends a photo from bytes (multipart upload). */
  sendPhoto(chatId: number | string, photo: { bytes: Buffer; filename: string; mime: string }, caption?: string): Promise<TgMessage> {
    return this.callMultipart('sendPhoto', { chat_id: String(chatId), caption }, [{ field: 'photo', ...photo }]);
  }

  sendVideo(chatId: number | string, video: { bytes: Buffer; filename: string; mime: string }, caption?: string): Promise<TgMessage> {
    return this.callMultipart('sendVideo', { chat_id: String(chatId), caption, supports_streaming: 'true' }, [{ field: 'video', ...video }]);
  }

  /** 2–10 photos/videos as one album; the caption goes on the first item. */
  sendMediaGroup(chatId: number | string, items: { type: 'photo' | 'video'; bytes: Buffer; filename: string; mime: string }[], caption?: string): Promise<TgMessage[]> {
    const media = items.map((it, i) => ({ type: it.type, media: `attach://file${i}`, ...(i === 0 && caption ? { caption } : {}) }));
    return this.callMultipart(
      'sendMediaGroup',
      { chat_id: String(chatId), media },
      items.map((it, i) => ({ field: `file${i}`, bytes: it.bytes, filename: it.filename, mime: it.mime })),
    );
  }
}

export interface TgStarTransaction {
  id: string;
  amount: number;
  nanostar_amount?: number;
  date: number;
  source?: { type: string; user?: TgUser; invoice_payload?: string; [k: string]: unknown };
  receiver?: { type: string; user?: TgUser; [k: string]: unknown };
}
