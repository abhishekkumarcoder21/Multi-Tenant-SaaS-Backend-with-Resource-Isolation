import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { adminPool } from '../database/pool.js';
import { hashApiKey } from '../plugins/tenant-resolver.js';

/**
 * Tenant management routes.
 *
 * These are "admin" routes — they use adminPool because:
 * - Tenant creation happens BEFORE a tenant context exists
 * - Listing all tenants requires cross-tenant visibility
 *
 * In production, these would be protected by a separate admin auth mechanism.
 * For this demo, they're accessible under /admin/tenants.
 */
export async function tenantRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /admin/tenants — Create a new tenant
   *
   * Returns the raw API key ONCE. It's hashed before storage
   * and can never be retrieved again.
   */
  fastify.post('/admin/tenants', {
    schema: {
      description: 'Create a new tenant and generate an API key',
      tags: ['admin'],
      body: {
        type: 'object',
        required: ['name', 'slug'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          slug: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            pattern: '^[a-z0-9-]+$',
          },
          tier: { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            tenant: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                slug: { type: 'string' },
                tier: { type: 'string' },
                status: { type: 'string' },
                created_at: { type: 'string' },
              },
            },
            api_key: {
              type: 'string',
              description: 'Raw API key — shown once, never stored',
            },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { name, slug, tier } = request.body as {
      name: string;
      slug: string;
      tier?: string;
    };

    // Generate a random API key (32 bytes = 64 hex chars)
    const rawApiKey = `mt_${randomBytes(32).toString('hex')}`;
    const apiKeyHash = hashApiKey(rawApiKey);

    try {
      const { rows } = await adminPool.query(
        `INSERT INTO tenants (name, slug, tier, api_key_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, tier, status, created_at`,
        [name, slug, tier ?? 'free', apiKeyHash],
      );

      return reply.status(201).send({
        tenant: rows[0],
        api_key: rawApiKey,
      });
    } catch (error: unknown) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        // Unique violation — slug or api_key_hash already exists
        return reply.status(409).send({
          error: 'Conflict',
          message: `Tenant with slug "${slug}" already exists`,
        });
      }
      throw error;
    }
  });

  /**
   * GET /admin/tenants — List all tenants
   */
  fastify.get('/admin/tenants', {
    schema: {
      description: 'List all tenants',
      tags: ['admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            tenants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  tier: { type: 'string' },
                  status: { type: 'string' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (_request, _reply) => {
    const { rows } = await adminPool.query(
      `SELECT id, name, slug, tier, status, created_at
       FROM tenants
       WHERE status != 'deleted'
       ORDER BY created_at DESC`,
    );
    return { tenants: rows };
  });

  /**
   * GET /admin/tenants/:id — Get a single tenant
   */
  fastify.get('/admin/tenants/:id', {
    schema: {
      description: 'Get tenant details',
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
      `SELECT id, name, slug, tier, status, created_at, updated_at
       FROM tenants WHERE id = $1`,
      [id],
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    return { tenant: rows[0] };
  });

  /**
   * PATCH /admin/tenants/:id — Update tenant (tier, status, name)
   */
  fastify.patch('/admin/tenants/:id', {
    schema: {
      description: 'Update tenant properties',
      tags: ['admin'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          status: { type: 'string', enum: ['active', 'suspended'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, string>;

    // Build dynamic SET clause from provided fields
    const allowedFields = ['name', 'tier', 'status'];
    const setClauses: string[] = [];
    const values: string[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'No valid fields to update',
      });
    }

    setClauses.push(`updated_at = now()`);
    values.push(id);

    const { rows } = await adminPool.query(
      `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values,
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    return { tenant: rows[0] };
  });

  /**
   * DELETE /admin/tenants/:id — Soft-delete a tenant
   * Sets status to 'deleted'. Full cleanup (data + cache) is handled by
   * the tenant offboarding service (Layer 5).
   */
  fastify.delete('/admin/tenants/:id', {
    schema: {
      description: 'Soft-delete a tenant',
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

    const { rowCount } = await adminPool.query(
      `UPDATE tenants SET status = 'deleted', updated_at = now() WHERE id = $1`,
      [id],
    );

    if (rowCount === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    return reply.status(204).send();
  });
}
