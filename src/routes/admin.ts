import type { FastifyInstance } from 'fastify';
import { adminPool, appPool } from '../database/pool.js';
import { isRedisHealthy, getRedisClient } from '../redis/client.js';
import { register } from '../observability/metrics.js';
import { getRateLimiter } from '../plugins/rate-limiter.js';
import { getUsageTracker } from '../metering/usage-tracker.js';
import { offboardTenant } from '../services/tenant-offboarding.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /metrics — Prometheus Scrape Endpoint
   */
  fastify.get('/metrics', {
    schema: {
      description: 'Prometheus metrics scrape endpoint',
      tags: ['observability'],
    },
  }, async (_request, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });

  /**
   * GET /admin/metrics — Overall Operational Health Dashboard
   */
  fastify.get('/admin/metrics', {
    schema: {
      description: 'High-level operational health dashboard',
      tags: ['admin'],
    },
  }, async () => {
    const redisOk = await isRedisHealthy();

    const { rows: tenantCountRows } = await adminPool.query(
      `SELECT
         COUNT(*)::int as total,
         COUNT(*) FILTER (WHERE status = 'active')::int as active,
         COUNT(*) FILTER (WHERE status = 'suspended')::int as suspended
       FROM tenants`,
    );

    const { rows: projectCountRows } = await adminPool.query(
      'SELECT COUNT(*)::int as total FROM projects',
    );

    return {
      status: 'operational',
      timestamp: new Date().toISOString(),
      infrastructure: {
        postgresql: {
          appPool: {
            total: appPool.totalCount,
            idle: appPool.idleCount,
            waiting: appPool.waitingCount,
          },
          adminPool: {
            total: adminPool.totalCount,
            idle: adminPool.idleCount,
            waiting: adminPool.waitingCount,
          },
        },
        redis: {
          healthy: redisOk,
        },
      },
      tenants: tenantCountRows[0],
      total_projects: projectCountRows[0].total,
    };
  });

  /**
   * GET /admin/tenants/:id/metrics — Deep Dive Per-Tenant Resource Visibility
   *
   * Displays rate limit rejections, cache hit rate, and live consumption.
   * This is what makes multi-tenant resource isolation observable.
   */
  fastify.get('/admin/tenants/:id/metrics', {
    schema: {
      description: 'Per-tenant resource consumption and isolation metrics',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const { rows: tenantRows } = await adminPool.query(
      'SELECT id, name, slug, tier, status FROM tenants WHERE id = $1',
      [id],
    );

    if (tenantRows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const tenant = tenantRows[0];
    const limiter = getRateLimiter();
    const tracker = getUsageTracker();

    // Fetch live usage
    const liveUsage = await tracker.getCurrentUsage(id);

    // Get cache keys count for this tenant
    const redis = getRedisClient();
    const stream = redis.scanStream({ match: `cache:${id}:*`, count: 100 });
    let cachedKeysCount = 0;
    for await (const batch of stream) {
      cachedKeysCount += batch.length;
    }

    const rateLimitQuota = limiter.getLimitForTier(tenant.tier);

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tier: tenant.tier,
        status: tenant.status,
      },
      rate_limiting: {
        tier_quota_per_minute: rateLimitQuota,
      },
      caching: {
        active_cache_keys: cachedKeysCount,
      },
      usage_today: {
        date: liveUsage.date,
        live_api_calls: liveUsage.apiCalls,
        live_compute_ms: Math.round(liveUsage.computeMs * 100) / 100,
      },
    };
  });

  /**
   * DELETE /admin/tenants/:id/purge — Full Offboarding & Resource Purge
   */
  fastify.delete('/admin/tenants/:id/purge', {
    schema: {
      description: 'Completely offboard a tenant and purge all database & cache entries',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const { rows } = await adminPool.query(
      'SELECT id FROM tenants WHERE id = $1',
      [id],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const result = await offboardTenant(id);
    return {
      message: 'Tenant offboarded successfully. All database rows and Redis keys purged.',
      result,
    };
  });
}
