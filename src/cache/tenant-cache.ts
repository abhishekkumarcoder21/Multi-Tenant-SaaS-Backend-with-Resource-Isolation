import type { Redis } from 'ioredis';
import { getRedisClient } from '../redis/client.js';

export interface TenantCacheOptions {
  defaultTtlSeconds?: number;
}

/**
 * TenantCache
 *
 * Implements strict tenant-scoped caching.
 * Key Namespace: `cache:{tenant_id}:{resource}:{key}`
 *
 * Design Guarantees:
 * 1. Isolation: Every key is prefixed with the tenant ID. One tenant's operations
 *    can never read, mutate, or evict another tenant's cached data.
 * 2. Non-blocking Eviction: `flushTenant` uses SCAN rather than KEYS to avoid blocking
 *    the single-threaded Redis event loop.
 * 3. Graceful Degradation: If Redis fails or experiences memory eviction pressure (LRU),
 *    the cache treats it as a miss and lets the application fall back to the DB safely.
 */
export class TenantCache {
  private redis: Redis;
  private defaultTtl: number;

  constructor(redis?: Redis, options: TenantCacheOptions = {}) {
    this.redis = redis ?? getRedisClient();
    this.defaultTtl = options.defaultTtlSeconds ?? 300; // 5 minutes default
  }

  private buildKey(tenantId: string, resource: string, key: string): string {
    return `cache:${tenantId}:${resource}:${key}`;
  }

  /**
   * Retrieve cached value for a specific tenant and resource.
   * Returns null if key is not found or if Redis fails (graceful degradation).
   */
  async get<T>(tenantId: string, resource: string, key: string): Promise<T | null> {
    try {
      const fullKey = this.buildKey(tenantId, resource, key);
      const data = await this.redis.get(fullKey);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      console.warn(`[TenantCache] Cache read failed for tenant ${tenantId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Set cached value with an optional TTL in seconds.
   */
  async set<T>(
    tenantId: string,
    resource: string,
    key: string,
    value: T,
    ttlSeconds?: number,
  ): Promise<void> {
    try {
      const fullKey = this.buildKey(tenantId, resource, key);
      const serialized = JSON.stringify(value);
      const ttl = ttlSeconds ?? this.defaultTtl;

      await this.redis.set(fullKey, serialized, 'EX', ttl);
    } catch (err) {
      console.warn(`[TenantCache] Cache write failed for tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  /**
   * Invalidate a single cached item for a tenant.
   */
  async invalidate(tenantId: string, resource: string, key: string): Promise<void> {
    try {
      const fullKey = this.buildKey(tenantId, resource, key);
      await this.redis.del(fullKey);
    } catch (err) {
      console.warn(`[TenantCache] Invalidation failed for tenant ${tenantId}: ${(err as Error).message}`);
    }
  }

  /**
   * Invalidate all cached items for a specific resource under a tenant.
   */
  async invalidateResource(tenantId: string, resource: string): Promise<void> {
    const pattern = `cache:${tenantId}:${resource}:*`;
    await this.scanAndDelete(pattern);
  }

  /**
   * Flush ALL cache keys for a specific tenant (e.g. during offboarding or cache reset).
   * NEVER touches any other tenant's keys.
   */
  async flushTenant(tenantId: string): Promise<number> {
    const pattern = `cache:${tenantId}:*`;
    return this.scanAndDelete(pattern);
  }

  /**
   * Non-blocking batch scan and delete helper.
   */
  private async scanAndDelete(pattern: string): Promise<number> {
    try {
      const stream = this.redis.scanStream({ match: pattern, count: 100 });
      let deletedCount = 0;

      for await (const batch of stream) {
        if (batch.length > 0) {
          const count = await this.redis.del(...batch);
          deletedCount += count;
        }
      }

      return deletedCount;
    } catch (err) {
      console.warn(`[TenantCache] Scan and delete failed for pattern ${pattern}: ${(err as Error).message}`);
      return 0;
    }
  }
}

let tenantCacheInstance: TenantCache | null = null;

export function getTenantCache(): TenantCache {
  if (!tenantCacheInstance) {
    tenantCacheInstance = new TenantCache();
  }
  return tenantCacheInstance;
}
