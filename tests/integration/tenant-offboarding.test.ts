import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import Redis from 'ioredis';
import { createAdminPool, createTestTenant, cleanupTestData } from '../helpers.js';
import { getTenantCache } from '../../src/cache/tenant-cache.js';
import { getUsageTracker } from '../../src/metering/usage-tracker.js';
import { getRateLimiter } from '../../src/plugins/rate-limiter.js';
import { offboardTenant } from '../../src/services/tenant-offboarding.js';

describe('Tenant Offboarding & Zero-Orphan Purge', () => {
  let adminPool: pg.Pool;
  let redis: Redis;

  beforeAll(async () => {
    adminPool = createAdminPool();
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  });

  afterAll(async () => {
    await cleanupTestData(adminPool);
    await adminPool.end();
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupTestData(adminPool);
  });

  it('completely purges all PostgreSQL rows and Redis keys without leaving orphans', async () => {
    // 1. Create tenant
    const { tenant } = await createTestTenant(adminPool);
    const tenantId = tenant.id;

    // 2. Insert PostgreSQL projects
    await adminPool.query(
      `INSERT INTO projects (tenant_id, name, description)
       VALUES ($1, 'P1', 'Desc 1'), ($1, 'P2', 'Desc 2')`,
      [tenantId],
    );

    // 3. Insert PostgreSQL usage record
    const todayStr = new Date().toISOString().split('T')[0];
    await adminPool.query(
      `INSERT INTO usage_records (tenant_id, recorded_date, api_calls, compute_ms)
       VALUES ($1, $2, 100, 500)`,
      [tenantId, todayStr],
    );

    // 4. Create Redis cache keys
    const cache = getTenantCache();
    await cache.set(tenantId, 'project', 'p1', { id: 'p1', name: 'P1' });
    await cache.set(tenantId, 'settings', 'config', { foo: 'bar' });

    // 5. Create Redis rate limit keys
    const limiter = getRateLimiter();
    await limiter.consume(tenantId, 'free');

    // 6. Create Redis usage counters
    const tracker = getUsageTracker();
    await tracker.recordUsage(tenantId, 10, 55.5);

    // Verify resources exist before offboarding
    const { rows: preProjects } = await adminPool.query(
      'SELECT id FROM projects WHERE tenant_id = $1',
      [tenantId],
    );
    expect(preProjects).toHaveLength(2);

    // ── Execute Offboarding ──
    const result = await offboardTenant(tenantId, adminPool, redis);

    expect(result.tenantId).toBe(tenantId);
    expect(result.databaseRowsDeleted.projects).toBe(2);
    expect(result.databaseRowsDeleted.usageRecords).toBe(1);
    expect(result.databaseRowsDeleted.tenant).toBe(1);
    expect(result.redisKeysDeleted.cacheKeys).toBeGreaterThanOrEqual(2);
    expect(result.redisKeysDeleted.rateLimitKeys).toBeGreaterThanOrEqual(1);
    expect(result.redisKeysDeleted.usageKeys).toBeGreaterThanOrEqual(1);

    // ── Verify Zero Orphaned PostgreSQL Records ──
    const { rows: postProjects } = await adminPool.query(
      'SELECT id FROM projects WHERE tenant_id = $1',
      [tenantId],
    );
    expect(postProjects).toHaveLength(0);

    const { rows: postUsage } = await adminPool.query(
      'SELECT id FROM usage_records WHERE tenant_id = $1',
      [tenantId],
    );
    expect(postUsage).toHaveLength(0);

    const { rows: postTenant } = await adminPool.query(
      'SELECT id FROM tenants WHERE id = $1',
      [tenantId],
    );
    expect(postTenant).toHaveLength(0);

    // ── Verify Zero Orphaned Redis Keys ──
    const checkKeys = async (pattern: string) => {
      const stream = redis.scanStream({ match: pattern, count: 100 });
      let count = 0;
      for await (const batch of stream) {
        count += batch.length;
      }
      return count;
    };

    expect(await checkKeys(`cache:${tenantId}:*`)).toBe(0);
    expect(await checkKeys(`rl:${tenantId}:*`)).toBe(0);
    expect(await checkKeys(`usage:${tenantId}:*`)).toBe(0);
  });
});
