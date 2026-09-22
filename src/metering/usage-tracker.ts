import type { Redis } from 'ioredis';
import { getRedisClient } from '../redis/client.js';

export interface TenantUsageSummary {
  tenantId: string;
  date: string;
  apiCalls: number;
  computeMs: number;
}

/**
 * Atomic Redis Usage Tracker
 *
 * Tracks billable SaaS metrics per tenant in real time.
 *
 * CONCURRENCY SAFETY:
 * Uses atomic Redis primitives (`INCRBY` and `INCRBYFLOAT`) rather than
 * read-modify-write loops. This ensures that concurrent requests arriving
 * at the same millisecond never overwrite or drop each other's increments.
 */
export class UsageTracker {
  private redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis ?? getRedisClient();
  }

  private formatDate(date?: Date): string {
    const d = date ?? new Date();
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private getCallsKey(tenantId: string, date: string): string {
    return `usage:${tenantId}:api_calls:${date}`;
  }

  private getComputeKey(tenantId: string, date: string): string {
    return `usage:${tenantId}:compute_ms:${date}`;
  }

  /**
   * Atomically increment usage metrics for a tenant.
   *
   * @param tenantId The tenant UUID
   * @param apiCalls Number of API requests (usually 1)
   * @param computeMs Duration of processing in milliseconds
   * @param date Optional date for billing bucket (defaults to today)
   */
  async recordUsage(
    tenantId: string,
    apiCalls = 1,
    computeMs = 0,
    date?: Date,
  ): Promise<void> {
    const dateStr = this.formatDate(date);
    const callsKey = this.getCallsKey(tenantId, dateStr);
    const computeKey = this.getComputeKey(tenantId, dateStr);

    // Pipeline both atomic increments in a single network round-trip
    const pipeline = this.redis.pipeline();
    pipeline.incrby(callsKey, apiCalls);
    // Keep keys alive for 7 days so aggregator has plenty of time to flush
    pipeline.expire(callsKey, 86400 * 7);

    if (computeMs > 0) {
      pipeline.incrbyfloat(computeKey, computeMs);
      pipeline.expire(computeKey, 86400 * 7);
    }

    await pipeline.exec();
  }

  /**
   * Read the current live usage counters from Redis for a tenant.
   */
  async getCurrentUsage(tenantId: string, date?: Date): Promise<TenantUsageSummary> {
    const dateStr = this.formatDate(date);
    const callsKey = this.getCallsKey(tenantId, dateStr);
    const computeKey = this.getComputeKey(tenantId, dateStr);

    const [callsVal, computeVal] = await this.redis.mget(callsKey, computeKey);

    return {
      tenantId,
      date: dateStr,
      apiCalls: callsVal ? parseInt(callsVal, 10) : 0,
      computeMs: computeVal ? parseFloat(computeVal) : 0,
    };
  }

  /**
   * Atomically fetch AND reset usage counters in Redis using a Lua script.
   *
   * WHY LUA:
   * Prevents double-counting or lost increments during aggregation flush:
   * Any requests arriving while we read and reset will be safely counted in the next cycle.
   */
  async extractAndResetUsage(tenantId: string, dateStr: string): Promise<TenantUsageSummary> {
    const callsKey = this.getCallsKey(tenantId, dateStr);
    const computeKey = this.getComputeKey(tenantId, dateStr);

    const luaScript = `
      local calls = redis.call('get', KEYS[1]) or '0'
      local compute = redis.call('get', KEYS[2]) or '0'
      redis.call('del', KEYS[1], KEYS[2])
      return { calls, compute }
    `;

    const [callsStr, computeStr] = (await this.redis.eval(
      luaScript,
      2,
      callsKey,
      computeKey,
    )) as [string, string];

    return {
      tenantId,
      date: dateStr,
      apiCalls: parseInt(callsStr, 10) || 0,
      computeMs: parseFloat(computeStr) || 0,
    };
  }
}

let usageTrackerInstance: UsageTracker | null = null;

export function getUsageTracker(): UsageTracker {
  if (!usageTrackerInstance) {
    usageTrackerInstance = new UsageTracker();
  }
  return usageTrackerInstance;
}
