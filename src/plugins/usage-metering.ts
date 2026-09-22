import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getUsageTracker } from '../metering/usage-tracker.js';

/**
 * Usage Metering Plugin
 *
 * Hooks into Fastify's `onResponse` lifecycle to meter:
 * 1. Total API call count
 * 2. Total compute duration (elapsed time in milliseconds)
 *
 * Uses non-blocking atomic Redis operations so that metering adds zero
 * detectable latency to the client request.
 */
async function usageMeteringPlugin(fastify: FastifyInstance): Promise<void> {
  const tracker = getUsageTracker();

  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only meter authenticated tenant requests
    if (!request.tenant) {
      return;
    }

    const tenantId = request.tenant.id;
    const elapsedTime = reply.elapsedTime; // Fastify automatically computes elapsed time

    try {
      await tracker.recordUsage(tenantId, 1, elapsedTime);
    } catch (err) {
      // Never fail the request if usage recording fails; log the error
      request.log.error({ err, tenantId }, 'Failed to record tenant usage');
    }
  });
}

export default fp(usageMeteringPlugin, {
  name: 'usage-metering',
  dependencies: ['tenant-resolver'],
});
