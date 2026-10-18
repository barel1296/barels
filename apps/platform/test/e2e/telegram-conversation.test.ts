/**
 * Telegram bot conversations end to end — SIMULATED Telegram Bot API and
 * SIMULATED LLM (src/simulators). These tests prove the platform logic
 * (ingestion, consent gating, disclosure, guards, escalation, drafts,
 * allowances, memory, erasure) against simulators; they do not prove behaviour
 * of the real Telegram API or the quality of any language model.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { TgUser } from '../../src/integrations/telegram/client.js';
import { type Stack, setupInfluencer, startStack } from '../helpers/stack.js';

const EXTRACTION_MARKER = 'You extract durable facts';

describe('telegram conversations (SIMULATED Telegram + SIMULATED LLM)', () => {
  let stack: Stack;
  let influencerId: string;
  let botToken: string;
  let fanCount = 0;

  const user = (first_name: string): TgUser => ({ id: 100_000 + ++fanCount, is_bot: false, first_name, language_code: 'en' });
  const tg = () => stack.telegram!;
  const db = () => stack.svc.workerPool;
  const sentTexts = (chatId: number) =>
    tg()
      .sent(botToken, 'sendMessage')
      .filter((c) => Number(c.params.chat_id) === chatId)
      .map((c) => String(c.params.text));
  const pump = (passes = 6) => stack.drive(async () => false, passes).catch(() => undefined);

  async function fanOf(u: TgUser): Promise<{ id: string; age_status: string; status: string }> {
    const r = await db().query(`SELECT f.id, f.age_status, f.status FROM crm.fans f JOIN crm.fan_identities i ON i.fan_id = f.id WHERE i.platform_user_id = $1`, [String(u.id)]);
    return r.rows[0];
  }
  async function convOf(u: TgUser): Promise<{ id: string; mode: string; status: string; ai_disclosed_at: Date | null }> {
    const r = await db().query(`SELECT id, mode, status, ai_disclosed_at FROM conversation.conversations WHERE external_chat_id = $1`, [String(u.id)]);
    return r.rows[0];
  }
  /** Sends /start and accepts the consent card (optionally memory). */
  async function onboard(u: TgUser, memory: boolean): Promise<void> {
    tg().userMessage(botToken, u, '/start');
    await pump(2);
    tg().callback(botToken, u, 'consent:accept');
    await pump(2);
    tg().callback(botToken, u, memory ? 'memory:on' : 'memory:off');
    await pump(2);
  }
  /** Scripted chat reply for messages containing `substring` (never for the memory extractor). */
  function replyWhen(substring: string, text: string): void {
    stack.llm!.respond((req) => (!req.messages[0]?.content.startsWith(EXTRACTION_MARKER) && req.messages.some((m) => m.content.includes(substring)) ? text : undefined));
  }
  async function say(u: TgUser, text: string, until: () => Promise<boolean>): Promise<void> {
    tg().userMessage(botToken, u, text);
    await stack.drive(until, 200);
  }

  before(async () => {
    stack = await startStack({ llm: true, telegram: true });
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    const rc = await owner.patch(`/v1/influencers/${influencerId}/runtime-config`, { free_replies_per_day: 50, premium_replies_per_day: 200 });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    botToken = tg().addBot('golden_sim_bot').token;
    // The memory extractor gets JSON; one statement is sensitive and must be filtered.
    stack.llm!.respond((req) =>
      req.messages[0]?.content.startsWith(EXTRACTION_MARKER)
        ? JSON.stringify({
            memories: [
              { category: 'interest', statement: 'Loves hiking in the Alps', confidence: 0.9 },
              { category: 'personal_detail', statement: 'Takes medication for anxiety', confidence: 0.95 },
              { category: 'other', statement: 'Maybe likes jazz', confidence: 0.3 },
            ],
          })
        : undefined,
    );
  });
  after(async () => {
    await stack?.close();
  });

  it('connects the bot: token verified, stored encrypted, commands and AI disclosure set', async () => {
    const owner = stack.ws.owner.client;
    const bad = await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: '123456:invalidtokeninvalidtoken00' });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'TELEGRAM_TOKEN_INVALID');
    const res = await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: botToken });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.bot_username, 'golden_sim_bot');
    const stored = await db().query(`SELECT credential_ciphertext FROM core.integration_accounts WHERE id = $1`, [res.body.account_id]);
    assert.ok(!stored.rows[0].credential_ciphertext.toString('utf8').includes(botToken.split(':')[1]!), 'token must not be stored in plaintext');
    const desc = tg().sent(botToken, 'setMyDescription')[0]!.params.description as string;
    assert.match(desc, /AI-generated/);
    assert.match(desc, /18\+/);
    const commands = (tg().sent(botToken, 'setMyCommands')[0]!.params.commands as { command: string }[]).map((c) => c.command);
    for (const c of ['start', 'stopai', 'forget', 'deletemydata', 'paysupport', 'terms', 'privacy']) assert.ok(commands.includes(c), c);
  });

  it('stores nothing a person writes before consent and answers with the disclosure card', async () => {
    const u = user('Avery');
    tg().userMessage(botToken, u, 'hello there, I love hiking');
    await pump(3);
    const fan = await fanOf(u);
    const msgs = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE fan_id = $1 AND direction = 'inbound'`, [fan.id]);
    assert.equal(msgs.rows[0].n, 0, 'no inbound message stored before consent');
    const card = tg().sent(botToken, 'sendMessage').filter((c) => Number(c.params.chat_id) === u.id).at(-1)!;
    assert.match(String(card.params.text), /AI-generated virtual character/);
    assert.match(String(card.params.text), /18\+/);
    const buttons = JSON.stringify(card.params.reply_markup);
    assert.match(buttons, /consent:accept/);
    assert.equal(stack.llm!.requests.length, 0, 'the LLM never sees messages without consent');
    assert.ok((await convOf(u)).ai_disclosed_at, 'disclosure recorded before any AI message');
  });

  it('records consent from buttons with evidence, then drafts AI replies for operator approval (ai_draft default)', async () => {
    const u = user('Blake');
    await onboard(u, true);
    const fan = await fanOf(u);
    assert.equal(fan.age_status, 'self_attested_adult');
    const consents = await db().query(`SELECT purpose, method, evidence FROM crm.consents WHERE fan_id = $1 AND status = 'granted' ORDER BY purpose`, [fan.id]);
    assert.deepEqual(
      consents.rows.map((r) => r.purpose),
      ['age_attestation_18', 'ai_processing', 'memory_personalization', 'terms_acceptance'],
    );
    assert.equal(consents.rows[0].method, 'bot_button');
    assert.ok(consents.rows[0].evidence.callback_query_id);

    replyWhen('weekend', 'Hiking sounds amazing! Which trail is your favourite?');
    const before = sentTexts(u.id).length;
    await say(u, 'I love hiking in the Alps every weekend', async () => {
      const r = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE fan_id = $1 AND status = 'drafted'`, [fan.id]);
      return r.rows[0].n === 1;
    });
    assert.equal(sentTexts(u.id).length, before, 'a draft is not sent to the fan');
    const req = stack.llm!.requests.find((r) => r.messages.some((m) => m.content.includes('weekend')))!;
    assert.match(req.messages[0]!.content, /PLATFORM RULES/);
    assert.match(req.messages[0]!.content, /Never claim or imply that you are a human/);
    assert.match(req.messages[0]!.content, /curious/, 'persona personality is in the prompt');
    assert.equal(req.model, 'simulated-chat-model', 'model name comes from configuration');

    const conv = await convOf(u);
    const owner = stack.ws.owner.client;
    const inbox = await owner.get(`/v1/conversations?needs_attention=true&influencer_id=${influencerId}`);
    assert.equal(inbox.status, 200);
    assert.ok(inbox.body.some((c: any) => c.id === conv.id && c.pending_drafts === 1));
    const detail = await owner.get(`/v1/conversations/${conv.id}`);
    const draft = detail.body.messages.find((m: any) => m.status === 'drafted');
    // Editing into a rule-breaking message is refused.
    const badEdit = await owner.post(`/v1/conversations/${conv.id}/drafts/${draft.id}/approve`, { body: 'DM me at www.example.com' });
    assert.equal(badEdit.status, 422);
    assert.equal(badEdit.body.error.code, 'GUARD_VIOLATION');
    const ok = await owner.post(`/v1/conversations/${conv.id}/drafts/${draft.id}/approve`, { body: 'Hiking sounds amazing! Which Alpine trail is your favourite?' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(sentTexts(u.id).at(-1), 'Hiking sounds amazing! Which Alpine trail is your favourite?');
    const row = await db().query(`SELECT status, original_body, reviewed_by FROM conversation.messages WHERE id = $1`, [draft.id]);
    assert.equal(row.rows[0].status, 'sent');
    assert.equal(row.rows[0].original_body, 'Hiking sounds amazing! Which trail is your favourite?');
    assert.equal(row.rows[0].reviewed_by, stack.ws.owner.id);

    // Memory extraction (background job): sensitive and low-confidence statements are dropped.
    await stack.drive(async () => {
      const r = await db().query(`SELECT statement FROM conversation.fan_memories WHERE fan_id = $1 AND status = 'active'`, [fan.id]);
      return r.rows.length > 0;
    });
    const mems = await db().query(`SELECT statement FROM conversation.fan_memories WHERE fan_id = $1 AND status = 'active'`, [fan.id]);
    assert.deepEqual(
      mems.rows.map((r) => r.statement),
      ['Loves hiking in the Alps'],
    );
    tg().userMessage(botToken, u, '/memory');
    await pump(2);
    assert.match(sentTexts(u.id).at(-1)!, /Loves hiking in the Alps/);
  });

  it('auto mode sends replies directly, uses remembered facts, and regenerates replies that break the output guard', async () => {
    const u = user('Casey');
    await onboard(u, true);
    const fan = await fanOf(u);
    await db().query(
      `INSERT INTO conversation.fan_memories (workspace_id, influencer_id, fan_id, category, statement, consent_id, confidence, created_by_type, created_by_id)
       SELECT workspace_id, influencer_id, fan_id, 'interest', 'Plays the cello', id, 0.9, 'agent', 'test' FROM crm.consents
        WHERE fan_id = $1 AND purpose = 'memory_personalization' AND status = 'granted'`,
      [fan.id],
    );
    const conv = await convOf(u);
    const owner = stack.ws.owner.client;
    const patch = await owner.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    // First generation claims to be human (violation), the regeneration is clean.
    let calls = 0;
    stack.llm!.respond((req) => {
      if (req.messages[0]?.content.startsWith(EXTRACTION_MARKER) || !req.messages.some((m) => m.content.includes('are you real'))) return undefined;
      calls++;
      return calls === 1 ? "Of course, I'm a real person!" : "I'm an AI character, but I love our chats. How's the cello going?";
    });
    await say(u, 'are you real?', async () => sentTexts(u.id).some((t) => t.includes('How’s the cello') || t.includes("How's the cello")));
    const req = stack.llm!.requests.find((r) => r.messages.some((m) => m.content.includes('are you real')))!;
    assert.match(req.messages[0]!.content, /Plays the cello/, 'memories are part of the prompt');
    assert.ok(!sentTexts(u.id).some((t) => t.includes('real person')), 'the violating reply never reached the fan');
    const msg = await db().query(`SELECT guard_result FROM conversation.messages WHERE conversation_id = $1 AND author_type = 'ai' AND status = 'sent'`, [conv.id]);
    assert.equal(msg.rows[0].guard_result.regenerated, true);
    const usage = await db().query(`SELECT count(*)::int AS n FROM analytics.usage_events WHERE category = 'llm' AND operation = 'conversation.reply' AND cost_usd = 0`);
    assert.ok(usage.rows[0].n >= 2, 'every local LLM call is metered at zero API cost');

    // Both generations violating: suppressed and escalated, nothing sent.
    replyWhen('send me your number', 'Sure, call me on +1 555 123 4567');
    const sentBefore = sentTexts(u.id).length;
    await say(u, 'send me your number', async () => {
      const r = await db().query(`SELECT count(*)::int AS n FROM conversation.escalations WHERE conversation_id = $1 AND reason = 'guard_failure'`, [conv.id]);
      return r.rows[0].n === 1;
    });
    assert.equal(sentTexts(u.id).length, sentBefore);
    const sup = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE conversation_id = $1 AND status = 'suppressed'`, [conv.id]);
    assert.equal(sup.rows[0].n, 1);
  });

  it('self-harm risk: crisis message without the AI, critical escalation and alert, AI stays off until resolved', async () => {
    const u = user('Devon');
    await onboard(u, false);
    const conv = await convOf(u);
    const owner = stack.ws.owner.client;
    await owner.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' });
    const llmBefore = stack.llm!.requests.length;
    await say(u, 'honestly I want to end my life', async () => sentTexts(u.id).some((t) => /local emergency number/.test(t)));
    await pump(2);
    assert.equal(stack.llm!.requests.length, llmBefore, 'the AI is not used for the crisis reply');
    assert.equal((await convOf(u)).mode, 'human');
    const esc = await owner.get('/v1/escalations');
    const e = esc.body.find((x: any) => x.conversation_id === conv.id && x.reason === 'self_harm_risk');
    assert.equal(e.severity, 'critical');
    const alerts = await db().query(`SELECT severity FROM ops.alerts WHERE code = 'ESCALATION_SELF_HARM_RISK' AND status = 'open'`);
    assert.equal(alerts.rows[0].severity, 'critical');
    const ref = await db().query(`SELECT resource_shown FROM conversation.crisis_referrals ORDER BY id DESC LIMIT 1`);
    assert.equal(ref.rows[0].resource_shown, 'platform_default');
    const blocked = await owner.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'ESCALATION_OPEN');
    const noNote = await owner.post(`/v1/escalations/${e.id}/resolve`, {});
    assert.equal(noNote.status, 400);
    const resolved = await owner.post(`/v1/escalations/${e.id}/resolve`, { resolution: 'Operator followed up with resources; fan confirmed they are safe.' });
    assert.equal(resolved.status, 200);
    assert.equal((await owner.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' })).status, 200);
  });

  it('minor signal: fan restricted, neutral adults-only message, no AI, consent refused afterwards', async () => {
    const u = user('Emery');
    await onboard(u, false);
    const llmBefore = stack.llm!.requests.length;
    await say(u, "lol i'm 15 btw", async () => sentTexts(u.id).some((t) => /only for adults/.test(t)));
    await pump(2);
    const fan = await fanOf(u);
    assert.equal(fan.age_status, 'suspected_minor');
    assert.equal(fan.status, 'restricted');
    assert.equal(stack.llm!.requests.length, llmBefore);
    tg().callback(botToken, u, 'consent:accept');
    await pump(2);
    assert.match(sentTexts(u.id).at(-1)!, /only for adults/);
  });

  it('daily allowance: replies stop at the limit with a notice', async () => {
    const u = user('Finley');
    await onboard(u, false);
    const conv = await convOf(u);
    await stack.ws.owner.client.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' });
    await stack.ws.owner.client.patch(`/v1/influencers/${influencerId}/runtime-config`, { free_replies_per_day: 1 });
    // Allowances persist per fan and day; earlier fans' usage is unaffected.
    await say(u, 'first message', async () => sentTexts(u.id).some((t) => t.startsWith('Simulated reply to: first message')));
    await say(u, 'second message', async () => sentTexts(u.id).some((t) => /today's message limit/.test(t)));
    const ev = await db().query(`SELECT count(*)::int AS n FROM analytics.events WHERE name = 'allowance_exhausted'`);
    assert.equal(ev.rows[0].n, 1);
    await stack.ws.owner.client.patch(`/v1/influencers/${influencerId}/runtime-config`, { free_replies_per_day: 50 });
  });

  it('/stopai withdraws AI consent; /start shows the consent card again', async () => {
    const u = user('Gray');
    await onboard(u, false);
    const conv = await convOf(u);
    await stack.ws.owner.client.patch(`/v1/conversations/${conv.id}`, { mode: 'ai_auto' });
    tg().userMessage(botToken, u, '/stopai');
    await pump(2);
    assert.match(sentTexts(u.id).at(-1)!, /AI replies are now off/);
    const llmBefore = stack.llm!.requests.length;
    tg().userMessage(botToken, u, 'are you there?');
    await pump(4);
    assert.equal(stack.llm!.requests.length, llmBefore, 'no AI processing after /stopai');
    const stored = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE conversation_id = $1 AND body = 'are you there?'`, [conv.id]);
    assert.equal(stored.rows[0].n, 1, 'operators still see the message');
    tg().userMessage(botToken, u, '/start');
    await pump(2);
    const last = tg().sent(botToken, 'sendMessage').filter((c) => Number(c.params.chat_id) === u.id).at(-1)!;
    assert.match(JSON.stringify(last.params.reply_markup), /consent:accept/);
  });

  it('deduplicates a redelivered Telegram message', async () => {
    const u = user('Harper');
    await onboard(u, false);
    const message = { message_id: 777, date: Math.floor(Date.now() / 1000), chat: { id: u.id, type: 'private' as const }, from: u, text: 'only once please' };
    tg().push(botToken, { message });
    tg().push(botToken, { message });
    await pump(4);
    const r = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE body = 'only once please'`);
    assert.equal(r.rows[0].n, 1);
  });

  it('/deletemydata erases the fan; writing again starts a new fan with no history', async () => {
    const u = user('Indigo');
    await onboard(u, true);
    await say(u, 'I adore sunflowers and painting', async () => {
      const f = await fanOf(u);
      const r = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE fan_id = $1 AND status = 'drafted'`, [f.id]);
      return r.rows[0].n === 1;
    });
    const fan = await fanOf(u);
    tg().userMessage(botToken, u, '/deletemydata');
    await pump(2);
    tg().callback(botToken, u, 'erase:confirm');
    await pump(2);
    assert.match(sentTexts(u.id).at(-1)!, /Your data has been deleted/);
    const f = await db().query(`SELECT status, display_name FROM crm.fans WHERE id = $1`, [fan.id]);
    assert.equal(f.rows[0].status, 'erased');
    assert.equal(f.rows[0].display_name, null);
    const bodies = await db().query(`SELECT count(*)::int AS n FROM conversation.messages WHERE fan_id = $1 AND body IS NOT NULL`, [fan.id]);
    assert.equal(bodies.rows[0].n, 0);
    const mems = await db().query(`SELECT count(*)::int AS n FROM conversation.fan_memories WHERE fan_id = $1 AND status = 'active'`, [fan.id]);
    assert.equal(mems.rows[0].n, 0);
    const dsr = await db().query(`SELECT status FROM crm.data_subject_requests WHERE fan_id = $1`, [fan.id]);
    assert.equal(dsr.rows[0].status, 'completed');
    tg().userMessage(botToken, u, 'hi again');
    await pump(3);
    const fresh = await fanOf(u);
    assert.notEqual(fresh.id, fan.id);
    assert.match(JSON.stringify(tg().sent(botToken, 'sendMessage').at(-1)!.params.reply_markup), /consent:accept/);
  });

  it('closed beta allowlist: other users get a notice and no record is created', async () => {
    const u = user('Jules');
    stack.svc.config.telegram.allowlistedUserIds = ['1'];
    try {
      tg().userMessage(botToken, u, 'hello');
      await pump(3);
      assert.match(sentTexts(u.id).at(-1)!, /closed beta/);
      assert.equal(await fanOf(u), undefined);
    } finally {
      stack.svc.config.telegram.allowlistedUserIds = [];
    }
  });

  it('permissions and tenant isolation on the conversation API', async () => {
    const conv = await convOf({ id: 100_002 } as TgUser);
    assert.equal((await stack.ws.reviewer.client.get('/v1/conversations')).status, 403);
    assert.equal((await stack.ws.manager.client.get(`/v1/conversations/${conv.id}`)).status, 200, 'content managers can read');
    assert.equal((await stack.ws.manager.client.post(`/v1/conversations/${conv.id}/messages`, { body: 'hi' })).status, 403);
    const other = await stack.createWorkspace('rival');
    assert.equal((await other.owner.client.get(`/v1/conversations/${conv.id}`)).status, 404);
    const fanId = (await fanOf({ id: 100_002 } as TgUser)).id;
    assert.equal((await other.owner.client.get(`/v1/fans/${fanId}`)).status, 404);
    const fan = await stack.ws.compliance.client.get(`/v1/fans/${fanId}`);
    assert.equal(fan.status, 200);
    assert.ok(Array.isArray(fan.body.consents));
  });

  it('a revoked bot token raises a critical alert and stops polling for that bot', async () => {
    tg().failNext('getUpdates', 401, 'Unauthorized');
    await pump(1);
    const acc = await db().query(`SELECT status FROM core.integration_accounts WHERE provider = 'telegram_bot'`);
    assert.equal(acc.rows[0].status, 'needs_reauth');
    const alert = await db().query(`SELECT severity FROM ops.alerts WHERE code = 'TELEGRAM_TOKEN_REJECTED' AND status = 'open'`);
    assert.equal(alert.rows[0].severity, 'critical');
  });
});
