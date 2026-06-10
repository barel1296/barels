-- 007: the worker plane schedules per-tenant jobs (detection, triage,
-- maintenance) and therefore needs to enumerate active tenants. Worker
-- connections are marked app.role='worker' (trusted process boundary; the
-- API never sets it).
CREATE POLICY tenant_worker_read ON tenants FOR SELECT USING (app_is_worker());

-- The sync scheduler enumerates healthy integrations across tenants (it sets
-- the tenant context before doing any per-integration work).
CREATE POLICY integrations_worker_read ON integrations FOR SELECT USING (app_is_worker());
