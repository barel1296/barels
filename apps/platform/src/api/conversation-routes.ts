import type { FastifyInstance } from 'fastify';
import { connectTelegramBot, clientForAccount, configureBotProfile } from '../integrations/telegram/bot.js';
import { notFound } from '../lib/errors.js';
import { requireInfluencerAccess, requirePermission } from '../modules/context.js';
import * as conv from '../modules/conversation/admin.js';
import { getInfluencer } from '../modules/identity.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

export function registerConversationRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const { tenant } = api;

  // --- Telegram bot connection -------------------------------------------------
  app.post<{ Params: { id: string }; Body: { token: string } }>(
    '/v1/influencers/:id/telegram/bot',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', pattern: '^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$' } } },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => connectTelegramBot(svc, db, ctx, req.params.id, req.body.token))),
  );

  app.post<{ Params: { id: string } }>('/v1/influencers/:id/telegram/bot/sync-profile', { schema: { params: idParams } }, async (req) => {
    const { inf, accountId } = await tenant(req, async (db, ctx) => {
      requirePermission(ctx, 'integration.manage');
      const inf = await getInfluencer(db, ctx, req.params.id);
      const acc = await db.query<{ id: string }>(`SELECT id FROM core.integration_accounts WHERE influencer_id = $1 AND provider = 'telegram_bot' AND status = 'active'`, [req.params.id]);
      if (!acc.rows[0]) throw notFound('Telegram bot for influencer', req.params.id);
      return { inf, accountId: acc.rows[0].id };
    });
    await configureBotProfile(await clientForAccount(svc, accountId), inf);
    return { ok: true };
  });

  // --- Inbox -----------------------------------------------------------------------
  app.get<{ Querystring: { influencer_id?: string; status?: string; mode?: string; needs_attention?: string; limit?: string } }>(
    '/v1/conversations',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            influencer_id: uuid,
            status: { type: 'string', enum: ['open', 'snoozed', 'closed', 'blocked'] },
            mode: { type: 'string', enum: ['ai_auto', 'ai_draft', 'human', 'paused'] },
            needs_attention: { type: 'string', enum: ['true', 'false'] },
            limit: { type: 'string', pattern: '^[0-9]{1,4}$' },
          },
        },
      },
    },
    async (req) =>
      tenant(req, (db, ctx) =>
        conv.listConversations(db, ctx, {
          ...(req.query.influencer_id ? { influencer_id: req.query.influencer_id } : {}),
          ...(req.query.status ? { status: req.query.status } : {}),
          ...(req.query.mode ? { mode: req.query.mode } : {}),
          needs_attention: req.query.needs_attention === 'true',
          ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
        }),
      ),
  );

  app.get<{ Params: { id: string } }>('/v1/conversations/:id', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => conv.getConversation(db, ctx, req.params.id)));

  app.patch<{ Params: { id: string }; Body: Parameters<typeof conv.updateConversation>[3] }>(
    '/v1/conversations/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            mode: { type: 'string', enum: ['ai_auto', 'ai_draft', 'human', 'paused'] },
            status: { type: 'string', enum: ['open', 'snoozed', 'closed', 'blocked'] },
            assigned_user_id: { anyOf: [uuid, { type: 'null' }] },
          },
        },
      },
    },
    async (req) => tenant(req, (db, ctx) => conv.updateConversation(db, ctx, req.params.id, req.body)),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/v1/conversations/:id/messages',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } } } } },
    async (req, reply) => reply.status(201).send(await conv.staffSend(svc, req.ctx, req.params.id, req.body.body)),
  );

  const draftParams = { type: 'object', required: ['id', 'messageId'], properties: { id: uuid, messageId: uuid } } as const;
  app.post<{ Params: { id: string; messageId: string }; Body: { body?: string } | undefined }>(
    '/v1/conversations/:id/drafts/:messageId/approve',
    { schema: { params: draftParams, body: { type: 'object', additionalProperties: false, properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } } } } },
    async (req) => conv.staffApproveDraft(svc, req.ctx, req.params.id, req.params.messageId, req.body?.body ?? null),
  );

  app.post<{ Params: { id: string; messageId: string } }>('/v1/conversations/:id/drafts/:messageId/reject', { schema: { params: draftParams } }, async (req) =>
    conv.staffRejectDraft(svc, req.ctx, req.params.id, req.params.messageId),
  );

  // --- Escalations --------------------------------------------------------------
  app.get<{ Querystring: { status?: 'open' | 'acknowledged' | 'resolved' | 'unresolved'; influencer_id?: string } }>(
    '/v1/escalations',
    { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'acknowledged', 'resolved', 'unresolved'] }, influencer_id: uuid } } } },
    async (req) => tenant(req, (db, ctx) => conv.listEscalations(db, ctx, req.query)),
  );

  for (const action of ['acknowledge', 'resolve'] as const) {
    app.post<{ Params: { id: string }; Body: { resolution?: string } | undefined }>(
      `/v1/escalations/:id/${action}`,
      { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { resolution: { type: 'string', minLength: 1, maxLength: 4000 } } } } },
      async (req) => tenant(req, (db, ctx) => conv.updateEscalation(db, ctx, req.params.id, action, req.body?.resolution)),
    );
  }

  // --- Fans ------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/fans', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => {
      requireInfluencerAccess(ctx, req.params.id);
      return conv.listFans(db, ctx, req.params.id);
    }),
  );

  app.get<{ Params: { id: string } }>('/v1/fans/:id', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => conv.getFan(db, ctx, req.params.id)));

  app.post<{ Params: { id: string; memoryId: string } }>(
    '/v1/fans/:id/memories/:memoryId/delete',
    { schema: { params: { type: 'object', required: ['id', 'memoryId'], properties: { id: uuid, memoryId: uuid } } } },
    async (req) => {
      await tenant(req, (db, ctx) => conv.deleteMemory(db, ctx, req.params.id, req.params.memoryId));
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/fans/:id/erase', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => conv.staffEraseFan(db, ctx, req.params.id)));
}
