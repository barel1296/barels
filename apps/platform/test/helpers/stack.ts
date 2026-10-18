import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApi } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { withTx } from '../../src/db/tx.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { issueApiToken } from '../../src/modules/auth.js';
import { type MockEngine, startMockEngine } from '../../src/mock-engine/engine.js';
import { type LlmSimulator, startLlmSimulator } from '../../src/simulators/llm.js';
import { type TelegramSimulator, startTelegramSimulator } from '../../src/simulators/telegram.js';
import { type Services, closeServices, createServices } from '../../src/services.js';
import { engineHealthTick, runWorkerOnce } from '../../src/worker.js';
import { createTestDatabase, type TestDatabase } from './db.js';

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export interface Client {
  get<T = any>(path: string): Promise<HttpResult<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult<T>>;
  put<T = any>(path: string, body?: unknown): Promise<HttpResult<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<HttpResult<T>>;
  upload<T = any>(path: string, bytes: Buffer, contentType: string): Promise<HttpResult<T>>;
}

export interface Users {
  workspaceId: string;
  /** Workspace owner and platform administrator (registers engines, approves workflows). */
  owner: { id: string; token: string; client: Client };
  /** Content manager: configures the influencer, requests generation, prepares and schedules content. */
  manager: { id: string; token: string; client: Client };
  /** Reviewer: approves or rejects content. */
  reviewer: { id: string; token: string; client: Client };
  /** Compliance officer: approves personas and reference assets. */
  compliance: { id: string; token: string; client: Client };
}

export interface Stack {
  db: TestDatabase;
  svc: Services;
  api: FastifyInstance;
  apiUrl: string;
  engine: MockEngine;
  engineToken: string;
  /** SIMULATED LLM (only with opts.llm). */
  llm: LlmSimulator | null;
  /** SIMULATED Telegram Bot API (only with opts.telegram). */
  telegram: TelegramSimulator | null;
  mediaRoot: string;
  ws: Users;
  client(token: string): Client;
  /** Creates another workspace with its own users (tenant isolation tests). */
  createWorkspace(slug: string): Promise<Users>;
  /** Runs worker passes until `done` returns true (or throws after maxPasses). */
  drive(done: () => Promise<boolean>, maxPasses?: number): Promise<void>;
  close(): Promise<void>;
}

export function makeClient(baseUrl: string, token: string): Client {
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: { bytes: Buffer; type: string }) => {
    const h: Record<string, string> = { Authorization: `Bearer ${token}`, ...headers };
    let payload: string | Buffer | undefined;
    if (raw) {
      h['Content-Type'] = raw.type;
      payload = raw.bytes;
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    put: (p, b) => call('PUT', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    upload: (p, bytes, type) => call('POST', p, undefined, {}, { bytes, type }),
  };
}

export interface StackOptions {
  maxConcurrentJobs?: number;
  /** Start the SIMULATED LLM server and point LLM_BASE_URL at it. */
  llm?: boolean;
  /** Start the SIMULATED Telegram Bot API server and point TELEGRAM_API_BASE_URL at it. */
  telegram?: boolean;
  /** Extra environment overrides for loadConfig. */
  env?: Record<string, string>;
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const db = await createTestDatabase();
  const mediaRoot = await mkdtemp(join(tmpdir(), 'gi-media-'));
  const engineToken = randomBytes(32).toString('base64url');
  const llmSim = opts.llm ? await startLlmSimulator() : null;
  const tgSim = opts.telegram ? await startTelegramSimulator() : null;
  const config = loadConfig({
    ...(tgSim ? { TELEGRAM_API_BASE_URL: tgSim.baseUrl, TELEGRAM_POLL_TIMEOUT_S: '0' } : {}),
    CONVERSATION_REPLY_DEBOUNCE_MS: '0',
    ...(llmSim ? { LLM_BASE_URL: llmSim.baseUrl, LLM_CHAT_MODEL: 'simulated-chat-model', LLM_TIMEOUT_MS: '5000' } : {}),
    SESSION_COOKIE_SECURE: 'false',
    DATABASE_URL: db.appUrl,
    WORKER_DATABASE_URL: db.workerUrl,
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_ID: 'test-1',
    ASSET_URL_SECRET: randomBytes(32).toString('base64'),
    MEDIA_ROOT: mediaRoot,
    HTTP_PORT: '0',
    ENGINE_HTTP_TIMEOUT_MS: '3000',
    RETRY_BASE_MS: '0',
    RETRY_MAX_MS: '0',
    POLL_INTERVAL_MS: '10',
    LEASE_S: '30',
    TIMEOUT_GRACE_S: '0',
    WORKER_ID: 'test-worker',
    ...(opts.env ?? {}),
  });
  const svc = createServices(config);
  const engine = await startMockEngine({ token: engineToken, contractDir: config.contractDir, maxConcurrentJobs: opts.maxConcurrentJobs ?? 1, defaultDelayMs: 20 });
  const api = buildApi(svc);
  const cleanup = async () => {
    await llmSim?.close().catch(() => undefined);
    await tgSim?.close().catch(() => undefined);
    await api.close().catch(() => undefined);
    await engine.close().catch(() => undefined);
    await closeServices(svc);
    await db.drop().catch(() => undefined);
    await rm(mediaRoot, { recursive: true, force: true });
  };
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
  // Signed reference URLs must point at the running API.
  svc.config.publicBaseUrl = address;

  const createWorkspace = async (slug: string): Promise<Users> =>
    withTx(svc.workerPool, async (tx) => {
      const ws = uuidv7();
      await tx.query('INSERT INTO core.workspaces (id, slug, name) VALUES ($1, $2, $3)', [ws, slug, `Workspace ${slug}`]);
      const make = async (role: string, admin: boolean) => {
        const id = uuidv7();
        await tx.query(
          `INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject, is_platform_admin) VALUES ($1, $2, $3, 'local', $2::citext::text, $4)`,
          [id, `${role}.${slug}@example.test`, `${role} ${slug}`, admin],
        );
        await tx.query(
          `INSERT INTO core.memberships (workspace_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE key = $3 AND workspace_id IS NULL`,
          [ws, id, role],
        );
        const { token } = await issueApiToken(tx, { userId: id, workspaceId: ws, name: 'test', createdBy: null });
        return { id, token, client: makeClient(address, token) };
      };
      return {
        workspaceId: ws,
        owner: await make('owner', true),
        manager: await make('content_manager', false),
        reviewer: await make('reviewer', false),
        compliance: await make('compliance_officer', false),
      };
    });

  let ws: Users;
  try {
    ws = await createWorkspace('studio');
  } catch (err) {
    await cleanup();
    throw err;
  }

  const drive = async (done: () => Promise<boolean>, maxPasses = 300) => {
    for (let i = 0; i < maxPasses; i++) {
      if (await done()) return;
      await engineHealthTick(svc);
      await runWorkerOnce(svc);
      await sleep(15);
    }
    if (!(await done())) throw new Error(`drive: condition not reached after ${maxPasses} worker passes`);
  };

  return {
    db,
    svc,
    api,
    apiUrl: address,
    engine,
    engineToken,
    llm: llmSim,
    telegram: tgSim,
    mediaRoot,
    ws,
    client: (token) => makeClient(address, token),
    createWorkspace,
    drive,
    close: cleanup,
  };
}

// --- Scenario builders shared by the e2e suites --------------------------------------

export const PERSONA = {
  personality: { traits: ['curious', 'warm'], values: ['craft'], boundaries: ['no politics'] },
  writing_style: { tone: 'playful', emoji_policy: 'sparse' },
  biography: { fictional: true, age_years: 27, home_city: 'Lisbon (fictional backstory)' },
  visual_identity: { hair: 'auburn bob', eyes: 'green', marks: ['freckles'], palette: ['teal', 'sand'], photo_style: 'natural light' },
  conversation_rules: { disclosure: 'I am an AI-generated virtual creator.', relationship_framing: 'friendly, never romantic exclusivity' },
};

/** Registers the mock engine, syncs and approves its persona workflow. Returns the workflow id. */
export async function setupEngine(stack: Stack): Promise<{ engineId: string; workflowId: string; conformanceWorkflowId: string }> {
  const owner = stack.ws.owner.client;
  const reg = await owner.post('/v1/platform/engines', { engine_key: 'ws01-mock', base_url: stack.engine.url, token: stack.engineToken });
  if (reg.status !== 201) throw new Error(`engine registration failed: ${JSON.stringify(reg.body)}`);
  const sync = await owner.post(`/v1/platform/engines/${reg.body.id}/sync`);
  if (sync.status !== 200) throw new Error(`sync failed: ${JSON.stringify(sync.body)}`);
  const list = await owner.get('/v1/platform/workflows');
  const persona = list.body.find((w: any) => w.workflow_key === 'mock.persona_portrait');
  const conformance = list.body.find((w: any) => w.workflow_key === '__conformance__.solid_color');
  for (const wf of [persona, conformance]) {
    const d = await owner.post(`/v1/platform/workflows/${wf.id}/decision`, { decision: 'approve', note: 'contract mock — test evidence only' });
    if (d.status !== 200) throw new Error(`approve failed: ${JSON.stringify(d.body)}`);
  }
  return { engineId: reg.body.id, workflowId: persona.id, conformanceWorkflowId: conformance.id };
}

/** Creates an influencer with an approved, active persona (manager authors, compliance approves). */
export async function setupInfluencer(stack: Stack, slug: string, users: Users = stack.ws): Promise<{ influencerId: string; personaVersionId: string }> {
  const m = users.manager.client;
  const owner = users.owner.client;
  const inf = await owner.post('/v1/influencers', {
    slug,
    display_name: `Persona ${slug}`,
    ai_disclosure_short: 'AI-generated virtual creator',
    ai_disclosure_long: 'This account is an AI-generated virtual character. Images are AI-generated; messages are automated.',
    timezone: 'Europe/Lisbon',
    primary_language: 'en',
  });
  if (inf.status !== 201) throw new Error(`influencer: ${JSON.stringify(inf.body)}`);
  const pv = await m.post(`/v1/influencers/${inf.body.id}/persona-versions`, PERSONA);
  if (pv.status !== 201) throw new Error(`persona: ${JSON.stringify(pv.body)}`);
  for (const [client, action] of [
    [m, 'submit'],
    [users.compliance.client, 'approve'],
    [owner, 'activate'],
  ] as const) {
    const r = await client.post(`/v1/persona-versions/${pv.body.id}/${action}`);
    if (r.status !== 200) throw new Error(`persona ${action}: ${JSON.stringify(r.body)}`);
  }
  return { influencerId: inf.body.id, personaVersionId: pv.body.id };
}

export async function jobState(stack: Stack, token: string, jobId: string): Promise<any> {
  return (await stack.client(token).get(`/v1/visual-jobs/${jobId}`)).body;
}

/** Adds a user with the given role to a workspace and returns an API client for them. */
export async function addMember(stack: Stack, workspaceId: string, role: string, name: string): Promise<{ id: string; token: string; client: Client }> {
  return withTx(stack.svc.workerPool, async (tx) => {
    const id = uuidv7();
    await tx.query(
      `INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject) VALUES ($1, $2, $3, 'local', $2::citext::text)`,
      [id, `${name}.${id.slice(-6)}@example.test`, name],
    );
    await tx.query(`INSERT INTO core.memberships (workspace_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE key = $3 AND workspace_id IS NULL`, [workspaceId, id, role]);
    const { token } = await issueApiToken(tx, { userId: id, workspaceId, name: 'test', createdBy: null });
    return { id, token, client: makeClient(stack.apiUrl, token) };
  });
}
