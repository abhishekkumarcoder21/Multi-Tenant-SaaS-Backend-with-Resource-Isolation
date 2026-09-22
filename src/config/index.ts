import dotenv from 'dotenv';

// Load .env file in development
dotenv.config();

/**
 * Rate limit tiers — requests per minute per tenant.
 * These map to the `tier` column on the tenants table.
 */
export interface RateLimitTiers {
  free: number;
  pro: number;
  enterprise: number;
}

export interface Config {
  server: {
    port: number;
    host: string;
    nodeEnv: string;
    logLevel: string;
  };
  database: {
    /** Application connection — RLS enforced (non-superuser) */
    url: string;
    /** Admin connection — bypasses RLS for migrations */
    adminUrl: string;
    poolSize: number;
  };
  redis: {
    url: string;
  };
  rateLimits: RateLimitTiers;
  metering: {
    /** How often (ms) usage counters are flushed from Redis to Postgres */
    flushIntervalMs: number;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  return {
    server: {
      port: parseInt(optional('PORT', '3000'), 10),
      host: optional('HOST', '0.0.0.0'),
      nodeEnv: optional('NODE_ENV', 'development'),
      logLevel: optional('LOG_LEVEL', 'info'),
    },
    database: {
      url: required('DATABASE_URL'),
      adminUrl: required('DATABASE_ADMIN_URL'),
      poolSize: parseInt(optional('DATABASE_POOL_SIZE', '20'), 10),
    },
    redis: {
      url: optional('REDIS_URL', 'redis://localhost:6379'),
    },
    rateLimits: {
      free: parseInt(optional('RATE_LIMIT_FREE', '60'), 10),
      pro: parseInt(optional('RATE_LIMIT_PRO', '600'), 10),
      enterprise: parseInt(optional('RATE_LIMIT_ENTERPRISE', '6000'), 10),
    },
    metering: {
      flushIntervalMs: parseInt(optional('USAGE_FLUSH_INTERVAL_MS', '300000'), 10),
    },
  };
}

/** Singleton config instance */
export const config = loadConfig();
