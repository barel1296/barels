import { readFile } from 'node:fs/promises';
import type { PublishRequest, PublishingAdapter } from '../../modules/publishing.js';
import { PublishError, composeCaption } from '../../modules/publishing-support.js';
import { TelegramApiError, TelegramClient } from './client.js';

/**
 * Publishes approved posts to a Telegram channel (public or premium) through
 * the influencer's bot, which must be a channel administrator. Telegram has
 * no idempotency key: network failures and 5xx answers are reported as
 * ambiguous (needs a human check), 429 as retryable, other 4xx as failed.
 */
export class TelegramChannelAdapter implements PublishingAdapter {
  constructor(
    readonly channelKind: 'telegram_public_channel' | 'telegram_premium_channel',
    private readonly apiBaseUrl: string,
  ) {}

  async publish(req: PublishRequest): Promise<{ externalPostId: string; permalink?: string | null }> {
    const client = new TelegramClient(this.apiBaseUrl, req.credential, 120_000);
    const chat = req.channel.external_id;
    const media = await Promise.all(
      req.assets.map(async (a, i) => ({
        type: a.mime_type.startsWith('video/') ? ('video' as const) : ('photo' as const),
        bytes: await readFile(a.path),
        filename: `media${i}.${a.mime_type.split('/')[1] ?? 'bin'}`,
        mime: a.mime_type,
      })),
    );
    if (media.length > 10) throw new PublishError('Telegram albums hold at most 10 items', { code: 'TOO_MANY_ASSETS' });
    const caption = composeCaption(req.revision, media.length ? 1024 : 4096);
    let ids: number[];
    try {
      if (media.length === 0) ids = [(await client.sendMessage(chat, caption, { disablePreview: true })).message_id];
      else if (media.length === 1) {
        const m = media[0]!;
        ids = [(m.type === 'video' ? await client.sendVideo(chat, m, caption) : await client.sendPhoto(chat, m, caption)).message_id];
      } else ids = (await client.sendMediaGroup(chat, media, caption)).map((m) => m.message_id);
    } catch (err) {
      throw toPublishError(err);
    }
    const username = req.channel.username;
    return { externalPostId: ids.join(','), permalink: username ? `https://t.me/${username}/${ids[0]}` : null };
  }
}

function toPublishError(err: unknown): PublishError {
  if (!(err instanceof TelegramApiError)) return new PublishError((err as Error).message, { ambiguous: true });
  if (err.code === 429) return new PublishError(err.message, { retryAfterMs: (err.retryAfterS ?? 30) * 1000, code: 'RATE_LIMITED' });
  if (err.network || (err.code !== null && err.code >= 500)) return new PublishError(err.message, { ambiguous: true });
  return new PublishError(err.message, { code: `TELEGRAM_${err.code ?? 'ERROR'}` });
}
