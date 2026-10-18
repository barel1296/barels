import { setTimeout as sleep } from 'node:timers/promises';
import type { PublishRequest, PublishingAdapter } from '../../modules/publishing.js';
import { PublishError, composeCaption, ensureJpeg, publicAssetUrl } from '../../modules/publishing-support.js';
import type { Services } from '../../services.js';
import { InstagramApiError, InstagramClient } from './client.js';

/**
 * Instagram content publishing (feed image, carousel, reel) through the Graph
 * API: create containers from signed public media URLs, wait until each is
 * FINISHED, then publish. The AI disclosure is part of every caption.
 * Instagram only fetches JPEG images, so PNG output is converted to a derived
 * JPEG asset first. media_publish has no idempotency key: a failure there is
 * reported as ambiguous so a human checks the account before any retry.
 */
export class InstagramAdapter implements PublishingAdapter {
  readonly channelKind = 'instagram_account';

  constructor(private readonly svc: Services) {}

  async publish(req: PublishRequest): Promise<{ externalPostId: string; permalink?: string | null }> {
    const cfg = this.svc.config.instagram;
    const ig = new InstagramClient(cfg.graphBaseUrl, cfg.graphVersion, req.credential);
    const user = req.channel.external_id;
    if (req.assets.length === 0) throw new PublishError('Instagram posts need at least one image or video', { code: 'NO_MEDIA' });
    if (req.assets.length > 10) throw new PublishError('Instagram carousels hold at most 10 items', { code: 'TOO_MANY_ASSETS' });

    await guard(async () => {
      const q = await ig.publishingLimit(user);
      await this.svc.workerPool.query(`INSERT INTO publishing.quota_snapshots (channel_id, quota_used, quota_total) VALUES ($1, $2, $3)`, [req.channel.id, q.quota_usage, q.quota_total ?? 0]);
      if (q.quota_total !== null && q.quota_usage >= q.quota_total) throw new PublishError('Instagram publishing quota reached for the last 24 hours', { retryAfterMs: 3_600_000, code: 'QUOTA' });
    });

    const caption = composeCaption(req.revision, 2200, 30);
    const items = [];
    for (const a of req.assets) {
      if (a.mime_type.startsWith('video/')) items.push({ video: true, url: publicAssetUrl(this.svc, a.media_asset_id) });
      else items.push({ video: false, url: publicAssetUrl(this.svc, (await ensureJpeg(this.svc, a.media_asset_id)).id) });
    }

    let containerId: string;
    if (items.length === 1) {
      const it = items[0]!;
      containerId = await guard(() => ig.createContainer(user, it.video ? { media_type: 'REELS', video_url: it.url, caption } : { image_url: it.url, caption }));
    } else {
      const children: string[] = [];
      for (const it of items) {
        const child = await guard(() => ig.createContainer(user, it.video ? { media_type: 'VIDEO', video_url: it.url, is_carousel_item: true } : { image_url: it.url, is_carousel_item: true }));
        await this.waitFinished(ig, child);
        children.push(child);
      }
      containerId = await guard(() => ig.createContainer(user, { media_type: 'CAROUSEL', children: children.join(','), caption }));
    }
    await this.waitFinished(ig, containerId);
    let mediaId: string;
    try {
      mediaId = await ig.publish(user, containerId);
    } catch (err) {
      // The post may exist even though the call failed (timeout, 5xx).
      const e = err as InstagramApiError;
      if (e.rateLimited) throw new PublishError(e.message, { retryAfterMs: 900_000, code: 'RATE_LIMITED' });
      throw new PublishError(`media_publish failed: ${e.message}`, { ambiguous: e.network || (e.status ?? 0) >= 500 });
    }
    const permalink = await ig
      .media(mediaId, 'permalink')
      .then((m) => (typeof m.permalink === 'string' ? m.permalink : null))
      .catch(() => null);
    return { externalPostId: mediaId, permalink };
  }

  private async waitFinished(ig: InstagramClient, containerId: string): Promise<void> {
    const cfg = this.svc.config.instagram;
    const deadline = Date.now() + cfg.containerTimeoutSeconds * 1000;
    for (;;) {
      const s = await guard(() => ig.containerStatus(containerId));
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new PublishError(`container ${containerId} ${s.status_code}: ${s.status ?? ''}`, { code: `CONTAINER_${s.status_code}` });
      if (s.status_code === 'PUBLISHED') throw new PublishError(`container ${containerId} is already published`, { ambiguous: true });
      if (Date.now() > deadline) throw new PublishError(`container ${containerId} not ready after ${cfg.containerTimeoutSeconds}s`, { retryAfterMs: 600_000, code: 'CONTAINER_TIMEOUT' });
      await sleep(cfg.containerPollIntervalMs);
    }
  }
}

/** Maps errors before media_publish: nothing has been posted yet, so failures are never ambiguous. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PublishError) throw err;
    const e = err as InstagramApiError;
    if (e.authFailure) throw new PublishError(`Instagram token rejected: ${e.message}`, { code: 'AUTH' });
    if (e.rateLimited || e.network || (e.status ?? 0) >= 500) throw new PublishError(e.message, { retryAfterMs: e.rateLimited ? 900_000 : 120_000, code: 'RETRYABLE' });
    throw new PublishError(e.message, { code: 'INSTAGRAM_REJECTED' });
  }
}
