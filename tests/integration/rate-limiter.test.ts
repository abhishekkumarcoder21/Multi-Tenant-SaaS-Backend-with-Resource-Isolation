import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildServer } from '../../src/server.js';
import { createAdminPool, createTestTenant, cleanupTestData } from '../helpers.js';
import { getRateLimiter } from '../../src/plugins/rate-limiter.js';

describe('Rate Limiter HTTP Integration', () => {
  let server: FastifyInstance;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = createAdminPool();
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await cleanupTestData(adminPool);
    await adminPool.end();
    await server.close();
  });

  beforeEach(async () => {
    await cleanupTestData(adminPool);
  });

  it('sets X-RateLimit headers on successful requests', async () => {
    const { apiKey } = await createTestTenant(adminPool, { tier: 'free' });

    const res = await server.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(60);
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeLessThan(60);
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('returns 429 when tenant quota is exhausted without affecting another tenant', async () => {
    const limiter = getRateLimiter();
    // Temporarily mock low limit for 'free' tier
    const originalGetLimit = limiter.getLimitForTier.bind(limiter);
    limiter.getLimitForTier = () => 2;

    try {
      const tenantA = await createTestTenant(adminPool, { name: 'Tenant A', tier: 'free' });
      const tenantB = await createTestTenant(adminPool, { name: 'Tenant B', tier: 'free' });

      // Request 1 for A: OK
      const resA1 = await server.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
      });
      expect(resA1.statusCode).toBe(200);

      // Request 2 for A: OK
      const resA2 = await server.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
      });
      expect(resA2.statusCode).toBe(200);

      // Request 3 for A: 429 Too Many Requests
      const resA3 = await server.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${tenantA.apiKey}` },
      });
      expect(resA3.statusCode).toBe(429);
      expect(resA3.headers['retry-after']).toBeDefined();
      const bodyA3 = resA3.json();
      expect(bodyA3.error).toBe('Too Many Requests');

      // Tenant B sends a request: MUST BE 200 OK (perfect isolation!)
      const resB1 = await server.inject({
        method: 'GET',
        url: '/projects',
        headers: { authorization: `Bearer ${tenantB.apiKey}` },
      });
      expect(resB1.statusCode).toBe(200);

      // Clean up Redis keys
      await limiter.resetTenant(tenantA.tenant.id);
      await limiter.resetTenant(tenantB.tenant.id);
    } finally {
      limiter.getLimitForTier = originalGetLimit;
    }
  });
});
