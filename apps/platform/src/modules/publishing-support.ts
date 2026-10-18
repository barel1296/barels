import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { maybeOne } from '../db/tx.js';
import { sha256Hex } from '../lib/canonical-json.js';
import { signAssetUrl } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';
import type { Services } from '../services.js';

/**
 * Shared helpers for channel adapters: caption composition with the AI
 * disclosure, typed publish errors, signed public media URLs and JPEG
 * derivatives for platforms that only accept JPEG.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly opts: { ambiguous?: boolean; retryAfterMs?: number; code?: string } = {},
  ) {
    super(message);
    this.name = 'PublishError';
  }
  /** The outcome is unknown (the request may have been applied): never retried automatically. */
  get ambiguous(): boolean {
    return this.opts.ambiguous === true;
  }
  /** Definitely not applied; safe to retry after this delay. */
  get retryAfterMs(): number | undefined {
    return this.opts.retryAfterMs;
  }
}

/**
 * Caption = body + hashtags + AI disclosure. The disclosure is never cut: when
 * the platform limit is exceeded the body is shortened instead.
 */
export function composeCaption(r: { caption: string | null; hashtags: string[]; disclosure_text: string }, maxChars: number, maxHashtags = 30): string {
  const tags = r.hashtags
    .slice(0, maxHashtags)
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .join(' ');
  const disclosure = r.disclosure_text.trim();
  const body = (r.caption ?? '').trim();
  const tail = [tags, body.toLowerCase().includes(disclosure.toLowerCase()) ? '' : disclosure].filter(Boolean).join('\n\n');
  const room = maxChars - (tail ? tail.length + 2 : 0);
  if (room < 0) return disclosure.slice(0, maxChars);
  const trimmedBody = body.length > room ? `${body.slice(0, Math.max(0, room - 1)).trimEnd()}…` : body;
  return [trimmedBody, tail].filter(Boolean).join('\n\n');
}

/** Short-lived signed URL that a platform (e.g. Instagram) uses to fetch a media file. */
export function publicAssetUrl(svc: Services, assetId: string, ttlSeconds = 7200): string {
  const base = svc.config.instagram.publicMediaBaseUrl;
  if (!base) throw new PublishError('PUBLIC_MEDIA_BASE_URL is not configured: Instagram fetches media from a public HTTPS URL', { code: 'PUBLIC_MEDIA_URL_MISSING' });
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${base}/v1/assets/${assetId}/content?exp=${exp}&sig=${signAssetUrl(svc.config.assetUrlSecret, assetId, exp)}`;
}

/**
 * Returns a JPEG version of an approved image: the asset itself if it is a
 * JPEG, otherwise a derived asset (PNG decoded, alpha flattened on white,
 * re-encoded at quality 92) linked to its parent with provenance. The
 * approved source pixels are unchanged; only the container format differs.
 */
export async function ensureJpeg(svc: Services, assetId: string): Promise<{ id: string; mime: string }> {
  const db = svc.workerPool;
  const src = await maybeOne<{ id: string; workspace_id: string; influencer_id: string; mime_type: string; storage_key: string; sha256: Buffer; engine_kind: string | null; width: number | null; height: number | null }>(
    db,
    'SELECT id, workspace_id, influencer_id, mime_type, storage_key, sha256, engine_kind, width, height FROM content.media_assets WHERE id = $1',
    [assetId],
  );
  if (!src) throw new PublishError(`media asset ${assetId} not found`);
  if (src.mime_type === 'image/jpeg') return { id: src.id, mime: src.mime_type };
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM content.media_assets WHERE parent_asset_id = $1 AND mime_type = 'image/jpeg' AND origin = 'derived' AND status = 'valid'`, [assetId]);
  if (existing) return { id: existing.id, mime: 'image/jpeg' };
  if (src.mime_type !== 'image/png') throw new PublishError(`${src.mime_type} cannot be converted to JPEG here; provide PNG or JPEG output`, { code: 'UNSUPPORTED_IMAGE_FORMAT' });
  const png = PNG.sync.read(await svc.store.get(src.storage_key));
  const rgba = Buffer.alloc(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) {
    const a = png.data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(png.data[i * 4 + c]! * a + 255 * (1 - a));
    rgba[i * 4 + 3] = 255;
  }
  const bytes = jpeg.encode({ data: rgba, width: png.width, height: png.height }, 92).data;
  const sha = sha256Hex(bytes);
  const key = svc.store.keyFor(src.workspace_id, src.influencer_id, sha, 'jpg');
  await svc.store.put(key, bytes, sha);
  const id = uuidv7();
  await db.query(
    `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, parent_asset_id,
       provenance, engine_kind, status)
     VALUES ($1, $2, $3, 'image', $4, 'image/jpeg', $5, $6, $7, $8, 'derived', $9, $10, $11, 'valid')`,
    [
      id,
      src.workspace_id,
      src.influencer_id,
      key,
      bytes.length,
      png.width,
      png.height,
      Buffer.from(sha, 'hex'),
      src.id,
      JSON.stringify({ transform: 'png_to_jpeg_q92_flatten_white', source_sha256: src.sha256.toString('hex') }),
      src.engine_kind,
    ],
  );
  return { id, mime: 'image/jpeg' };
}
