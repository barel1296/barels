-- 005: global catalog seeds — permission catalog, system roles, data source
-- catalog, global semantic metric definitions, playbooks.
-- NOTE: permission keys must stay in sync with packages/shared/src/permissions.ts
-- (guarded by apps/api test src/rbac/permissions-sync.spec.ts).

INSERT INTO permissions (key, description, category) VALUES
  ('tenant:manage',        'Manage tenant settings and budgets', 'tenant'),
  ('members:manage',       'Invite and manage tenant members', 'tenant'),
  ('roles:manage',         'Create and edit custom roles', 'tenant'),
  ('apikeys:manage',       'Create and revoke API keys', 'tenant'),
  ('integrations:manage',  'Connect, configure and revoke data sources', 'data'),
  ('taxonomy:manage',      'Manage the canonical event taxonomy', 'data'),
  ('metrics:read',         'Query metrics and dashboards', 'data'),
  ('health:read',          'View tracking health', 'health'),
  ('health:manage',        'Acknowledge checks and override health gates', 'health'),
  ('warroom:read',         'View War Room sessions', 'warroom'),
  ('warroom:create',       'Start investigations', 'warroom'),
  ('warroom:participate',  'Send directives to running sessions', 'warroom'),
  ('warroom:manage',       'Cancel sessions', 'warroom'),
  ('recs:read',            'View recommendations', 'recs'),
  ('recs:manage',          'Dismiss recommendations', 'recs'),
  ('actions:read',         'View actions and approval queue', 'actions'),
  ('actions:approve:budget_change',     'Approve budget change actions', 'actions'),
  ('actions:approve:pause_entity',      'Approve pause/resume actions', 'actions'),
  ('actions:approve:create_campaign',   'Approve campaign creation actions', 'actions'),
  ('actions:approve:audience_sync',     'Approve audience sync actions', 'actions'),
  ('actions:approve:creative_rotation', 'Approve creative rotation actions', 'actions'),
  ('actions:approve:crm_journey_change','Approve CRM actions', 'actions'),
  ('actions:approve:aso_change',        'Approve ASO actions', 'actions'),
  ('actions:execute',      'Manually execute or roll back actions (L3+)', 'actions'),
  ('policies:manage',      'Manage guardrails, approval policies and autonomy levels', 'policies'),
  ('memory:manage',        'Curate tenant business memory', 'agents'),
  ('audit:read',           'Read audit logs', 'audit'),
  ('costs:read',           'View LLM cost ledger and budgets', 'costs');

-- System roles (tenant_id NULL).
INSERT INTO roles (id, tenant_id, name, is_system) VALUES
  ('00000000-0000-4000-8000-000000000001', NULL, 'owner',    true),
  ('00000000-0000-4000-8000-000000000002', NULL, 'admin',    true),
  ('00000000-0000-4000-8000-000000000003', NULL, 'approver', true),
  ('00000000-0000-4000-8000-000000000004', NULL, 'analyst',  true),
  ('00000000-0000-4000-8000-000000000005', NULL, 'viewer',   true);

-- owner: everything
INSERT INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000001', key FROM permissions;

-- admin: everything except tenant:manage
INSERT INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000002', key FROM permissions
WHERE key <> 'tenant:manage';

-- approver
INSERT INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000003', unnest(ARRAY[
  'metrics:read','health:read','warroom:read','warroom:create',
  'warroom:participate','recs:read','recs:manage','actions:read',
  'actions:approve:budget_change','actions:approve:pause_entity',
  'actions:approve:create_campaign','actions:approve:audience_sync',
  'actions:approve:creative_rotation','actions:approve:crm_journey_change',
  'actions:approve:aso_change','costs:read'
]);

-- analyst
INSERT INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000004', unnest(ARRAY[
  'metrics:read','health:read','warroom:read','warroom:create',
  'warroom:participate','recs:read','actions:read','costs:read'
]);

-- viewer
INSERT INTO role_permissions (role_id, permission_key)
SELECT '00000000-0000-4000-8000-000000000005', unnest(ARRAY[
  'metrics:read','health:read','warroom:read','recs:read','actions:read'
]);

-- Data source catalog (connector implementations land per roadmap Phase 1+).
INSERT INTO data_sources (key, category, display_name, capabilities, min_sync_interval_min) VALUES
  ('appsflyer',  'mmp',        'AppsFlyer',  '{"entities":["attribution","cost","skan"],"execution":false}', 60),
  ('meta_ads',   'ad_network', 'Meta Ads',   '{"entities":["campaigns","adsets","ads","insights"],"execution":true}', 60),
  ('google_ads', 'ad_network', 'Google Ads', '{"entities":["campaigns","adgroups","ads","insights"],"execution":true}', 60),
  ('tiktok_ads', 'ad_network', 'TikTok Ads', '{"entities":["campaigns","adgroups","ads","insights"],"execution":true}', 60),
  ('revenuecat', 'revenue',    'RevenueCat', '{"entities":["subscriptions","transactions"],"execution":false}', 30),
  ('firebase',   'product',    'Firebase / GA4', '{"entities":["events"],"execution":false}', 60),
  ('firstparty', 'product',    'First-party events', '{"entities":["events"],"execution":false}', 0);

-- ── Global semantic metric definitions ───────────────────────────────────────
-- formula: {table, timeCol, valueExpr, defaultWhere?}
-- valueExpr fragments are trusted (reviewed migration), composed with
-- parameterized filters at runtime.

INSERT INTO metric_definitions (key, version, tenant_id, display_name, description, formula, dimensions, grains, value_format, caveats) VALUES
('spend', 1, NULL, 'Spend', 'Total ad spend (USD)',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(spend_usd)"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'currency', '[]'),
('installs', 1, NULL, 'Installs', 'Paid installs (network-reported)',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(installs)"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'number', '[]'),
('impressions', 1, NULL, 'Impressions', 'Ad impressions',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(impressions)"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'number', '[]'),
('cpi', 1, NULL, 'CPI', 'Cost per install',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(spend_usd) / nullIf(sum(installs), 0)"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'currency', '[]'),
('cpm', 1, NULL, 'CPM', 'Cost per mille',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(spend_usd) / nullIf(sum(impressions), 0) * 1000"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'currency', '[]'),
('ctr', 1, NULL, 'CTR', 'Click-through rate',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(clicks) / nullIf(sum(impressions), 0)"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'percent', '[]'),
('ipm', 1, NULL, 'IPM', 'Installs per mille impressions',
 '{"table":"spend_metrics_daily","timeCol":"date","valueExpr":"sum(installs) / nullIf(sum(impressions), 0) * 1000"}',
 '{channel,campaign_id,country,platform}', '{day,week,month}', 'ratio', '[]'),
('revenue', 1, NULL, 'Revenue', 'Gross revenue (USD)',
 '{"table":"revenue_events","timeCol":"event_time","valueExpr":"sum(revenue_usd)"}',
 '{country,store,kind}', '{day,week,month}', 'currency', '[]'),
('roas_d0', 1, NULL, 'ROAS D0', 'Day-0 cohort return on ad spend',
 '{"table":"cohort_metrics","timeCol":"cohort_date","valueExpr":"sumIf(revenue_usd, day_n = 0) / nullIf(sumIf(spend_usd, day_n = 0), 0)"}',
 '{media_source,campaign_id,country,platform}', '{day,week}', 'ratio',
 '["Recent cohorts are immature; values restate as revenue accrues"]'),
('roas_d7', 1, NULL, 'ROAS D7', 'Day-7 cohort return on ad spend',
 '{"table":"cohort_metrics","timeCol":"cohort_date","valueExpr":"sumIf(revenue_usd, day_n = 7) / nullIf(sumIf(spend_usd, day_n = 0), 0)"}',
 '{media_source,campaign_id,country,platform}', '{day,week}', 'ratio',
 '["Cohorts younger than 7 days are incomplete for this metric"]'),
('roas_d30', 1, NULL, 'ROAS D30', 'Day-30 cohort return on ad spend',
 '{"table":"cohort_metrics","timeCol":"cohort_date","valueExpr":"sumIf(revenue_usd, day_n = 30) / nullIf(sumIf(spend_usd, day_n = 0), 0)"}',
 '{media_source,campaign_id,country,platform}', '{day,week}', 'ratio',
 '["Cohorts younger than 30 days are incomplete for this metric"]'),
('retention_d1', 1, NULL, 'Retention D1', 'Day-1 retention rate',
 '{"table":"cohort_metrics","timeCol":"cohort_date","valueExpr":"sumIf(retained, day_n = 1) / nullIf(sumIf(cohort_size, day_n = 0), 0)"}',
 '{media_source,campaign_id,country,platform}', '{day,week}', 'percent', '[]'),
('retention_d7', 1, NULL, 'Retention D7', 'Day-7 retention rate',
 '{"table":"cohort_metrics","timeCol":"cohort_date","valueExpr":"sumIf(retained, day_n = 7) / nullIf(sumIf(cohort_size, day_n = 0), 0)"}',
 '{media_source,campaign_id,country,platform}', '{day,week}', 'percent', '[]'),
('creative_ctr', 1, NULL, 'Creative CTR', 'Per-creative click-through rate',
 '{"table":"creative_metrics_daily","timeCol":"date","valueExpr":"sum(clicks) / nullIf(sum(impressions), 0)"}',
 '{creative_id,channel,country}', '{day,week}', 'percent', '[]'),
('creative_ipm', 1, NULL, 'Creative IPM', 'Per-creative installs per mille',
 '{"table":"creative_metrics_daily","timeCol":"date","valueExpr":"sum(installs) / nullIf(sum(impressions), 0) * 1000"}',
 '{creative_id,channel,country}', '{day,week}', 'ratio', '[]'),
('creative_spend', 1, NULL, 'Creative Spend', 'Per-creative spend (USD)',
 '{"table":"creative_metrics_daily","timeCol":"date","valueExpr":"sum(spend_usd)"}',
 '{creative_id,channel,country}', '{day,week}', 'currency', '[]'),
('trial_starts', 1, NULL, 'Trial Starts', 'Subscription trials started',
 '{"table":"revenue_events","timeCol":"event_time","valueExpr":"countIf(kind = ''trial_start'')"}',
 '{country,store}', '{day,week,month}', 'number', '[]'),
('trial_to_paid', 1, NULL, 'Trial → Paid', 'Trial-to-paid conversion ratio (period-level)',
 '{"table":"revenue_events","timeCol":"event_time","valueExpr":"countIf(kind = ''trial_convert'') / nullIf(countIf(kind = ''trial_start''), 0)"}',
 '{country,store}', '{day,week,month}', 'percent',
 '["Period-level ratio, not a true cohort conversion rate"]'),
('refund_rate', 1, NULL, 'Refund Rate', 'Refunds as share of payments',
 '{"table":"revenue_events","timeCol":"event_time","valueExpr":"countIf(kind = ''refund'') / nullIf(countIf(kind IN (''renewal'',''trial_convert'',''iap'')), 0)"}',
 '{country,store}', '{day,week,month}', 'percent', '[]'),
('dau', 1, NULL, 'DAU', 'Daily active users (session_start uniques)',
 '{"table":"events","timeCol":"event_time","valueExpr":"uniqExact(user_id)","defaultWhere":"event_name = ''session_start''"}',
 '{country,platform,source_install}', '{day,week,month}', 'number', '[]');

-- ── Playbooks ────────────────────────────────────────────────────────────────

INSERT INTO playbooks (key, version, definition, status) VALUES
('roas_drop', 1, '{
  "title": "ROAS drop investigation",
  "roster": ["tracking", "intelligence", "creative", "growth_director", "operations"],
  "phases": ["triage","health_gate","investigation","debate","synthesis","action_prep","review"],
  "budgets": {"maxToolCallsPerAgent": 12, "maxDebateRounds": 3, "maxCostUsd": 10, "maxWallClockSec": 900},
  "mandatoryPrimitives": ["decompose_metric_change", "correlate_events", "fatigue_check"],
  "allowedActionKinds": ["budget_change", "pause_entity", "creative_rotation"]
}', 'active'),
('creative_fatigue', 1, '{
  "title": "Creative fatigue response",
  "roster": ["tracking", "creative", "intelligence", "growth_director", "operations"],
  "phases": ["triage","health_gate","investigation","debate","synthesis","action_prep","review"],
  "budgets": {"maxToolCallsPerAgent": 10, "maxDebateRounds": 2, "maxCostUsd": 8, "maxWallClockSec": 900},
  "mandatoryPrimitives": ["fatigue_check"],
  "allowedActionKinds": ["creative_rotation", "budget_change"]
}', 'active'),
('tracking_break', 1, '{
  "title": "Tracking / data quality incident",
  "roster": ["tracking", "growth_director"],
  "phases": ["triage","investigation","synthesis","review"],
  "budgets": {"maxToolCallsPerAgent": 10, "maxDebateRounds": 1, "maxCostUsd": 5, "maxWallClockSec": 600},
  "mandatoryPrimitives": ["reconciliation_drilldown"],
  "allowedActionKinds": []
}', 'active'),
('cpi_spike', 1, '{
  "title": "CPI spike investigation",
  "roster": ["tracking", "intelligence", "creative", "growth_director", "operations"],
  "phases": ["triage","health_gate","investigation","debate","synthesis","action_prep","review"],
  "budgets": {"maxToolCallsPerAgent": 12, "maxDebateRounds": 3, "maxCostUsd": 10, "maxWallClockSec": 900},
  "mandatoryPrimitives": ["decompose_metric_change", "correlate_events"],
  "allowedActionKinds": ["budget_change", "pause_entity", "creative_rotation"]
}', 'active');
