-- PostgreSQL initialization script
-- Run automatically when the container is first created
--
-- Creates the `app_user` role that the application uses.
-- This role does NOT have superuser or BYPASSRLS privileges,
-- so Row-Level Security policies are always enforced for app queries.

-- Create the application user (non-superuser, no RLS bypass)
CREATE ROLE app_user WITH LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Grant connect privilege on the database
GRANT CONNECT ON DATABASE saas_mt TO app_user;

-- Grant schema usage (tables will be granted after migration creates them)
GRANT USAGE ON SCHEMA public TO app_user;

-- Allow app_user to use sequences (for auto-generated IDs if any)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
