import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite } from './mocks/api.mjs';
import { handler } from '../src/index.js';
import { lookupOrganisations, prepareOrganisations, attachOrganisationIds, loadAllOrganisations, organisationNote } from '../static/src/organisations.js';

// Calls resolvers the way @forge/bridge does, so the UI helpers run against the real backend code.
// A development context: licensing is tested separately in licensing-and-storage.test.mjs.
const invoke = (name, payload) => handler[name]({ payload, context: { environmentType: 'DEVELOPMENT' } });
const pageRequests = () => site.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/rest/servicedeskapi/organization?')).length;
const created = () => site.requests.filter((r) => r.method === 'POST').length;

beforeEach(() => resetSite(2300));

test('finds organisations beyond the old 1,000-organisation cap, including on the last page', async () => {
  const { found, missing } = await lookupOrganisations(invoke, ['Org 5', 'Org 2200', 'Org 2300']);
  assert.deepEqual([...found.keys()].sort(), ['org 2200', 'org 2300', 'org 5']);
  assert.deepEqual(missing, []);
});

test('matches names case-insensitively, ignores surrounding spaces and blanks, keeps the first spelling', async () => {
  const { found, missing } = await lookupOrganisations(invoke, ['  org 1500 ', 'Brand New Co', 'brand new co', '', null]);
  assert.ok(found.has('org 1500'));
  assert.deepEqual(missing, ['Brand New Co']);
});

test('stops paging once every name is found', async () => {
  await lookupOrganisations(invoke, ['Org 1', 'Org 2']);
  assert.equal(pageRequests(), 1);
});

test('scans a 20,000-organisation site across several resumable resolver calls', async () => {
  resetSite(20000);
  let calls = 0;
  const counting = (name, payload) => { if (name === 'getImportOrganizations') calls += 1; return invoke(name, payload); };
  const { found, missing } = await lookupOrganisations(counting, ['Org 19999', 'Missing Org']);
  assert.ok(found.has('org 19999'));
  assert.deepEqual(missing, ['Missing Org']);
  assert.equal(pageRequests(), 400);
  assert.ok(calls > 1, 'expected more than one resolver call');
});

test('creates only organisations that a complete scan proved missing, and never twice', async () => {
  const first = await prepareOrganisations(invoke, ['Org 1500', 'Brand New Co', 'Another New']);
  assert.deepEqual(first.created.map((o) => o.name), ['Brand New Co', 'Another New']);
  assert.equal(first.organizations.length, 3);
  const second = await prepareOrganisations(invoke, ['brand new co', 'Org 1500']);
  assert.deepEqual(second.created, []);
  assert.equal(created(), 2);
});

test('creates nothing when pagination stalls before the final page', async () => {
  const stalled = async (name, payload) => {
    const r = await invoke(name, payload);
    return name === 'getImportOrganizations' ? { ...r, complete: false, nextStart: payload.start } : r;
  };
  await assert.rejects(prepareOrganisations(stalled, ['Missing Org']), /stopped before the lookup was complete/);
  assert.equal(created(), 0);
});

test('creates missing organisations in chunks of at most 20', async () => {
  const names = Array.from({ length: 45 }, (_, i) => `New ${i}`);
  let createCalls = 0;
  const counting = (name, payload) => { if (name === 'createImportOrganizations') createCalls += 1; return invoke(name, payload); };
  const { created: made } = await prepareOrganisations(counting, names);
  assert.equal(made.length, 45);
  assert.equal(createCalls, 3);
  await assert.rejects(invoke('createImportOrganizations', { names: Array.from({ length: 21 }, (_, i) => `x${i}`) }), /at most 20/);
});

test('attaches organisation ids to rows, leaving rows without an organisation empty', async () => {
  const { rows } = await attachOrganisationIds(invoke, [
    { email: 'a@x.test', organisation: 'Org 1200' },
    { email: 'b@x.test', organisation: 'Fresh Org' },
    { email: 'c@x.test', organisation: '' }
  ]);
  assert.deepEqual(rows[0].organizationIds, ['1200']);
  assert.equal(rows[1].organizationIds.length, 1);
  assert.deepEqual(rows[2].organizationIds, []);
});

test('loads the full organisation list for the Organisations tab', async () => {
  resetSite(4321);
  const progress = [];
  const all = await loadAllOrganisations(invoke, (list, complete) => progress.push([list.length, complete]));
  assert.equal(all.length, 4321);
  assert.equal(new Set(all.map((o) => o.id)).size, 4321);
  assert.deepEqual(progress.at(-1), [4321, true]);
  assert.ok(progress.length > 1, 'expected progressive updates');
});

test('loads an empty site without error', async () => {
  resetSite(0);
  assert.deepEqual(await loadAllOrganisations(invoke), []);
  const { missing } = await lookupOrganisations(invoke, ['Anything']);
  assert.deepEqual(missing, ['Anything']);
});

test('only the missing organisation gets a "will be created" note', () => {
  const existing = new Set(['org 1']);
  assert.equal(organisationNote({ organisation: ' ORG 1 ' }, existing), '');
  assert.equal(organisationNote({ organisation: '' }, existing), '');
  assert.match(organisationNote({ organisation: 'New Co' }, existing), /“New Co” will be created/);
});

test('organisation resolvers require Jira administrator permission', async () => {
  site.isAdmin = false;
  await assert.rejects(invoke('getOrganizationIndexBatch', {}), /administrator permission/);
  await assert.rejects(invoke('createImportOrganizations', { names: ['X'] }), /administrator permission/);
  assert.equal(created(), 0);
});
