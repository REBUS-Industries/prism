/**
 * Schema heal + migration integrity checks.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  SCHEMA_HEAL_STEPS,
  checkMigrationIntegrity,
  healSchemaDrift,
} from '../src/db/schemaHeal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(here, '../src/db/migrations');

function migrationHash(tag: string): string {
  const query = readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8');
  return createHash('sha256').update(query).digest('hex');
}

describe('healSchemaDrift', () => {
  it('applies heal SQL only for missing schema elements', async () => {
    const satisfied = new Set(['0012_material_branch']);
    const healedIds: string[] = [];

    const pool = {
      query: vi.fn(async (sql: string) => {
        for (const step of SCHEMA_HEAL_STEPS) {
          if (sql.includes(step.probeSql.trim().split('\n')[1]!.trim())) {
            const ok = satisfied.has(step.id);
            return { rows: ok ? [{}] : [], rowCount: ok ? 1 : 0 };
          }
        }
        for (const step of SCHEMA_HEAL_STEPS) {
          if (sql.includes('ADD COLUMN IF NOT EXISTS') && sql.includes('branched_from_id')) {
            healedIds.push(step.id);
            satisfied.add(step.id);
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes('CREATE TABLE IF NOT EXISTS') && sql.includes('material_groups')) {
            healedIds.push('0013_material_groups');
            satisfied.add('0013_material_groups');
            return { rows: [], rowCount: 0 };
          }
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const result = await healSchemaDrift(pool as never);

    expect(result.alreadyOk).toContain('0012_material_branch');
    expect(result.healed).toContain('0013_material_groups');
    expect(healedIds).toContain('0013_material_groups');
  });

  it('is a no-op when all probes succeed', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{}], rowCount: 1 })),
    };

    const result = await healSchemaDrift(pool as never);
    expect(result.healed).toEqual([]);
    expect(result.alreadyOk).toHaveLength(SCHEMA_HEAL_STEPS.length);
  });

  it('throws when heal SQL does not satisfy the probe', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    await expect(healSchemaDrift(pool as never)).rejects.toThrow(/schema heal failed/);
  });
});

describe('checkMigrationIntegrity', () => {
  it('flags extra rows in drizzle.__drizzle_migrations', async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const rows = journal.entries.map((e, i) => ({
      hash: migrationHash(e.tag),
      created_at: String(1_700_000_000_000 + i),
    }));
    rows.push({ hash: 'phantom', created_at: '1800000000000' });

    const pool = {
      query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    };

    const report = await checkMigrationIntegrity(pool as never, migrationsFolder);

    expect(report.appliedCount).toBe(journal.entries.length + 1);
    expect(report.warnings.some((w) => w.includes('extra rows'))).toBe(true);
  });

  it('flags hash mismatch between journal SQL and applied record', async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const rows = journal.entries.map((e, i) => ({
      hash: i === journal.entries.length - 1 ? 'deadbeef'.repeat(8) : migrationHash(e.tag),
      created_at: String(1_700_000_000_000 + i),
    }));

    const pool = {
      query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    };

    const report = await checkMigrationIntegrity(pool as never, migrationsFolder);

    expect(report.hashMismatches).toHaveLength(1);
    expect(report.hashMismatches[0]?.tag).toBe(journal.entries.at(-1)?.tag);
  });

  it('flags hand-rounded journal timestamps on 0012/0013', async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const rows = journal.entries.map((e, i) => ({
      hash: migrationHash(e.tag),
      created_at: String(1_700_000_000_000 + i),
    }));

    const pool = {
      query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    };

    const report = await checkMigrationIntegrity(pool as never, migrationsFolder);

    expect(report.warnings.some((w) => w.includes('0012_material_branch'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('0013_material_groups'))).toBe(true);
  });
});
