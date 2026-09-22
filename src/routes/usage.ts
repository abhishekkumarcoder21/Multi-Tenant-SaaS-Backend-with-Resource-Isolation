import type { FastifyInstance } from 'fastify';
import { adminPool } from '../database/pool.js';
import { withTenantContext } from '../database/tenant-context.js';
import { getUsageTracker } from '../metering/usage-tracker.js';

export async function usageRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /tenants/:id/usage — Current period usage summary
   *
   * Combines persisted PostgreSQL records for today with live real-time Redis counters.
   */
  fastify.get('/tenants/:id/usage', {
    schema: {
      description: 'Get live usage summary for a tenant',
      tags: ['usage'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // Tenant can only view their own usage unless admin
    if (request.tenant && request.tenant.id !== id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Cannot view usage for another tenant',
      });
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const tracker = getUsageTracker();
    const liveRedisUsage = await tracker.getCurrentUsage(id);

    // Query persisted database record for today (if already flushed)
    const { rows: dbRows } = await adminPool.query(
      `SELECT api_calls, compute_ms
       FROM usage_records
       WHERE tenant_id = $1 AND recorded_date = $2`,
      [id, todayStr],
    );

    const dbApiCalls = dbRows.length > 0 ? parseInt(dbRows[0].api_calls, 10) : 0;
    const dbComputeMs = dbRows.length > 0 ? parseFloat(dbRows[0].compute_ms) : 0;

    const totalApiCalls = dbApiCalls + liveRedisUsage.apiCalls;
    const totalComputeMs = dbComputeMs + liveRedisUsage.computeMs;

    return {
      tenant_id: id,
      date: todayStr,
      live_api_calls: liveRedisUsage.apiCalls,
      persisted_api_calls: dbApiCalls,
      total_api_calls: totalApiCalls,
      total_compute_ms: Math.round(totalComputeMs * 100) / 100,
    };
  });

  /**
   * GET /tenants/:id/usage/history — Historical usage breakdown
   */
  fastify.get('/tenants/:id/usage/history', {
    schema: {
      description: 'Get historical daily usage breakdown for a tenant',
      tags: ['usage'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit: number };

    // Tenant can only view their own history
    if (request.tenant && request.tenant.id !== id) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Cannot view usage history for another tenant',
      });
    }

    // Use withTenantContext to demonstrate RLS on usage_records
    const records = await withTenantContext(id, async (client) => {
      const { rows } = await client.query(
        `SELECT recorded_date, api_calls, compute_ms, created_at, updated_at
         FROM usage_records
         WHERE tenant_id = $1
         ORDER BY recorded_date DESC
         LIMIT $2`,
        [id, limit ?? 30],
      );
      return rows;
    });

    return {
      tenant_id: id,
      records,
    };
  });
}
