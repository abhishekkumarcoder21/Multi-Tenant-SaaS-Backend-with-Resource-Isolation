import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyCors from '@fastify/cors';
import { config } from './config/index.js';
import tenantResolverPlugin from './plugins/tenant-resolver.js';
import rateLimiterPlugin from './plugins/rate-limiter.js';
import usageMeteringPlugin from './plugins/usage-metering.js';
import { tenantRoutes } from './routes/tenants.js';
import { projectRoutes } from './routes/projects.js';
import { usageRoutes } from './routes/usage.js';
import { adminRoutes } from './routes/admin.js';

/**
 * Build and configure the Fastify application.
 *
 * Exported as a factory function so tests can create isolated instances.
 */
export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.server.logLevel,
      // Structured logging with pino — tenant_id is added via request serializer
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
            // Include tenant_id in every log line for observability
            tenantId: (request as unknown as { tenant?: { id?: string } | null }).tenant?.id,
          };
        },
      },
    },
    // Disable request ID header in production for security
    requestIdHeader: config.server.nodeEnv === 'production' ? false : 'x-request-id',
  });

  // ── CORS ──
  await fastify.register(fastifyCors, {
    origin: true, // Allow all origins in development
  });

  // ── Swagger/OpenAPI ──
  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Multi-Tenant SaaS Backend',
        description: 'Production-grade multi-tenant API with resource isolation',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'Tenant API key',
          },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'admin', description: 'Admin operations (no tenant auth required)' },
        { name: 'projects', description: 'Tenant-scoped project operations' },
        { name: 'usage', description: 'Usage and billing endpoints' },
      ],
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // ── Tenant Resolver, Rate Limiter & Usage Metering ──
  await fastify.register(tenantResolverPlugin);
  await fastify.register(rateLimiterPlugin);
  await fastify.register(usageMeteringPlugin);

  // ── Health Check (no auth required) ──
  fastify.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['system'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // ── Routes ──
  await fastify.register(tenantRoutes);   // /admin/tenants/*
  await fastify.register(projectRoutes);  // /projects/*
  await fastify.register(usageRoutes);    // /tenants/:id/usage/*
  await fastify.register(adminRoutes);    // /admin/* & /metrics

  // ── Global Error Handler ──
  fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Log the full error with tenant context
    request.log.error({
      err: error,
      tenantId: request.tenant?.id,
    }, 'Request error');

    // Don't leak internal details in production
    if (config.server.nodeEnv === 'production') {
      return reply.status(error.statusCode ?? 500).send({
        error: error.statusCode === 400 ? 'Bad Request' : 'Internal Server Error',
        message: error.statusCode === 400 ? error.message : 'An unexpected error occurred',
      });
    }

    // In development, include full error details
    return reply.status(error.statusCode ?? 500).send({
      error: error.name,
      message: error.message,
      stack: error.stack,
    });
  });

  return fastify;
}
