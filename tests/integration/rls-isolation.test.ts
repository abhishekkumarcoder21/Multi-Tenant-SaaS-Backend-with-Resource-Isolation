import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  createTestTenant,
  cleanupTestData,
  createAdminPool,
  createAppPool,
} from '../helpers.js';

/**
 * RLS ISOLATION TEST SUITE
 *
 * This is the most critical test file in the project.
 * It verifies that PostgreSQL Row-Level Security actually prevents
 * cross-tenant data leaks — even when queries are buggy or malicious.
 *
 * Test structure:
 * 1. Create two tenants (A and B) with data
 * 2. Query as tenant A → should only see A's data
 * 3. Query as tenant B → should only see B's data
 * 4. Query WITHOUT tenant context → should fail (not leak data)
 * 5. INSERT with wrong tenant_id → should be blocked by WITH CHECK
 */
describe('RLS Isolation', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let tenantA: { id: string; name: string; slug: string };
  let tenantB: { id: string; name: string; slug: string };

  beforeAll(async () => {
    adminPool = createAdminPool();
    appPool = createAppPool();
  });

  afterAll(async () => {
    await cleanupTestData(adminPool);
    await adminPool.end();
    await appPool.end();
  });

  beforeEach(async () => {
    await cleanupTestData(adminPool);

    // Create two test tenants
    const resultA = await createTestTenant(adminPool, {
      name: 'Tenant A',
      slug: 'tenant-a',
    });
    const resultB = await createTestTenant(adminPool, {
      name: 'Tenant B',
      slug: 'tenant-b',
    });
    tenantA = resultA.tenant;
    tenantB = resultB.tenant;

    // Insert test data using admin pool (bypasses RLS)
    await adminPool.query(
      `INSERT INTO projects (tenant_id, name, description) VALUES
       ($1, 'Project Alpha', 'Tenant A project 1'),
       ($1, 'Project Beta', 'Tenant A project 2'),
       ($2, 'Project Gamma', 'Tenant B project 1'),
       ($2, 'Project Delta', 'Tenant B project 2'),
       ($2, 'Project Epsilon', 'Tenant B project 3')`,
      [tenantA.id, tenantB.id],
    );
  });

  // ─────────────────────────────────────────────────────
  // POSITIVE TESTS: Verify correct isolation
  // ─────────────────────────────────────────────────────

  it('tenant A can only see their own projects', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      const { rows } = await client.query('SELECT name FROM projects ORDER BY name');

      await client.query('COMMIT');

      // Should see exactly 2 projects (A's), not 5 (all)
      expect(rows).toHaveLength(2);
      expect(rows.map((r: { name: string }) => r.name).sort()).toEqual([
        'Project Alpha',
        'Project Beta',
      ]);
    } finally {
      client.release();
    }
  });

  it('tenant B can only see their own projects', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantB.id],
      );

      const { rows } = await client.query('SELECT name FROM projects ORDER BY name');

      await client.query('COMMIT');

      // Should see exactly 3 projects (B's), not 5 (all)
      expect(rows).toHaveLength(3);
      expect(rows.map((r: { name: string }) => r.name).sort()).toEqual([
        'Project Delta',
        'Project Epsilon',
        'Project Gamma',
      ]);
    } finally {
      client.release();
    }
  });

  it('a query without WHERE tenant_id still returns only the correct tenant\'s data', async () => {
    // This tests the KEY property of RLS: even if a developer writes
    // SELECT * FROM projects (no WHERE clause), RLS automatically filters.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      // Deliberately omitting WHERE tenant_id = ? — RLS should catch this
      const { rows } = await client.query('SELECT * FROM projects');

      await client.query('COMMIT');

      // RLS ensures only tenant A's projects are returned
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.tenant_id).toBe(tenantA.id);
      }
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────
  // NEGATIVE TESTS: Verify that bypasses are blocked
  // ─────────────────────────────────────────────────────

  it('query WITHOUT setting tenant context fails closed (error, not empty results)', async () => {
    // If app.tenant_id is never set, current_setting() should throw an error.
    // This is "fail closed" — rather than returning empty results or all results,
    // the query itself fails, which is the safest behavior.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      // Do NOT set app.tenant_id — simulate a bug where tenant context is missing
      await expect(
        client.query('SELECT * FROM projects'),
      ).rejects.toThrow();

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('INSERT with a different tenant_id is blocked by WITH CHECK', async () => {
    // Set context as tenant A, but try to insert a row with tenant B's ID.
    // The WITH CHECK policy should block this.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      // Attempt to insert a project with tenant B's ID while authenticated as tenant A
      await expect(
        client.query(
          `INSERT INTO projects (tenant_id, name) VALUES ($1, 'Sneaky Project')`,
          [tenantB.id],
        ),
      ).rejects.toThrow(/row-level security/i);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('UPDATE cannot modify another tenant\'s data', async () => {
    const client = await appPool.connect();
    try {
      // Get a project ID belonging to tenant B (using admin pool)
      const { rows: bProjects } = await adminPool.query(
        `SELECT id FROM projects WHERE tenant_id = $1 LIMIT 1`,
        [tenantB.id],
      );
      const tenantBProjectId = bProjects[0].id;

      // Now authenticate as tenant A and try to update tenant B's project
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      const { rowCount } = await client.query(
        `UPDATE projects SET name = 'Hacked' WHERE id = $1`,
        [tenantBProjectId],
      );

      await client.query('COMMIT');

      // The update should affect 0 rows (RLS hides tenant B's rows from tenant A)
      expect(rowCount).toBe(0);

      // Verify the project is unchanged (using admin pool)
      const { rows: unchanged } = await adminPool.query(
        `SELECT name FROM projects WHERE id = $1`,
        [tenantBProjectId],
      );
      expect(unchanged[0].name).not.toBe('Hacked');
    } finally {
      client.release();
    }
  });

  it('DELETE cannot remove another tenant\'s data', async () => {
    const client = await appPool.connect();
    try {
      // Get a project ID belonging to tenant B
      const { rows: bProjects } = await adminPool.query(
        `SELECT id FROM projects WHERE tenant_id = $1 LIMIT 1`,
        [tenantB.id],
      );
      const tenantBProjectId = bProjects[0].id;

      // Authenticate as tenant A and try to delete tenant B's project
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      const { rowCount } = await client.query(
        `DELETE FROM projects WHERE id = $1`,
        [tenantBProjectId],
      );

      await client.query('COMMIT');

      // The delete should affect 0 rows
      expect(rowCount).toBe(0);

      // Verify the project still exists
      const { rows: stillExists } = await adminPool.query(
        `SELECT id FROM projects WHERE id = $1`,
        [tenantBProjectId],
      );
      expect(stillExists).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  it('COUNT(*) is tenant-scoped (no data leakage through aggregates)', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true)`,
        [tenantA.id],
      );

      // COUNT should only count tenant A's projects
      const { rows } = await client.query('SELECT COUNT(*)::int as count FROM projects');

      await client.query('COMMIT');

      expect(rows[0].count).toBe(2); // Not 5
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────
  // CONTEXT LEAKAGE TESTS: Verify pooled connections are safe
  // ─────────────────────────────────────────────────────

  it('tenant context does not leak across sequential transactions on the same pool', async () => {
    // Simulate: Tenant A's request finishes, then Tenant B's request starts
    // on a potentially reused connection from the pool.
    // Tenant B should NOT see Tenant A's data.

    // Transaction 1: Tenant A
    const client1 = await appPool.connect();
    await client1.query('BEGIN');
    await client1.query(
      `SELECT set_config('app.tenant_id', $1, true)`,
      [tenantA.id],
    );
    const { rows: aRows } = await client1.query('SELECT COUNT(*)::int as count FROM projects');
    expect(aRows[0].count).toBe(2);
    await client1.query('COMMIT');
    client1.release();

    // Transaction 2: Tenant B (might get the same connection from the pool)
    const client2 = await appPool.connect();
    await client2.query('BEGIN');
    await client2.query(
      `SELECT set_config('app.tenant_id', $1, true)`,
      [tenantB.id],
    );
    const { rows: bRows } = await client2.query('SELECT COUNT(*)::int as count FROM projects');
    expect(bRows[0].count).toBe(3); // Should be B's count, not A's
    await client2.query('COMMIT');
    client2.release();
  });
});
