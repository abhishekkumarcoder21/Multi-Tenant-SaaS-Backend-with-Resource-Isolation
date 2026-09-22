import type pg from 'pg';
import type { Redis } from 'ioredis';
import { adminPool } from '../database/pool.js';
import { getRedisClient } from '../redis/client.js';

export interface OffboardingResult {
  tenantId: string;
  databaseRowsDeleted: {
    projects: number;
    usageRecords: number;
    tenant: number;
  };
  redisKeysDeleted: {
    cacheKeys: number;
    rateLimitKeys: number;
    usageKeys: number;
  };
}

/**
 * Tenant Offboarding Service
 *
 * Ensures 100% complete resource purging when a tenant is offboarded.
 * Leaves ZERO orphaned records in PostgreSQL or Redis.
 *
 * Steps:
 * 1. Database: Delete all tenant-scoped rows (projects, usage_records) and tenant record.
 * 2. Redis: Delete all cache keys (`cache:{tenantId}:*`).
 * 3. Redis: Delete all rate limiter keys (`rl:{tenantId}:*`).
 * 4. Redis: Delete all usage counter keys (`usage:{tenantId}:*`).
 */
export async function offboardTenant(
  tenantId: string,
  pool: pg.Pool = adminPool,
  redis: Redis = getRedisClient(),
): Promise<OffboardingResult> {
  // ─── 1. PostgreSQL Purge ───
  // Because foreign keys have ON DELETE CASCADE, deleting from tenants cascades,
  // but we explicitly count and delete to return precise audit telemetry.
  const { rowCount: projectsDeleted } = await pool.query(
    'DELETE FROM projects WHERE tenant_id = $1',
    [tenantId],
  );

  const { rowCount: usageRecordsDeleted } = await pool.query(
    'DELETE FROM usage_records WHERE tenant_id = $1',
    [tenantId],
  );

  const { rowCount: tenantDeleted } = await pool.query(
    'DELETE FROM tenants WHERE id = $1',
    [tenantId],
  );

  // ─── 2. Redis Purge ───
  const scanAndDelete = async (pattern: string): Promise<number> => {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    let total = 0;
    for await (const batch of stream) {
      if (batch.length > 0) {
        const deleted = await redis.del(...batch);
        total += deleted;
      }
    }
    return total;
  };

  const cacheKeysDeleted = await scanAndDelete(`cache:${tenantId}:*`);
  const rateLimitKeysDeleted = await scanAndDelete(`rl:${tenantId}:*`);
  const usageKeysDeleted = await scanAndDelete(`usage:${tenantId}:*`);

  return {
    tenantId,
    databaseRowsDeleted: {
      projects: projectsDeleted ?? 0,
      usageRecords: usageRecordsDeleted ?? 0,
      tenant: tenantDeleted ?? 0,
    },
    redisKeysDeleted: {
      cacheKeys: cacheKeysDeleted,
      rateLimitKeys: rateLimitKeysDeleted,
      usageKeys: usageKeysDeleted,
    },
  };
}
