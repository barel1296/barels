import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '../config.js';
import { notFound } from '../lib/errors.js';
import { requireInfluencerAccess, requirePermission } from '../modules/context.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

/**
 * Admin dashboard (static, same origin) and authenticated media previews.
 * The dashboard uses the session cookie + CSRF header; it loads nothing from
 * other origins, which the Content-Security-Policy enforces.
 */
const WEB_ROOT = join(paths.repoRoot, 'apps/platform/web/admin');
const FILES: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export function registerWebRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const pub = { config: { public: true } };
  const serve = async (file: string, reply: import('fastify').FastifyReply) => {
    const type = FILES[file];
    if (!type) throw notFound('File', file);
    return reply
      .header('content-type', type)
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .send(await readFile(join(WEB_ROOT, file)));
  };
  app.get('/admin', pub, async (_req, reply) => reply.redirect('/admin/'));
  app.get('/admin/', pub, async (_req, reply) => serve('index.html', reply));
  app.get<{ Params: { file: string } }>('/admin/:file', pub, async (req, reply) => serve(req.params.file, reply));

  // Media preview for signed-in staff (approvals, library). Tenant- and influencer-scoped.
  app.get<{ Params: { id: string } }>('/v1/media-assets/:id/preview', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const asset = await api.tenant(req, async (db, ctx) => {
      requirePermission(ctx, 'content.read');
      const { rows } = await db.query<{ influencer_id: string; storage_key: string; mime_type: string; status: string }>(
        'SELECT influencer_id, storage_key, mime_type, status FROM content.media_assets WHERE id = $1',
        [req.params.id],
      );
      const a = rows[0];
      if (!a || a.status === 'deleted') throw notFound('Media asset', req.params.id);
      requireInfluencerAccess(ctx, a.influencer_id);
      return a;
    });
    return reply.header('content-type', asset.mime_type).header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff').send(await svc.store.get(asset.storage_key));
  });
}
