-- Migration 002: Create projects table (sample tenant-owned resource)
-- This table demonstrates RLS in action — every row belongs to exactly one tenant.

CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite index: tenant_id FIRST for RLS filter efficiency.
-- PostgreSQL can use this index to satisfy the RLS policy's WHERE tenant_id = ?
-- without a full table scan, even when the application query doesn't include it.
CREATE INDEX IF NOT EXISTS idx_projects_tenant_id ON projects (tenant_id, created_at DESC);

-- Grant CRUD to app_user (RLS will restrict which rows they can actually access)
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO app_user;
