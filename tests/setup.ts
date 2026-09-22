import { beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * Global test setup.
 *
 * PREREQUISITES: Docker Compose services must be running.
 * Tests use real Postgres and Redis — not mocks.
 *
 * Run: docker compose up -d postgres redis
 */

// Set test environment variables
process.env.DATABASE_URL = 'postgresql://app_user:app_password@localhost:5432/saas_mt';
process.env.DATABASE_ADMIN_URL = 'postgresql://postgres:postgres@localhost:5432/saas_mt';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Quiet during tests

beforeAll(async () => {
  // Verify database connectivity
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_ADMIN_URL,
    max: 1,
  });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    console.error(
      '\n❌ Cannot connect to PostgreSQL. Make sure Docker Compose is running:\n' +
      '   docker compose up -d postgres redis\n' +
      '   npm run db:migrate\n',
    );
    throw error;
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  // Allow pending promises to settle
  await new Promise((resolve) => setTimeout(resolve, 100));
});
