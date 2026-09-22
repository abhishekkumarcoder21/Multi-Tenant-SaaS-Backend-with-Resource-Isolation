-- Migration 001: Create tenants table
-- This table stores tenant metadata and is NOT subject to RLS
-- (it needs to be queried during authentication before tenant context is set)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  tier          VARCHAR(20)  NOT NULL DEFAULT 'free'
                CHECK (tier IN ('free', 'pro', 'enterprise')),
  status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'deleted')),
  -- API key hash (SHA-256). The raw key is shown once at creation and never stored.
  api_key_hash  VARCHAR(64)  NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Index for API key lookup during authentication (hot path)
CREATE INDEX IF NOT EXISTS idx_tenants_api_key_hash ON tenants (api_key_hash);

-- Grant access to app_user for authentication lookups
GRANT SELECT ON tenants TO app_user;
