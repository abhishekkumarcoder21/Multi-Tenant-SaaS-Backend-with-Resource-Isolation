import client from 'prom-client';

/**
 * Prometheus Observability Module
 *
 * Exposes per-tenant metrics for resource consumption, rate-limiting,
 * and cache hit rates.
 *
 * NOTE ON CARDINALITY:
 * In high-scale SaaS with 100,000+ tenants, tenant_id labels are restricted to
 * aggregated tier labels or sampled tenants to avoid metrics cardinality explosion.
 * For dedicated monitoring, per-tenant metrics provide unmatched operational visibility.
 */

// Initialize default Node.js runtime metrics (event loop, memory, GC)
client.collectDefaultMetrics({ prefix: 'saas_' });

export const httpRequestDuration = new client.Histogram({
  name: 'saas_http_request_duration_seconds',
  help: 'HTTP request duration in seconds per tenant and route',
  labelNames: ['tenant_id', 'method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const rateLimitRejections = new client.Counter({
  name: 'saas_rate_limit_rejections_total',
  help: 'Total rate limit rejections per tenant and tier',
  labelNames: ['tenant_id', 'tier'],
});

export const cacheRequests = new client.Counter({
  name: 'saas_cache_requests_total',
  help: 'Total cache lookups per tenant, labeled by hit or miss',
  labelNames: ['tenant_id', 'result'], // result: 'hit' | 'miss'
});

export const tenantApiCalls = new client.Counter({
  name: 'saas_tenant_api_calls_total',
  help: 'Total billable API calls executed per tenant',
  labelNames: ['tenant_id'],
});

export const register = client.register;
