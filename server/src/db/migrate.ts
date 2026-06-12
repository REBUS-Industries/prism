/**
 * Apply pending Drizzle migrations + heal schema drift.
 *
 * Run from the host during dev with: npm run db:migrate
 * Run from the container at boot via bootstrap.ts.
 */
import 'dotenv/config';
import { pool } from './client.js';
import { runMigrations } from './runMigrations.js';

async function main() {
  console.log('[migrate] starting');
  await runMigrations({ log: console });
  console.log('[migrate] done');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
