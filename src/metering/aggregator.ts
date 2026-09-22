import { Queue, Worker, Job } from 'bullmq';
import { adminPool } from '../database/pool.js';
import { getUsageTracker } from './usage-tracker.js';
import { config } from '../config/index.js';

export const BILLING_QUEUE_NAME = 'billing-aggregation';

/**
 * Flush a specific tenant's daily usage from Redis into PostgreSQL.
 *
 * IDEMPOTENT & CONCURRENCY-SAFE:
 * Uses `ON CONFLICT (tenant_id, recorded_date) DO UPDATE` to aggregate
 * flushed usage additively into the relational database.
 */
export async function flushTenantUsage(tenantId: string, dateStr: string): Promise<boolean> {
  const tracker = getUsageTracker();
  const summary = await tracker.extractAndResetUsage(tenantId, dateStr);

  if (summary.apiCalls === 0 && summary.computeMs === 0) {
    return false; // Nothing to flush
  }

  // Persist into PostgreSQL usage_records table (using adminPool because
  // aggregator runs as a background system job across multiple tenants)
  await adminPool.query(
    `INSERT INTO usage_records (tenant_id, recorded_date, api_calls, compute_ms)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, recorded_date)
     DO UPDATE SET
       api_calls = usage_records.api_calls + EXCLUDED.api_calls,
       compute_ms = usage_records.compute_ms + EXCLUDED.compute_ms,
       updated_at = now()`,
    [tenantId, dateStr, summary.apiCalls, summary.computeMs],
  );

  return true;
}

/**
 * Scan all active tenants and flush usage for today and yesterday.
 */
export async function flushAllTenantsUsage(): Promise<number> {
  const { rows: tenants } = await adminPool.query(
    `SELECT id FROM tenants WHERE status != 'deleted'`,
  );

  const today = new Date().toISOString().split('T')[0];
  const yesterdayDate = new Date(Date.now() - 86400 * 1000);
  const yesterday = yesterdayDate.toISOString().split('T')[0];

  let flushedCount = 0;

  for (const tenant of tenants) {
    const flushedToday = await flushTenantUsage(tenant.id, today);
    const flushedYesterday = await flushTenantUsage(tenant.id, yesterday);
    if (flushedToday || flushedYesterday) {
      flushedCount++;
    }
  }

  return flushedCount;
}

export class BillingAggregator {
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  async start(): Promise<void> {
    const redisOptions = {
      connection: {
        url: config.redis.url,
      },
    };

    this.queue = new Queue(BILLING_QUEUE_NAME, redisOptions);

    this.worker = new Worker(
      BILLING_QUEUE_NAME,
      async (_job: Job) => {
        return await flushAllTenantsUsage();
      },
      redisOptions,
    );

    // Schedule repeatable aggregation job
    await this.queue.add(
      'periodic-aggregation',
      {},
      {
        repeat: {
          every: config.metering.flushIntervalMs,
        },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}

let aggregatorInstance: BillingAggregator | null = null;

export function getBillingAggregator(): BillingAggregator {
  if (!aggregatorInstance) {
    aggregatorInstance = new BillingAggregator();
  }
  return aggregatorInstance;
}
