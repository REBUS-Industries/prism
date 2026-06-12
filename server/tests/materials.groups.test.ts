/**
 * Coverage for /api/material-groups CRUD and material groupId assignment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

interface GroupRow {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: Date;
}

interface MaterialRow {
  id: string;
  name: string;
  groupId: string | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

const state = vi.hoisted(() => ({
  groups: [] as GroupRow[],
  materials: [] as MaterialRow[],
  principal: { kind: 'adminSession' as const, adminUserId: 'admin-1', username: 'admin' },
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { principal: typeof state.principal }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!state.principal) { reply.code(401).send({ error: 'authentication required' }); return; }
    req.principal = state.principal;
  },
  requireScope: (_scope: string) => async (
    req: { principal: typeof state.principal },
    reply: { code: (n: number) => { send: (b: unknown) => void } },
  ) => {
    const p = req.principal;
    if (!p) { reply.code(401).send({ error: 'authentication required' }); return; }
    if (p.kind === 'adminSession') return;
    if (p.kind === 'apiKey' && p.scopes.includes(_scope)) return;
    reply.code(403).send({ error: 'forbidden', scope: _scope });
  },
}));

vi.mock('../src/db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/schema.js')>();
  return actual;
});

const mocks = vi.hoisted(() => ({
  loadMaterialDetail: vi.fn(),
}));

vi.mock('../src/materials/loadDetail.js', () => ({
  loadMaterialDetail: mocks.loadMaterialDetail,
  SLOTS_TOTAL: 8,
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    query: {
      materialGroups: {
        findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
          void where;
          return null;
        }),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { db } from '../src/db/client.js';

function installGroupDbMocks() {
  vi.mocked(db.query.materialGroups.findFirst).mockImplementation(async () => null);

  vi.mocked(db.select).mockImplementation((shape?: unknown) => ({
    from: () => {
      const rowsPromise = (async () => {
        if (shape && typeof shape === 'object' && 'maxOrder' in (shape as object)) {
          const maxOrder = state.groups.reduce((max, g) => Math.max(max, g.sortOrder), -1);
          return [{ maxOrder }];
        }
        return [...state.groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      })();
      return {
        orderBy: () => rowsPromise,
        then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => rowsPromise.then(resolve, reject),
      };
    },
  }) as never);

  vi.mocked(db.insert).mockImplementation(() => ({
    values: (vals: Partial<GroupRow>) => ({
      returning: async () => {
        const row: GroupRow = {
          id: randomUUID(),
          name: vals.name ?? 'Group',
          sortOrder: vals.sortOrder ?? 0,
          createdAt: new Date(),
        };
        state.groups.push(row);
        return [row];
      },
    }),
  }) as never);

  vi.mocked(db.update).mockImplementation(() => ({
    set: (patch: Partial<GroupRow & MaterialRow>) => ({
      where: (where: unknown) => {
        const w = where as { id?: string; materialIds?: string[]; groupId?: string; materialId?: string };
        return {
          returning: async () => {
            if (w.groupId !== undefined) {
              const row = state.groups.find((g) => g.id === w.groupId);
              if (!row) return [];
              Object.assign(row, patch);
              return [row];
            }
            if (w.materialIds) {
              const updated = state.materials.filter(
                (m) => w.materialIds!.includes(m.id) && m.deletedAt === null,
              );
              for (const m of updated) {
                if ('groupId' in patch) m.groupId = patch.groupId ?? null;
              }
              return updated.map((m) => ({ id: m.id }));
            }
            if (w.materialId) {
              const row = state.materials.find((m) => m.id === w.materialId && m.deletedAt === null);
              if (!row) return [];
              if ('groupId' in patch) row.groupId = patch.groupId ?? null;
              return [{ id: row.id }];
            }
            return [];
          },
        };
      },
    }),
  }) as never);

  vi.mocked(db.delete).mockImplementation(() => ({
    where: (where: unknown) => {
      const w = where as { groupId?: string };
      return {
        returning: async () => {
          const idx = state.groups.findIndex((g) => g.id === w.groupId);
          if (idx < 0) return [];
          const [removed] = state.groups.splice(idx, 1);
          for (const m of state.materials) {
            if (m.groupId === removed.id) m.groupId = null;
          }
          return [{ id: removed.id }];
        },
      };
    },
  }) as never);
}

// Patch drizzle helpers used by the routes to carry plain ids for the mock above.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();

  function tableName(col: unknown): string {
    const c = col as { table?: Record<symbol, string> };
    const sym = Object.getOwnPropertySymbols(c.table ?? {}).find((s) => String(s).includes('Name'));
    return sym ? (c.table![sym] ?? '') : '';
  }

  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      const c = col as { name?: string };
      const t = tableName(col);
      if (t === 'material_groups' && c.name === 'id') return { groupId: val };
      if (t === 'materials' && c.name === 'id') return { materialId: val };
      return actual.eq(col as never, val as never);
    },
    and: (...args: unknown[]) => {
      const idsNode = args.find((a) => a && typeof a === 'object' && 'materialIds' in (a as object)) as { materialIds?: string[] } | undefined;
      const idNode = args.find((a) => a && typeof a === 'object' && 'materialId' in (a as object)) as { materialId?: string } | undefined;
      const groupNode = args.find((a) => a && typeof a === 'object' && 'groupId' in (a as object)) as { groupId?: string } | undefined;
      if (idsNode?.materialIds) return { materialIds: idsNode.materialIds };
      if (idNode?.materialId) return { materialId: idNode.materialId };
      if (groupNode?.groupId) return { groupId: groupNode.groupId };
      return actual.and(...args as never[]);
    },
    inArray: (col: unknown, vals: unknown) => {
      if (tableName(col) === 'materials') return { materialIds: vals };
      return actual.inArray(col as never, vals as never);
    },
  };
});

async function buildGroupsApp() {
  const app = Fastify();
  await app.register(import('../src/api/materialGroups.js'), { prefix: '/api/material-groups' });
  return app;
}

async function buildMaterialsApp() {
  const app = Fastify();
  await app.register(import('../src/api/materials.js'), { prefix: '/api/materials' });
  return app;
}

describe('/api/material-groups', () => {
  let app: Awaited<ReturnType<typeof buildGroupsApp>>;

  beforeEach(async () => {
    state.groups = [];
    state.materials = [];
    state.principal = { kind: 'adminSession', adminUserId: 'admin-1', username: 'admin' };
    installGroupDbMocks();
    vi.mocked(db.query.materialGroups.findFirst).mockImplementation(async ({ where }: { where: { groupId?: string } }) => {
      const id = (where as { groupId?: string }).groupId;
      return state.groups.find((g) => g.id === id) ?? null;
    });
    app = await buildGroupsApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists groups in sort order', async () => {
    state.groups.push(
      { id: 'g2', name: 'B', sortOrder: 1, createdAt: new Date() },
      { id: 'g1', name: 'A', sortOrder: 0, createdAt: new Date() },
    );

    const res = await app.inject({ method: 'GET', url: '/api/material-groups' });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.map((g: { id: string }) => g.id)).toEqual(['g1', 'g2']);
  });

  it('creates a group with the next sort order', async () => {
    state.groups.push({ id: 'g1', name: 'Existing', sortOrder: 3, createdAt: new Date() });

    const res = await app.inject({
      method: 'POST',
      url: '/api/material-groups',
      payload: { name: 'New group' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('New group');
    expect(body.sortOrder).toBe(4);
  });

  it('renames a group via PATCH', async () => {
    const groupId = randomUUID();
    state.groups.push({ id: groupId, name: 'Old', sortOrder: 0, createdAt: new Date() });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/material-groups/${groupId}`,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed');
  });

  it('deletes a group', async () => {
    const groupId = randomUUID();
    state.groups.push({ id: groupId, name: 'Trash me', sortOrder: 0, createdAt: new Date() });

    const res = await app.inject({ method: 'DELETE', url: `/api/material-groups/${groupId}` });
    expect(res.statusCode).toBe(204);
    expect(state.groups).toHaveLength(0);
  });

  it('bulk-assigns materials to a group', async () => {
    const groupId = randomUUID();
    state.groups.push({ id: groupId, name: 'Shelf', sortOrder: 0, createdAt: new Date() });
    const m1 = randomUUID();
    const m2 = randomUUID();
    state.materials.push(
      { id: m1, name: 'A', groupId: null, deletedAt: null, updatedAt: new Date() },
      { id: m2, name: 'B', groupId: null, deletedAt: null, updatedAt: new Date() },
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/material-groups/${groupId}/materials`,
      payload: { materialIds: [m1, m2] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().assigned).toBe(2);
    expect(state.materials.every((m) => m.groupId === groupId)).toBe(true);
  });
});

describe('PUT /api/materials/:id groupId', () => {
  let app: Awaited<ReturnType<typeof buildMaterialsApp>>;
  const groupId = randomUUID();
  const materialId = randomUUID();

  beforeEach(async () => {
    state.groups = [{ id: groupId, name: 'Group', sortOrder: 0, createdAt: new Date() }];
    state.materials = [{
      id: materialId,
      name: 'Mat',
      groupId: null,
      deletedAt: null,
      updatedAt: new Date(),
    }];
    mocks.loadMaterialDetail.mockReset();
    state.principal = { kind: 'adminSession', adminUserId: 'admin-1', username: 'admin' };
    installGroupDbMocks();
    vi.mocked(db.query.materialGroups.findFirst).mockImplementation(async ({ where }: { where: { groupId?: string } }) => {
      const id = (where as { groupId?: string }).groupId;
      return state.groups.find((g) => g.id === id) ?? null;
    });
    app = await buildMaterialsApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('assigns a material to a group', async () => {
    mocks.loadMaterialDetail.mockResolvedValue({ id: materialId, name: 'Mat', groupId });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/materials/${materialId}`,
      payload: { groupId },
    });

    expect(res.statusCode).toBe(200);
    expect(state.materials[0]!.groupId).toBe(groupId);
  });

  it('clears group membership with null groupId', async () => {
    state.materials[0]!.groupId = groupId;
    mocks.loadMaterialDetail.mockResolvedValue({ id: materialId, name: 'Mat', groupId: null });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/materials/${materialId}`,
      payload: { groupId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(state.materials[0]!.groupId).toBeNull();
  });

  it('returns 400 when the group does not exist', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/materials/${materialId}`,
      payload: { groupId: randomUUID() },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'group not found' });
  });
});
