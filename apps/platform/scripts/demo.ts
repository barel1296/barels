/**
 * Local DEMO of the admin dashboard with a sample influencer.
 *
 * Everything external is SIMULATED and in-process: Telegram Bot API (including Stars), Instagram Graph
 * API, the local LLM and ComfyUI (behind the real VEC bridge). The platform itself is the real build
 * (dist/src/main.js) on a separate database of a LOCAL PostgreSQL server. Nothing connects to Telegram,
 * Meta, a model, the workstation or production.
 *
 *   npm run build
 *   npm run demo -- --admin-url postgres://postgres:<pw>@127.0.0.1:5432/postgres [--db golden_demo] [--port 8090] [--out <dir>] [--reset]
 *
 * --admin-url  superuser connection to a DEVELOPMENT server on this machine (loopback only). The demo
 *              creates the runtime roles if needed and RESETS their passwords: never point it at a
 *              server that runs a real installation.
 * The owner's password and TOTP secret are written to <out>/demo-credentials.txt (mode 600), never to
 * the console. Stop with Ctrl+C; the database is kept (use --reset to start over).
 * Screenshots of every screen: npm run demo:screenshots -- --out <same dir>
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { startBridge } from '../src/comfy-bridge/bridge.js';
import { loadConfig, paths } from '../src/config.js';
import { bootstrapCluster, migrate } from '../src/db/migrate.js';
import { withTx } from '../src/db/tx.js';
import type { TgUser } from '../src/integrations/telegram/client.js';
import { uuidv7 } from '../src/lib/ids.js';
import { encodeSolidPng } from '../src/lib/png.js';
import { issueApiToken } from '../src/modules/auth.js';
import { enrollTotp, setPassword } from '../src/modules/sessions.js';
import { startComfySimulator } from '../src/simulators/comfyui.js';
import { startInstagramSimulator } from '../src/simulators/instagram.js';
import { type SimChatRequest, startLlmSimulator } from '../src/simulators/llm.js';
import { startTelegramSimulator } from '../src/simulators/telegram.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const log = (msg: string) => console.log(`[demo] ${msg}`);

const adminUrl = arg('admin-url') ?? process.env.DEMO_PG_ADMIN_URL;
const dbName = arg('db') ?? 'golden_demo';
const port = Number(arg('port') ?? 8090);
const out = resolve(arg('out') ?? join(tmpdir(), 'golden-demo'));
const platformDir = resolve(paths.repoRoot, 'apps/platform');

if (!adminUrl) throw new Error('--admin-url postgres://<superuser>:<pw>@127.0.0.1:<port>/postgres is required (or DEMO_PG_ADMIN_URL)');
// Loopback only, plus host names listed in DEMO_ALLOWED_DB_HOSTS (e.g. the private `db` service of the dev container).
const allowedHosts = ['127.0.0.1', 'localhost', '[::1]', ...(process.env.DEMO_ALLOWED_DB_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)];
if (!allowedHosts.includes(new URL(adminUrl).hostname)) throw new Error('the demo only runs against a PostgreSQL server on this machine (or a host in DEMO_ALLOWED_DB_HOSTS)');
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new Error('invalid --db');
if (!existsSync(join(platformDir, 'dist/src/main.js'))) throw new Error('run `npm run build` first (the demo starts the built platform)');
mkdirSync(out, { recursive: true });

const urlFor = (user: string, password: string, database: string) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
};
const secret = (n = 32) => randomBytes(n).toString('base64');

// ---------------------------------------------------------------------------------------------
// Database: separate demo database, production role model.
// ---------------------------------------------------------------------------------------------
const rolePassword = randomBytes(18).toString('base64url');
await bootstrapCluster(adminUrl, resolve(paths.repoRoot, 'db/bootstrap.sql'), { migrator_password: rolePassword, app_password: rolePassword, worker_password: rolePassword });
{
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount === 1;
    if (exists && !flag('reset')) throw new Error(`database ${dbName} exists: pass --reset to recreate it`);
    if (exists) await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName} OWNER aios_migrator`);
    await admin.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO aios_app, aios_worker`);
  } finally {
    await admin.end();
  }
}
await migrate(urlFor('aios_migrator', rolePassword, dbName), resolve(paths.repoRoot, 'db/migrations'));
const db = new pg.Pool({ connectionString: urlFor(new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password), dbName), max: 4 });
log(`database ${dbName} migrated`);

// ---------------------------------------------------------------------------------------------
// Simulators (in this process) and the real bridge in front of the simulated ComfyUI.
// ---------------------------------------------------------------------------------------------
const llm = await startLlmSimulator({ model: 'simulated-chat-model' });
const tg = await startTelegramSimulator();
const ig = await startInstagramSimulator();
const comfy = await startComfySimulator();
const vecToken = randomBytes(32).toString('base64url');
const bridge = await startBridge({
  token: vecToken,
  comfyUrl: comfy.baseUrl,
  packagesDir: join(platformDir, 'test/fixtures/comfy-packages'),
  dataDir: join(out, 'bridge'),
  contractDir: paths.contractDir,
  engineId: 'demo-comfyui-bridge',
  pollIntervalMs: 200,
});
scriptLlm();

// A stand-in for nvidia-smi so the Ops page has GPU samples (SIMULATED values).
const fakeSmi = join(out, 'fake-nvidia-smi.mjs');
writeFileSync(
  fakeSmi,
  `const t = Date.now() / 60000; const u = Math.round(35 + 30 * Math.abs(Math.sin(t)));\n` +
    `console.log(\`0, SIMULATED GPU - demo, no hardware, \${u}, \${Math.round(9000 + u * 120)}, 24463, \${Math.round(55 + u / 4)}, \${(60 + u).toFixed(1)}\`);\n`,
);

const env: Record<string, string> = {
  DATABASE_URL: urlFor('aios_app', rolePassword, dbName),
  WORKER_DATABASE_URL: urlFor('aios_worker', rolePassword, dbName),
  MIGRATION_DATABASE_URL: urlFor('aios_migrator', rolePassword, dbName),
  MASTER_KEY: secret(),
  MASTER_KEY_ID: 'demo-1',
  ASSET_URL_SECRET: secret(),
  INVOICE_SECRET: secret(),
  METRICS_TOKEN: randomBytes(24).toString('base64url'),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: String(port),
  PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  MEDIA_ROOT: join(out, 'media'),
  AUDIT_EXPORT_DIR: join(out, 'audit'),
  NODE_NAME: 'demo',
  SESSION_COOKIE_SECURE: 'false',
  LLM_BASE_URL: llm.baseUrl,
  LLM_CHAT_MODEL: 'simulated-chat-model',
  CONVERSATION_REPLY_DEBOUNCE_MS: '200',
  TELEGRAM_API_BASE_URL: tg.baseUrl,
  TELEGRAM_POLL_TIMEOUT_S: '0',
  TELEGRAM_POLL_INTERVAL_MS: '250',
  INSTAGRAM_GRAPH_BASE_URL: ig.baseUrl,
  INSTAGRAM_CONTAINER_POLL_MS: '200',
  PUBLISHING_ADAPTERS: 'telegram,instagram',
  PUBLIC_MEDIA_BASE_URL: `http://127.0.0.1:${port}`,
  DISPATCH_INTERVAL_MS: '300',
  POLL_INTERVAL_MS: '300',
  PUBLISH_INTERVAL_MS: '1000',
  ENGINE_HEALTH_INTERVAL_MS: '5000',
  GPU_MONITOR_ENABLED: 'true',
  GPU_MONITOR_COMMAND: `node ${fakeSmi}`,
  GPU_SAMPLE_INTERVAL_MS: '5000',
  COST_GPU_HOUR_USD: '0.35',
  COST_LLM_PER_1K_TOKENS_USD: '0.0004',
  COST_FIXED_MONTHLY_USD: '60',
};
const config = loadConfig({ ...env });

// ---------------------------------------------------------------------------------------------
// The platform: the real build, as its own process.
// ---------------------------------------------------------------------------------------------
const logFd = openSync(join(out, 'platform.log'), 'a');
const platform = spawn(process.execPath, ['dist/src/main.js'], { cwd: platformDir, env: { ...process.env, ...env }, stdio: ['ignore', logFd, logFd] });
let stopping = false;
// Never leave the platform running when this script ends, whatever the reason.
process.on('exit', () => platform.kill('SIGTERM'));
platform.on('exit', (code) => {
  if (!stopping) {
    console.error(`[demo] the platform exited (${code}); see ${join(out, 'platform.log')}`);
    process.exit(1);
  }
});
const base = `http://127.0.0.1:${port}`;
await until('platform /healthz', async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok === true, 60_000);
log(`platform up at ${base}`);

// ---------------------------------------------------------------------------------------------
// People (the CLI does the same): owner with password + TOTP, and one account per role.
// ---------------------------------------------------------------------------------------------
const workspaceId = uuidv7();
await db.query(`INSERT INTO core.workspaces (id, slug, name) VALUES ($1, 'studio', 'Golden Studio (demo)')`, [workspaceId]);
async function addUser(email: string, name: string, role: string, platformAdmin = false): Promise<{ id: string; token: string }> {
  return withTx(db, async (tx) => {
    const id = uuidv7();
    await tx.query(`INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject, is_platform_admin) VALUES ($1, $2, $3, 'local', $2::citext::text, $4)`, [id, email, name, platformAdmin]);
    await tx.query(`INSERT INTO core.memberships (workspace_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE key = $3 AND workspace_id IS NULL`, [workspaceId, id, role]);
    const { token } = await issueApiToken(tx, { userId: id, workspaceId, name: 'demo seeding', createdBy: null });
    return { id, token };
  });
}
const ownerEmail = 'owner@demo.local';
const owner = await addUser(ownerEmail, 'Dana (owner)', 'owner', true);
const manager = await addUser('manager@demo.local', 'Ravi (content manager)', 'content_manager');
const reviewer = await addUser('reviewer@demo.local', 'Ines (reviewer)', 'reviewer');
const compliance = await addUser('compliance@demo.local', 'Tom (compliance)', 'compliance_officer');
const finance = await addUser('finance@demo.local', 'Mei (finance)', 'finance');
await addUser('operator@demo.local', 'Alex (chat operator)', 'chat_operator');
const ownerPassword = `demo-${randomBytes(9).toString('base64url')}`;
await setPassword(db, owner.id, ownerPassword);
const totp = await enrollTotp(db, config, owner.id, ownerEmail);

async function api(token: string, method: string, path: string, body?: unknown, raw?: { bytes: Buffer; type: string }): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: string | Buffer | undefined;
  if (raw) {
    headers['content-type'] = raw.type;
    payload = raw.bytes;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const O = owner.token;
const M = manager.token;

// ---------------------------------------------------------------------------------------------
// Visual engine: the bridge (in front of the simulated ComfyUI) and its test workflow.
// ---------------------------------------------------------------------------------------------
const engine = await api(O, 'POST', '/v1/platform/engines', { engine_key: 'ws-comfyui', base_url: bridge.url, token: vecToken });
await api(O, 'POST', `/v1/platform/engines/${engine.id}/sync`, {});
for (const w of await api(O, 'GET', '/v1/platform/workflows')) {
  if (w.workflow_key === 'sim.portrait') await api(O, 'POST', `/v1/platform/workflows/${w.id}/decision`, { decision: 'approve', note: 'DEMO: simulated test package, not a Track A workflow' });
}
log('engine registered, workflow approved');

// ---------------------------------------------------------------------------------------------
// The demo influencer: Luna Vale.
// ---------------------------------------------------------------------------------------------
const luna = await api(O, 'POST', '/v1/influencers', {
  slug: 'luna-vale',
  display_name: 'Luna Vale',
  ai_disclosure_short: 'AI-generated virtual creator',
  ai_disclosure_long: 'Luna Vale is an AI-generated virtual character. Her images are AI-generated and her messages are written by an AI and reviewed by a human team.',
  timezone: 'Europe/Lisbon',
  primary_language: 'en',
});
const L = luna.id as string;
await api(O, 'PATCH', `/v1/influencers/${L}/runtime-config`, { free_replies_per_day: 10, premium_replies_per_day: 100, default_conversation_mode: 'ai_draft', memory_enabled: true });
const persona = {
  personality: { traits: ['curious', 'warm', 'playful', 'a little nerdy about film photography'], values: ['craft', 'kindness'], boundaries: ['no politics', 'no explicit content', 'never claims to be human'] },
  writing_style: { tone: 'warm and playful', emoji_policy: 'sparse', sentence_length: 'short', signature_phrase: 'golden hour hunter' },
  biography: { fictional: true, age_years: 26, home_city: 'Lisbon (fictional backstory)', occupation: 'travel and lifestyle creator', hobbies: ['film photography', 'hiking', 'pastel de nata taste tests'] },
  visual_identity: { hair: 'copper waves', eyes: 'hazel', marks: ['freckles'], palette: ['terracotta', 'sand', 'teal'], photo_style: 'warm natural light, 35 mm film look' },
  conversation_rules: { disclosure: 'I am an AI-generated virtual creator.', relationship_framing: 'friendly, never romantic exclusivity', topics_to_avoid: ['politics', 'medical advice'] },
};
const pv1 = await api(M, 'POST', `/v1/influencers/${L}/persona-versions`, { ...persona, change_summary: 'First persona' });
await api(M, 'POST', `/v1/persona-versions/${pv1.id}/submit`);
await api(compliance.token, 'POST', `/v1/persona-versions/${pv1.id}/approve`);
await api(O, 'POST', `/v1/persona-versions/${pv1.id}/activate`);
const pv2 = await api(M, 'POST', `/v1/influencers/${L}/persona-versions`, { ...persona, writing_style: { ...persona.writing_style, emoji_policy: 'moderate' }, change_summary: 'Slightly more emoji in chats' });
await api(M, 'POST', `/v1/persona-versions/${pv2.id}/submit`);
const face = await api(M, 'POST', `/v1/influencers/${L}/reference-assets?kind=face_canonical`, undefined, { bytes: encodeSolidPng(96, 96, [214, 140, 96]), type: 'image/png' });
await api(compliance.token, 'POST', `/v1/reference-assets/${face.id}/approve`);
await api(M, 'POST', `/v1/influencers/${L}/reference-assets?kind=outfit`, undefined, { bytes: encodeSolidPng(96, 96, [42, 128, 128]), type: 'image/png' });
// The simulated ComfyUI only knows sim-lora-a.safetensors; a real Track A LoRA name goes here on the workstation.
const adapter = await api(M, 'POST', `/v1/influencers/${L}/adapters`, { kind: 'lora', engine_ref: 'sim-lora-a.safetensors', workflow_keys: ['sim.portrait'] });
await api(compliance.token, 'POST', `/v1/adapters/${adapter.id}/approve`);
await api(M, 'PUT', `/v1/influencers/${L}/workflow-bindings/feed_photo`, { workflow_key: 'sim.portrait', version_range: '^1.0', default_parameters: { aspect_ratio: '4:5' }, priority_class: 'scheduled_image' });
await api(O, 'POST', `/v1/influencers/${L}/status`, { status: 'active' });
log('Luna Vale configured and active');

// Channels: Telegram bot, public channel, premium channel; Instagram account.
const botToken = tg.addBot('lunavale_demo_bot').token;
const bot = await api(O, 'POST', `/v1/influencers/${L}/telegram/bot`, { token: botToken });
const tgPublic = await api(O, 'POST', `/v1/influencers/${L}/channels`, { integration_account_id: bot.account_id, kind: 'telegram_public_channel', external_id: '-1001234567890', username: 'lunavale_demo' });
const VIP_CHAT = '-1009876543210';
const tgVip = await api(O, 'POST', `/v1/influencers/${L}/channels`, { integration_account_id: bot.account_id, kind: 'telegram_premium_channel', external_id: VIP_CHAT, title: 'Luna VIP' });
const igAccount = ig.addAccount('luna.vale.ai');
const igAcc = await api(O, 'POST', '/v1/integration-accounts', { influencer_id: L, provider: 'instagram', external_account_id: igAccount.igUserId, credential: igAccount.token });
const igCh = await api(O, 'POST', `/v1/influencers/${L}/channels`, { integration_account_id: igAcc.id, kind: 'instagram_account', external_id: igAccount.igUserId, username: 'luna.vale.ai' });

// Products: drafted by the manager, approved by the owner (four-eyes); one left as a draft.
const products: Record<string, string> = {};
for (const d of [
  { sku: 'vip', kind: 'premium_channel_subscription', name: 'Luna VIP channel', description: 'Monthly access to the private channel with behind-the-scenes AI-generated posts.', price_stars: 250, grants: [{ kind: 'premium_channel_access', channel_id: tgVip.id }] },
  { sku: 'chat-plus', kind: 'bot_subscription', name: 'Chat Plus', description: 'More daily messages with Luna (AI).', price_stars: 150, grants: [{ kind: 'bot_premium_tier' }] },
  { sku: 'pack-100', kind: 'message_pack', name: '100 messages', description: '100 extra messages with Luna (AI).', price_stars: 50, grants: [{ kind: 'message_credits', quantity: 100 }] },
]) {
  const p = await api(M, 'POST', `/v1/influencers/${L}/products`, d);
  await api(M, 'POST', `/v1/products/${p.id}/submit`);
  await api(O, 'POST', `/v1/products/${p.id}/approve`);
  products[d.sku] = p.id;
}
await api(M, 'POST', `/v1/influencers/${L}/products`, { sku: 'pack-20', kind: 'message_pack', name: '20 messages (draft)', description: 'Starter pack, not yet submitted.', price_stars: 15, grants: [{ kind: 'message_credits', quantity: 20 }] });
await api(O, 'POST', '/v1/star-valuations', { effective_date: day(-30), fiat_currency: 'USD', fiat_per_star: 0.013, method: 'platform_quoted_rate', source_ref: 'DEMO value, not a real rate' });
log('channels and products ready');

// ---------------------------------------------------------------------------------------------
// Media: four generations through platform -> bridge -> simulated ComfyUI (solid-colour images).
// ---------------------------------------------------------------------------------------------
const scenes = ['Golden hour on the Tagus riverfront', 'Morning coffee at a tiled café', 'Rainy hike above Sintra', 'Film camera on a sunlit windowsill'];
const assets: string[] = [];
for (const [i, scene] of scenes.entries()) {
  const job = await api(M, 'POST', `/v1/influencers/${L}/visual-jobs`, { idempotency_key: `demo-gen-${i}-${Date.now()}`, purpose: 'feed_photo', parameters: { scene, mood: 'warm', seed: 1000 + i * 77 }, output_count: 1 });
  await until(`generation ${i}`, async () => ['succeeded', 'failed', 'cancelled'].includes((await api(M, 'GET', `/v1/visual-jobs/${job.id}`)).state));
  const done = await api(M, 'GET', `/v1/visual-jobs/${job.id}`);
  if (done.state !== 'succeeded') throw new Error(`generation ${i} ${done.state}: ${done.error_code} ${done.error?.message ?? ''}`);
  const a = await api(M, 'GET', `/v1/influencers/${L}/media-assets?visual_job_id=${job.id}`);
  assets.push(a[0].id);
}
log(`${assets.length} images generated (SIMULATED ComfyUI)`);

// ---------------------------------------------------------------------------------------------
// Agents and content.
// ---------------------------------------------------------------------------------------------
await api(O, 'POST', '/v1/agents/enable', { agent_keys: ['content_strategist', 'social_media', 'qa_compliance'] });
async function contentItem(format: string, brief: Record<string, unknown>, caption: string, asset: string, hashtags: string[] = []) {
  const item = await api(M, 'POST', `/v1/influencers/${L}/content-items`, { format, brief });
  const rev = await api(M, 'POST', `/v1/content-items/${item.id}/revisions`, { caption, hashtags, assets: [{ media_asset_id: asset, role: 'primary' }] });
  return { item, rev };
}
async function approveContent(revId: string): Promise<void> {
  const req = await api(M, 'POST', `/v1/revisions/${revId}/approval-requests`);
  await until('QA review', async () => (await db.query('SELECT 1 FROM approvals.qa_reviews WHERE approval_request_id = $1', [req.id])).rowCount! > 0, 30_000).catch(() => undefined);
  const a = await api(reviewer.token, 'GET', `/v1/approvals/${req.id}`);
  await api(reviewer.token, 'POST', `/v1/approvals/${req.id}/decisions`, { decision: 'approve', payload_hash: a.payload_hash });
}
// Published on Instagram (with insights and comments).
const igPost = await contentItem('ig_image', { theme: 'River sunsets', mood: 'warm' }, 'Golden hour on the river never gets old ✨ Where do you watch the sunset?', assets[0]!, ['goldenhour', 'lisbon']);
await approveContent(igPost.rev.id);
const igPub = await api(M, 'POST', `/v1/content-items/${igPost.item.id}/publications`, { channel_id: igCh.id, scheduled_for: new Date().toISOString() });
// Published on the public Telegram channel.
const tgPost = await contentItem('tg_post', { theme: 'Café mornings' }, 'Slow morning, strong coffee ☕ What is your go-to order?', assets[1]!);
await approveContent(tgPost.rev.id);
await api(M, 'POST', `/v1/content-items/${tgPost.item.id}/publications`, { channel_id: tgPublic.id, scheduled_for: new Date().toISOString() });
// Approved and scheduled for tomorrow evening.
const later = await contentItem('tg_post', { theme: 'Rainy trails' }, 'Rain on the trail, tea in the thermos. Perfect day 🌧️', assets[2]!);
await approveContent(later.rev.id);
const tomorrow = new Date(Date.now() + 86_400_000);
tomorrow.setUTCHours(18, 30, 0, 0);
await api(M, 'POST', `/v1/content-items/${later.item.id}/publications`, { channel_id: tgPublic.id, scheduled_for: tomorrow.toISOString() });
// Waiting for review (automated QA runs first).
const pending = await contentItem('ig_image', { theme: 'Film photography' }, 'My favourite camera is older than me 📷 Do you shoot film?', assets[3]!, ['filmphotography']);
const pendingReq = await api(M, 'POST', `/v1/revisions/${pending.rev.id}/approval-requests`);
// Caught by automated QA: claims to be human and asks for off-platform payment -> needs rework.
const bad = await contentItem('ig_image', { theme: 'Exclusive pics' }, "I'm a real girl, send stars via paypal for exclusive pics", assets[3]!);
await api(M, 'POST', `/v1/revisions/${bad.rev.id}/approval-requests`);
// The strategist's plan for next week (approved -> calendar) and the week after (waiting).
const plan1 = await api(M, 'POST', `/v1/influencers/${L}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(1), period_end: day(7), posts: 4 } });
await until('strategist plan', async () => ['waiting_approval', 'succeeded', 'failed'].includes((await db.query('SELECT status FROM agents.tasks WHERE id = $1', [plan1.id])).rows[0]?.status));
const prop = (await api(M, 'GET', `/v1/proposals?influencer_id=${L}`))[0];
if (prop?.approval_request_id) {
  const a = await api(M, 'GET', `/v1/approvals/${prop.approval_request_id}`);
  await api(M, 'POST', `/v1/approvals/${prop.approval_request_id}/decisions`, { decision: 'approve', payload_hash: a.payload_hash });
}
const plan2 = await api(M, 'POST', `/v1/influencers/${L}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(8), period_end: day(14), posts: 3 } });
await until('second plan', async () => ['waiting_approval', 'succeeded', 'failed'].includes((await db.query('SELECT status FROM agents.tasks WHERE id = $1', [plan2.id])).rows[0]?.status));
await until('publications', async () => (await db.query(`SELECT count(*)::int AS n FROM publishing.publications WHERE influencer_id = $1 AND status = 'published'`, [L])).rows[0].n >= 2, 60_000);
const igMediaId = (await db.query('SELECT external_post_id FROM publishing.publications WHERE id = $1', [igPub.id])).rows[0]?.external_post_id as string;
ig.setInsights(igMediaId, { reach: 4120, likes: 512, comments: 38, saved: 61, shares: 22, views: 6900 });
const hello = ig.addComment(igMediaId, { text: 'This light is unreal 😍', fromId: '17841400001', username: 'travel.with.jo' });
ig.addComment(igMediaId, { text: 'Which film stock was this?', fromId: '17841400002', username: 'grain.lover' });
ig.addComment(igMediaId, { text: 'thank you Jo! 💛', fromId: igAccount.igUserId, username: 'luna.vale.ai', parentId: hello });
ig.addComment(igMediaId, { text: 'Free followers here!! check www.spam-followers.example', fromId: '17841400003', username: 'promo.bot.99' });
log('content, plans and publications ready');

// ---------------------------------------------------------------------------------------------
// Fans on Telegram: consent, chats (drafts, auto replies), memories, escalations, purchases.
// ---------------------------------------------------------------------------------------------
const fan = (id: number, first_name: string, username: string): TgUser => ({ id, is_bot: false, first_name, username }) as TgUser;
const fans = { mia: fan(910001, 'Mia', 'mia_travels'), jonas: fan(910002, 'Jonas', 'jonas.k'), priya: fan(910003, 'Priya', 'priya_hikes'), leo: fan(910004, 'Leo', 'leo_b'), sofia: fan(910005, 'Sofia', 'sofi'), kenji: fan(910006, 'Kenji', 'kenji_jazz') };
const sentTo = (u: TgUser, tok = botToken) => tg.sent(tok, 'sendMessage').filter((c) => String(c.params.chat_id) === String(u.id)).length;
async function say(u: TgUser, text: string, tok = botToken): Promise<void> {
  const before = await db.query('SELECT count(*)::int AS n FROM conversation.messages m JOIN conversation.conversations c ON c.id = m.conversation_id WHERE c.external_chat_id = $1', [String(u.id)]).catch(() => ({ rows: [{ n: 0 }] }));
  tg.userMessage(tok, u, text);
  await until(`message from ${u.first_name}`, async () => (await db.query('SELECT count(*)::int AS n FROM conversation.messages m JOIN conversation.conversations c ON c.id = m.conversation_id WHERE c.external_chat_id = $1', [String(u.id)])).rows[0].n > before.rows[0].n);
  await sleep(900);
}
async function onboard(u: TgUser, memory = false, tok = botToken): Promise<void> {
  const n = sentTo(u, tok);
  tg.userMessage(tok, u, '/start');
  await until(`consent prompt for ${u.first_name}`, async () => sentTo(u, tok) > n);
  const m = sentTo(u, tok);
  tg.callback(tok, u, 'consent:accept');
  await until(`welcome for ${u.first_name}`, async () => sentTo(u, tok) > m);
  if (memory) {
    // Fan memory is a separate, optional consent ("Yes, remember").
    const k = sentTo(u, tok);
    tg.callback(tok, u, 'memory:on');
    await until(`memory consent for ${u.first_name}`, async () => sentTo(u, tok) > k);
  }
}
async function buy(u: TgUser, productId: string, subscription = false, tok = botToken): Promise<string> {
  const n = tg.sent(tok, 'createInvoiceLink').length;
  tg.callback(tok, u, `buy:${productId}`);
  await until('invoice', async () => tg.sent(tok, 'createInvoiceLink').length > n);
  const invoice = tg.sent(tok, 'createInvoiceLink').at(-1)!.params;
  const payload = String(invoice.payload);
  const amount = (invoice.prices as { amount: number }[])[0]!.amount;
  const answers = tg.preCheckoutAnswers.size;
  tg.preCheckout(tok, u, payload, amount);
  await until('pre-checkout', async () => tg.preCheckoutAnswers.size > answers);
  const chargeId = `stxDEMO${u.id}${Date.now() % 100000}`;
  tg.successfulPayment(tok, u, { payload, amount, chargeId, ...(subscription ? { subscriptionExpiration: Math.floor(Date.now() / 1000) + 30 * 86400, isRecurring: true, isFirstRecurring: true } : {}) });
  await until('payment', async () => (await db.query('SELECT 1 FROM monetization.payments WHERE telegram_payment_charge_id = $1', [chargeId])).rowCount === 1);
  // Telegram's Stars ledger has the same transaction, so reconciliation matches it.
  tg.addStarTransaction(tok, { id: chargeId, amount, date: Math.floor(Date.now() / 1000), source: { type: 'user', user: u, invoice_payload: payload } });
  return chargeId;
}
const convOf = async (u: TgUser) => (await db.query('SELECT id FROM conversation.conversations WHERE external_chat_id = $1', [String(u.id)])).rows[0]?.id as string;
for (const u of Object.values(fans)) await onboard(u, [fans.mia, fans.priya, fans.kenji].includes(u));
await say(fans.mia, 'hi Luna! loved your sunset post on the river 😍');
await say(fans.mia, "I'm into film photography too, I shoot on a Pentax K1000");
await say(fans.jonas, 'what camera do you use?');
await say(fans.priya, 'any tips for hiking in the rain?');
await say(fans.leo, 'can I talk to a real person please?');
// Kenji's chat runs on automatic AI replies.
await api(O, 'PATCH', `/v1/conversations/${await convOf(fans.kenji)}`, { mode: 'ai_auto' });
await say(fans.kenji, 'my cat Miso says hi 🐱');
await say(fans.kenji, 'I play jazz piano in a small bar on weekends');
// The operator approves Jonas's draft; Mia's and Priya's stay in the inbox.
const jonasConv = await convOf(fans.jonas);
await until('Jonas draft', async () => (await api(O, 'GET', `/v1/conversations/${jonasConv}`)).messages.some((m: any) => m.status === 'drafted'));
const jd = (await api(O, 'GET', `/v1/conversations/${jonasConv}`)).messages.find((m: any) => m.status === 'drafted');
await api(O, 'POST', `/v1/conversations/${jonasConv}/drafts/${jd.id}/approve`, {});
// Purchases (Telegram Stars, simulated).
await buy(fans.mia, products.vip!, true);
tg.joinRequest(botToken, Number(VIP_CHAT), fans.mia);
await buy(fans.jonas, products['chat-plus']!, true);
await buy(fans.priya, products['pack-100']!);
await buy(fans.kenji, products['pack-100']!);
const sofiaCharge = await buy(fans.sofia, products.vip!, true);
await say(fans.sofia, "I'd like a refund please, I bought it by mistake");
const sofiaPay = (await db.query('SELECT id FROM monetization.payments WHERE telegram_payment_charge_id = $1', [sofiaCharge])).rows[0].id;
await api(O, 'POST', `/v1/payments/${sofiaPay}/refunds`, { reason: 'Fan says the subscription was bought by mistake (DEMO)' });
log('fans, chats and payments ready');

await api(O, 'POST', '/v1/autonomy-policies', { influencer_id: L, action_type: 'caption.propose', agent_key: 'social_media', level: 3, conditions: { max_per_day: 5 } });

// ---------------------------------------------------------------------------------------------
// A second influencer from the golden template, and two weeks of (synthetic) history.
// ---------------------------------------------------------------------------------------------
const cloned = await api(O, 'POST', `/v1/influencers/${L}/clone`, {
  slug: 'nova-reyes',
  display_name: 'Nova Reyes',
  ai_disclosure_short: 'AI-generated virtual creator',
  ai_disclosure_long: 'Nova Reyes is an AI-generated virtual character. Images are AI-generated; messages are automated.',
  timezone: 'Europe/Madrid',
  primary_language: 'en',
});
// The clone brings configuration only; Nova gets her own identity, bot, fans and content.
const N = cloned.influencer.id as string;
const novaPersona = {
  personality: { traits: ['adventurous', 'sunny', 'witty'], values: ['curiosity', 'slow travel'], boundaries: ['no politics', 'no explicit content', 'never claims to be human'] },
  writing_style: { tone: 'upbeat', emoji_policy: 'moderate', sentence_length: 'short' },
  biography: { fictional: true, age_years: 29, home_city: 'Madrid (fictional backstory)', occupation: 'travel creator', hobbies: ['night trains', 'street food', 'flamenco guitar'] },
  visual_identity: { hair: 'black curls', eyes: 'brown', palette: ['coral', 'cobalt', 'cream'], photo_style: 'bright daylight, wide angle' },
  conversation_rules: { disclosure: 'I am an AI-generated virtual creator.', relationship_framing: 'friendly, never romantic exclusivity' },
};
const npv = await api(M, 'POST', `/v1/influencers/${N}/persona-versions`, { ...novaPersona, change_summary: 'First persona' });
await api(M, 'POST', `/v1/persona-versions/${npv.id}/submit`);
await api(compliance.token, 'POST', `/v1/persona-versions/${npv.id}/approve`);
await api(O, 'POST', `/v1/persona-versions/${npv.id}/activate`);
const novaFace = await api(M, 'POST', `/v1/influencers/${N}/reference-assets?kind=face_canonical`, undefined, { bytes: encodeSolidPng(96, 96, [232, 116, 97]), type: 'image/png' });
await api(compliance.token, 'POST', `/v1/reference-assets/${novaFace.id}/approve`);
await api(O, 'PATCH', `/v1/influencers/${N}/runtime-config`, { paused: false, free_replies_per_day: 10, default_conversation_mode: 'ai_draft', memory_enabled: true });
await api(O, 'POST', `/v1/influencers/${N}/status`, { status: 'active' });
const novaBotToken = tg.addBot('novareyes_demo_bot').token;
const novaBot = await api(O, 'POST', `/v1/influencers/${N}/telegram/bot`, { token: novaBotToken });
const novaPublic = await api(O, 'POST', `/v1/influencers/${N}/channels`, { integration_account_id: novaBot.account_id, kind: 'telegram_public_channel', external_id: '-1002223334445', username: 'novareyes_demo' });
const novaPlus = await api(M, 'POST', `/v1/influencers/${N}/products`, { sku: 'nova-plus', kind: 'bot_subscription', name: 'Nova Chat Plus', description: 'More daily messages with Nova (AI).', price_stars: 120, grants: [{ kind: 'bot_premium_tier' }] });
await api(M, 'POST', `/v1/products/${novaPlus.id}/submit`);
await api(O, 'POST', `/v1/products/${novaPlus.id}/approve`);
const novaJob = await api(M, 'POST', `/v1/influencers/${N}/visual-jobs`, { idempotency_key: `demo-nova-${Date.now()}`, purpose: 'feed_photo', parameters: { scene: 'Night train window at sunrise', mood: 'dreamy', seed: 4242 }, output_count: 1 });
await until('Nova generation', async () => ['succeeded', 'failed', 'cancelled'].includes((await api(M, 'GET', `/v1/visual-jobs/${novaJob.id}`)).state));
const novaAsset = (await api(M, 'GET', `/v1/influencers/${N}/media-assets?visual_job_id=${novaJob.id}`))[0]?.id as string | undefined;
if (novaAsset) {
  const item = await api(M, 'POST', `/v1/influencers/${N}/content-items`, { format: 'tg_post', brief: { theme: 'Night trains' } });
  const rev = await api(M, 'POST', `/v1/content-items/${item.id}/revisions`, { caption: 'Woke up somewhere new again 🚆 Where should the next night train go?', assets: [{ media_asset_id: novaAsset, role: 'primary' }] });
  await approveContent(rev.id);
  await api(M, 'POST', `/v1/content-items/${item.id}/publications`, { channel_id: novaPublic.id, scheduled_for: new Date().toISOString() });
}
const lucia = fan(920001, 'Lucía', 'lucia_viaja');
const mateo = fan(920002, 'Mateo', 'mateo.m');
await onboard(lucia, true, novaBotToken);
await onboard(mateo, false, novaBotToken);
await say(lucia, 'hola Nova! where are you travelling next?', novaBotToken);
await say(mateo, 'love your photos from Madrid', novaBotToken);
await buy(mateo, novaPlus.id, true, novaBotToken);
log('Nova Reyes configured with her own persona, bot, fans and content');
// DEMO ONLY: audience history and older activity so the analytics charts have two weeks of data.
const shifts: [TgUser, number][] = [[fans.jonas, 9], [fans.priya, 6], [fans.leo, 4], [fans.kenji, 2]];
for (const [u, days] of shifts) {
  await db.query(`UPDATE conversation.messages SET created_at = created_at - make_interval(days => $2) WHERE fan_id = (SELECT fan_id FROM conversation.conversations WHERE external_chat_id = $1 LIMIT 1)`, [String(u.id), days]);
  await db.query(`UPDATE crm.fan_influencer_profiles SET first_interaction_at = first_interaction_at - make_interval(days => $2) WHERE fan_id = (SELECT fan_id FROM conversation.conversations WHERE external_chat_id = $1 LIMIT 1)`, [String(u.id), days]);
  await db.query(`UPDATE monetization.payments SET received_at = received_at - make_interval(days => $2) WHERE fan_id = (SELECT fan_id FROM conversation.conversations WHERE external_chat_id = $1 LIMIT 1)`, [String(u.id), days]);
}
for (let d = 14; d >= 1; d--) {
  const at = new Date(Date.now() - d * 86_400_000);
  const rows: [string, string, string, string, number, string][] = [
    [igCh.id, 'account', igAccount.igUserId, 'followers_count', 880 + (14 - d) * 23 + (d % 3) * 4, 'instagram_insights'],
    [tgPublic.id, 'channel', '-1001234567890', 'member_count', 410 + (14 - d) * 9, 'telegram_bot_api'],
    [tgVip.id, 'channel', VIP_CHAT, 'member_count', 18 + Math.floor((14 - d) / 2), 'telegram_bot_api'],
  ];
  for (const [ch, type, ref, metric, value, source] of rows) {
    await db.query(
      `INSERT INTO analytics.metric_snapshots (captured_at, workspace_id, influencer_id, channel_id, subject_type, subject_ref, metric, value, period, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'lifetime', $9)`,
      [at, workspaceId, L, ch, type, ref, metric, value, source],
    );
  }
}
// Let the periodic jobs (insights, comments, member counts, rollups) run now instead of in hours.
await db.query(
  `UPDATE core.periodic_tasks SET last_started_at = now() - interval '7 days', last_finished_at = now() - interval '7 days'
    WHERE name IN ('analytics.instagram_insights', 'analytics.telegram_member_counts', 'instagram.comments_ingest', 'monetization.star_reconcile', 'audit.seal')`,
);
await sleep(8000);
await api(O, 'POST', '/v1/analytics/recompute', { from: day(-14), to: day(0) });

// ---------------------------------------------------------------------------------------------
// Done: write the credentials file (mode 600) and a state file for the screenshot script.
// ---------------------------------------------------------------------------------------------
const credentials = join(out, 'demo-credentials.txt');
writeFileSync(
  credentials,
  [
    'Golden Influencer LOCAL DEMO: throwaway credentials for a throwaway database. Do not reuse anywhere.',
    `Dashboard: ${base}/admin/`,
    `Email:     ${ownerEmail}`,
    `Password:  ${ownerPassword}`,
    `TOTP secret (add to an authenticator app): ${totp.secret}`,
    `otpauth URI: ${totp.uri}`,
    '',
  ].join('\n'),
);
chmodSync(credentials, 0o600);
writeFileSync(
  join(out, 'demo-state.json'),
  JSON.stringify({ base, ownerEmail, credentials, influencerId: L, novaId: N, mia: await convOf(fans.mia), pendingApproval: pendingReq.id, cloneSlug: 'nova-reyes' }, null, 2),
);
log(`READY: ${base}/admin/  (sign-in details in ${credentials}; Ctrl+C to stop)`);

const stop = async () => {
  stopping = true;
  platform.kill('SIGTERM');
  await Promise.allSettled([bridge.close(), llm.close(), tg.close(), ig.close(), comfy.close(), db.end()]);
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

// ---------------------------------------------------------------------------------------------
// Scripted answers of the SIMULATED LLM (persona chat, memory extraction, agents, QA).
// ---------------------------------------------------------------------------------------------
function scriptLlm(): void {
  const lastUser = (r: SimChatRequest) => [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const chat: [RegExp, string][] = [
    [/pentax|film photography/i, 'A K1000! Such a classic 📷 Black and white or colour film?'],
    [/camera/i, 'I shoot on a little 1970s film camera: the grain makes every sunset feel like a memory. What do you shoot on?'],
    [/hiking|rain/i, 'Rain hikes are secretly my favourite! Waterproof layers, grippy shoes and a thermos of tea. Where are you heading?'],
    [/sunset|river/i, 'Thank you! That one was pure golden hour luck on the river ✨ Do you have a favourite sunset spot?'],
    [/cat|miso/i, 'Hi Miso! 🐱 Is she the bossy type or the cuddly type?'],
    [/jazz|piano/i, 'Jazz piano on weekends sounds dreamy 🎹 What do you love playing most?'],
    [/travel/i, 'Next stop: a night train to the coast 🚆 Any place you think I should see?'],
    [/madrid/i, 'Gracias! Madrid at golden hour is unbeatable ☀️ Have you been?'],
  ];
  llm.respond((r) => {
    if (!r.messages[0]?.content.includes('PLATFORM RULES')) return undefined;
    const text = lastUser(r);
    return chat.find(([re]) => re.test(text))?.[1] ?? 'That made me smile, tell me more! 💛';
  });
  llm.respond((r) => {
    if (!r.messages[0]?.content.startsWith('You extract durable facts')) return undefined;
    const text = lastUser(r);
    const memories = [
      /pentax/i.test(text) ? { category: 'interest', statement: 'Shoots on a Pentax K1000 film camera', confidence: 0.92 } : null,
      /cat/i.test(text) ? { category: 'personal_detail', statement: 'Has a cat named Miso', confidence: 0.9 } : null,
      /jazz/i.test(text) ? { category: 'interest', statement: 'Plays jazz piano on weekends', confidence: 0.88 } : null,
      /hiking/i.test(text) ? { category: 'interest', statement: 'Enjoys hiking, also in the rain', confidence: 0.8 } : null,
    ].filter(Boolean);
    return JSON.stringify({ memories });
  });
  const themes = ['Pastel de nata taste test', 'Tram 28 at sunrise', 'Darkroom day', 'Beach picnic', 'Rooftop golden hour', 'Market finds', 'Rainy window reading'];
  llm.respond((r) => {
    if (!r.messages[0]?.content.startsWith('You are the content strategist')) return undefined;
    const m = /Plan (\d+) posts for (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(r.messages.at(-1)?.content ?? '');
    if (!m) return undefined;
    const [, n, from, to] = m;
    const start = new Date(`${from}T00:00:00Z`).getTime();
    const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - start) / 86_400_000) + 1;
    const items = Array.from({ length: Number(n) }, (_, i) => ({
      planned_for: `${new Date(start + Math.floor((i * days) / Number(n)) * 86_400_000).toISOString().slice(0, 10)}T${String(9 + (i % 3) * 4).padStart(2, '0')}:30:00+00:00`,
      format: i % 2 ? 'tg_post' : 'ig_image',
      theme: themes[(i + Number(n)) % themes.length],
      brief: { scene: `${themes[(i + Number(n)) % themes.length]} in Lisbon (fictional)`, outfit: 'linen shirt', location: 'Lisbon (fictional)', mood: 'warm', shot: 'medium shot', caption_idea: 'Small joys', cta: 'Ask fans about their week' },
    }));
    return JSON.stringify({
      summary: 'A warm week mixing food, film and city themes.',
      proposals: [{ action_type: 'content_plan.propose', payload: { period_start: from, period_end: to, strategy_notes: 'Alternate Instagram and Telegram; morning and evening slots.', items }, rationale: 'Fits the persona and the posting cadence.', confidence: 0.8, risk_self_assessment: 'low' }],
      no_action_reason: null,
    });
  });
  llm.respond((r) => (r.messages[0]?.content.startsWith('You are the second-line QA reviewer') ? JSON.stringify({ verdict: 'pass', issues: [] }) : undefined));
}
