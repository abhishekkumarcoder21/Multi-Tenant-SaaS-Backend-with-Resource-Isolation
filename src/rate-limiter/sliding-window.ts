import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { getRedisClient } from '../redis/client.js';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LUA_SCRIPT_PATH = path.join(__dirname, 'lua', 'sliding-window.lua');

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private redis: Redis;
  private luaScript: string;
  private scriptSha: string | null = null;
  private windowSizeSeconds: number;

  constructor(redis?: Redis, windowSizeSeconds = 60) {
    this.redis = redis ?? getRedisClient();
    this.windowSizeSeconds = windowSizeSeconds;
    this.luaScript = fs.readFileSync(LUA_SCRIPT_PATH, 'utf-8');
  }

  /**
   * Pre-load the Lua script SHA into Redis to maximize throughput.
   */
  async init(): Promise<void> {
    try {
      this.scriptSha = await this.redis.script('LOAD', this.luaScript) as string;
    } catch (err) {
      console.warn('[RateLimiter] Failed to preload Lua script SHA:', (err as Error).message);
    }
  }

  /**
   * Determine rate limit for a specific tenant tier.
   */
  getLimitForTier(tier: 'free' | 'pro' | 'enterprise'): number {
    switch (tier) {
      case 'pro':
        return config.rateLimits.pro;
      case 'enterprise':
        return config.rateLimits.enterprise;
      case 'free':
      default:
        return config.rateLimits.free;
    }
  }

  /**
   * Check and consume rate limit token for a tenant.
   *
   * @param tenantId The unique tenant identifier
   * @param tier Tenant subscription tier
   * @returns RateLimitResult with status and headers info
   */
  async consume(tenantId: string, tier: 'free' | 'pro' | 'enterprise'): Promise<RateLimitResult> {
    const limit = this.getLimitForTier(tier);
    const now = Date.now() / 1000;
    const windowStart = Math.floor(now / this.windowSizeSeconds) * this.windowSizeSeconds;
    const prevWindowStart = windowStart - this.windowSizeSeconds;

    const currentKey = `rl:${tenantId}:${windowStart}`;
    const prevKey = `rl:${tenantId}:${prevWindowStart}`;

    try {
      let result: [number, number, number];

      if (this.scriptSha) {
        try {
          result = (await this.redis.evalsha(
            this.scriptSha,
            2,
            currentKey,
            prevKey,
            limit.toString(),
            this.windowSizeSeconds.toString(),
            now.toString(),
            windowStart.toString(),
          )) as [number, number, number];
        } catch (evalShaError: unknown) {
          // If NOSCRIPT, fallback to EVAL and reload SHA
          if ((evalShaError as Error).message?.includes('NOSCRIPT')) {
            this.scriptSha = await this.redis.script('LOAD', this.luaScript) as string;
            result = (await this.redis.eval(
              this.luaScript,
              2,
              currentKey,
              prevKey,
              limit.toString(),
              this.windowSizeSeconds.toString(),
              now.toString(),
              windowStart.toString(),
            )) as [number, number, number];
          } else {
            throw evalShaError;
          }
        }
      } else {
        result = (await this.redis.eval(
          this.luaScript,
          2,
          currentKey,
          prevKey,
          limit.toString(),
          this.windowSizeSeconds.toString(),
          now.toString(),
          windowStart.toString(),
        )) as [number, number, number];
      }

      const [allowedNum, remaining, resetAfterSeconds] = result;

      return {
        allowed: allowedNum === 1,
        limit,
        remaining,
        resetAfterSeconds,
      };
    } catch (redisError) {
      // Failure mode: Fail-safe (reject request or notify outage).
      // We log and re-throw, allowing middleware to return 503 Service Unavailable.
      throw new Error(`Rate limiter storage unavailable: ${(redisError as Error).message}`);
    }
  }

  /**
   * Reset rate limit state for a tenant (useful for testing or manual admin reset).
   */
  async resetTenant(tenantId: string): Promise<void> {
    const pattern = `rl:${tenantId}:*`;
    const stream = this.redis.scanStream({ match: pattern, count: 100 });
    const keys: string[] = [];

    for await (const batch of stream) {
      if (batch.length > 0) {
        keys.push(...batch);
      }
    }

    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
