/**
 * Governance and security invariants, verified against PostgreSQL with the
 * production role model (aios_app NOBYPASSRLS, aios_worker, aios_migrator).
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { paths } from '../../src/config.js';
import { migrate } from '../../src/db/migrate.js';
import { sha256Hex } from '../../src/lib/canonical-json.js';
import { decryptSecret, signAssetUrl } from '../../src/lib/crypto.js';
import { uuidv7 } from '../../src/lib/ids.js';
import { encodeSolidPng } from '../../src/lib/png.js';
import { credentialAad } from '../../src/modules/integrations.js';
import type { PublishRequest, PublishingAdapter } from '../../src/modules/publishing.js';
import { publisherTick } from '../../src/modules/publishing.js';
import { type Stack, type Users, setupEngine, setupInfluencer, startStack } from '../helpers/stack.js';

async function asRole(url: string, workspaceId: string | null, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (workspaceId) await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

async function expectPgError(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(p, (err: Error) => {
    assert.match(`${(err as { code?: string }).code ?? ''} ${err.message}`, pattern);
    return true;
  });
}

class RecordingAdapter implements PublishingAdapter {
  readonly calls: PublishRequest[] = [];
  constructor(readonly channelKind: string) {}
  async publish(req: PublishRequest) {
    this.calls.push(req);
    return { externalPostId: `test-post-${this.calls.length}`, permalink: null };
  }
}

describe('governance and security invariants', () => {
  let stack: Stack;
  let wsB: Users;
  let infA: string;
  let assetId: string;
  let itemId: string;
  let revisionId: string;
  let approvalId: string;
  let channelId: string;
  let accountId: string;

  before(async () => {
    stack = await startStack();
    await setupEngine(stack);
    ({ influencerId: infA } = await setupInfluencer(stack, 'aria'));
    wsB = await stack.createWorkspace('other-studio');
    await setupInfluencer(stack, 'bea', wsB);

    // One generated asset, revision and pending approval in workspace A.
    const m = stack.ws.manager.client;
    const item = await m.post(`/v1/influencers/${infA}/content-items`, { format: 'ig_image' });
    itemId = item.body.id;
    const job = await m.post(`/v1/influencers/${infA}/visual-jobs`, {
      idempotency_key: 'gov-job-000001',
      workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
      parameters: { scene: 'garden', aspect_ratio: '1:1' },
      content_item_id: itemId,
    });
    await stack.drive(async () => (await m.get(`/v1/visual-jobs/${job.body.id}`)).body.state === 'succeeded');
    assetId = (await m.get(`/v1/influencers/${infA}/media-assets?visual_job_id=${job.body.id}`)).body[0].id;
    const rev = await m.post(`/v1/content-items/${itemId}/revisions`, { caption: 'hello', assets: [{ media_asset_id: assetId, role: 'primary' }] });
    revisionId = rev.body.id;
    approvalId = (await m.post(`/v1/revisions/${revisionId}/approval-requests`)).body.id;
    const account = await stack.ws.owner.client.post('/v1/integration-accounts', {
      influencer_id: infA,
      provider: 'instagram',
      external_account_id: 'ig-aria',
      credential: 'super-secret-token-value-123',
    });
    accountId = account.body.id;
    channelId = (await stack.ws.owner.client.post(`/v1/influencers/${infA}/channels`, { integration_account_id: accountId, kind: 'instagram_account', external_id: 'ig-aria' })).body.id;
  });
  after(async () => {
    await stack?.close();
  });

  describe('tenant isolation', () => {
    it('API: another workspace cannot see or act on this influencer', async () => {
      const b = wsB.owner.client;
      assert.equal((await b.get(`/v1/influencers/${infA}`)).status, 404);
      assert.equal((await b.get('/v1/influencers')).body.some((i: any) => i.id === infA), false);
      const job = await b.post(`/v1/influencers/${infA}/visual-jobs`, {
        idempotency_key: 'cross-tenant-1',
        workflow: { key: 'mock.persona_portrait', version_range: '^1.0' },
        parameters: { scene: 'x', aspect_ratio: '1:1' },
      });
      assert.equal(job.status, 404);
      assert.equal((await b.get(`/v1/content-items/${itemId}/lineage`)).status, 404);
    });

    it('DB: row-level security scopes aios_app to app.workspace_id and fails closed without it', async () => {
      await asRole(stack.db.appUrl, wsB.workspaceId, async (c) => {
        const inf = await c.query('SELECT id FROM identity.influencers');
        assert.equal(inf.rows.some((r) => r.id === infA), false);
        assert.equal((await c.query('SELECT 1 FROM inference.visual_jobs WHERE influencer_id = $1', [infA])).rowCount, 0);
        assert.equal((await c.query('SELECT 1 FROM core.integration_accounts WHERE id = $1', [accountId])).rowCount, 0);
        assert.equal((await c.query('SELECT 1 FROM core.audit_log WHERE influencer_id = $1', [infA])).rowCount, 0);
        await expectPgError(
          c.query(`INSERT INTO content.content_items (workspace_id, influencer_id, format, created_by_type, created_by_id) VALUES ($1, $2, 'ig_image', 'user', 'x')`, [stack.ws.workspaceId, infA]),
          /row-level security/,
        );
      });
      await asRole(stack.db.appUrl, null, async (c) => {
        await expectPgError(c.query('SELECT count(*) FROM identity.influencers'), /app\.workspace_id/);
      });
    });
  });

  describe('append-only records', () => {
    for (const [table, url] of [
      ['core.audit_log', 'appUrl'],
      ['core.audit_log', 'workerUrl'],
      ['inference.visual_job_events', 'appUrl'],
      ['approvals.approval_decisions', 'workerUrl'],
    ] as const) {
      it(`${table} cannot be updated or deleted by ${url === 'appUrl' ? 'aios_app' : 'aios_worker'}`, async () => {
        await asRole(stack.db[url], stack.ws.workspaceId, async (c) => {
          await expectPgError(c.query(`UPDATE ${table} SET workspace_id = workspace_id`), /42501|permission denied/);
        });
        await asRole(stack.db[url], stack.ws.workspaceId, async (c) => {
          await expectPgError(c.query(`DELETE FROM ${table}`), /42501|permission denied/);
        });
      });
    }
  });

  describe('approvals', () => {
    it('API: a requester with approval rights still cannot approve their own request', async () => {
      const owner = stack.ws.owner.client;
      const item = await owner.post(`/v1/influencers/${infA}/content-items`, { format: 'ig_image' });
      const rev = await owner.post(`/v1/content-items/${item.body.id}/revisions`, { assets: [{ media_asset_id: assetId, role: 'primary' }] });
      const req = await owner.post(`/v1/revisions/${rev.body.id}/approval-requests`);
      const self = await owner.post(`/v1/approvals/${req.body.id}/decisions`, { decision: 'approve', payload_hash: req.body.payload_hash });
      assert.equal(self.status, 403);
      assert.match(self.body.error.message, /SELF_APPROVAL_FORBIDDEN/);
    });

    it('DB trigger: self-approval and hash mismatch are rejected even when the application is bypassed', async () => {
      const { rows } = await stack.svc.workerPool.query('SELECT requested_by_id, payload_hash FROM approvals.approval_requests WHERE id = $1', [approvalId]);
      await asRole(stack.db.workerUrl, null, async (c) => {
        await expectPgError(
          c.query(`INSERT INTO approvals.approval_decisions (workspace_id, approval_request_id, approver_user_id, decision, payload_hash_seen) VALUES ($1, $2, $3, 'approve', $4)`, [
            stack.ws.workspaceId,
            approvalId,
            rows[0].requested_by_id,
            rows[0].payload_hash,
          ]),
          /SELF_APPROVAL_FORBIDDEN/,
        );
      });
      await asRole(stack.db.workerUrl, null, async (c) => {
        await expectPgError(
          c.query(`INSERT INTO approvals.approval_decisions (workspace_id, approval_request_id, approver_user_id, decision, payload_hash_seen) VALUES ($1, $2, $3, 'approve', '\\x00')`, [
            stack.ws.workspaceId,
            approvalId,
            stack.ws.reviewer.id,
          ]),
          /PAYLOAD_HASH_MISMATCH/,
        );
      });
    });

    it('a new revision supersedes the pending approval of the previous one', async () => {
      const m = stack.ws.manager.client;
      const item = await m.post(`/v1/influencers/${infA}/content-items`, { format: 'ig_image' });
      const r1 = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'v1', assets: [{ media_asset_id: assetId, role: 'primary' }] });
      const a1 = await m.post(`/v1/revisions/${r1.body.id}/approval-requests`);
      await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'v2', assets: [{ media_asset_id: assetId, role: 'primary' }] });
      const late = await stack.ws.reviewer.client.post(`/v1/approvals/${a1.body.id}/decisions`, { decision: 'approve', payload_hash: a1.body.payload_hash });
      assert.equal(late.status, 409);
      assert.equal(late.body.error.code, 'APPROVAL_NOT_PENDING');
    });
  });

  describe('publication authorization', () => {
    it('DB trigger: a publication cannot be scheduled without an approved request for that exact content hash', async () => {
      const { rows } = await stack.svc.workerPool.query('SELECT content_hash FROM content.content_revisions WHERE id = $1', [revisionId]);
      await asRole(stack.db.workerUrl, null, async (c) => {
        await expectPgError(
          c.query(
            `INSERT INTO publishing.publications (workspace_id, influencer_id, content_item_id, revision_id, channel_id, scheduled_for, status,
               authorized_content_hash, authorization_kind, approval_request_id)
             VALUES ($1, $2, $3, $4, $5, now(), 'scheduled', $6, 'human_approval', $7)`,
            [stack.ws.workspaceId, infA, itemId, revisionId, channelId, rows[0].content_hash, approvalId],
          ),
          /UNAUTHORIZED_CONTENT/,
        );
      });
    });

    it('approved contract-mock content is scheduled but held: MOCK_ASSET_NOT_PUBLISHABLE, never published', async () => {
      const approval = (await stack.ws.reviewer.client.get(`/v1/approvals/${approvalId}`)).body;
      assert.equal((await stack.ws.reviewer.client.post(`/v1/approvals/${approvalId}/decisions`, { decision: 'approve', payload_hash: approval.payload_hash })).status, 200);
      const adapter = new RecordingAdapter('instagram_account');
      stack.svc.publishingAdapters.register(adapter);
      const pub = await stack.ws.manager.client.post(`/v1/content-items/${itemId}/publications`, { channel_id: channelId, scheduled_for: new Date().toISOString() });
      assert.equal(pub.status, 201, JSON.stringify(pub.body));
      assert.equal(pub.body.execution.blocked_reason, 'MOCK_ASSET_NOT_PUBLISHABLE');
      await publisherTick(stack.svc);
      const row = (await stack.svc.workerPool.query('SELECT status, last_error FROM publishing.publications WHERE id = $1', [pub.body.id])).rows[0];
      assert.equal(row.status, 'scheduled');
      assert.equal(row.last_error.code, 'MOCK_ASSET_NOT_PUBLISHABLE');
      assert.equal(adapter.calls.length, 0);
      // Tampering with the authorized hash, or forcing the status, is refused by the database.
      await asRole(stack.db.workerUrl, null, async (c) => {
        await expectPgError(c.query(`UPDATE publishing.publications SET authorized_content_hash = '\\x00' WHERE id = $1`, [pub.body.id]), /UNAUTHORIZED_CONTENT/);
      });
      await asRole(stack.db.workerUrl, null, async (c) => {
        await expectPgError(c.query(`UPDATE publishing.publications SET status = 'publishing' WHERE id = $1`, [pub.body.id]), /MOCK_ASSET_NOT_PUBLISHABLE/);
      });
    });

    it('publisher executes only through a registered channel adapter and records the external operation (in-process test adapter, not Instagram)', async () => {
      // An "edited" asset with no contract-mock origin stands in for real-engine output here.
      const png = encodeSolidPng(16, 16, [1, 2, 3]);
      const sha = sha256Hex(png);
      const key = stack.svc.store.keyFor(stack.ws.workspaceId, infA, sha, 'png');
      await stack.svc.store.put(key, png, sha);
      const asset = uuidv7();
      await stack.svc.workerPool.query(
        `INSERT INTO content.media_assets (id, workspace_id, influencer_id, kind, storage_key, mime_type, bytes, width, height, sha256, origin, status)
         VALUES ($1, $2, $3, 'image', $4, 'image/png', $5, 16, 16, $6, 'edited', 'valid')`,
        [asset, stack.ws.workspaceId, infA, key, png.length, Buffer.from(sha, 'hex')],
      );
      const m = stack.ws.manager.client;
      const item = await m.post(`/v1/influencers/${infA}/content-items`, { format: 'ig_image' });
      const rev = await m.post(`/v1/content-items/${item.body.id}/revisions`, { caption: 'real', assets: [{ media_asset_id: asset, role: 'primary' }] });
      const req = await m.post(`/v1/revisions/${rev.body.id}/approval-requests`);
      await stack.ws.reviewer.client.post(`/v1/approvals/${req.body.id}/decisions`, { decision: 'approve', payload_hash: req.body.payload_hash });
      // Telegram has no adapter: held, not faked.
      const tgAccount = await stack.ws.owner.client.post('/v1/integration-accounts', { influencer_id: infA, provider: 'telegram_bot', external_account_id: 'bot-1', credential: '123456:ABCDEF-test-token' });
      const tg = await stack.ws.owner.client.post(`/v1/influencers/${infA}/channels`, { integration_account_id: tgAccount.body.id, kind: 'telegram_public_channel', external_id: '-1001' });
      const tgPub = await m.post(`/v1/content-items/${item.body.id}/publications`, { channel_id: tg.body.id, scheduled_for: new Date().toISOString() });
      assert.equal(tgPub.body.execution.blocked_reason, 'NO_CHANNEL_ADAPTER');
      const igPub = await m.post(`/v1/content-items/${item.body.id}/publications`, { channel_id: channelId, scheduled_for: new Date().toISOString() });
      assert.equal(igPub.body.execution.will_execute, true);
      // The influencer must be active for anything to leave the platform.
      await stack.ws.owner.client.post(`/v1/influencers/${infA}/status`, { status: 'active' });
      const adapter = new RecordingAdapter('instagram_account');
      stack.svc.publishingAdapters.register(adapter);
      await publisherTick(stack.svc);
      const rows = (await stack.svc.workerPool.query('SELECT id, status, external_post_id, last_error FROM publishing.publications WHERE content_item_id = $1', [item.body.id])).rows;
      const ig = rows.find((r) => r.id === igPub.body.id)!;
      const tgRow = rows.find((r) => r.id === tgPub.body.id)!;
      assert.equal(ig.status, 'published');
      assert.equal(ig.external_post_id, 'test-post-1');
      assert.equal(tgRow.status, 'scheduled');
      assert.equal(tgRow.last_error.code, 'NO_CHANNEL_ADAPTER');
      assert.equal(adapter.calls[0]!.credential, 'super-secret-token-value-123');
      assert.equal(adapter.calls[0]!.revision.disclosure_text, 'AI-generated virtual creator');
      const op = (await stack.svc.workerPool.query(`SELECT status, external_ref FROM core.external_operations WHERE idempotency_key = $1`, [`publish:${ig.id}`])).rows[0];
      assert.deepEqual(op, { status: 'succeeded', external_ref: 'test-post-1' });
    });
  });

  describe('secrets', () => {
    it('stores platform credentials and engine tokens only as envelope-encrypted ciphertext', async () => {
      const acc = (await stack.svc.workerPool.query('SELECT * FROM core.integration_accounts WHERE id = $1', [accountId])).rows[0];
      assert.equal(acc.credential_ciphertext.includes(Buffer.from('super-secret-token-value-123')), false);
      const env = { ciphertext: acc.credential_ciphertext, nonce: acc.credential_nonce, dataKeyCiphertext: acc.data_key_ciphertext, wrappingKeyId: acc.wrapping_key_id };
      assert.equal(decryptSecret(stack.svc.config.masterKeys, env, credentialAad(acc.workspace_id, acc.provider, acc.external_account_id)), 'super-secret-token-value-123');
      assert.throws(() => decryptSecret(stack.svc.config.masterKeys, env, credentialAad(acc.workspace_id, acc.provider, 'another-account')));
      const engine = (await stack.svc.workerPool.query('SELECT token_ciphertext FROM inference.visual_engines')).rows[0];
      assert.equal(engine.token_ciphertext.includes(Buffer.from(stack.engineToken)), false);
      const listed = await stack.ws.owner.client.get('/v1/platform/engines');
      assert.equal(JSON.stringify(listed.body).includes(stack.engineToken), false);
    });

    it('serves reference assets to the engine only through valid, unexpired signed URLs', async () => {
      const ref = await stack.ws.manager.client.upload(`/v1/influencers/${infA}/reference-assets?kind=outfit`, encodeSolidPng(8, 8, [9, 9, 9]), 'image/png');
      const id = ref.body.media_asset_id;
      const exp = Math.floor(Date.now() / 1000) + 60;
      const sig = signAssetUrl(stack.svc.config.assetUrlSecret, id, exp);
      const ok = await fetch(`${stack.apiUrl}/v1/assets/${id}/content?exp=${exp}&sig=${sig}`);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('x-content-sha256'), ref.body.sha256);
      assert.equal((await fetch(`${stack.apiUrl}/v1/assets/${id}/content?exp=${exp}&sig=${sig.slice(1)}x`)).status, 403);
      const past = Math.floor(Date.now() / 1000) - 1;
      assert.equal((await fetch(`${stack.apiUrl}/v1/assets/${id}/content?exp=${past}&sig=${signAssetUrl(stack.svc.config.assetUrlSecret, id, past)}`)).status, 403);
    });
  });

  describe('RBAC and policy', () => {
    it('enforces role permissions and platform-admin-only operations', async () => {
      const reviewer = stack.ws.reviewer.client;
      assert.equal((await reviewer.post('/v1/influencers', { slug: 'x-1', display_name: 'x', ai_disclosure_short: 'AI', ai_disclosure_long: 'AI', timezone: 'UTC', primary_language: 'en' })).status, 403);
      assert.equal((await reviewer.post(`/v1/influencers/${infA}/visual-jobs`, { idempotency_key: 'rbac-000001', purpose: 'feed_photo' })).status, 403);
      assert.equal((await stack.ws.manager.client.post('/v1/platform/engines', { engine_key: 'rogue', base_url: 'http://127.0.0.1:1', token: 'x'.repeat(40) })).status, 403);
      assert.equal((await stack.client('gi_' + 'A'.repeat(43)).get('/v1/me')).status, 401);
    });

    it('rejects mature channels without an adult audience gate and explicit content entirely', async () => {
      const owner = stack.ws.owner.client;
      const acc = await owner.post('/v1/integration-accounts', { influencer_id: infA, provider: 'telegram_bot', external_account_id: 'bot-gate', credential: '42:gate-test-token' });
      const mature = await owner.post(`/v1/influencers/${infA}/channels`, { integration_account_id: acc.body.id, kind: 'telegram_premium_channel', external_id: '-1002', max_rating: 'mature' });
      assert.equal(mature.status, 422);
      assert.equal(mature.body.error.code, 'CHANNEL_RATING_GATE');
      const explicit = await stack.ws.manager.client.post(`/v1/influencers/${infA}/content-items`, { format: 'tg_post', target_rating: 'explicit' });
      assert.equal(explicit.status, 422);
    });

    it('a new influencer starts empty: nothing is copied from existing personas', async () => {
      const res = await stack.ws.owner.client.post('/v1/influencers', {
        slug: 'fresh',
        display_name: 'Fresh',
        ai_disclosure_short: 'AI-generated virtual creator',
        ai_disclosure_long: 'An AI-generated virtual character.',
        timezone: 'UTC',
        primary_language: 'en',
      });
      const detail = (await stack.ws.owner.client.get(`/v1/influencers/${res.body.id}`)).body;
      assert.equal(detail.active_persona_version_id, null);
      for (const k of ['persona_versions', 'reference_assets', 'adapters', 'workflow_bindings']) assert.deepEqual(detail[k], [], k);
      const counts = (
        await stack.svc.workerPool.query(
          `SELECT (SELECT count(*) FROM publishing.channels WHERE influencer_id = $1) AS channels,
                  (SELECT count(*) FROM core.integration_accounts WHERE influencer_id = $1) AS accounts,
                  (SELECT count(*) FROM crm.fan_influencer_profiles WHERE influencer_id = $1) AS fans,
                  (SELECT count(*) FROM conversation.conversations WHERE influencer_id = $1) AS conversations,
                  (SELECT count(*) FROM conversation.fan_memories WHERE influencer_id = $1) AS memories`,
          [res.body.id],
        )
      ).rows[0];
      assert.deepEqual(counts, { channels: 0, accounts: 0, fans: 0, conversations: 0, memories: 0 });
    });
  });

  describe('migrations', () => {
    it('are idempotent and refuse to run when an applied migration was modified', async () => {
      const again = await migrate(stack.db.migratorUrl, resolve(paths.repoRoot, 'db/migrations'));
      assert.deepEqual(again.applied, []);
      assert.deepEqual(again.alreadyApplied, ['0001', '0002']);
      const dir = mkdtempSync(join(tmpdir(), 'gi-mig-'));
      try {
        cpSync(resolve(paths.repoRoot, 'db/migrations'), dir, { recursive: true });
        const f = join(dir, '0002_visual_engine_contract.sql');
        writeFileSync(f, `${readFileSync(f, 'utf8')}\n-- tampered\n`);
        await assert.rejects(migrate(stack.db.migratorUrl, dir), /checksum mismatch/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
