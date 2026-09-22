import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';

/**
 * Test helper utilities.
 * Provides functions for creating test tenants and cleaning up test data.
 */

const ADMIN_URL = 'postgresql://postgres:postgres@localhost:5432/saas_mt';

/**
 * Create a test tenant and return the tenant data + raw API key.
 */
export async function createTestTenant(
  pool: pg.Pool,
  overrides: Partial<{
    name: string;
    slug: string;
    tier: string;
    status: string;
  }> = {},
): Promise<{
  tenant: {
    id: string;
    name: string;
    slug: string;
    tier: string;
    status: string;
  };
  apiKey: string;
}> {
  const slug = overrides.slug ?? `test-${randomBytes(8).toString('hex')}`;
  const rawApiKey = `mt_test_${randomBytes(32).toString('hex')}`;
  const apiKeyHash = createHash('sha256').update(rawApiKey).digest('hex');

  const { rows } = await pool.query(
    `INSERT INTO tenants (name, slug, tier, status, api_key_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, slug, tier, status`,
    [
      overrides.name ?? `Test Tenant ${slug}`,
      slug,
      overrides.tier ?? 'free',
      overrides.status ?? 'active',
      apiKeyHash,
    ],
  );

  return {
    tenant: rows[0],
    apiKey: rawApiKey,
  };
}

/**
 * Clean up all test data.
 * Deletes all tenants (cascading to all tenant-owned tables).
 */
export async function cleanupTestData(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM usage_records');
  await pool.query('DELETE FROM projects');
  await pool.query('DELETE FROM tenants');
}

/**
 * Create an admin pool for tests.
 */
export function createAdminPool(): pg.Pool {
  return new pg.Pool({
    connectionString: ADMIN_URL,
    max: 5,
  });
}

/**
 * Create an app_user pool for tests (RLS enforced).
 */
export function createAppPool(): pg.Pool {
  return new pg.Pool({
    connectionString: 'postgresql://app_user:app_password@localhost:5432/saas_mt',
    max: 5,
  });
}
