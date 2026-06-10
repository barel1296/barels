import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { CurrentAuth, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.types';

const createSessionSchema = z.object({
  question: z.string().min(5).max(500),
  playbookKey: z.string().default('roas_drop'),
  scope: z.record(z.unknown()).default({}),
});

const directiveSchema = z.object({
  claim: z.string().min(3).max(1000),
});

@Controller('v1/sessions')
export class SessionsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('warroom:read')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200);
    const conds = ['tenant_id = $1'];
    const params: unknown[] = [auth.tenantId];
    if (status) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    params.push(n);
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, playbook_key, trigger_type, title, scope, phase, status,
              money_at_stake_usd, abstract, created_at, updated_at, closed_at,
              (decision ->> 'confidence')::numeric AS confidence,
              decision ->> 'outcome' AS decision_outcome
         FROM agent_sessions
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { items: rows };
  }

  @Post()
  @RequirePermission('warroom:create')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSessionSchema))
    body: z.infer<typeof createSessionSchema>,
  ) {
    const playbook = await this.db.queryOne<{ key: string; definition: Record<string, unknown> }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT key, definition FROM playbooks
        WHERE key = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [body.playbookKey],
    );
    if (!playbook) throw new NotFoundException(`Unknown playbook: ${body.playbookKey}`);

    const session = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO agent_sessions
         (tenant_id, playbook_key, trigger_type, trigger_ref, title, scope, budgets)
       VALUES ($1, $2, 'user', $3, $4, $5, $6)
       RETURNING id`,
      [
        auth.tenantId,
        playbook.key,
        JSON.stringify({ question: body.question, userId: auth.userId }),
        body.question.slice(0, 200),
        JSON.stringify(body.scope),
        JSON.stringify(playbook.definition['budgets'] ?? {}),
      ],
    );
    await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO jobs (tenant_id, kind, payload)
       VALUES ($1, 'run_session', $2)`,
      [auth.tenantId, JSON.stringify({ sessionId: session!.id })],
    );
    await this.audit.write(auth, {
      event: 'session.created',
      objectType: 'agent_session',
      objectId: session!.id,
      after: { question: body.question, playbook: playbook.key },
    });
    return { id: session!.id };
  }

  @Get(':id')
  @RequirePermission('warroom:read')
  async get(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const session = await this.db.queryOne(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT s.*,
         (SELECT json_agg(json_build_object(
             'id', a.id, 'kind', a.kind, 'status', a.status, 'diff', a.diff,
             'diffHash', a.diff_hash, 'guardrailEval', a.guardrail_eval,
             'rollbackPlan', a.rollback_plan, 'monitoringPlan', a.monitoring_plan,
             'expiresAt', a.expires_at) ORDER BY a.created_at)
            FROM actions a WHERE a.session_id = s.id) AS actions,
         (SELECT json_agg(json_build_object(
             'id', r.id, 'title', r.title, 'summary', r.summary,
             'category', r.category, 'confidence', r.confidence,
             'confidenceBreakdown', r.confidence_breakdown,
             'predictedImpact', r.predicted_impact, 'status', r.status)
             ORDER BY r.created_at)
            FROM recommendations r WHERE r.session_id = s.id) AS recommendations
         FROM agent_sessions s
        WHERE s.id = $1 AND s.tenant_id = $2`,
      [id, auth.tenantId],
    );
    if (!session) throw new NotFoundException();
    return session;
  }

  @Get(':id/messages')
  @RequirePermission('warroom:read')
  async messages(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Query('afterSeq') afterSeq?: string,
  ) {
    const after = parseInt(afterSeq ?? '0', 10) || 0;
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, agent, type, claim, payload, evidence_ids, confidence,
              directed_to, in_reply_to, seq, created_at
         FROM agent_messages
        WHERE session_id = $1 AND tenant_id = $2 AND seq > $3
        ORDER BY seq LIMIT 500`,
      [id, auth.tenantId, after],
    );
    return { items: rows };
  }

  @Get(':id/evidence')
  @RequirePermission('warroom:read')
  async evidence(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    const rows = await this.db.query(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, kind, metric_key, metric_version, params, sql_hash,
              result_digest, freshness_at, executed_at
         FROM evidence
        WHERE session_id = $1 AND tenant_id = $2
        ORDER BY executed_at`,
      [id, auth.tenantId],
    );
    return { items: rows };
  }

  /** User joins the room: a directive the Growth Director must address. */
  @Post(':id/messages')
  @RequirePermission('warroom:participate')
  async directive(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(directiveSchema)) body: z.infer<typeof directiveSchema>,
  ) {
    const session = await this.db.queryOne<{ id: string; status: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `SELECT id, status FROM agent_sessions WHERE id = $1 AND tenant_id = $2`,
      [id, auth.tenantId],
    );
    if (!session) throw new NotFoundException();
    const row = await this.db.queryOne<{ id: string }>(
      { tenantId: auth.tenantId, userId: auth.userId },
      `INSERT INTO agent_messages (tenant_id, session_id, agent, type, claim, payload)
       VALUES ($1, $2, 'user', 'directive', $3, $4)
       RETURNING id`,
      [auth.tenantId, id, body.claim, JSON.stringify({ userId: auth.userId })],
    );
    return { id: row!.id };
  }

  /** Server-sent events: streams new messages + phase changes for a session. */
  @Get(':id/stream')
  @RequirePermission('warroom:read')
  async stream(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastSeq = 0;
    let lastPhase = '';
    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    const tick = async (): Promise<boolean> => {
      const msgs = await this.db.query<{ seq: string; [k: string]: unknown }>(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT id, agent, type, claim, payload, evidence_ids, confidence, seq, created_at
           FROM agent_messages
          WHERE session_id = $1 AND tenant_id = $2 AND seq > $3
          ORDER BY seq LIMIT 100`,
        [id, auth.tenantId, lastSeq],
      );
      for (const m of msgs) {
        lastSeq = Number(m.seq);
        res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      }
      const session = await this.db.queryOne<{ phase: string; status: string }>(
        { tenantId: auth.tenantId, userId: auth.userId },
        `SELECT phase, status FROM agent_sessions WHERE id = $1 AND tenant_id = $2`,
        [id, auth.tenantId],
      );
      if (session && session.phase !== lastPhase) {
        lastPhase = session.phase;
        res.write(`event: phase\ndata: ${JSON.stringify(session)}\n\n`);
      }
      return session ? ['running'].includes(session.status) : false;
    };

    // Poll loop: 1s cadence, ends when the session leaves `running` or the
    // client disconnects. Postgres LISTEN/NOTIFY is the planned upgrade path.
    for (let i = 0; i < 600 && !closed; i++) {
      const alive = await tick();
      if (!alive && i > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!closed) res.end();
  }
}
