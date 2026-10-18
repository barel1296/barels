import type { FastifyInstance } from 'fastify';
import * as catalog from '../modules/monetization/catalog.js';
import * as payments from '../modules/monetization/payments.js';
import { reconciliationReport } from '../modules/monetization/reconcile.js';
import { deliverOffer, reconcileNow, staffOffer } from '../modules/monetization/telegram-sales.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const note = { type: 'object', additionalProperties: false, properties: { note: { type: 'string', minLength: 1, maxLength: 2000 } } } as const;

const grant = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['kind', 'channel_id'], properties: { kind: { const: 'premium_channel_access' }, channel_id: uuid } },
    { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'bot_premium_tier' } } },
    { type: 'object', additionalProperties: false, required: ['kind', 'quantity'], properties: { kind: { const: 'message_credits' }, quantity: { type: 'integer', minimum: 1, maximum: 100000 } } },
  ],
} as const;

export function registerMonetizationRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const { tenant } = api;

  // --- Catalog -------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: catalog.CreateProductInput }>(
    '/v1/influencers/:id/products',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sku', 'kind', 'name', 'description', 'price_stars', 'grants'],
          properties: {
            sku: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,63}$' },
            kind: { type: 'string', enum: ['premium_channel_subscription', 'bot_subscription', 'paid_media', 'message_pack', 'custom_request', 'tip', 'bundle'] },
            name: { type: 'string', minLength: 1, maxLength: 32 },
            description: { type: 'string', minLength: 1, maxLength: 255 },
            price_stars: { type: 'integer', minimum: 1, maximum: 100000 },
            grants: { type: 'array', maxItems: 5, items: grant },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => catalog.createProduct(db, ctx, svc.config, req.params.id, req.body))),
  );

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/v1/influencers/:id/products', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => catalog.listProducts(db, ctx, req.params.id, req.query.status)),
  );

  for (const [action, fn] of [
    ['submit', catalog.submitProduct],
    ['approve', catalog.approveProduct],
    ['retire', catalog.retireProduct],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/products/:id/${action}`, { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => fn(db, ctx, req.params.id)));
  }

  // --- Offers in a conversation ----------------------------------------------------
  app.post<{ Params: { id: string }; Body: { product_id: string } }>(
    '/v1/conversations/:id/offers',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['product_id'], properties: { product_id: uuid } } } },
    async (req, reply) => {
      const { offerId } = await tenant(req, (db, ctx) => staffOffer(svc, db, ctx, req.params.id, req.body.product_id));
      return reply.status(201).send(await deliverOffer(svc, offerId));
    },
  );

  // --- Payments, subscriptions, refunds ----------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/payments', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => payments.listPayments(db, ctx, req.params.id)));
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/subscriptions', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => payments.listSubscriptions(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/v1/payments/:id/refunds',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 3, maxLength: 2000 } } } } },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => payments.requestRefund(db, ctx, req.params.id, req.body.reason))),
  );

  app.get<{ Querystring: { status?: string } }>('/v1/refunds', async (req) => tenant(req, (db, ctx) => payments.listRefunds(db, ctx, req.query.status)));

  for (const decision of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } | undefined }>(`/v1/refunds/:id/${decision}`, { schema: { params: idParams, body: note } }, async (req) =>
      tenant(req, (db, ctx) => payments.decideRefund(db, ctx, req.params.id, decision, req.body?.note ?? null)),
    );
  }

  // --- Reconciliation ------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/reconciliation', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => reconciliationReport(db, ctx, req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/v1/influencers/:id/reconciliation/run', { schema: { params: idParams } }, async (req) => reconcileNow(svc, req.ctx, req.params.id));
}
