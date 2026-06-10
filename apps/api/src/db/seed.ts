/* DEV-ONLY seed: demo tenant, owner user, entities, taxonomy, policies.
 * Never run in production — guarded below. Synthetic analytics data and a
 * demo War Room session are seeded by `python -m gros_workers.seed.generate`.
 */
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/passwords';

const DEMO = {
  tenantSlug: 'demo',
  tenantName: 'Nimbus Games (demo)',
  email: 'demo@gros.dev',
  password: 'demo-password-123',
  name: 'Dana Demo',
};

// Stable UUIDs so the Python seed can reference the same entities.
export const SEED_IDS = {
  tenant: 'aaaaaaaa-0000-4000-8000-000000000001',
  user: 'aaaaaaaa-0000-4000-8000-000000000002',
  app: 'aaaaaaaa-0000-4000-8000-000000000003',
  campaignDeGoogle: 'aaaaaaaa-0000-4000-8000-000000000010',
  campaignUsMeta: 'aaaaaaaa-0000-4000-8000-000000000011',
  campaignBrandLocked: 'aaaaaaaa-0000-4000-8000-000000000012',
  creativeHero: 'aaaaaaaa-0000-4000-8000-000000000020',
  creativeB: 'aaaaaaaa-0000-4000-8000-000000000021',
  creativeC: 'aaaaaaaa-0000-4000-8000-000000000022',
};

export async function seedDemo(): Promise<void> {
  // Demo seeding in production requires an explicit opt-in (hosted demo
  // deployments set ALLOW_DEMO_SEED=true). It only ever creates the fixed
  // demo tenant and is idempotent — it skips when the tenant exists.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed in production without ALLOW_DEMO_SEED=true');
  }
  // Dev seed runs as the owner role (cross-tenant bootstrap inserts).
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL_OWNER ??
      process.env.DATABASE_URL ??
      'postgres://gros:gros@localhost:5432/gros',
  });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [SEED_IDS.user]);

    const existing = await c.query('SELECT 1 FROM tenants WHERE slug = $1', [
      DEMO.tenantSlug,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      console.log('demo tenant already seeded — skipping');
      await c.query('ROLLBACK');
      return;
    }

    const passwordHash = await hashPassword(DEMO.password);
    await c.query(
      `INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`,
      [SEED_IDS.user, DEMO.email, DEMO.name, passwordHash],
    );
    await c.query(
      `INSERT INTO tenants (id, name, slug, plan) VALUES ($1, $2, $3, 'design_partner')`,
      [SEED_IDS.tenant, DEMO.tenantName, DEMO.tenantSlug],
    );
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [SEED_IDS.tenant]);
    await c.query(
      `INSERT INTO memberships (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE tenant_id IS NULL AND name = 'owner'`,
      [SEED_IDS.tenant, SEED_IDS.user],
    );

    // Tenant defaults (mirrors registration bootstrap).
    await c.query(`INSERT INTO cost_budgets (tenant_id) VALUES ($1)`, [SEED_IDS.tenant]);
    const kinds = [
      'budget_change', 'pause_entity', 'create_campaign', 'audience_sync',
      'creative_rotation', 'crm_journey_change', 'aso_change',
    ];
    for (const kind of kinds) {
      await c.query(
        `INSERT INTO approval_policies (tenant_id, action_kind, rules, autonomy_level)
         VALUES ($1, $2, $3, 2)`,
        [SEED_IDS.tenant, kind, JSON.stringify({
          requiredPermission: `actions:approve:${kind}`,
          maxMagnitudeUsd: kind === 'budget_change' ? 5000 : null,
          twoPersonAboveUsd: null,
          expiryHours: 72,
        })],
      );
    }
    const guardrails: [string, string, Record<string, unknown>][] = [
      ['max_budget_change_pct_per_day', 'Max budget change per entity per day (%)', { maxPct: 25 }],
      ['max_budget_change_usd', 'Max absolute daily budget change', { maxUsd: 5000 }],
      ['blast_radius_pct', 'Max share of tenant daily spend affected by one action', { maxPct: 10 }],
      ['entity_change_cooldown_hours', 'Min hours between changes to one entity', { hours: 24 }],
      ['data_health_gate', 'Block actions while the relevant domain is red', {}],
    ];
    for (const [key, description, params] of guardrails) {
      await c.query(
        `INSERT INTO guardrail_policies (tenant_id, key, description, params)
         VALUES ($1, $2, $3, $4)`,
        [SEED_IDS.tenant, key, description, JSON.stringify(params)],
      );
    }
    for (const domain of ['attribution', 'spend', 'revenue', 'events', 'skan']) {
      await c.query(
        `INSERT INTO health_status (tenant_id, domain, status, declared_by)
         VALUES ($1, $2, 'green', 'system')`,
        [SEED_IDS.tenant, domain],
      );
    }

    // App + campaigns + creatives.
    await c.query(
      `INSERT INTO apps (id, tenant_id, name, platform, store_id)
       VALUES ($1, $2, 'Nimbus Saga', 'android', 'com.nimbus.saga')`,
      [SEED_IDS.app, SEED_IDS.tenant],
    );
    const campaigns: [string, string, string, string, number][] = [
      [SEED_IDS.campaignDeGoogle, 'ext-g-001', 'DE_Google_UA', 'google', 1200],
      [SEED_IDS.campaignUsMeta, 'ext-m-001', 'US_Meta_Value', 'meta', 3000],
      [SEED_IDS.campaignBrandLocked, 'ext-g-002', 'Global_Brand_Protect', 'google', 400],
    ];
    for (const [id, ext, name, channel, budget] of campaigns) {
      await c.query(
        `INSERT INTO campaigns (id, tenant_id, app_id, external_id, name, channel,
                                status, budget_amount, budget_type, geo_targets, managed_state)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 'daily',
                 $8, $9)`,
        [id, SEED_IDS.tenant, SEED_IDS.app, ext, name, channel, budget,
         name.startsWith('DE') ? ['DE'] : ['US'],
         name.includes('Brand') ? 'locked' : 'observed'],
      );
    }
    const creatives: [string, string, string][] = [
      [SEED_IDS.creativeHero, 'Bonus_Hook_v3', 'reward_reveal'],
      [SEED_IDS.creativeB, 'Fail_Retry_v1', 'fail_retry'],
      [SEED_IDS.creativeC, 'Story_Intro_v2', 'narrative'],
    ];
    for (const [id, name, hook] of creatives) {
      await c.query(
        `INSERT INTO creatives (id, tenant_id, name, format, duration_s, language, tags, first_seen_at)
         VALUES ($1, $2, $3, 'video', 30, 'en', $4, now() - interval '60 days')`,
        [id, SEED_IDS.tenant, name, JSON.stringify({ hook_type: hook, theme: 'gameplay' })],
      );
    }

    // Canonical event taxonomy.
    const events: [string, string][] = [
      ['session_start', 'lifecycle'], ['install', 'lifecycle'],
      ['level_complete', 'product'], ['tutorial_complete', 'product'],
      ['paywall_view', 'monetization'], ['trial_start', 'monetization'],
      ['purchase', 'monetization'],
    ];
    for (const [name, category] of events) {
      await c.query(
        `INSERT INTO event_taxonomy (tenant_id, event_name, description, category)
         VALUES ($1, $2, $3, $4)`,
        [SEED_IDS.tenant, name, `${name} (seeded)`, category],
      );
    }

    // An experiment so correlate_events has a registry to consult.
    await c.query(
      `INSERT INTO experiments (tenant_id, kind, name, scope, starts_at, ends_at, source)
       VALUES ($1, 'liveops', 'Summer Event Week', '{"geos":["all"]}',
               now() - interval '50 days', now() - interval '43 days', 'manual')`,
      [SEED_IDS.tenant],
    );

    // Tenant business memory.
    const memory: [string, string, unknown][] = [
      ['targets', 'roas_d7', { value: 1.4, scope: 'blended' }],
      ['constraints', 'never_touch', { campaigns: ['Global_Brand_Protect'] }],
      ['preferences', 'tenantDailySpendUsd', 16000],
    ];
    for (const [category, key, value] of memory) {
      await c.query(
        `INSERT INTO tenant_memory (tenant_id, category, key, value, source)
         VALUES ($1, $2, $3, $4, 'onboarding')`,
        [SEED_IDS.tenant, category, key, JSON.stringify(value)],
      );
    }

    // Ingest API key (printed once).
    const secret = `gros_${randomBytes(24).toString('base64url')}`;
    await c.query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes)
       VALUES ($1, 'dev ingest key', $2, $3, '{ingest}')`,
      [SEED_IDS.tenant, createHash('sha256').update(secret).digest('hex'), secret.slice(0, 12)],
    );

    await c.query('COMMIT');
    console.log('Seeded demo tenant.');
    console.log(`  login:    ${DEMO.email} / ${DEMO.password}`);
    console.log(`  ingest:   X-Api-Key: ${secret}`);
    console.log('Next: cd workers/py && uv run python -m gros_workers.seed.generate');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
