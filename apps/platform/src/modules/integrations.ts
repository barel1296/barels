import type { Config } from '../config.js';
import type { Db } from '../db/tx.js';
import { maybeOne, one } from '../db/tx.js';
import { encryptSecret } from '../lib/crypto.js';
import { PG, conflict, notFound, pgCode, unprocessable } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { auditCtx } from './audit.js';
import { type Ctx, requireInfluencerAccess, requirePermission } from './context.js';
import { getInfluencer } from './identity.js';

export type Provider = 'instagram' | 'telegram_bot' | 'telegram_business';

/** AAD binding a credential ciphertext to its row identity (cannot be moved between accounts). */
export function credentialAad(workspaceId: string, provider: string, externalAccountId: string): string {
  return `integration_account:${workspaceId}:${provider}:${externalAccountId}`;
}

const PUBLIC_ACCOUNT_COLUMNS = `id, workspace_id, influencer_id, provider, external_account_id, display_name, status, scopes,
  wrapping_key_id, credential_version, expires_at, last_refreshed_at, metadata, created_at, updated_at`;

/**
 * Stores a platform credential (Instagram token, Telegram bot token, …) with
 * envelope encryption. The plaintext is never returned or logged. Accounts are
 * per influencer: credentials are never shared or copied between influencers.
 */
export async function createIntegrationAccount(
  db: Db,
  ctx: Ctx,
  config: Config,
  input: {
    influencer_id: string;
    provider: Provider;
    external_account_id: string;
    display_name?: string | null;
    credential: string;
    scopes?: string[];
    expires_at?: string | null;
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'integration.manage');
  await getInfluencer(db, ctx, input.influencer_id);
  const env = encryptSecret(config.masterKey, input.credential, credentialAad(ctx.workspaceId, input.provider, input.external_account_id));
  const id = uuidv7();
  try {
    const row = await one(
      db,
      `INSERT INTO core.integration_accounts (id, workspace_id, influencer_id, provider, external_account_id, display_name,
         scopes, credential_ciphertext, credential_nonce, data_key_ciphertext, wrapping_key_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${PUBLIC_ACCOUNT_COLUMNS}`,
      [
        id,
        ctx.workspaceId,
        input.influencer_id,
        input.provider,
        input.external_account_id,
        input.display_name ?? null,
        input.scopes ?? [],
        env.ciphertext,
        env.nonce,
        env.dataKeyCiphertext,
        env.wrappingKeyId,
        input.expires_at ?? null,
      ],
    );
    await auditCtx(db, ctx, {
      influencerId: input.influencer_id,
      action: 'integration_account.create',
      subjectType: 'integration_account',
      subjectId: id,
      metadata: { provider: input.provider, external_account_id: input.external_account_id, wrapping_key_id: env.wrappingKeyId },
    });
    return row;
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('ACCOUNT_EXISTS', 'This external account is already connected');
    throw err;
  }
}

const CHANNEL_PROVIDER: Record<string, Provider> = {
  instagram_account: 'instagram',
  telegram_public_channel: 'telegram_bot',
  telegram_premium_channel: 'telegram_bot',
  telegram_bot: 'telegram_bot',
  telegram_business_account: 'telegram_business',
};

export async function createChannel(
  db: Db,
  ctx: Ctx,
  influencerId: string,
  input: {
    integration_account_id: string;
    kind: keyof typeof CHANNEL_PROVIDER;
    external_id: string;
    username?: string | null;
    title?: string | null;
    max_rating?: 'general' | 'suggestive' | 'mature' | 'explicit';
    audience_gate?: 'none' | 'self_attested_adult' | 'verified_adult';
  },
): Promise<Record<string, unknown>> {
  requirePermission(ctx, 'integration.manage');
  await getInfluencer(db, ctx, influencerId);
  const account = await maybeOne<{ influencer_id: string | null; provider: string; status: string }>(
    db,
    'SELECT influencer_id, provider, status FROM core.integration_accounts WHERE id = $1',
    [input.integration_account_id],
  );
  if (!account) throw notFound('Integration account', input.integration_account_id);
  if (account.influencer_id !== influencerId) throw unprocessable('ACCOUNT_NOT_OWNED', 'The integration account belongs to another influencer');
  if (account.provider !== CHANNEL_PROVIDER[input.kind]) {
    throw unprocessable('PROVIDER_MISMATCH', `${input.kind} requires a ${CHANNEL_PROVIDER[input.kind]} account, got ${account.provider}`);
  }
  if (input.max_rating === 'explicit') throw unprocessable('RATING_DISABLED', 'explicit content is disabled platform-wide (docs/03)');
  const id = uuidv7();
  try {
    const row = await one(
      db,
      `INSERT INTO publishing.channels (id, workspace_id, influencer_id, integration_account_id, kind, external_id, username,
         title, max_rating, audience_gate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        id,
        ctx.workspaceId,
        influencerId,
        input.integration_account_id,
        input.kind,
        input.external_id,
        input.username ?? null,
        input.title ?? null,
        input.max_rating ?? 'general',
        input.audience_gate ?? 'none',
      ],
    );
    await auditCtx(db, ctx, { influencerId, action: 'channel.create', subjectType: 'channel', subjectId: id, changes: { after: input } });
    return row;
  } catch (err) {
    if (pgCode(err) === PG.uniqueViolation) throw conflict('CHANNEL_EXISTS', 'This channel is already connected');
    if (pgCode(err) === PG.checkViolation) {
      throw unprocessable('CHANNEL_RATING_GATE', 'mature content requires an adult audience gate; explicit requires verified adults');
    }
    throw err;
  }
}

export async function listChannels(db: Db, ctx: Ctx, influencerId: string): Promise<unknown[]> {
  requirePermission(ctx, 'channel.read');
  requireInfluencerAccess(ctx, influencerId);
  const { rows } = await db.query('SELECT * FROM publishing.channels WHERE influencer_id = $1 ORDER BY created_at', [influencerId]);
  return rows;
}
