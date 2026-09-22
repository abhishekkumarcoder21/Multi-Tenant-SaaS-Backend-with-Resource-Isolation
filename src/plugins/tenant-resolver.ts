import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { adminPool } from '../database/pool.js';

/**
 * Tenant Resolver Plugin
 *
 * Resolves every incoming request to a tenant context by:
 * 1. Extracting the API key from the Authorization header
 * 2. Hashing it (SHA-256) and looking up in the tenants table
 * 3. Decorating request.tenant with the resolved tenant data
 *
 * WHY SHA-256 HASHING:
 * - Raw API keys are never stored in the database
 * - Even if the database is compromised, the attacker cannot reconstruct API keys
 * - The key is shown once at tenant creation and never again
 *
 * WHY adminPool (not appPool):
 * - The tenants table is queried BEFORE tenant context is set
 * - RLS on the tenants table would require a chicken-and-egg situation
 * - Instead, tenants table has no RLS, and we use adminPool for this single lookup
 * - All subsequent queries use appPool with tenant context set
 */
async function tenantResolverPlugin(fastify: FastifyInstance): Promise<void> {
  // Initialize the decorator as null to avoid reference-sharing bugs
  // (Fastify reuses the decorated value as a prototype — objects would be shared)
  fastify.decorateRequest('tenant', null);

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip tenant resolution for health check and metrics endpoints
    if (
      request.url === '/health' ||
      request.url === '/metrics' ||
      request.url.startsWith('/docs') ||
      request.url.startsWith('/admin')
    ) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header. Expected: Bearer <api_key>',
      });
    }

    const apiKey = authHeader.slice(7); // Remove 'Bearer ' prefix
    if (!apiKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key is empty',
      });
    }

    // Hash the API key to look up in the database
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    try {
      const { rows } = await adminPool.query(
        `SELECT id, name, slug, tier, status
         FROM tenants
         WHERE api_key_hash = $1
         LIMIT 1`,
        [keyHash],
      );

      if (rows.length === 0) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid API key',
        });
      }

      const tenant = rows[0];

      if (tenant.status === 'suspended') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Tenant account is suspended',
        });
      }

      if (tenant.status === 'deleted') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Tenant account has been deleted',
        });
      }

      // Populate the tenant context on the request
      request.tenant = {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        tier: tenant.tier,
        status: tenant.status,
      };
    } catch (error) {
      request.log.error({ err: error }, 'Failed to resolve tenant');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to authenticate request',
      });
    }
  });
}

export default fp(tenantResolverPlugin, {
  name: 'tenant-resolver',
  // No dependencies — this is the first plugin in the chain
});

/**
 * Hash an API key using SHA-256.
 * Exported for use in tenant creation (to hash before storing).
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
