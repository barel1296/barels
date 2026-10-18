import type { FastifyInstance } from 'fastify';
import { listComments, replyToComment, resolveComment, setCommentHidden } from '../integrations/instagram/comments.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerPublishingRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const { tenant } = api;

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/v1/influencers/:id/comments',
    { schema: { params: idParams, querystring: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'replied', 'hidden', 'deleted', 'ignored', 'escalated'] } } } } },
    async (req) => tenant(req, (db, ctx) => listComments(db, ctx, req.params.id, req.query.status)),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/v1/comments/:id/reply',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 2200 } } } } },
    async (req) => tenant(req, (db, ctx) => replyToComment(svc, db, ctx, req.params.id, req.body.body)),
  );

  for (const [path, hide] of [
    ['hide', true],
    ['unhide', false],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/comments/:id/${path}`, { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => setCommentHidden(svc, db, ctx, req.params.id, hide)));
  }

  app.post<{ Params: { id: string } }>('/v1/comments/:id/ignore', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => resolveComment(db, ctx, req.params.id, 'ignored')));
}
