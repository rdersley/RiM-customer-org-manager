import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite } from './mocks/api.mjs';
import { resetStore } from './mocks/kvs.mjs';
import { handler } from '../src/index.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
const row = (n, email, organizationIds = []) => ({ rowNumber: n, email, displayName: `Person ${n}`, organizationIds });

beforeEach(() => { resetSite(3); resetStore(); });

test('an import adds the organisations it uses to the service project, so the space shows them', async () => {
  const rows = [row(2, 'a@x.test', ['1']), row(3, 'b@x.test', ['1', '2'])];
  await call('bulkUpsertCustomers', { rows });
  await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  assert.deepEqual([...site.projectOrgs.get('SD')].sort(), ['1', '2']);
});

test('an organisation the space refuses is reported on the rows that use it', async () => {
  site.failMembership.add('deskorg:2');
  const rows = [row(2, 'a@x.test', ['1']), row(3, 'b@x.test', ['2'])];
  await call('bulkUpsertCustomers', { rows });
  const { results } = await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  assert.equal(results.find((r) => r.email === 'a@x.test').status, 'done');
  const b = results.find((r) => r.email === 'b@x.test');
  assert.equal(b.status, 'failed');
  assert.match(b.error, /Organisation 2 not added to the service project: You cannot add this organization/);
});

test('repair: list the organisations in a space, then add the chosen ones', async () => {
  site.projectOrgs.set('SD', ['1']);
  const before = await call('getServiceDeskOrganizationBatch', { serviceDeskId: '1' });
  assert.deepEqual(before, { ids: ['1'], nextStart: 0, complete: true });
  site.failMembership.add('deskorg:3');
  const r = await call('addOrganizationsToServiceDesk', { serviceDeskId: '1', organizationIds: ['2', '3', '2', 'x'] });
  assert.deepEqual(r.added, ['2']);
  assert.deepEqual(r.failed.map((f) => f.id), ['3']);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(site.projectOrgs.get('SD'), ['1', '2']);
  await assert.rejects(call('addOrganizationsToServiceDesk', { serviceDeskId: 'abc', organizationIds: ['2'] }), /serviceDeskId/);
});
