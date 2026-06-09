-- ClickHouse analytics schema (docs/07 §7.2). Applied by
-- `python -m gros_workers.chmigrate`. Every table is keyed by tenant_id first.

CREATE TABLE IF NOT EXISTS raw_events (
  tenant_id    UUID,
  source       LowCardinality(String),
  entity_kind  LowCardinality(String),
  external_id  String,
  payload      String,
  payload_hash UInt64,
  ingested_at  DateTime64(3),
  sync_run_id  String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (tenant_id, source, entity_kind, ingested_at)
TTL toDateTime(ingested_at) + INTERVAL 13 MONTH;

CREATE TABLE IF NOT EXISTS events (
  tenant_id       UUID,
  app_id          UUID,
  event_name      LowCardinality(String),
  event_time      DateTime64(3),
  user_id         String,
  platform        LowCardinality(String),
  country         LowCardinality(String),
  app_version     LowCardinality(String),
  source_install  LowCardinality(String),
  campaign_id     UUID,
  revenue_usd     Decimal(14, 4) DEFAULT 0,
  properties      Map(String, String),
  source          LowCardinality(String),
  inserted_at     DateTime DEFAULT now()
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, app_id, event_name, event_time, user_id);

CREATE TABLE IF NOT EXISTS attribution (
  tenant_id         UUID,
  app_id            UUID,
  install_time      DateTime64(3),
  user_id           String,
  media_source      LowCardinality(String),
  channel           LowCardinality(String),
  campaign_id       UUID,
  campaign_external String,
  country           LowCardinality(String),
  platform          LowCardinality(String),
  attribution_type  LowCardinality(String),
  cost_usd          Decimal(14, 4) DEFAULT 0,
  source            LowCardinality(String)
) ENGINE = ReplacingMergeTree(install_time)
PARTITION BY toYYYYMM(install_time)
ORDER BY (tenant_id, app_id, user_id, install_time);

CREATE TABLE IF NOT EXISTS skan_postbacks (
  tenant_id         UUID,
  app_id            UUID,
  postback_time     DateTime,
  network           LowCardinality(String),
  campaign_external String,
  conversion_value  Nullable(UInt8),
  coarse_value      LowCardinality(Nullable(String)),
  did_win           Bool,
  postback_index    UInt8,
  cv_schema_version LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(postback_time)
ORDER BY (tenant_id, app_id, network, postback_time);

CREATE TABLE IF NOT EXISTS spend_metrics_daily (
  tenant_id   UUID,
  channel     LowCardinality(String),
  campaign_id UUID,
  ad_group_id UUID,
  ad_id       UUID,
  creative_id UUID,
  country     LowCardinality(String),
  platform    LowCardinality(String),
  date        Date,
  impressions UInt64,
  clicks      UInt64,
  installs    UInt64,
  spend_usd   Decimal(14, 4),
  restated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(restated_at)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, channel, campaign_id, ad_group_id, ad_id, creative_id, country, platform, date);

CREATE TABLE IF NOT EXISTS revenue_events (
  tenant_id        UUID,
  app_id           UUID,
  event_time       DateTime64(3),
  user_id          String,
  kind             LowCardinality(String),
  product_id       String,
  revenue_usd      Decimal(14, 4),
  proceeds_usd     Decimal(14, 4),
  is_first_payment Bool,
  country          LowCardinality(String),
  store            LowCardinality(String),
  source           LowCardinality(String)
) ENGINE = ReplacingMergeTree(event_time)
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, app_id, user_id, event_time, kind, product_id);

CREATE TABLE IF NOT EXISTS cohort_metrics (
  tenant_id    UUID,
  app_id       UUID,
  cohort_date  Date,
  media_source LowCardinality(String),
  campaign_id  UUID,
  country      LowCardinality(String),
  platform     LowCardinality(String),
  day_n        UInt16,
  cohort_size  UInt64,
  retained     UInt64,
  payers       UInt64,
  revenue_usd  Decimal(14, 4),
  spend_usd    Decimal(14, 4),
  computed_at  DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(cohort_date)
ORDER BY (tenant_id, app_id, cohort_date, media_source, campaign_id, country, platform, day_n);

CREATE TABLE IF NOT EXISTS creative_metrics_daily (
  tenant_id   UUID,
  creative_id UUID,
  channel     LowCardinality(String),
  country     LowCardinality(String),
  date        Date,
  impressions UInt64,
  clicks      UInt64,
  installs    UInt64,
  spend_usd   Decimal(14, 4),
  spend_share Float32,
  days_live   UInt16,
  computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, creative_id, channel, country, date);
