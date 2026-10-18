import type { FastifyInstance } from 'fastify';
import type { WorkflowManifest } from '../contract/types.js';
import { badRequest } from '../lib/errors.js';
import * as approvals from '../modules/approvals.js';
import * as content from '../modules/content.js';
import { requirePlatformAdmin } from '../modules/context.js';
import * as history from '../modules/history.js';
import * as identity from '../modules/identity.js';
import * as integrations from '../modules/integrations.js';
import * as publishing from '../modules/publishing.js';
import * as engines from '../modules/visual/engines.js';
import * as jobs from '../modules/visual/jobs.js';
import * as workflows from '../modules/visual/workflows.js';
import type { Services } from '../services.js';
import type { Api } from './server.js';

// --- JSON schema fragments ----------------------------------------------------
const uuid = { type: 'string', format: 'uuid' } as const;
const obj = { type: 'object' } as const;
const text = (max = 2000) => ({ type: 'string', minLength: 1, maxLength: max }) as const;
const priorityClass = { type: 'string', enum: ['time_sensitive', 'scheduled_image', 'video', 'maintenance'] } as const;
const rating = { type: 'string', enum: ['general', 'suggestive', 'mature', 'explicit'] } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

const runtimeConfig = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content_tier: { type: 'string', enum: ['lite', 'standard', 'plus'] },
    gpu_quota_seconds_day: { type: 'integer', minimum: 0 },
    free_replies_per_day: { type: 'integer', minimum: 0 },
    premium_replies_per_day: { type: 'integer', minimum: 0 },
    languages: { type: 'array', items: text(16) },
    quiet_hours: obj,
    paused: { type: 'boolean' },
  },
} as const;

export function registerRoutes(app: FastifyInstance, svc: Services, api: Api): void {
  const { tenant } = api;
  const cfg = svc.config;

  app.get('/v1/me', async (req) => ({
    user_id: req.ctx.userId,
    workspace_id: req.ctx.workspaceId,
    is_platform_admin: req.ctx.isPlatformAdmin,
    permissions: [...req.ctx.permissions].sort(),
    influencer_scope: req.ctx.influencerScope ? [...req.ctx.influencerScope] : null,
  }));

  // --- Platform: visual engines and workflow registry (platform admins) -------
  app.post<{ Body: { engine_key: string; base_url: string; token: string; dispatch_limit?: number; media_lane_vram_mb?: number } }>(
    '/v1/platform/engines',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['engine_key', 'base_url', 'token'],
          properties: {
            engine_key: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{1,63}$' },
            base_url: { type: 'string', pattern: '^https?://' },
            token: { type: 'string', minLength: 32, maxLength: 512 },
            dispatch_limit: { type: 'integer', minimum: 1 },
            media_lane_vram_mb: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => engines.registerEngine(db, ctx, svc.engineClients, cfg, req.body))),
  );

  app.get('/v1/platform/engines', async (req) => tenant(req, (db, ctx) => engines.listEngines(db, ctx)));

  app.post<{ Params: { id: string } }>('/v1/platform/engines/:id/sync', { schema: { params: idParams } }, async (req) => {
    requirePlatformAdmin(req.ctx);
    return engines.syncEngineWorkflows(svc.appPool, svc.engineClients, svc.validator, req.params.id, req.ctx.actor);
  });

  app.post<{ Params: { id: string } }>('/v1/platform/engines/:id/health', { schema: { params: idParams } }, async (req) => {
    requirePlatformAdmin(req.ctx);
    const engine = await engines.loadEngine(svc.appPool, req.params.id);
    return { health: await engines.refreshEngineHealth(svc.appPool, svc.engineClients, engine) };
  });

  app.get<{ Querystring: { status?: string; key?: string } }>('/v1/platform/workflows', async (req) =>
    tenant(req, (db, ctx) => workflows.listWorkflows(db, ctx, req.query)),
  );

  app.get<{ Params: { id: string } }>('/v1/platform/workflows/:id', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => workflows.getWorkflow(db, ctx, req.params.id)),
  );

  app.post<{ Body: WorkflowManifest }>('/v1/platform/workflows', { schema: { body: obj } }, async (req, reply) =>
    reply.status(201).send(await tenant(req, (db, ctx) => workflows.registerManifestManually(db, ctx, svc.validator, req.body))),
  );

  app.post<{ Params: { id: string }; Body: { decision: 'approve' | 'reject' | 'disable' | 'deprecate'; note: string } }>(
    '/v1/platform/workflows/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'note'],
          properties: { decision: { type: 'string', enum: ['approve', 'reject', 'disable', 'deprecate'] }, note: text(4000) },
        },
      },
    },
    async (req) => tenant(req, (db, ctx) => workflows.decideWorkflow(db, ctx, req.params.id, req.body.decision, req.body.note)),
  );

  // --- Influencers and persona identity ----------------------------------------
  app.post<{ Body: identity.CreateInfluencerInput }>(
    '/v1/influencers',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'display_name', 'ai_disclosure_short', 'ai_disclosure_long', 'timezone', 'primary_language'],
          properties: {
            slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' },
            display_name: text(120),
            ai_disclosure_short: text(200),
            ai_disclosure_long: text(2000),
            timezone: text(64),
            primary_language: { type: 'string', pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' },
            runtime: runtimeConfig,
          },
        },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await tenant(req, (db, ctx) => identity.createInfluencer(db, ctx, req.body, { gpuQuotaSecondsPerDay: cfg.defaultGpuQuotaSecondsPerDay }))),
  );

  app.get('/v1/influencers', async (req) => tenant(req, (db, ctx) => identity.listInfluencers(db, ctx)));

  app.get<{ Params: { id: string } }>('/v1/influencers/:id', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => identity.getInfluencerDetail(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { status: 'active' | 'paused' | 'archived' | 'draft' } }>(
    '/v1/influencers/:id/status',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['active', 'paused', 'archived'] } } },
      },
    },
    async (req) => tenant(req, (db, ctx) => identity.setInfluencerStatus(db, ctx, req.params.id, req.body.status)),
  );

  app.patch<{ Params: { id: string }; Body: identity.RuntimeConfigInput }>(
    '/v1/influencers/:id/runtime-config',
    { schema: { params: idParams, body: runtimeConfig } },
    async (req) => tenant(req, (db, ctx) => identity.updateRuntimeConfig(db, ctx, req.params.id, req.body)),
  );

  app.post<{ Params: { id: string }; Body: identity.PersonaInput }>(
    '/v1/influencers/:id/persona-versions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['personality', 'writing_style', 'biography', 'visual_identity', 'conversation_rules'],
          properties: {
            personality: obj,
            writing_style: obj,
            biography: obj,
            visual_identity: obj,
            conversation_rules: obj,
            voice_profile: { type: ['object', 'null'] },
            change_summary: { type: ['string', 'null'], maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => identity.createPersonaVersion(db, ctx, req.params.id, req.body))),
  );

  for (const [action, fn] of [
    ['submit', identity.submitPersonaVersion],
    ['approve', identity.approvePersonaVersion],
    ['activate', identity.activatePersonaVersion],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/persona-versions/:id/${action}`, { schema: { params: idParams } }, async (req) =>
      tenant(req, (db, ctx) => fn(db, ctx, req.params.id)),
    );
  }

  app.post<{ Params: { id: string }; Querystring: { kind?: string; notes?: string }; Body: Buffer }>(
    '/v1/influencers/:id/reference-assets',
    { schema: { params: idParams } },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('INVALID_REQUEST', 'Send the image bytes with Content-Type image/png, image/jpeg or image/webp');
      return reply.status(201).send(
        await tenant(req, (db, ctx) =>
          identity.uploadReferenceAsset(db, ctx, svc.store, req.params.id, {
            kind: req.query.kind ?? '',
            bytes: req.body,
            declaredMime: req.headers['content-type']?.split(';')[0],
            notes: req.query.notes ?? null,
          }),
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>('/v1/reference-assets/:id/approve', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => identity.approveReferenceAsset(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { kind: 'lora' | 'other'; engine_ref: string; workflow_keys?: string[]; dataset_manifest_ref?: string; eval_metrics?: Record<string, unknown> } }>(
    '/v1/influencers/:id/adapters',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'engine_ref'],
          properties: {
            kind: { type: 'string', enum: ['lora', 'other'] },
            engine_ref: text(512),
            workflow_keys: { type: 'array', items: text(81) },
            dataset_manifest_ref: text(512),
            eval_metrics: obj,
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => identity.registerAdapter(db, ctx, req.params.id, req.body))),
  );

  app.post<{ Params: { id: string } }>('/v1/adapters/:id/approve', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => identity.approveAdapter(db, ctx, req.params.id)),
  );

  app.put<{ Params: { id: string; purpose: string }; Body: { workflow_key: string; version_range: string; default_parameters?: Record<string, unknown>; priority_class?: string; output_count?: number } }>(
    '/v1/influencers/:id/workflow-bindings/:purpose',
    {
      schema: {
        params: { type: 'object', required: ['id', 'purpose'], properties: { id: uuid, purpose: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,62}$' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['workflow_key', 'version_range'],
          properties: {
            workflow_key: { type: 'string', pattern: '^[a-z_][a-z0-9_.]{1,80}$' },
            version_range: text(64),
            default_parameters: obj,
            priority_class: priorityClass,
            output_count: { type: 'integer', minimum: 1, maximum: 64 },
          },
        },
      },
    },
    async (req) => tenant(req, (db, ctx) => identity.upsertBinding(db, ctx, req.params.id, { ...req.body, purpose: req.params.purpose })),
  );

  app.post<{ Body: { influencer_id: string | null; check_key: string; min_score?: number; max_score?: number; required?: boolean; on_fail?: 'reject' | 'flag' } }>(
    '/v1/qa-thresholds',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['influencer_id', 'check_key'],
          properties: {
            influencer_id: { type: ['string', 'null'], format: 'uuid' },
            check_key: { type: 'string', pattern: '^[a-z][a-z0-9_.]{0,63}$' },
            min_score: { type: 'number' },
            max_score: { type: 'number' },
            required: { type: 'boolean' },
            on_fail: { type: 'string', enum: ['reject', 'flag'] },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => identity.setQaThreshold(db, ctx, req.body))),
  );

  // --- Visual jobs (ComfyUI integration gateway) ---------------------------------
  app.post<{ Params: { id: string }; Body: Omit<jobs.CreateJobInput, 'idempotency_key'> & { idempotency_key?: string } }>(
    '/v1/influencers/:id/visual-jobs',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            idempotency_key: { type: 'string', minLength: 8, maxLength: 200 },
            purpose: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,62}$' },
            workflow: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'version_range'],
              properties: { key: { type: 'string', pattern: '^[a-z_][a-z0-9_.]{1,80}$' }, version_range: text(64) },
            },
            parameters: obj,
            references: {
              type: 'array',
              maxItems: 16,
              items: { type: 'object', additionalProperties: false, required: ['asset_id', 'role'], properties: { asset_id: uuid, role: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,40}$' } } },
            },
            output_count: { type: 'integer', minimum: 1, maximum: 64 },
            priority_class: priorityClass,
            content_item_id: { type: ['string', 'null'], format: 'uuid' },
            deadline_at: { type: ['string', 'null'], format: 'date-time' },
            use_adapters: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const header = req.headers['idempotency-key'];
      const key = req.body.idempotency_key ?? (typeof header === 'string' ? header : undefined);
      if (!key || key.length < 8) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Provide idempotency_key in the body or an Idempotency-Key header (>= 8 chars)');
      const { job, replayed } = await tenant(req, (db, ctx) =>
        jobs.createVisualJob(db, ctx, svc.validator, { maxAttempts: cfg.worker.maxAttempts, jobTimeoutCapSeconds: cfg.worker.jobTimeoutCapSeconds }, req.params.id, {
          ...req.body,
          idempotency_key: key,
        }),
      );
      return reply.status(replayed ? 200 : 202).send(jobs.publicJob(job));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { state?: string } }>('/v1/influencers/:id/visual-jobs', { schema: { params: idParams } }, async (req) =>
    (await tenant(req, (db, ctx) => jobs.listVisualJobs(db, ctx, req.params.id, req.query.state))).map(jobs.publicJob),
  );

  app.get<{ Params: { id: string } }>('/v1/visual-jobs/:id', { schema: { params: idParams } }, async (req) => {
    const { job, events } = await tenant(req, (db, ctx) => jobs.getVisualJob(db, ctx, req.params.id));
    return { ...jobs.publicJob(job), events };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } | undefined }>('/v1/visual-jobs/:id/cancel', { schema: { params: idParams } }, async (req) =>
    jobs.publicJob(await tenant(req, (db, ctx) => jobs.cancelVisualJob(db, ctx, req.params.id, req.body?.reason ?? null))),
  );

  app.get<{ Params: { id: string }; Querystring: { visual_job_id?: string; status?: string } }>(
    '/v1/influencers/:id/media-assets',
    { schema: { params: idParams } },
    async (req) => tenant(req, (db, ctx) => content.listMediaAssets(db, ctx, req.params.id, req.query)),
  );

  // --- Content, revisions and approvals ------------------------------------------
  app.post<{ Params: { id: string }; Body: Parameters<typeof content.createContentItem>[3] }>(
    '/v1/influencers/:id/content-items',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['format'],
          properties: {
            format: { type: 'string', enum: [...content.CONTENT_FORMATS] },
            planned_for: { type: ['string', 'null'], format: 'date-time' },
            target_rating: rating,
            brief: { type: ['object', 'null'] },
            is_sponsored: { type: 'boolean' },
            sponsor_disclosure: { type: ['string', 'null'], maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => content.createContentItem(db, ctx, req.params.id, req.body))),
  );

  app.get<{ Params: { id: string } }>('/v1/content-items/:id', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => content.getContentItem(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: Parameters<typeof content.createRevision>[3] }>(
    '/v1/content-items/:id/revisions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['assets'],
          properties: {
            caption: { type: ['string', 'null'], maxLength: 2200 },
            hashtags: { type: 'array', maxItems: 30, items: { type: 'string', pattern: '^#?[\\p{L}\\p{N}_]{1,100}$' } },
            alt_text: { type: ['string', 'null'], maxLength: 1000 },
            cta: { type: ['object', 'null'] },
            assets: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['media_asset_id', 'role'],
                properties: { media_asset_id: uuid, role: { type: 'string', enum: ['primary', 'carousel', 'cover', 'teaser', 'full'] } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => content.createRevision(db, ctx, req.params.id, req.body))),
  );

  app.post<{ Params: { id: string } }>('/v1/revisions/:id/approval-requests', { schema: { params: idParams } }, async (req, reply) =>
    reply.status(201).send(await tenant(req, (db, ctx) => content.requestApproval(db, ctx, req.params.id, cfg.approvalTtlHours))),
  );

  app.get<{ Querystring: { status?: string } }>('/v1/approvals', async (req) => tenant(req, (db, ctx) => approvals.listApprovals(db, ctx, req.query.status)));

  app.get<{ Params: { id: string } }>('/v1/approvals/:id', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => approvals.getApproval(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { decision: 'approve' | 'reject' | 'request_changes'; payload_hash: string; comment?: string } }>(
    '/v1/approvals/:id/decisions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'payload_hash'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject', 'request_changes'] },
            payload_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            comment: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (req) => tenant(req, (db, ctx) => approvals.decide(db, ctx, req.params.id, req.body)),
  );

  // --- Integrations, channels and publishing ------------------------------------------
  app.post<{ Body: Parameters<typeof integrations.createIntegrationAccount>[3] }>(
    '/v1/integration-accounts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['influencer_id', 'provider', 'external_account_id', 'credential'],
          properties: {
            influencer_id: uuid,
            provider: { type: 'string', enum: ['instagram', 'telegram_bot', 'telegram_business'] },
            external_account_id: text(128),
            display_name: { type: ['string', 'null'], maxLength: 200 },
            credential: { type: 'string', minLength: 8, maxLength: 4096 },
            scopes: { type: 'array', items: text(128) },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => integrations.createIntegrationAccount(db, ctx, cfg, req.body))),
  );

  app.post<{ Params: { id: string }; Body: Parameters<typeof integrations.createChannel>[3] }>(
    '/v1/influencers/:id/channels',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['integration_account_id', 'kind', 'external_id'],
          properties: {
            integration_account_id: uuid,
            kind: { type: 'string', enum: ['instagram_account', 'telegram_public_channel', 'telegram_premium_channel', 'telegram_bot', 'telegram_business_account'] },
            external_id: text(128),
            username: { type: ['string', 'null'], maxLength: 64 },
            title: { type: ['string', 'null'], maxLength: 200 },
            max_rating: rating,
            audience_gate: { type: 'string', enum: ['none', 'self_attested_adult', 'verified_adult'] },
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => integrations.createChannel(db, ctx, req.params.id, req.body))),
  );

  app.get<{ Params: { id: string } }>('/v1/influencers/:id/channels', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => integrations.listChannels(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { channel_id: string; scheduled_for: string; revision_id?: string } }>(
    '/v1/content-items/:id/publications',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channel_id', 'scheduled_for'],
          properties: { channel_id: uuid, scheduled_for: { type: 'string', format: 'date-time' }, revision_id: uuid },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await tenant(req, (db, ctx) => publishing.schedulePublication(db, ctx, svc, req.params.id, req.body))),
  );

  app.get<{ Params: { id: string } }>('/v1/influencers/:id/publications', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => publishing.listPublications(db, ctx, req.params.id)),
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } | undefined }>('/v1/publications/:id/cancel', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => publishing.cancelPublication(db, ctx, req.params.id, req.body?.reason ?? null)),
  );

  // --- History ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/content-items/:id/lineage', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => history.contentLineage(db, ctx, req.params.id)),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/v1/influencers/:id/audit', { schema: { params: idParams } }, async (req) =>
    tenant(req, (db, ctx) => history.influencerAudit(db, ctx, req.params.id, Number(req.query.limit ?? 200))),
  );
}
