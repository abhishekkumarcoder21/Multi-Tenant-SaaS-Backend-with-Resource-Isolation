-- Migration 003: Enable Row-Level Security
--
-- DESIGN DECISIONS:
--
-- 1. ENABLE ROW LEVEL SECURITY: Activates RLS on the table.
--    Without this, all rows are visible regardless of policies.
--
-- 2. FORCE ROW LEVEL SECURITY: Ensures RLS applies even to the table owner.
--    Without FORCE, the table owner (typically the role that created it) bypasses RLS.
--    Since our admin role creates tables but app_user queries them, FORCE ensures
--    that even if app_user somehow became the table owner, RLS still applies.
--
-- 3. USING clause: Controls which rows can be read (SELECT), updated (UPDATE),
--    or deleted (DELETE). Only rows where tenant_id matches the session variable.
--
-- 4. WITH CHECK clause: Controls which rows can be inserted (INSERT) or
--    updated-to (UPDATE). Prevents a tenant from inserting data with a
--    different tenant's ID — even if they craft a malicious INSERT.
--
-- 5. current_setting('app.tenant_id'): Reads the transaction-local variable
--    set by our withTenantContext() wrapper. If this variable is NOT set,
--    current_setting() throws an error, which means queries without tenant
--    context FAIL CLOSED (denied) rather than FAIL OPEN (returning all data).
--
-- WHY RLS OVER SCHEMA-PER-TENANT:
-- See README.md Trade-offs section for the full discussion. In short:
-- - RLS scales to thousands of tenants without catalog bloat
-- - Single schema means simpler migrations, backups, and connection pooling
-- - Schema-per-tenant provides stronger isolation but at O(n) operational cost

-- ═══════════════════════════════════════════════════════════════
-- Projects table RLS
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Policy for SELECT, UPDATE, DELETE: only see/modify your own tenant's rows
CREATE POLICY tenant_isolation_select ON projects
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_insert ON projects
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_update ON projects
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_delete ON projects
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
