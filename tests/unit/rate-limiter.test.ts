import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { SlidingWindowRateLimiter } from '../../src/rate-limiter/sliding-window.js';

describe('SlidingWindowRateLimiter Unit Tests', () => {
  let redis: Redis;
  let limiter: SlidingWindowRateLimiter;
  const testTenant = 'test-tenant-unit';

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    limiter = new SlidingWindowRateLimiter(redis, 60);
    await limiter.init();
  });

  afterAll(async () => {
    await limiter.resetTenant(testTenant);
    await redis.quit();
  });

  beforeEach(async () => {
    await limiter.resetTenant(testTenant);
  });

  it('allows requests within limit and decrements remaining tokens', async () => {
    const res1 = await limiter.consume(testTenant, 'free');
    expect(res1.allowed).toBe(true);
    expect(res1.limit).toBe(60);
    expect(res1.remaining).toBe(59);

    const res2 = await limiter.consume(testTenant, 'free');
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(58);
  });

  it('respects different tier limits', () => {
    expect(limiter.getLimitForTier('free')).toBe(60);
    expect(limiter.getLimitForTier('pro')).toBe(600);
    expect(limiter.getLimitForTier('enterprise')).toBe(6000);
  });

  it('blocks requests once quota is exhausted', async () => {
    const microLimiter = new SlidingWindowRateLimiter(redis, 60);
    // Override getLimitForTier to test small quota
    microLimiter.getLimitForTier = () => 3;
    await microLimiter.init();

    const r1 = await microLimiter.consume('tenant-burst', 'free');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await microLimiter.consume('tenant-burst', 'free');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await microLimiter.consume('tenant-burst', 'free');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request must be rejected
    const r4 = await microLimiter.consume('tenant-burst', 'free');
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetAfterSeconds).toBeGreaterThan(0);

    await microLimiter.resetTenant('tenant-burst');
  });

  it('ensures rate limits of one tenant do not affect another', async () => {
    const microLimiter = new SlidingWindowRateLimiter(redis, 60);
    microLimiter.getLimitForTier = () => 2;
    await microLimiter.init();

    const tenantA = 'tenant-iso-a';
    const tenantB = 'tenant-iso-b';

    // Exhaust Tenant A
    await microLimiter.consume(tenantA, 'free');
    await microLimiter.consume(tenantA, 'free');
    const rejectedA = await microLimiter.consume(tenantA, 'free');
    expect(rejectedA.allowed).toBe(false);

    // Tenant B must still have full quota!
    const allowedB = await microLimiter.consume(tenantB, 'free');
    expect(allowedB.allowed).toBe(true);
    expect(allowedB.remaining).toBe(1);

    await microLimiter.resetTenant(tenantA);
    await microLimiter.resetTenant(tenantB);
  });
});
