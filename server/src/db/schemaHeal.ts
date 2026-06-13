/**
 * Heal schema drift when drizzle.__drizzle_migrations records a migration as
 * applied but the DDL never ran (manual journal inserts, partial deploys, etc.).
 *
 * Each step is idempotent — safe to run on every boot.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

export interface SchemaHealStep {
  /** Matches migration tag for traceability */
  id: string;
  description: string;
  /** Returns a row when the schema element already exists */
  probeSql: string;
  /** Idempotent DDL applied when probe returns no rows */
  healSql: string;
}

/** Idempotent DDL mirrored from migrations 0012 + 0013. Extend when new drift-prone migrations ship. */
export const SCHEMA_HEAL_STEPS: SchemaHealStep[] = [
  {
    id: '0012_material_branch',
    description: 'materials.branched_from_id column and self-referential FK',
    probeSql: `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'materials'
        AND column_name = 'branched_from_id'
      LIMIT 1`,
    healSql: `
      ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "branched_from_id" uuid;
      DO $$ BEGIN
        ALTER TABLE "materials" ADD CONSTRAINT "materials_branched_from_id_materials_id_fk"
          FOREIGN KEY ("branched_from_id") REFERENCES "public"."materials"("id")
          ON DELETE set null ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;`,
  },
  {
    id: '0013_material_groups',
    description: 'material_groups table, materials.group_id column, and FK',
    probeSql: `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'material_groups'
      LIMIT 1`,
    healSql: `
      CREATE TABLE IF NOT EXISTS "material_groups" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "name" varchar(128) NOT NULL,
        "sort_order" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "material_groups_sort_order_idx"
        ON "material_groups" USING btree ("sort_order");
      ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "group_id" uuid;
      DO $$ BEGIN
        ALTER TABLE "materials" ADD CONSTRAINT "materials_group_id_material_groups_id_fk"
          FOREIGN KEY ("group_id") REFERENCES "public"."material_groups"("id")
          ON DELETE set null ON UPDATE no action;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;`,
  },
];

export interface MigrationIntegrityReport {
  journalCount: number;
  appliedCount: number;
  hashMismatches: Array<{ tag: string; expectedHash: string; appliedHash: string | null }>;
  warnings: string[];
}

type HealLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

const noopLogger: HealLogger = {
  info: () => {},
  warn: () => {},
};

function migrationFileHash(migrationsFolder: string, tag: string): string {
  const filePath = path.join(migrationsFolder, `${tag}.sql`);
  const query = readFileSync(filePath, 'utf8');
  return createHash('sha256').update(query).digest('hex');
}

function readJournalTags(migrationsFolder: string): Array<{ tag: string; when: number }> {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`migration journal not found: ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries;
}

/** Compare journal hashes vs drizzle.__drizzle_migrations — surfaces manual journal inserts. */
export async function checkMigrationIntegrity(
  pool: pg.Pool,
  migrationsFolder: string,
): Promise<MigrationIntegrityReport> {
  const journal = readJournalTags(migrationsFolder);
  const { rows } = await pool.query<{ hash: string; created_at: string }>(
    'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC',
  );

  const warnings: string[] = [];
  const hashMismatches: MigrationIntegrityReport['hashMismatches'] = [];

  if (rows.length > journal.length) {
    warnings.push(
      `drizzle.__drizzle_migrations has ${rows.length} rows but the journal lists ${journal.length}; `
      + 'extra rows usually mean migrations were inserted without running SQL — schema heal will attempt recovery',
    );
  }

  for (let i = 0; i < journal.length; i++) {
    const { tag } = journal[i]!;
    const expectedHash = migrationFileHash(migrationsFolder, tag);
    const applied = rows[i];
    if (!applied) continue;

    if (applied.hash !== expectedHash) {
      hashMismatches.push({ tag, expectedHash, appliedHash: applied.hash });
      warnings.push(
        `migration ${tag}: journal SQL hash ${expectedHash.slice(0, 12)}… does not match applied `
        + `${applied.hash.slice(0, 12)}… — file may have been edited after a manual journal insert`,
      );
    }

    const when = journal[i]!.when;
    // drizzle-kit uses millisecond precision; hand-edited journal rows are often rounded to 10M ms.
    if (when % 10_000_000 === 0) {
      warnings.push(
        `migration ${tag}: journal timestamp ${when} looks hand-rounded — verify it was generated via drizzle-kit, not hand-edited`,
      );
    }
  }

  return {
    journalCount: journal.length,
    appliedCount: rows.length,
    hashMismatches,
    warnings,
  };
}

/** Run idempotent heal SQL for any schema elements that are still missing. */
export async function healSchemaDrift(
  pool: pg.Pool,
  log: HealLogger = noopLogger,
): Promise<{ healed: string[]; alreadyOk: string[] }> {
  const healed: string[] = [];
  const alreadyOk: string[] = [];

  for (const step of SCHEMA_HEAL_STEPS) {
    const probe = await pool.query(step.probeSql);
    if (probe.rowCount && probe.rowCount > 0) {
      alreadyOk.push(step.id);
      continue;
    }

    log.warn(
      { step: step.id, description: step.description },
      'schema heal: applying missing DDL',
    );
    await pool.query(step.healSql);

    const verify = await pool.query(step.probeSql);
    if (!verify.rowCount || verify.rowCount === 0) {
      throw new Error(`schema heal failed for ${step.id}: probe still empty after heal SQL`);
    }
    healed.push(step.id);
  }

  if (healed.length) {
    log.warn({ healed }, 'schema heal recovered missing columns/tables');
  }

  return { healed, alreadyOk };
}
