import 'fastify';

/**
 * Augment FastifyRequest to include tenant context.
 * Populated by the tenant-resolver plugin in the preHandler hook.
 */
declare module 'fastify' {
  interface FastifyRequest {
    tenant: {
      id: string;
      name: string;
      slug: string;
      tier: 'free' | 'pro' | 'enterprise';
      status: 'active' | 'suspended' | 'deleted';
    } | null;
  }
}
