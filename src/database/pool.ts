import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

/**
 * Application database pool — connects as `app_user`.
 *
 * CRITICAL: This user does NOT have BYPASSRLS privilege.
 * All queries through this pool are subject to Row-Level Security policies.
 * This is the primary defense against cross-tenant data leaks.
 */
export const appPool = new Pool({
  connectionString: config.database.url,
  max: config.database.poolSize,
  // Idle timeout: release connections back to the pool after 30s of inactivity
  idleTimeoutMillis: 30_000,
  // Connection timeout: fail fast if we can't get a connection in 5s
  connectionTimeoutMillis: 5_000,
});

/**
 * Admin database pool — connects as superuser.
 *
 * WARNING: This pool bypasses RLS. Use ONLY for:
 * - Database migrations
 * - Tenant provisioning (creating rows in the tenants table)
 * - Admin operations that need cross-tenant visibility
 *
 * Never expose this pool to tenant-scoped request handlers.
 */
export const adminPool = new Pool({
  connectionString: config.database.adminUrl,
  max: 5, // Small pool — admin operations are infrequent
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Graceful shutdown — drain all connections.
 */
export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), adminPool.end()]);
}
