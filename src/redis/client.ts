import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config/index.js';

let redisClient: Redis | null = null;

/**
 * Get or initialize the Redis client singleton.
 * Uses ioredis with built-in retry strategy and connection pooling.
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const options: RedisOptions = {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy(times) {
        // Exponential backoff up to 2 seconds
        const delay = Math.min(times * 100, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetErrors = ['READONLY', 'ETIMEDOUT'];
        return targetErrors.some((target) => err.message.includes(target));
      },
    };

    redisClient = new Redis(config.redis.url, options);

    redisClient.on('error', (err: Error) => {
      // In production or tests, log Redis connection issues
      if (process.env.NODE_ENV !== 'test') {
        console.error('[Redis Error]', err.message);
      }
    });
  }

  return redisClient;
}

/**
 * Check if Redis is currently connected and responsive.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const client = getRedisClient();
    const pong = await client.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Gracefully close Redis connection.
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
