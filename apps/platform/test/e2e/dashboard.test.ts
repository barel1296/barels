/**
 * Admin dashboard smoke test in a REAL headless Chromium (Playwright) against
 * the running platform API, with SIMULATED Telegram and SIMULATED LLM behind
 * it. Proves sign-in with password + TOTP, the strict CSP, rendering of the
 * main pages, an approval decision, approving an AI chat draft, a kill
 * switch, setting up and cloning an influencer entirely from the UI (engine,
 * workflow approval, persona four-eyes, reference image, adapter, binding),
 * and that fan-supplied text is rendered as text (no markup injection). Skipped (and reported as skipped) when no Chromium is installed.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright-core';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { totpAt } from '../../src/lib/totp.js';
import { enrollTotp, setPassword } from '../../src/modules/sessions.js';
import { type Stack, setupInfluencer, startStack } from '../helpers/stack.js';

describe('admin dashboard (real Chromium; SIMULATED Telegram + LLM)', () => {
  let stack: Stack;
  let browser: Browser | null = null;
  let page: Page;
  let skip: string | false = false;
  let totpSecret: string;
  let influencerId: string;
  let botToken: string;
  const errors: string[] = [];
  const email = 'owner.studio@example.test';
  const password = 'dashboard test password 1';
  const fan = { id: 777001, is_bot: false, first_name: '<img src=x onerror=alert(1)>' };

  before(async () => {
    try {
      browser = await chromium.launch();
    } catch (err) {
      skip = `no Chromium available: ${(err as Error).message.split('\n')[0]}`;
      return;
    }
    stack = await startStack({ llm: true, telegram: true });
    await setPassword(stack.svc.workerPool, stack.ws.owner.id, password);
    totpSecret = (await enrollTotp(stack.svc.workerPool, stack.svc.config, stack.ws.owner.id, email)).secret;
    ({ influencerId } = await setupInfluencer(stack, 'golden'));
    const owner = stack.ws.owner.client;
    await owner.post(`/v1/influencers/${influencerId}/status`, { status: 'active' });
    await owner.patch(`/v1/influencers/${influencerId}/runtime-config`, { free_replies_per_day: 10 });
    // A pending content approval with a real (edited) image.
    const png = encodeSolidPng(48, 60, [180, 90, 40]);
    const sha = sha256Hex(png);
    const key = stack.svc.store.keyFor(stack.ws.workspaceId, influencerId, sha, 'png');
    await stack.svc.store.put(key, png, sha);
    const asset = uuidv7();
    await stack.svc.workerPool.query(
      `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, status)
       VALUES ($1, $2, $3, 'image', $4, 'image/png', $5, 48, 60, $6, 'edited', 'valid')`,
      [asset, stack.ws.workspaceId, influencerId, key, png.length, Buffer.from(sha, 'hex')],
    );
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${influencerId}/content-items`, { format: 'ig_image', planned_for: new Date(Date.now() + 86_400_000).toISOString(), brief: { theme: 'Sunday market' } });
    const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'Sunday market finds 🍋', hashtags: ['market'], assets: [{ media_asset_id: asset, role: 'primary' }] });
    await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
    // A fan conversation with an AI draft waiting for the operator (ai_draft is the default).
    botToken = stack.telegram!.addBot('golden_dash_bot').token;
    await owner.post(`/v1/influencers/${influencerId}/telegram/bot`, { token: botToken });
    stack.llm!.whenContains('market', 'The lemons were the best part! Do you like markets?');
    stack.telegram!.userMessage(botToken, fan, '/start');
    await stack.drive(async () => false, 2).catch(() => undefined);
    stack.telegram!.callback(botToken, fan, 'consent:accept');
    await stack.drive(async () => false, 2).catch(() => undefined);
    stack.telegram!.userMessage(botToken, fan, 'loved your market post');
    await stack.drive(async () => (await stack.svc.workerPool.query(`SELECT 1 FROM conversation.messages WHERE status = 'drafted'`)).rowCount === 1);

    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`));
    page.on('dialog', (d) => {
      if (d.type() === 'alert') errors.push(`unexpected alert: ${d.message()}`);
      // Workflow decisions ask for an audit note.
      if (d.type() === 'prompt') void d.accept('approved from the dashboard test');
      else void d.dismiss();
    });
  });
  after(async () => {
    await browser?.close();
    await stack?.close();
  });

  it('serves the dashboard with a strict CSP and signs in with password + TOTP', async (t) => {
    if (skip) return t.skip(skip);
    const res = await page.goto(`${stack.apiUrl}/admin/`);
    assert.match(res!.headers()['content-security-policy']!, /default-src 'self'/);
    await page.waitForSelector('form');
    assert.match(page.url(), /#\/login$/);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=password]', password);
    await page.fill('input[name=totp]', totpAt(totpSecret, Math.floor(Date.now() / 1000)));
    await page.click('button[type=submit]');
    await page.waitForSelector('h1:has-text("Overview")');
    const pending = await page.locator('.stat', { hasText: 'Pending approvals' }).locator('.v').textContent();
    assert.equal(pending, '1');
    assert.ok(await page.locator('nav a', { hasText: 'Ops' }).count(), 'platform admins see Ops');
  });

  it('reviews and approves content with the image preview and QA findings', async (t) => {
    if (skip) return t.skip(skip);
    await stack.drive(async () => (await stack.svc.workerPool.query('SELECT 1 FROM approvals.qa_reviews')).rowCount === 1);
    await page.click('nav a:has-text("Approvals")');
    await page.click('table a:has-text("content.publish")');
    await page.waitForSelector('h2:has-text("Automated QA")');
    const img = page.locator('.thumbs img').first();
    await img.waitFor();
    assert.equal(await img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth), 48, 'the preview image loaded through the authenticated route');
    assert.ok(await page.locator('text=Sunday market finds').count());
    await page.selectOption('select[name=decision]', 'approve');
    await page.click('button:has-text("Submit decision")');
    await page.waitForSelector('h1 .badge:has-text("approved")');
  });

  it('approves an AI chat draft from the inbox and renders fan text safely', async (t) => {
    if (skip) return t.skip(skip);
    await page.click('nav a:has-text("Inbox")');
    const link = page.locator('table a').first();
    assert.equal(await link.textContent(), fan.first_name, 'markup in a fan name is shown as text');
    await link.click();
    await page.waitForSelector('.msg.drafted');
    await page.click('button:has-text("Approve & send")');
    await page.waitForSelector('.msg.drafted', { state: 'detached' });
    const sent = stack.telegram!.sent(botToken, 'sendMessage').map((c) => String(c.params.text));
    assert.ok(sent.includes('The lemons were the best part! Do you like markets?'));
    assert.equal(await page.locator('img[src="x"]').count(), 0, 'no injected element');
  });

  it('toggles a kill switch and shows the calendar, agents, money, analytics and ops pages', async (t) => {
    if (skip) return t.skip(skip);
    await page.goto(`${stack.apiUrl}/admin/#/influencer/${influencerId}`);
    await page.click('button:has-text("Stop publishing")');
    await page.waitForSelector('button:has-text("Resume publishing")');
    const flag = await stack.svc.workerPool.query(`SELECT value FROM core.feature_flags WHERE key = 'kill_switch.publishing' AND influencer_id = $1`, [influencerId]);
    assert.equal(flag.rows[0].value, true);
    for (const [nav, heading] of [
      ['Calendar', 'Content calendar'],
      ['Media', 'Media library'],
      ['Agents', 'Agents'],
      ['Money', 'Monetization'],
      ['Analytics', 'Analytics'],
      ['Ops', 'Operations'],
      ['Users', 'Users'],
      ['Escalations', 'Escalations'],
    ]) {
      await page.click(`nav a:has-text("${nav}")`);
      await page.waitForSelector(`h1:has-text("${heading}")`);
      assert.equal(await page.locator('.notice:has-text("Could not load")').count(), 0, `${nav} loaded without errors`);
      if (nav === 'Media') assert.equal(await page.locator('.tile img').first().evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth), 48);
      if (nav === 'Calendar') assert.ok(await page.locator('td:has-text("Sunday market")').count(), 'the calendar shows the planned item');
    }
  });

  it('sets up a new influencer from the UI: engine, workflow, persona, reference, adapter, binding, clone', async (t) => {
    if (skip) return t.skip(skip);
    // Engines: register the (contract mock) engine, sync and approve its workflow.
    await page.click('nav a:has-text("Engines")');
    await page.waitForSelector('h1:has-text("Visual engines")');
    await page.fill('input[name=engine_key]', 'ui-mock');
    await page.fill('input[name=base_url]', stack.engine.url);
    await page.fill('input[name=token]', stack.engineToken);
    await page.click('button:has-text("Register")');
    const engineRow = page.locator('tr', { hasText: 'ui-mock' });
    await engineRow.waitFor();
    await engineRow.locator('button:has-text("Sync workflows")').click();
    const wfRow = page.locator('tr', { hasText: 'mock.persona_portrait@' });
    await wfRow.waitFor();
    await wfRow.locator('button:has-text("Approve")').click();
    await wfRow.locator('.badge:has-text("approved")').waitFor();

    // New influencer.
    await page.click('nav a:has-text("Influencers")');
    await page.fill('input[name=slug]', 'ui-made');
    await page.fill('input[name=display_name]', 'UI Made');
    await page.click('button:has-text("Create")');
    await page.waitForSelector('h1:has-text("Setup · UI Made")');
    const newId = page.url().split('/').pop()!;

    // Persona: draft and submit here; a different person approves (four-eyes); activate here.
    await page.fill('input[name=change_summary]', 'first draft from the UI');
    await page.click('button:has-text("Save draft")');
    await page.click('button:has-text("Submit for review")');
    await page.waitForSelector('text=awaiting another reviewer');
    assert.equal(await page.locator('button:has-text("Approve")').count(), 0, 'the author is not offered approval');
    const pv = (await stack.ws.owner.client.get(`/v1/influencers/${newId}`)).body.persona_versions[0];
    assert.equal((await stack.ws.compliance.client.post(`/v1/persona-versions/${pv.id}/approve`)).status, 200);
    await page.reload();
    await page.locator('tr', { hasText: 'first draft from the UI' }).locator('button:has-text("Activate")').click();
    await page.locator('tr', { hasText: 'first draft from the UI' }).locator('.badge:has-text("active")').waitFor();
    await page.locator('h2:has-text("Status") + div button:has-text("Activate")').click();
    await page.waitForSelector('h1 .badge:has-text("active")');

    // Reference image: upload the file, approve, and see the authenticated preview.
    await page.setInputFiles('input[name=file]', { name: 'face.png', mimeType: 'image/png', buffer: encodeSolidPng(40, 40, [200, 160, 120]) });
    await page.click('button:has-text("Upload")');
    const refRow = page.locator('tr', { hasText: 'face_canonical' });
    await refRow.locator('.badge:has-text("pending")').waitFor();
    await refRow.locator('button:has-text("Approve")').click();
    await refRow.locator('.badge:has-text("approved")').waitFor();
    assert.equal(await refRow.locator('img.ref').evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth), 40);

    // Adapter: the registrant cannot approve it.
    await page.fill('input[name=engine_ref]', 'ui-lora-a.safetensors');
    await page.click('button:has-text("Register adapter")');
    await page.locator('tr', { hasText: 'ui-lora-a.safetensors' }).locator('text=awaiting another approver').waitFor();

    // Binding to the approved workflow.
    await page.selectOption('select[name=workflow_key]', 'mock.persona_portrait');
    await page.fill('textarea[name=default_parameters]', '{"aspect_ratio": "4:5"}');
    await page.click('button:has-text("Save binding")');
    await page.locator('tr', { hasText: 'feed_photo' }).locator('td:has-text("mock.persona_portrait")').waitFor();

    // Clone: configuration comes along, identity does not.
    await page.fill('input[name=slug]', 'ui-clone');
    await page.fill('input[name=display_name]', 'UI Clone');
    await page.click('button:has-text("Clone")');
    await page.waitForSelector('h1:has-text("Setup · UI Clone")');
    await page.locator('tr', { hasText: 'feed_photo' }).locator('td:has-text("mock.persona_portrait")').waitFor();
    assert.ok(await page.locator('text=No persona yet').count(), 'the persona is not copied');
    assert.ok(await page.locator('text=No reference images yet').count(), 'reference images are not copied');
    assert.equal(await page.locator('.notice:has-text("Could not load")').count(), 0);
  });

  it('signs out', async (t) => {
    if (skip) return t.skip(skip);
    await page.click('nav a:has-text("Sign out")');
    await page.waitForSelector('h1:has-text("Sign in")');
    const r = await page.evaluate(async () => (await fetch('/v1/auth/session')).status);
    assert.equal(r, 401);
    assert.deepEqual(errors.filter((e) => !e.includes('401')), [], 'no page errors');
  });
});
