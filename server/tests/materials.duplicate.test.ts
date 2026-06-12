/**
 * Coverage for material duplicate/branch: naming helper and REST surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  duplicateMaterial: vi.fn(),
  loadMaterialDetail: vi.fn(),
}));

vi.mock('../src/materials/duplicate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/materials/duplicate.js')>();
  return {
    ...actual,
    duplicateMaterial: mocks.duplicateMaterial,
  };
});

vi.mock('../src/materials/loadDetail.js', () => ({
  loadMaterialDetail: mocks.loadMaterialDetail,
  SLOTS_TOTAL: 8,
}));

const state = vi.hoisted(() => ({
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

import { defaultCopyName } from '../src/materials/duplicate.js';

describe('defaultCopyName', () => {
  it('appends (copy) for duplicates', () => {
    expect(defaultCopyName('Brick Wall', false)).toBe('Brick Wall (copy)');
  });

  it('appends (branch) for branches', () => {
    expect(defaultCopyName('Brick Wall', true)).toBe('Brick Wall (branch)');
  });

  it('truncates long names to fit the suffix', () => {
    const long = 'x'.repeat(300);
    const copy = defaultCopyName(long, false);
    expect(copy.endsWith(' (copy)')).toBe(true);
    expect(copy.length).toBeLessThanOrEqual(256);
  });
});

describe('POST /api/materials/:id/duplicate', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  async function buildTestApp() {
    const fastify = Fastify();
    await fastify.register(import('../src/api/materials.js'), { prefix: '/api/materials' });
    return fastify;
  }

  beforeEach(async () => {
    mocks.duplicateMaterial.mockReset();
    mocks.loadMaterialDetail.mockReset();
    state.principal = { kind: 'adminSession', adminUserId: 'admin-1', username: 'admin' };
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 201 with material detail on success', async () => {
    const sourceId = randomUUID();
    const newId = randomUUID();
    const detail = { id: newId, name: 'Test (copy)', branchedFromId: null };
    mocks.duplicateMaterial.mockResolvedValue(newId);
    mocks.loadMaterialDetail.mockResolvedValue(detail);

    const res = await app.inject({
      method: 'POST',
      url: `/api/materials/${sourceId}/duplicate`,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(detail);
    expect(mocks.duplicateMaterial).toHaveBeenCalledWith(sourceId, expect.objectContaining({
      branch: false,
      adminId: 'admin-1',
    }));
  });

  it('passes a custom name through to duplicateMaterial', async () => {
    const sourceId = randomUUID();
    const newId = randomUUID();
    mocks.duplicateMaterial.mockResolvedValue(newId);
    mocks.loadMaterialDetail.mockResolvedValue({ id: newId, name: 'Custom Name' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/materials/${sourceId}/duplicate`,
      payload: { name: 'Custom Name' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.duplicateMaterial).toHaveBeenCalledWith(sourceId, expect.objectContaining({
      name: 'Custom Name',
      branch: false,
    }));
  });

  it('returns 404 when the source material is missing', async () => {
    mocks.duplicateMaterial.mockRejectedValue(new Error('not found'));

    const res = await app.inject({
      method: 'POST',
      url: `/api/materials/${randomUUID()}/duplicate`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('returns 400 for an invalid id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/materials/not-a-uuid/duplicate',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/materials/:id/branch', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  async function buildTestApp() {
    const fastify = Fastify();
    await fastify.register(import('../src/api/materials.js'), { prefix: '/api/materials' });
    return fastify;
  }

  beforeEach(async () => {
    mocks.duplicateMaterial.mockReset();
    mocks.loadMaterialDetail.mockReset();
    state.principal = { kind: 'adminSession', adminUserId: 'admin-1', username: 'admin' };
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('records branch lineage via duplicateMaterial', async () => {
    const sourceId = randomUUID();
    const newId = randomUUID();
    const detail = { id: newId, name: 'Test (branch)', branchedFromId: sourceId };
    mocks.duplicateMaterial.mockResolvedValue(newId);
    mocks.loadMaterialDetail.mockResolvedValue(detail);

    const res = await app.inject({
      method: 'POST',
      url: `/api/materials/${sourceId}/branch`,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(detail);
    expect(mocks.duplicateMaterial).toHaveBeenCalledWith(sourceId, expect.objectContaining({
      branch: true,
      adminId: 'admin-1',
    }));
  });
});
