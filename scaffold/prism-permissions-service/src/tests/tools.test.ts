import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolGrants } from '../contracts/portal-access.js';
import { filterStaleRoleGrants } from '../access/tools.js';

test('filterStaleRoleGrants keeps live portal roles and drops stale grant keys', () => {
  const { grants, removed } = filterStaleRoleGrants(
    {
      roles: {
        'super-admin': ['convert', 'visualiser'],
        staff: ['convert'],
        viewer: ['visualiser'],
        l3WSTHHLkwd2KU: ['fixtures'],
      },
      users: { 'alice@rebus.industries': ['models'] },
    },
    ['super-admin', 'l3WSTHHLkwd2KU'],
  );

  assert.deepEqual(removed.sort(), ['staff', 'viewer']);
  assert.deepEqual(Object.keys(grants.roles ?? {}).sort(), ['l3WSTHHLkwd2KU', 'super-admin']);
  assert.deepEqual(grants.users, { 'alice@rebus.industries': ['models'] });
});

test('filterStaleRoleGrants is a no-op when every grant role is live', () => {
  const input: ToolGrants = {
    roles: { admin: ['convert'] },
    users: {},
  };
  const { grants, removed } = filterStaleRoleGrants(input, ['admin']);
  assert.deepEqual(removed, []);
  assert.deepEqual(grants, input);
});
