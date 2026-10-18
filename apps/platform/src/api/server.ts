import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { withTenant, type Db } from '../db/tx.js';
import { verifyAssetSignature } from '../lib/crypto.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { type Principal, authenticate, ctxFromPrincipal } from '../modules/auth.js';
import { SESSION_COOKIE, authenticateSession, parseCookies } from '../modules/sessions.js';
import type { Ctx } from '../modules/context.js';
import type { Services } from '../services.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerConversationRoutes } from './conversation-routes.js';
import { registerMonetizationRoutes } from './monetization-routes.js';
import { registerOpsRoutes } from './ops-routes.js';
import { registerRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface Api {
  app: FastifyInstance;
  /** Runs fn in a tenant transaction for the authenticated request. */
  tenant: <T>(req: FastifyRequest, fn: (db: Db, ctx: Ctx) => Promise<T>) => Promise<T>;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function buildApi(svc: Services, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(header) ? header : uuidv7();
    },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: true } },
  });

  // Reference uploads arrive as raw image bytes.
  app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.decorateRequest('ctx', null as unknown as Ctx);

  app.addHook('onRequest', async (req) => {
    if (req.routeOptions.config?.public) return;
    const header = req.headers.authorization;
    let principal: Principal;
    if (header?.startsWith('Bearer ')) {
      principal = await authenticate(svc.appPool, header.slice(7).trim());
    } else {
      const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!session) throw unauthorized();
      const csrf = req.headers['x-csrf-token'];
      principal = await authenticateSession(svc.appPool, svc.config.auth, session, req.method, typeof csrf === 'string' ? csrf : undefined);
    }
    req.ctx = ctxFromPrincipal(principal, {
      requestId: String(req.id),
      traceId: typeof req.headers['x-trace-id'] === 'string' ? req.headers['x-trace-id'] : null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });

  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number; code?: string }, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: err.message, details: { violations: err.validation } } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'INVALID_REQUEST', message: err.message } });
    }
    req.log.error(err);
    console.error(`[api] ${req.method} ${req.url} request=${req.id}: ${err.stack ?? err.message}`);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal error', details: { request_id: String(req.id) } } });
  });

  const tenant: Api['tenant'] = (req, fn) => withTenant(svc.appPool, req.ctx.workspaceId, (db) => fn(db, req.ctx));

  app.get('/healthz', { config: { public: true } }, async () => {
    await svc.appPool.query('SELECT 1');
    return { ok: true };
  });

  // Short-lived signed URLs for the visual engine to fetch reference assets (contract §3).
  app.get<{ Params: { id: string }; Querystring: { exp?: string; sig?: string } }>(
    '/v1/assets/:id/content',
    { config: { public: true } },
    async (req, reply) => {
      const exp = Number(req.query.exp);
      const sig = req.query.sig ?? '';
      if (!verifyAssetSignature(svc.config.assetUrlSecret, req.params.id, exp, sig, Math.floor(Date.now() / 1000))) {
        throw new AppError(403, 'INVALID_SIGNATURE', 'Invalid or expired asset URL');
      }
      const { rows } = await svc.workerPool.query<{ storage_key: string; mime_type: string; sha256: Buffer }>(
        `SELECT storage_key, mime_type, sha256 FROM content.media_assets WHERE id = $1 AND status <> 'deleted'`,
        [req.params.id],
      );
      const asset = rows[0];
      if (!asset) throw notFound('Asset', req.params.id);
      const bytes = await svc.store.get(asset.storage_key);
      return reply
        .header('content-type', asset.mime_type)
        .header('x-content-sha256', asset.sha256.toString('hex'))
        .header('cache-control', 'private, no-store')
        .send(bytes);
    },
  );

  registerRoutes(app, svc, { app, tenant });
  registerAuthRoutes(app, svc, { app, tenant });
  registerOpsRoutes(app, svc, { app, tenant });
  registerConversationRoutes(app, svc, { app, tenant });
  registerMonetizationRoutes(app, svc, { app, tenant });
  return app;
}
