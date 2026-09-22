import pg from 'pg';
import { appPool } from './pool.js';

/**
 * Execute a callback within a tenant-scoped database transaction.
 *
 * This is the ONLY way tenant-scoped queries should run. It:
 * 1. Acquires a connection from the app pool (non-superuser, RLS enforced)
 * 2. Begins a transaction
 * 3. Sets `app.tenant_id` as a transaction-local variable via SET LOCAL
 * 4. Executes the callback (which can run multiple queries on the same connection)
 * 5. Commits on success, rolls back on error
 * 6. Releases the connection back to the pool
 *
 * WHY SET LOCAL (not SET):
 * - SET LOCAL scopes the variable to the current transaction only
 * - When the transaction ends (commit/rollback), the variable is automatically cleared
 * - This prevents tenant context from leaking to the next query on a pooled connection
 * - Even if the application crashes mid-transaction, the variable won't persist
 *
 * WHY this wrapper (not inline SET in each query):
 * - Centralizes the tenant context setting — impossible to forget
 * - The RLS policy reads `current_setting('app.tenant_id')` automatically
 * - Business logic queries don't need WHERE tenant_id = ? (RLS does it)
 * - But we STILL add WHERE tenant_id = ? in queries as defense-in-depth
 *
 * @param tenantId - UUID of the tenant
 * @param callback - Function receiving a connected pg.PoolClient
 * @returns The return value of the callback
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();

  try {
    await client.query('BEGIN');

    // SET LOCAL ensures the tenant_id is scoped to THIS transaction only.
    // The third parameter `true` in set_config means "local to transaction".
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true)`,
      [tenantId],
    );

    const result = await callback(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    // Connection is released back to the pool.
    // Because we used SET LOCAL, the tenant_id variable is already cleared
    // after COMMIT/ROLLBACK — no risk of leaking to the next request.
    client.release();
  }
}
