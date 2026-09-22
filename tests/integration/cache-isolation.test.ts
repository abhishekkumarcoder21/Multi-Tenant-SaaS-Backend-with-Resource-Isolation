import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import Redis from 'ioredis';
import { buildServer } from '../../src/server.js';
import { createAdminPool, createTestTenant, cleanupTestData } from '../helpers.js';
import { getTenantCache } from '../../src/cache/tenant-cache.js';

describe('Tenant Cache Isolation', () => {
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

  it('guarantees tenant A and tenant B have isolated cache namespaces', async () => {
    const cache = getTenantCache();
    const tenantA = 'tenant-cache-a';
    const tenantB = 'tenant-cache-b';

    await cache.set(tenantA, 'settings', 'theme', { color: 'dark' });
    await cache.set(tenantB, 'settings', 'theme', { color: 'light' });

    const valA = await cache.get<{ color: string }>(tenantA, 'settings', 'theme');
    const valB = await cache.get<{ color: string }>(tenantB, 'settings', 'theme');

    expect(valA?.color).toBe('dark');
    expect(valB?.color).toBe('light');

    // Clean up
    await cache.flushTenant(tenantA);
    await cache.flushTenant(tenantB);
  });

  it('flushing tenant A cache leaves tenant B cache completely intact', async () => {
    const cache = getTenantCache();
    const tenantA = 'tenant-flush-a';
    const tenantB = 'tenant-flush-b';

    await cache.set(tenantA, 'data', 'item1', 'A-Value');
    await cache.set(tenantB, 'data', 'item1', 'B-Value');

    // Flush Tenant A
    await cache.flushTenant(tenantA);

    // Tenant A should be gone
    const valA = await cache.get(tenantA, 'data', 'item1');
    expect(valA).toBeNull();

    // Tenant B must still exist!
    const valB = await cache.get(tenantB, 'data', 'item1');
    expect(valB).toBe('B-Value');

    await cache.flushTenant(tenantB);
  });

  it('HTTP cache-aside sets X-Cache MISS then HIT, and invalidates on update', async () => {
    const { apiKey } = await createTestTenant(adminPool);

    // 1. Create a project
    const createRes = await server.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Cacheable Project' },
    });
    const projectId = createRes.json().project.id;

    // 2. First GET -> Cache MISS
    const getRes1 = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(getRes1.statusCode).toBe(200);
    expect(getRes1.headers['x-cache']).toBe('MISS');
    expect(getRes1.json().project.name).toBe('Cacheable Project');

    // 3. Second GET -> Cache HIT
    const getRes2 = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(getRes2.statusCode).toBe(200);
    expect(getRes2.headers['x-cache']).toBe('HIT');
    expect(getRes2.json().project.name).toBe('Cacheable Project');

    // 4. Update the project -> should invalidate cache
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'Updated Project' },
    });
    expect(patchRes.statusCode).toBe(200);

    // 5. Third GET -> Cache MISS (refetched from DB)
    const getRes3 = await server.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(getRes3.statusCode).toBe(200);
    expect(getRes3.headers['x-cache']).toBe('MISS');
    expect(getRes3.json().project.name).toBe('Updated Project');
  });
});
