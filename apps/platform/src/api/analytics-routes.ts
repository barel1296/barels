import type { FastifyInstance } from 'fastify';
import * as analytics from '../modules/analytics/api.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const range = { type: 'object', required: ['from', 'to'], properties: { from: date, to: date } } as const;

export function registerAnalyticsRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const { tenant } = api;

  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>('/v1/influencers/:id/kpis', { schema: { params: idParams, querystring: range } }, async (req) =>
    tenant(req, (db, ctx) => analytics.kpis(db, ctx, req.params.id, req.query.from, req.query.to)),
  );
  app.get<{ Querystring: { from: string; to: string } }>('/v1/analytics/overview', { schema: { querystring: range } }, async (req) =>
    tenant(req, (db, ctx) => analytics.overview(db, ctx, req.query.from, req.query.to)),
  );
  app.get<{ Querystring: { from: string; to: string } }>('/v1/analytics/usage', { schema: { querystring: range } }, async (req) => tenant(req, (db, ctx) => analytics.usage(db, ctx, req.query.from, req.query.to)));
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/post-performance', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => analytics.postPerformance(db, ctx, req.params.id)));
  app.post<{ Body: { from: string; to: string; influencer_id?: string } }>(
    '/v1/analytics/recompute',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: date, to: date, influencer_id: uuid } } } },
    async (req) => tenant(req, (db, ctx) => analytics.recompute(svc, db, ctx, req.body.from, req.body.to, req.body.influencer_id)),
  );
  app.get('/v1/star-valuations', async (req) => tenant(req, (db, ctx) => analytics.listStarValuations(db, ctx)));
  app.post<{ Body: Parameters<typeof analytics.recordStarValuation>[2] }>(
    '/v1/star-valuations',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effective_date', 'fiat_per_star', 'method'],
          properties: {
            effective_date: date,
            fiat_currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            fiat_per_star: { type: 'number', exclusiveMinimum: 0 },
            method: { type: 'string', enum: ['realized_payouts_trailing_90d', 'platform_quoted_rate', 'finance_manual'] },
            source_ref: { type: ['string', 'null'], maxLength: 500 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => analytics.recordStarValuation(db, ctx, req.body))),
  );
}
