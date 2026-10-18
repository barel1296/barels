import type { FastifyInstance } from 'fastify';
import * as agents from '../modules/agents/admin.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

export function registerAgentRoutes(app: FastifyInstance, _svc: Services, api: Api): void {
  const { tenant } = api;

  app.get('/v1/agents', async (req) => tenant(req, (db, ctx) => agents.listAgents(db, ctx)));
  app.post<{ Body: { agent_keys: string[] } }>(
    '/v1/agents/enable',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['agent_keys'], properties: { agent_keys: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } } } } } },
    async (req) => tenant(req, (db, ctx) => agents.enableAgents(db, ctx, req.body.agent_keys)),
  );

  app.post<{ Params: { id: string }; Body: { agent_key: string; task_type?: string; input: Record<string, unknown> } }>(
    '/v1/influencers/:id/agent-tasks',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['agent_key', 'input'], properties: { agent_key: { type: 'string' }, task_type: { type: 'string', maxLength: 64 }, input: { type: 'object' } } },
      },
    },
    async (req, reply) => reply.status(202).send(await tenant(req, (db, ctx) => agents.createAgentTask(db, ctx, req.params.id, req.body))),
  );
  app.get<{ Params: { id: string } }>('/v1/influencers/:id/agent-runs', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => agents.listRuns(db, ctx, req.params.id)));

  app.get<{ Querystring: { status?: string; influencer_id?: string } }>(
    '/v1/proposals',
    { schema: { querystring: { type: 'object', properties: { status: { type: 'string' }, influencer_id: uuid } } } },
    async (req) => tenant(req, (db, ctx) => agents.listProposals(db, ctx, req.query)),
  );
  app.get<{ Params: { id: string } }>('/v1/proposals/:id', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => agents.getProposal(db, ctx, req.params.id)));

  app.get('/v1/autonomy-policies', async (req) => tenant(req, (db, ctx) => agents.listAutonomyPolicies(db, ctx)));
  app.post<{ Body: Parameters<typeof agents.createAutonomyPolicy>[2] }>(
    '/v1/autonomy-policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action_type', 'level'],
          properties: {
            influencer_id: { anyOf: [uuid, { type: 'null' }] },
            action_type: { type: 'string' },
            agent_key: { type: ['string', 'null'] },
            level: { type: 'integer', minimum: 0, maximum: 4 },
            conditions: { type: 'object' },
            required_approver_role: { type: ['string', 'null'] },
            required_approvals: { type: 'integer', minimum: 1, maximum: 3 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => agents.createAutonomyPolicy(db, ctx, req.body))),
  );
  app.post<{ Params: { id: string } }>('/v1/autonomy-policies/:id/approve', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => agents.approveAutonomyPolicy(db, ctx, req.params.id)));
  app.post<{ Params: { id: string } }>('/v1/autonomy-policies/:id/retire', { schema: { params: idParams } }, async (req) => tenant(req, (db, ctx) => agents.retireAutonomyPolicy(db, ctx, req.params.id)));

  app.get('/v1/kill-switches', async (req) => tenant(req, (db, ctx) => agents.listKillSwitches(db, ctx)));
  app.post<{ Body: { key: 'autonomy' | 'conversations' | 'publishing'; influencer_id?: string | null; enabled: boolean } }>(
    '/v1/kill-switches',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'enabled'],
          properties: { key: { type: 'string', enum: ['autonomy', 'conversations', 'publishing'] }, influencer_id: { anyOf: [uuid, { type: 'null' }] }, enabled: { type: 'boolean' } },
        },
      },
    },
    async (req) => tenant(req, (db, ctx) => agents.setKillSwitch(db, ctx, req.body)),
  );

  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    '/v1/influencers/:id/calendar',
    { schema: { params: idParams, querystring: { type: 'object', required: ['from', 'to'], properties: { from: date, to: date } } } },
    async (req) => tenant(req, (db, ctx) => agents.calendar(db, ctx, req.params.id, req.query.from, req.query.to)),
  );
}
