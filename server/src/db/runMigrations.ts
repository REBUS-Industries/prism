/**
 * Unified migration runner: Drizzle forward-migrate + integrity warnings + schema heal.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyBaseLogger } from 'fastify';
import { db, pool } from './client.js';
import { checkMigrationIntegrity, healSchemaDrift } from './schemaHeal.js';

type MigrationLogger = Pick<FastifyBaseLogger, 'info' | 'warn'> | Pick<Console, 'info' | 'warn'>;

function logInfo(log: MigrationLogger, obj: unknown, msg?: string): void {
  if ('info' in log && typeof log.info === 'function') {
    if (msg) (log as FastifyBaseLogger).info(obj, msg);
    else (log as FastifyBaseLogger).info(obj);
    return;
  }
  console.info(msg ?? obj, msg ? obj : '');
}

function logWarn(log: MigrationLogger, obj: unknown, msg?: string): void {
  if ('warn' in log && typeof log.warn === 'function') {
    if (msg) (log as FastifyBaseLogger).warn(obj, msg);
    else (log as FastifyBaseLogger).warn(obj);
    return;
  }
  console.warn(msg ?? obj, msg ? obj : '');
}

export async function runMigrations(options?: {
  migrationsFolder?: string;
  log?: MigrationLogger;
}): Promise<void> {
  const migrationsFolder = options?.migrationsFolder ?? process.env.MIGRATIONS_DIR ?? './src/db/migrations';
  const log = options?.log ?? console;

  const integrity = await checkMigrationIntegrity(pool, migrationsFolder);
  for (const warning of integrity.warnings) {
    logWarn(log, { integrity }, warning);
  }

  logInfo(log, { migrationsFolder }, 'applying pending drizzle migrations');
  await migrate(db, { migrationsFolder });

  await healSchemaDrift(pool, {
    info: (obj, msg) => logInfo(log, obj, msg),
    warn: (obj, msg) => logWarn(log, obj, msg),
  });
}
