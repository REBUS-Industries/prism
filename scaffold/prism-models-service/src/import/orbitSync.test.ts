import assert from 'node:assert/strict';
import type { OrbitModelSummary } from '@rebus-industries/prism-shared/orbit';
import { emptyModelDefinition, type ModelDefinition } from '../contracts/models.js';
import {
  ORBIT_CONNECTOR_SOURCE,
  buildSyncedDefinition,
  orbitModelDisplayName,
  planOrbitSync,
  type ExistingModelRow,
} from './orbitSync.js';

const projectId = 'proj-models';

function orbitItem(id: string, name: string, extra: Partial<OrbitModelSummary> = {}): OrbitModelSummary {
  return { id, name, ...extra };
}

function row(
  id: string,
  name: string,
  opts: {
    deleted?: boolean;
    orbitModelId?: string;
    orbitProjectId?: string;
    importSource?: string;
  } = {},
): ExistingModelRow {
  const def: ModelDefinition = emptyModelDefinition();
  const metadata: Record<string, unknown> = {};
  if (opts.orbitModelId) {
    metadata.orbit = {
      target: 'prod',
      projectId: opts.orbitProjectId ?? projectId,
      modelId: opts.orbitModelId,
    };
  }
  if (opts.importSource) metadata.importSource = opts.importSource;
  if (Object.keys(metadata).length) def.metadata = metadata;
  return { id, name, deletedAt: opts.deleted ? new Date() : null, definition: def };
}

// --- create / link / skip -------------------------------------------------
{
  const items = [
    orbitItem('o-skip', 'Already Linked'),
    orbitItem('o-link', 'Existing Manual'),
    orbitItem('o-new', 'Brand New', { displayName: 'Brand New' }),
  ];
  const rows = [
    row('r-skip', 'Already Linked', { orbitModelId: 'o-skip' }),
    row('r-link', 'Existing Manual'),
    row('r-unrelated', 'Something Else'),
  ];
  const plan = planOrbitSync(items, rows, projectId);
  assert.deepEqual(plan.skip.map((i) => i.id), ['o-skip']);
  assert.deepEqual(
    plan.link.map((l) => ({ rowId: l.rowId, id: l.orbit.id })),
    [{ rowId: 'r-link', id: 'o-link' }],
  );
  assert.deepEqual(plan.create.map((i) => i.id), ['o-new']);
  assert.deepEqual(plan.prune, []);
}

// --- dedup against an in-flight Prism import row --------------------------
{
  // A Prism import already stored the Orbit ref while converting; listing the
  // project must not create a duplicate library row for the same Orbit model.
  const items = [orbitItem('o-import', 'My Truss')];
  const rows = [row('r-import', 'My Truss', { orbitModelId: 'o-import' })];
  const plan = planOrbitSync(items, rows, projectId);
  assert.deepEqual(plan.skip.map((i) => i.id), ['o-import']);
  assert.equal(plan.create.length, 0);
  assert.equal(plan.link.length, 0);
}

// --- name match is case/whitespace-insensitive ---------------------------
{
  const items = [orbitItem('o-1', '  Omega Robe ', { displayName: 'omega robe' })];
  const rows = [row('r-1', 'Omega Robe')];
  const plan = planOrbitSync(items, rows, projectId);
  assert.deepEqual(plan.link.map((l) => l.rowId), ['r-1']);
}

// --- soft-deleted rows are not resurrected nor name-linked ----------------
{
  // Linked-then-deleted: skipped via Orbit id (no recreate).
  const deletedLinked = planOrbitSync(
    [orbitItem('o-del', 'Deleted One')],
    [row('r-del', 'Deleted One', { orbitModelId: 'o-del', deleted: true })],
    projectId,
  );
  assert.deepEqual(deletedLinked.skip.map((i) => i.id), ['o-del']);
  assert.equal(deletedLinked.create.length, 0);
  assert.equal(deletedLinked.link.length, 0);

  // Deleted row with a matching name but no Orbit ref must not be linked.
  const deletedByName = planOrbitSync(
    [orbitItem('o-ghost', 'Ghost')],
    [row('r-ghost', 'Ghost', { deleted: true })],
    projectId,
  );
  assert.deepEqual(deletedByName.create.map((i) => i.id), ['o-ghost']);
  assert.equal(deletedByName.link.length, 0);
}

// --- prune targets any Orbit-linked row whose model disappeared -----------
{
  const items = [orbitItem('o-keep', 'Keeper')];
  const rows = [
    row('r-keep', 'Keeper', { orbitModelId: 'o-keep', importSource: ORBIT_CONNECTOR_SOURCE }),
    row('r-gone', 'Gone Connector', { orbitModelId: 'o-gone', importSource: ORBIT_CONNECTOR_SOURCE }),
    row('r-prism', 'Gone Prism Upload', { orbitModelId: 'o-prism-gone' }),
    row('r-local', 'Local Only Draft'),
    row('r-gone-deleted', 'Already Removed', {
      orbitModelId: 'o-also-gone',
      importSource: ORBIT_CONNECTOR_SOURCE,
      deleted: true,
    }),
  ];

  const additive = planOrbitSync(items, rows, projectId);
  assert.deepEqual(additive.prune, []);

  const strict = planOrbitSync(items, rows, projectId, { prune: true });
  assert.deepEqual(new Set(strict.prune), new Set(['r-gone', 'r-prism']));
  assert.ok(!strict.prune.includes('r-local'));
  assert.ok(!strict.prune.includes('r-gone-deleted'));
  assert.ok(!strict.prune.includes('r-keep'));
}

// --- a single row is never linked to two Orbit models in one run ----------
{
  const items = [orbitItem('o-a', 'Dup Name'), orbitItem('o-b', 'Dup Name')];
  const rows = [row('r-dup', 'Dup Name')];
  const plan = planOrbitSync(items, rows, projectId);
  assert.equal(plan.link.length, 1);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.link[0]!.rowId, 'r-dup');
}

// --- display name resolution ---------------------------------------------
assert.equal(orbitModelDisplayName(orbitItem('x', 'folder/Name', { displayName: 'Name' })), 'Name');
assert.equal(orbitModelDisplayName(orbitItem('x', 'OnlyName')), 'OnlyName');
assert.equal(orbitModelDisplayName(orbitItem('x', '')), 'Untitled model');

// --- synced definition carries the Orbit ref + provenance ----------------
{
  const def = buildSyncedDefinition('prod', projectId, orbitItem('o-z', 'Z', { previewUrl: 'https://x/p.png' }));
  const meta = def.metadata as Record<string, unknown>;
  assert.deepEqual(meta.orbit, { target: 'prod', projectId, modelId: 'o-z' });
  assert.equal(meta.importSource, ORBIT_CONNECTOR_SOURCE);
  assert.equal(meta.orbitPreviewUrl, 'https://x/p.png');

  const noPreview = buildSyncedDefinition('dev', projectId, orbitItem('o-y', 'Y'));
  assert.equal((noPreview.metadata as Record<string, unknown>).orbitPreviewUrl, undefined);
}

console.log('orbitSync tests passed');
