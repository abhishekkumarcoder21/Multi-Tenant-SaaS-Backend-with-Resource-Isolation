import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SlidingWindowRateLimiter } from '../rate-limiter/sliding-window.js';

let rateLimiterInstance: SlidingWindowRateLimiter | null = null;

export function getRateLimiter(): SlidingWindowRateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new SlidingWindowRateLimiter();
  }
  return rateLimiterInstance;
}

/**
 * Rate Limiter Plugin for Fastify
 *
 * Enforces per-tenant rate limits based on tenant subscription tier.
 * Sets standard rate-limit headers on replies.
 *
 * Handling of Failures:
 * FAIL-SAFE: When Redis is unreachable, the system rejects requests with 503
 * Service Unavailable instead of failing open (which could cause infinite unmetered traffic).
 */
async function rateLimiterPlugin(fastify: FastifyInstance): Promise<void> {
  const limiter = getRateLimiter();
  await limiter.init();

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only apply rate limiting to tenant-authenticated requests
    if (!request.tenant) {
      return;
    }

    const { id: tenantId, tier } = request.tenant;

    try {
      const result = await limiter.consume(tenantId, tier);

      // Add standard RFC rate-limiting headers
      reply.header('X-RateLimit-Limit', result.limit);
      reply.header('X-RateLimit-Remaining', result.remaining);
      reply.header('X-RateLimit-Reset', result.resetAfterSeconds);

      if (!result.allowed) {
        reply.header('Retry-After', result.resetAfterSeconds);
        return reply.status(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for tier "${tier}". Retry after ${result.resetAfterSeconds} seconds.`,
          tier,
          limit: result.limit,
          resetAfterSeconds: result.resetAfterSeconds,
        });
      }
    } catch (error) {
      request.log.error({ err: error, tenantId }, 'Rate limiter unavailable');

      // Fail-Safe policy: Reject traffic with 503 during Redis outage
      reply.header('Retry-After', '5');
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Rate limiting service temporarily unavailable. Please retry shortly.',
      });
    }
  });
}

export default fp(rateLimiterPlugin, {
  name: 'tenant-rate-limiter',
  dependencies: ['tenant-resolver'],
});
