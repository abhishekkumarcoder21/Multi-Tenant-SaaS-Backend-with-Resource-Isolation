import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import Redis from 'ioredis';
import { buildServer } from '../../src/server.js';
import { createAdminPool, createTestTenant, cleanupTestData } from '../helpers.js';
import { getUsageTracker } from '../../src/metering/usage-tracker.js';
import { flushTenantUsage } from '../../src/metering/aggregator.js';

describe('Usage Metering & Billing Concurrency', () => {
  let server: FastifyInstance;
  let adminPool: pg.Pool;
  let redis: Redis;

  beforeAll(async () => {
    adminPool = createAdminPool();
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await cleanupTestData(adminPool);
    await adminPool.end();
    await server.close();
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupTestData(adminPool);
  });

  it('accurately meters 50 concurrent requests with zero lost updates', async () => {
    // High tier tenant so rate limiting doesn't block any requests
    const { tenant, apiKey } = await createTestTenant(adminPool, { tier: 'enterprise' });
    const tracker = getUsageTracker();

    // Fire 50 concurrent HTTP requests simultaneously
    const CONCURRENT_REQUESTS = 50;
    const requestPromises = Array.from({ length: CONCURRENT_REQUESTS }, () =>
      server.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );

    const responses = await Promise.all(requestPromises);

    // Verify all 50 succeeded
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    // Check live Redis counter — must equal EXACTLY 50
    const liveUsage = await tracker.getCurrentUsage(tenant.id);
    expect(liveUsage.apiCalls).toBe(CONCURRENT_REQUESTS);
    expect(liveUsage.computeMs).toBeGreaterThan(0);
  });

  it('retrieves live usage via the GET /tenants/:id/usage endpoint', async () => {
    const { tenant, apiKey } = await createTestTenant(adminPool, { tier: 'enterprise' });

    // Send 3 requests
    await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const usageRes = await server.inject({
      method: 'GET',
      url: `/tenants/${tenant.id}/usage`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(usageRes.statusCode).toBe(200);
    const body = usageRes.json();
    expect(body.tenant_id).toBe(tenant.id);
    // At least 3 calls (plus the usage request itself if metered)
    expect(body.live_api_calls).toBeGreaterThanOrEqual(3);
    expect(body.total_compute_ms).toBeGreaterThan(0);
  });

  it('flushes Redis usage into PostgreSQL idempotently and resets Redis', async () => {
    const { tenant } = await createTestTenant(adminPool);
    const tracker = getUsageTracker();
    const todayStr = new Date().toISOString().split('T')[0];

    // Seed Redis directly with 25 calls and 150ms compute
    await tracker.recordUsage(tenant.id, 25, 150);

    // Flush to PostgreSQL
    const flushed = await flushTenantUsage(tenant.id, todayStr);
    expect(flushed).toBe(true);

    // Verify Redis counter was cleanly reset
    const liveAfterFlush = await tracker.getCurrentUsage(tenant.id);
    expect(liveAfterFlush.apiCalls).toBe(0);

    // Verify PostgreSQL has the recorded values
    const { rows } = await adminPool.query(
      `SELECT api_calls, compute_ms FROM usage_records WHERE tenant_id = $1 AND recorded_date = $2`,
      [tenant.id, todayStr],
    );
    expect(rows).toHaveLength(1);
    expect(parseInt(rows[0].api_calls, 10)).toBe(25);
    expect(parseFloat(rows[0].compute_ms)).toBeCloseTo(150, 1);

    // Seed another 10 calls in Redis and flush again (tests additive upsert)
    await tracker.recordUsage(tenant.id, 10, 50);
    await flushTenantUsage(tenant.id, todayStr);

    const { rows: rowsAfterSecondFlush } = await adminPool.query(
      `SELECT api_calls, compute_ms FROM usage_records WHERE tenant_id = $1 AND recorded_date = $2`,
      [tenant.id, todayStr],
    );
    expect(parseInt(rowsAfterSecondFlush[0].api_calls, 10)).toBe(35); // 25 + 10 = 35!
    expect(parseFloat(rowsAfterSecondFlush[0].compute_ms)).toBeCloseTo(200, 1);
  });
});
