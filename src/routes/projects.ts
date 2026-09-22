import type { FastifyInstance } from 'fastify';
import { withTenantContext } from '../database/tenant-context.js';
import { getTenantCache } from '../cache/tenant-cache.js';

/**
 * Project routes — sample tenant-scoped CRUD.
 *
 * Every query runs inside withTenantContext(), which sets the
 * RLS session variable. Even if a query omits WHERE tenant_id = ?,
 * RLS blocks cross-tenant access at the database level.
 *
 * We STILL include tenant_id in queries as defense-in-depth:
 * the application layer AND database layer both enforce isolation.
 */
export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /projects — List all projects for the current tenant
   */
  fastify.get('/projects', {
    schema: {
      description: 'List all projects for the authenticated tenant',
      tags: ['projects'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string', nullable: true },
                  status: { type: 'string' },
                  created_at: { type: 'string' },
                  updated_at: { type: 'string' },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, _reply) => {
    const tenant = request.tenant!;
    const { limit, offset } = request.query as { limit: number; offset: number };

    return withTenantContext(tenant.id, async (client) => {
      // Note: RLS automatically filters to this tenant's rows.
      // The WHERE clause is defense-in-depth.
      const { rows: projects } = await client.query(
        `SELECT id, name, description, status, created_at, updated_at
         FROM projects
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenant.id, limit, offset],
      );

      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int as total FROM projects WHERE tenant_id = $1`,
        [tenant.id],
      );

      return { projects, total: countRows[0].total };
    });
  });

  /**
   * POST /projects — Create a new project
   */
  fastify.post('/projects', {
    schema: {
      description: 'Create a new project',
      tags: ['projects'],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string', maxLength: 2000 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            project: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string', nullable: true },
                status: { type: 'string' },
                created_at: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const tenant = request.tenant!;
    const { name, description } = request.body as {
      name: string;
      description?: string;
    };

    const project = await withTenantContext(tenant.id, async (client) => {
      // tenant_id is set explicitly AND enforced by RLS WITH CHECK
      const { rows } = await client.query(
        `INSERT INTO projects (tenant_id, name, description)
         VALUES ($1, $2, $3)
         RETURNING id, name, description, status, created_at`,
        [tenant.id, name, description ?? null],
      );
      return rows[0];
    });

    return reply.status(201).send({ project });
  });

  /**
   * GET /projects/:id — Get a single project (Cache-Aside)
   */
  fastify.get('/projects/:id', {
    schema: {
      description: 'Get project details',
      tags: ['projects'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const tenant = request.tenant!;
    const { id } = request.params as { id: string };
    const cache = getTenantCache();

    // 1. Check tenant-scoped cache first
    const cachedProject = await cache.get(tenant.id, 'project', id);
    if (cachedProject) {
      reply.header('X-Cache', 'HIT');
      return { project: cachedProject };
    }

    // 2. Cache miss: fetch from PostgreSQL using RLS context
    const project = await withTenantContext(tenant.id, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, description, status, created_at, updated_at
         FROM projects
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenant.id],
      );
      return rows[0] ?? null;
    });

    if (!project) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Project not found',
      });
    }

    // 3. Populate tenant-scoped cache with 5-minute TTL
    await cache.set(tenant.id, 'project', id, project, 300);
    reply.header('X-Cache', 'MISS');

    return { project };
  });

  /**
   * PATCH /projects/:id — Update a project (with cache invalidation)
   */
  fastify.patch('/projects/:id', {
    schema: {
      description: 'Update a project',
      tags: ['projects'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          description: { type: 'string', maxLength: 2000 },
          status: { type: 'string', enum: ['active', 'archived'] },
        },
      },
    },
  }, async (request, reply) => {
    const tenant = request.tenant!;
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, string>;
    const cache = getTenantCache();

    const project = await withTenantContext(tenant.id, async (client) => {
      const allowedFields = ['name', 'description', 'status'];
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          setClauses.push(`${field} = $${paramIndex}`);
          values.push(updates[field]);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) {
        return null;
      }

      setClauses.push(`updated_at = now()`);
      values.push(id, tenant.id);

      const { rows } = await client.query(
        `UPDATE projects
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1}
         RETURNING id, name, description, status, created_at, updated_at`,
        values,
      );

      return rows[0] ?? null;
    });

    if (project === null) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Project not found or no fields to update',
      });
    }

    // Invalidate cached copy on update
    await cache.invalidate(tenant.id, 'project', id);

    return { project };
  });

  /**
   * DELETE /projects/:id — Delete a project (with cache invalidation)
   */
  fastify.delete('/projects/:id', {
    schema: {
      description: 'Delete a project',
      tags: ['projects'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const tenant = request.tenant!;
    const { id } = request.params as { id: string };
    const cache = getTenantCache();

    const deleted = await withTenantContext(tenant.id, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM projects WHERE id = $1 AND tenant_id = $2`,
        [id, tenant.id],
      );
      return (rowCount ?? 0) > 0;
    });

    if (!deleted) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Project not found',
      });
    }

    // Invalidate cached copy on delete
    await cache.invalidate(tenant.id, 'project', id);

    return reply.status(204).send();
  });
}
