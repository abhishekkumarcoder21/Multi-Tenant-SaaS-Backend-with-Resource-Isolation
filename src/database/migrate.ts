import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Simple sequential migration runner.
 *
 * Runs as the ADMIN user (superuser) because:
 * - CREATE TABLE, ALTER TABLE, CREATE POLICY require elevated privileges
 * - GRANT statements to app_user require being the table owner
 *
 * Tracks applied migrations in a `_migrations` table to avoid re-running.
 */
async function migrate(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: config.database.adminUrl,
    max: 1,
  });

  const client = await pool.connect();

  try {
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          SERIAL PRIMARY KEY,
        filename    VARCHAR(255) NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Get list of already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM _migrations ORDER BY filename',
    );
    const appliedSet = new Set(applied.map((r: { filename: string }) => r.filename));

    // Read migration files from disk, sorted by name
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f: string) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`  ✓ ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

      console.log(`  → Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (filename) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`  ✓ ${file} applied successfully`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`  ✗ ${file} failed:`, error);
        throw error;
      }
    }

    console.log('\nAll migrations applied.');
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migrations when this file is executed directly
migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
