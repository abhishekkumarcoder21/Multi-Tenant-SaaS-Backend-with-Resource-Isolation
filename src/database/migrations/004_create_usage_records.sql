-- Migration 004: Create usage_records table
-- Stores aggregated usage data flushed from Redis by the BullMQ worker.
-- Each row represents one tenant's usage for one day.

CREATE TABLE IF NOT EXISTS usage_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recorded_date DATE NOT NULL,
  api_calls     BIGINT NOT NULL DEFAULT 0,
  compute_ms    DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One record per tenant per day — prevents duplicates during re-aggregation
  UNIQUE (tenant_id, recorded_date)
);

-- Index for querying a tenant's usage history
CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_date
  ON usage_records (tenant_id, recorded_date DESC);

-- RLS on usage_records so tenants can only see their own usage
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON usage_records
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_insert ON usage_records
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_update ON usage_records
  FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY tenant_isolation_delete ON usage_records
  FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Grant to app_user
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_records TO app_user;
