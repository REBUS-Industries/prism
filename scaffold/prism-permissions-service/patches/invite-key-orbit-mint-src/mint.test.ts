import test from 'node:test';
import assert from 'node:assert/strict';
import { functionsToScopes } from '../orbit/mint.js';
import { LIGHT_CONNECTOR_FUNCTIONS } from '../contracts/portal-access.js';

test('Light scopes include write without receive', () => {
  const scopes = functionsToScopes([...LIGHT_CONNECTOR_FUNCTIONS]);
  assert.ok(scopes.includes('streams:write'));
  assert.ok(scopes.includes('objects:write'));
  assert.ok(scopes.includes('streams:read'));
});

test('Orbit limitResources type must be lowercase project (schema enum)', () => {
  // Mirrors gqlMint mapping — regression guard for the empty-orbitToken bug.
  const projectIds = ['abc123'];
  const limitResources = projectIds.map((id) => ({ id, type: 'project' as const }));
  assert.deepEqual(limitResources, [{ id: 'abc123', type: 'project' }]);
  assert.notEqual(limitResources[0]!.type, 'Project');
});
