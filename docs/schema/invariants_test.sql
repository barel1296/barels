-- =============================================================================
-- Schema invariant tests (docs/05 §4). Run against a FRESH database after
-- applying schema.sql:
--   psql -d <fresh_db> -f schema.sql && psql -d <fresh_db> -f invariants_test.sql
-- Each "must FAIL" case is expected to print an ERROR; each "must SUCCEED" case
-- must print nothing. CI wraps this file and asserts the expected outcomes.
-- =============================================================================
\set ON_ERROR_STOP 0
-- fixtures (as owner)
INSERT INTO core.workspaces (id, slug, name) VALUES
  ('00000000-0000-0000-0000-00000000000a','ws-a','A'), ('00000000-0000-0000-0000-00000000000b','ws-b','B');
INSERT INTO identity.influencers (id, workspace_id, slug, display_name, ai_disclosure_short, ai_disclosure_long, timezone, primary_language)
VALUES ('10000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','luna','Luna','AI-generated virtual creator','I am an AI character.','Europe/Berlin','en'),
       ('10000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-00000000000b','nova','Nova','AI-generated virtual creator','I am an AI character.','UTC','en');
INSERT INTO crm.fans (id, workspace_id) VALUES ('20000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a');
INSERT INTO core.integration_accounts (id, workspace_id, influencer_id, provider, external_account_id, credential_ciphertext, credential_nonce, data_key_ciphertext, wrapping_key_id)
VALUES ('30000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','telegram_bot','123','\x00','\x00','\x00','k');

\echo '--- T1 channel: mature rating without adult gate must FAIL'
INSERT INTO publishing.channels (workspace_id, influencer_id, integration_account_id, kind, external_id, max_rating, audience_gate)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','30000000-0000-0000-0000-00000000000a','telegram_premium_channel','-100','mature','none');

\echo '--- T2 channel: suggestive, no gate must SUCCEED'
INSERT INTO publishing.channels (id, workspace_id, influencer_id, integration_account_id, kind, external_id, max_rating)
VALUES ('40000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','30000000-0000-0000-0000-00000000000a','telegram_premium_channel','-100','suggestive');

\echo '--- T3 entitlement overlap from same source must FAIL on 2nd insert'
INSERT INTO monetization.entitlements (workspace_id, influencer_id, fan_id, kind, resource_type, resource_id, source_type, source_id, valid_from, valid_until, granted_by_type, granted_by_id)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','20000000-0000-0000-0000-00000000000a','premium_channel_access','channel','40000000-0000-0000-0000-00000000000a','subscription','50000000-0000-0000-0000-00000000000a','2026-10-01','2026-10-31','system','test');
INSERT INTO monetization.entitlements (workspace_id, influencer_id, fan_id, kind, resource_type, resource_id, source_type, source_id, valid_from, valid_until, granted_by_type, granted_by_id)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','20000000-0000-0000-0000-00000000000a','premium_channel_access','channel','40000000-0000-0000-0000-00000000000a','subscription','50000000-0000-0000-0000-00000000000a','2026-10-15','2026-11-15','system','test');

\echo '--- T4 sensitive memory must FAIL'
INSERT INTO crm.consents (id, workspace_id, fan_id, influencer_id, purpose, status, method, evidence, granted_at)
VALUES ('60000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','20000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','memory_personalization','granted','bot_button','{}', now());
INSERT INTO conversation.fan_memories (workspace_id, influencer_id, fan_id, category, statement, sensitivity, consent_id, confidence, created_by_type, created_by_id)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','20000000-0000-0000-0000-00000000000a','personal_detail','x','sensitive','60000000-0000-0000-0000-00000000000a',0.9,'agent','r');

\echo '--- T5 publication scheduled without authorization hash must FAIL'
INSERT INTO content.content_items (id, workspace_id, influencer_id, format, created_by_type, created_by_id)
VALUES ('70000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','tg_post','user','u');
INSERT INTO content.content_revisions (id, workspace_id, content_item_id, revision, disclosure_text, content_hash, created_by_type, created_by_id)
VALUES ('80000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-00000000000a','70000000-0000-0000-0000-00000000000a',1,'#AIgenerated','\x01','user','u');
INSERT INTO publishing.publications (workspace_id, influencer_id, content_item_id, revision_id, channel_id, scheduled_for, status)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a','70000000-0000-0000-0000-00000000000a','80000000-0000-0000-0000-00000000000a','40000000-0000-0000-0000-00000000000a', now(), 'scheduled');

\echo '--- T6 second active persona must FAIL'
INSERT INTO core.users (id, email, display_name, idp_issuer, idp_subject) VALUES ('90000000-0000-0000-0000-00000000000a','a@x.io','A','idp','s1');
INSERT INTO identity.persona_versions (workspace_id, influencer_id, version, status, personality, writing_style, biography, visual_identity, conversation_rules, approved_by)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a',1,'active','{}','{}','{}','{}','{}','90000000-0000-0000-0000-00000000000a');
INSERT INTO identity.persona_versions (workspace_id, influencer_id, version, status, personality, writing_style, biography, visual_identity, conversation_rules, approved_by)
VALUES ('00000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a',2,'active','{}','{}','{}','{}','{}','90000000-0000-0000-0000-00000000000a');

\echo '--- T7 RLS: app role scoped to ws-a sees 1 influencer, cannot insert into ws-b'
DO $$ BEGIN CREATE ROLE app_rw NOBYPASSRLS LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA core, identity, content, publishing, conversation, crm, monetization, analytics, agents, approvals TO app_rw;
GRANT SELECT, INSERT ON identity.influencers TO app_rw;
SET ROLE app_rw;
BEGIN; SET LOCAL app.workspace_id = '00000000-0000-0000-0000-00000000000a';
SELECT 'visible_influencers=' || count(*) FROM identity.influencers;
INSERT INTO identity.influencers (workspace_id, slug, display_name, ai_disclosure_short, ai_disclosure_long, timezone, primary_language)
VALUES ('00000000-0000-0000-0000-00000000000b','evil','E','AI','AI','UTC','en');
ROLLBACK;
RESET ROLE;

INSERT INTO inference.licenses (id, key, name, url, weights_commercial, outputs_commercial, reviewed_by, reviewed_at, evidence_ref) VALUES
 ('a0000000-0000-0000-0000-000000000001','apache-2.0','Apache 2.0','https://www.apache.org/licenses/LICENSE-2.0',true,true,'90000000-0000-0000-0000-00000000000a',now(),'docs/15'),
 ('a0000000-0000-0000-0000-000000000002','example-noncommercial','Example NC','https://example.invalid',false,true,'90000000-0000-0000-0000-00000000000a',now(),'docs/15'),
 ('a0000000-0000-0000-0000-000000000003','unreviewed','Unreviewed','https://example.invalid',true,true,NULL,NULL,'docs/15');
\echo '--- T8 approve model under non-commercial license must FAIL'
INSERT INTO inference.models (key, kind, name, source_uri, revision, file_sha256, engine, license_id, status, approved_by)
VALUES ('image.base.nc','image_base','nc','x','r','{h}','comfyui','a0000000-0000-0000-0000-000000000002','approved','90000000-0000-0000-0000-00000000000a');
\echo '--- T9 approve model under unreviewed license must FAIL'
INSERT INTO inference.models (key, kind, name, source_uri, revision, file_sha256, engine, license_id, status, approved_by)
VALUES ('image.base.unrev','image_base','u','x','r','{h}','comfyui','a0000000-0000-0000-0000-000000000003','approved','90000000-0000-0000-0000-00000000000a');
\echo '--- T10 approve model under reviewed commercial license must SUCCEED'
INSERT INTO inference.models (id, key, kind, name, source_uri, revision, file_sha256, engine, license_id, status, approved_by)
VALUES ('b0000000-0000-0000-0000-000000000001','chat.primary','llm','m','x','r','{h}','llm_engine','a0000000-0000-0000-0000-000000000001','approved','90000000-0000-0000-0000-00000000000a');
\echo '--- T11 activate GPU mode with unmeasured parameters must FAIL'
INSERT INTO inference.gpu_nodes (id, name, gpu_name, vram_total_mb, capabilities) VALUES ('c0000000-0000-0000-0000-000000000001','ws-01','RTX 5090 Laptop',24576,'{N,B,H,A,T}');
INSERT INTO inference.gpu_modes (node_id, name, version, chat_model_id, allowed_classes, status, approved_by)
VALUES ('c0000000-0000-0000-0000-000000000001','S',1,'b0000000-0000-0000-0000-000000000001','{I,N,B,A}','active','90000000-0000-0000-0000-00000000000a');
\echo '--- T12 approve workflow without measured VRAM must FAIL'
INSERT INTO inference.workflows (key, version, kind, graph, param_bindings, required_model_ids, custom_nodes_lock, allowed_modes, status, approved_by)
VALUES ('img.portrait',1,'image_gen','{}','{}','{}','lock','{S}','approved','90000000-0000-0000-0000-00000000000a');
\echo '--- T13 duplicate GPU job idempotency key must FAIL on 2nd insert'
INSERT INTO inference.gpu_jobs (job_class, kind, est_vram_mb, est_gpu_seconds, idempotency_key, input, requested_by_type, requested_by_id)
VALUES ('B','image_gen',9000,30,'gen:item1:cand1','{}','system','t');
INSERT INTO inference.gpu_jobs (job_class, kind, est_vram_mb, est_gpu_seconds, idempotency_key, input, requested_by_type, requested_by_id)
VALUES ('B','image_gen',9000,30,'gen:item1:cand1','{}','system','t');
\echo '--- T14 allowance consume is atomic and bounded (expect 1 row then 0 rows)'

-- (workspace, influencer and fan fixtures reused from T1–T7)
INSERT INTO monetization.daily_allowances (workspace_id, fan_id, influencer_id, day, used, daily_limit)
VALUES ('00000000-0000-0000-0000-00000000000a','20000000-0000-0000-0000-00000000000a','10000000-0000-0000-0000-00000000000a', current_date, 0, 1);
UPDATE monetization.daily_allowances SET used = used + 1 WHERE fan_id='20000000-0000-0000-0000-00000000000a' AND day=current_date AND used < daily_limit RETURNING 'consumed used=' || used;
UPDATE monetization.daily_allowances SET used = used + 1 WHERE fan_id='20000000-0000-0000-0000-00000000000a' AND day=current_date AND used < daily_limit RETURNING 'consumed used=' || used;
