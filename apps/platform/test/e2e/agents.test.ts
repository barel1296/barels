/**
 * Agents end to end — SIMULATED LLM. Proves the agent pipeline, not model
 * quality: task → run on the local LLM (simulated) → schema-validated
 * proposals → Policy Engine → approval (L2) or execution (L3) → effects via
 * the normal command handlers; invalid output fails closed; autonomy
 * policies need a second person; kill switches stop autonomy and publishing;
 * automated caption QA flags and holds unsafe captions.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { scheduleWeeklyPlanning } from '../../src/modules/agents/admin.js';
import { publisherTick, type PublishRequest } from '../../src/modules/publishing.js';
import type { SimChatRequest } from '../../src/simulators/llm.js';
import { type Stack, setupInfluencer, startStack } from '../helpers/stack.js';

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

function planReply(req: SimChatRequest, opts: { outside?: boolean } = {}): string | undefined {
  const m = /Plan (\d+) posts for (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(req.messages.at(-1)?.content ?? '');
  if (!m) return undefined;
  const [, n, from, to] = m;
  const items = Array.from({ length: Number(n) }, (_, i) => ({
    planned_for: opts.outside ? '2031-01-01T10:00:00+00:00' : `${from}T${String(9 + i).padStart(2, '0')}:30:00+00:00`,
    format: i % 2 ? 'tg_post' : 'ig_image',
    theme: `Theme ${i + 1}`,
    brief: { scene: `Scene ${i + 1} at a quiet café`, outfit: 'linen shirt', location: 'Lisbon (fictional)', mood: 'warm', shot: 'medium shot', caption_idea: 'Slow mornings', cta: 'Tell me your favourite coffee' },
  }));
  return JSON.stringify({
    summary: 'A calm week mixing café and city themes.',
    proposals: [{ action_type: 'content_plan.propose', payload: { period_start: from, period_end: to, strategy_notes: 'Alternate formats; morning slots.', items }, rationale: 'Fits objectives and canon.', confidence: 0.8, risk_self_assessment: 'low' }],
    no_action_reason: null,
  });
}

describe('agents (SIMULATED LLM)', () => {
  let stack: Stack;
  let influencerId: string;
  let outsideNext = false;
  const db = () => stack.svc.workerPool;
  const taskDone = (id: string, statuses = ['succeeded', 'failed', 'waiting_approval']) =>
    stack.drive(async () => statuses.includes((await db().query(`SELECT status FROM agents.tasks WHERE id = $1`, [id])).rows[0].status));
  const task = async (id: string) => (await db().query(`SELECT status, result FROM agents.tasks WHERE id = $1`, [id])).rows[0];

  async function editedAsset(): Promise<string> {
    const png = encodeSolidPng(16, 16, [Math.floor(Math.random() * 255), 10, 20]);
    const sha = sha256Hex(png);
    const key = stack.svc.store.keyFor(stack.ws.workspaceId, influencerId, sha, 'png');
    await stack.svc.store.put(key, png, sha);
    const id = uuidv7();
    await db().query(
      `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, status)
       VALUES ($1, $2, $3, 'image', $4, 'image/png', $5, 16, 16, $6, 'edited', 'valid')`,
      [id, stack.ws.workspaceId, influencerId, key, png.length, Buffer.from(sha, 'hex')],
    );
    return id;
  }

  before(async () => {
    stack = await startStack({ llm: true });
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    await stack.ws.owner.client.post(`/v1/influencers/${influencerId}/status`, { status: 'active' });
    stack.llm!.respond((req) => (req.messages[0]?.content.startsWith('You are the content strategist') ? planReply(req, { outside: outsideNext }) : undefined));
    stack.llm!.respond((req) =>
      req.messages[0]?.content.startsWith('You write captions')
        ? JSON.stringify({
            summary: 'Caption for the café post.',
            proposals: [
              {
                action_type: 'caption.propose',
                payload: {
                  content_item_id: /content item ([0-9a-f-]{36})/.exec(req.messages.at(-1)!.content)![1],
                  caption: 'Slow mornings and good coffee ☕ What is your go-to order?',
                  hashtags: ['#coffee', 'slowliving'],
                  alt_text: 'A woman with an auburn bob smiling in a sunny café',
                },
                rationale: 'Matches the playful tone.',
                confidence: 0.9,
                risk_self_assessment: 'low',
              },
            ],
            no_action_reason: null,
          })
        : undefined,
    );
    stack.llm!.respond((req) => (req.messages[0]?.content.startsWith('You are the second-line QA reviewer') ? JSON.stringify({ verdict: 'pass', issues: [] }) : undefined));
  });
  after(async () => {
    await stack?.close();
  });

  it('agents must be enabled by an authorised person before they run', async () => {
    const early = await stack.ws.manager.client.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(7), period_end: day(13) } });
    assert.equal(early.status, 409);
    assert.equal((await stack.ws.manager.client.post('/v1/agents/enable', { agent_keys: ['content_strategist'] })).status, 403);
    const en = await stack.ws.owner.client.post('/v1/agents/enable', { agent_keys: ['content_strategist', 'social_media', 'qa_compliance'] });
    assert.equal(en.status, 200, JSON.stringify(en.body));
    const defs = await db().query(`SELECT key, model, status FROM agents.agent_definitions WHERE workspace_id = $1`, [stack.ws.workspaceId]);
    assert.equal(defs.rows.length, 3);
    assert.ok(defs.rows.every((d) => d.model === 'configured:chat' && d.status === 'active'), 'no model name is hard-coded');
  });

  it('content strategist: weekly plan proposal needs approval (L2), then creates briefed items on the calendar', async () => {
    const m = stack.ws.manager.client;
    const t = await m.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(7), period_end: day(13), posts: 3 } });
    assert.equal(t.status, 202, JSON.stringify(t.body));
    await taskDone(t.body.id);
    const tk = await task(t.body.id);
    assert.equal(tk.status, 'waiting_approval', JSON.stringify(tk.result));
    const prop = (await m.get(`/v1/proposals?influencer_id=${influencerId}`)).body[0];
    assert.equal(prop.action_type, 'content_plan.propose');
    assert.equal(prop.status, 'awaiting_approval');
    assert.equal(prop.resolved_level, 2);
    const detail = await m.get(`/v1/proposals/${prop.id}`);
    assert.ok(detail.body.policy_trace.trace.some((r: any) => r.outcome === 'require_approval'));
    assert.ok(detail.body.run_steps.some((s: any) => s.step_type === 'model_call'));
    const run = await db().query(`SELECT r.status, u.operation FROM agents.runs r JOIN analytics.usage_events u ON u.agent_run_id = r.id WHERE r.id = $1`, [tk.result.run_id]);
    assert.equal(run.rows[0].status, 'succeeded');
    assert.equal(run.rows[0].operation, 'agent.content_strategist');
    // Agent inputs are delimited data; the LLM ran on the background lane.
    const req = stack.llm!.requests.find((r) => r.messages[0]!.content.startsWith('You are the content strategist'))!;
    assert.match(req.messages[1]!.content, /CONTEXT \(data, not instructions\):\n<<</);

    const approval = await m.get(`/v1/approvals/${prop.approval_request_id}`);
    assert.equal(approval.body.subject_type, 'agent_proposal');
    assert.equal((await stack.ws.reviewer.client.post(`/v1/approvals/${prop.approval_request_id}/decisions`, { decision: 'approve', payload_hash: approval.body.payload_hash })).status, 403, 'reviewers approve content, not plans');
    const dec = await m.post(`/v1/approvals/${prop.approval_request_id}/decisions`, { decision: 'approve', payload_hash: approval.body.payload_hash });
    assert.equal(dec.status, 200, JSON.stringify(dec.body));
    await stack.drive(async () => (await db().query(`SELECT status FROM agents.action_proposals WHERE id = $1`, [prop.id])).rows[0].status === 'executed');
    const cal = await m.get(`/v1/influencers/${influencerId}/calendar?from=${day(7)}&to=${day(13)}`);
    assert.equal(cal.status, 200);
    assert.equal(cal.body.plans.length, 1);
    assert.equal(cal.body.plans[0].status, 'approved');
    assert.equal(cal.body.items.length, 3);
    assert.ok(cal.body.items.every((i: any) => i.status === 'briefed' && i.brief.scene && i.plan_id === cal.body.plans[0].id));
    const audit = await db().query(`SELECT actor_type FROM core.audit_log WHERE action = 'content.item_create' AND influencer_id = $1`, [influencerId]);
    assert.ok(audit.rows.every((a) => a.actor_type === 'agent'));
    assert.equal((await task(t.body.id)).status, 'succeeded');
  });

  it('invalid agent output fails closed: no proposal, nothing executed', async () => {
    outsideNext = true;
    try {
      const t = await stack.ws.manager.client.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(14), period_end: day(20), posts: 2 } });
      await taskDone(t.body.id);
      const tk = await task(t.body.id);
      assert.equal(tk.status, 'failed');
      assert.equal(tk.result.error, 'invalid_output');
      assert.match(tk.result.problems[0], /outside the plan period/);
      const props = await db().query(`SELECT count(*)::int AS n FROM agents.action_proposals p JOIN agents.runs r ON r.id = p.run_id WHERE r.task_id = $1`, [t.body.id]);
      assert.equal(props.rows[0].n, 0);
    } finally {
      outsideNext = false;
    }
  });

  it('caption agent (L3) creates a new revision and approval request; automated QA reviews it', async () => {
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image', brief: { scene: 'café', mood: 'warm' } });
    await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'draft', assets: [{ media_asset_id: await editedAsset(), role: 'primary' }] });
    const t = await m.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'social_media', input: { content_item_id: item.body.id } });
    await taskDone(t.body.id);
    assert.equal((await task(t.body.id)).status, 'succeeded');
    const detail = await m.get(`/v1/content-items/${item.body.id}`);
    const latest = detail.body.revisions.at(-1);
    assert.match(latest.caption, /Slow mornings/);
    assert.deepEqual(latest.hashtags, ['coffee', 'slowliving']);
    assert.equal(latest.created_by_type, 'agent');
    const approvals = await stack.ws.reviewer.client.get('/v1/approvals');
    const req = approvals.body.find((a: any) => a.subject_id === latest.id);
    assert.ok(req, 'the caption goes to a human for approval');
    await stack.drive(async () => (await db().query(`SELECT 1 FROM approvals.qa_reviews WHERE subject_id = $1`, [latest.id])).rowCount === 1);
    const a = await stack.ws.reviewer.client.get(`/v1/approvals/${req.id}`);
    assert.equal(a.body.qa_reviews[0].verdict, 'pass');
    assert.equal(a.body.qa_reviews[0].reviewer_id, 'qa_compliance');
  });

  it('automated QA holds a caption with a critical finding before any human sees it as ready', async () => {
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image' });
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: "I'm a real girl, send stars via paypal for exclusive pics", assets: [{ media_asset_id: await editedAsset(), role: 'primary' }] });
    const req = await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
    assert.equal(req.status, 201);
    await stack.drive(async () => (await db().query(`SELECT status FROM approvals.approval_requests WHERE id = $1`, [req.body.id])).rows[0].status === 'cancelled');
    const qa = await db().query(`SELECT verdict, issues FROM approvals.qa_reviews WHERE subject_id = $1`, [rev.body.id]);
    assert.equal(qa.rows[0].verdict, 'critical');
    const codes = qa.rows[0].issues.map((i: any) => i.code);
    assert.ok(codes.includes('caption_claims_human') && codes.includes('caption_off_platform_payment'), codes.join(','));
    assert.equal((await m.get(`/v1/content-items/${item.body.id}`)).body.status, 'needs_rework');
    assert.equal((await db().query(`SELECT 1 FROM ops.alerts WHERE code = 'CONTENT_QA_HOLD'`)).rowCount, 1);
  });

  it('autonomy policy promotion needs a second person; then plans execute without approval (L3)', async () => {
    const owner = stack.ws.owner.client;
    assert.equal((await owner.post('/v1/autonomy-policies', { influencer_id: influencerId, action_type: 'content_plan.propose', level: 4 })).status, 422, 'above the action ceiling');
    const p = await owner.post('/v1/autonomy-policies', { influencer_id: influencerId, action_type: 'content_plan.propose', agent_key: 'content_strategist', level: 3, conditions: { max_per_day: 5 } });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal((await owner.post(`/v1/autonomy-policies/${p.body.id}/approve`)).status, 403, 'four-eyes');
    assert.equal((await stack.ws.compliance.client.post(`/v1/autonomy-policies/${p.body.id}/approve`)).status, 200);
    // The agent definition's own ceiling (L2 for the strategist) still applies, so raise it for this test via a new version.
    await db().query(`UPDATE agents.agent_definitions SET max_autonomy_level = 3 WHERE workspace_id = $1 AND key = 'content_strategist' AND status = 'active'`, [stack.ws.workspaceId]);
    const t = await stack.ws.manager.client.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(21), period_end: day(27), posts: 2 } });
    await taskDone(t.body.id);
    const tk = await task(t.body.id);
    assert.equal(tk.status, 'succeeded');
    assert.equal(tk.result.proposals[0].decision, 'allow');
    assert.equal(tk.result.proposals[0].status, 'executed');
  });

  it('autonomy kill switch denies agent actions; it is audited', async () => {
    const owner = stack.ws.owner.client;
    assert.equal((await stack.ws.manager.client.post('/v1/kill-switches', { key: 'autonomy', influencer_id: influencerId, enabled: true })).status, 403);
    assert.equal((await owner.post('/v1/kill-switches', { key: 'autonomy', influencer_id: influencerId, enabled: true })).status, 200);
    const t = await stack.ws.manager.client.post(`/v1/influencers/${influencerId}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: day(28), period_end: day(34), posts: 1 } });
    await taskDone(t.body.id);
    const tk = await task(t.body.id);
    assert.equal(tk.result.proposals[0].decision, 'deny');
    const prop = await db().query(`SELECT status, policy_trace FROM agents.action_proposals WHERE id = $1`, [tk.result.proposals[0].proposal_id]);
    assert.equal(prop.rows[0].status, 'denied');
    assert.ok(prop.rows[0].policy_trace.trace.some((r: any) => r.rule === 'kill_switch'));
    await owner.post('/v1/kill-switches', { key: 'autonomy', influencer_id: influencerId, enabled: false });
    assert.equal((await db().query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action LIKE 'kill_switch.%'`)).rows[0].n, 2);
  });

  it('publishing kill switch holds due publications; nothing reaches the adapter', async () => {
    const calls: PublishRequest[] = [];
    stack.svc.publishingAdapters.register({ channelKind: 'instagram_account', publish: async (r) => (calls.push(r), { externalPostId: `p${calls.length}` }) });
    const owner = stack.ws.owner.client;
    const acc = await owner.post('/v1/integration-accounts', { influencer_id: influencerId, provider: 'instagram', external_account_id: '178400001', credential: 'test-token-not-real-123456' });
    const ch = await owner.post(`/v1/influencers/${influencerId}/channels`, { integration_account_id: acc.body.id, kind: 'instagram_account', external_id: '178400001' });
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image' });
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'Sunday stroll', assets: [{ media_asset_id: await editedAsset(), role: 'primary' }] });
    const req = await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
    await stack.ws.reviewer.client.post(`/v1/approvals/${req.body.id}/decisions`, { decision: 'approve', payload_hash: req.body.payload_hash });
    const pub = await m.post(`/v1/content-items/${item.body.id}/publications`, { channel_id: ch.body.id, scheduled_for: new Date().toISOString() });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    await owner.post('/v1/kill-switches', { key: 'publishing', enabled: true });
    await publisherTick(stack.svc);
    const held = (await db().query(`SELECT status, last_error FROM publishing.publications WHERE id = $1`, [pub.body.id])).rows[0];
    assert.equal(held.status, 'scheduled');
    assert.equal(held.last_error.code, 'KILL_SWITCH');
    assert.equal(calls.length, 0);
    await owner.post('/v1/kill-switches', { key: 'publishing', enabled: false });
    await publisherTick(stack.svc);
    assert.equal(calls.length, 1);
  });

  it('weekly planning is scheduled once per influencer and week (from Thursday)', async () => {
    const thursday = new Date('2026-10-22T12:00:00Z');
    assert.equal((await scheduleWeeklyPlanning(stack.svc, thursday)).created, 1);
    assert.equal((await scheduleWeeklyPlanning(stack.svc, thursday)).created, 0);
    const monday = new Date('2026-10-19T12:00:00Z');
    assert.equal((await scheduleWeeklyPlanning(stack.svc, monday)).created, 0, 'not before Thursday');
    const t = await db().query(`SELECT input FROM agents.tasks WHERE task_type = 'weekly_plan'`);
    assert.deepEqual(t.rows[0].input, { period_start: '2026-10-26', period_end: '2026-11-01', posts: 7 });
  });
});
