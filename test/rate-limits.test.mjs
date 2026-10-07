import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite, addIssue, orgIdsOf, CLIENT_FIELD } from './mocks/api.mjs';
import { resetStore } from './mocks/kvs.mjs';
import { handler, handleIssueEvent, clearAdminCacheForTests } from '../src/index.js';
import { retrying, setSleepForTests } from '../src/http.js';

const waits = [];
setSleepForTests(async (ms) => { waits.push(ms); });
const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
const permissionCalls = () => site.requests.filter((r) => r.path.startsWith('/rest/api/3/mypermissions')).length;
const mappings = [{ clientValue: 'RYR', organizationId: '10', organizationName: 'Ryanair' }];
const settings = { enabled: true, clientFieldId: CLIENT_FIELD, projectKeys: ['SD'], mappings };
const updated = (id) => ({ eventType: 'avi:jira:updated:issue', issue: { id: String(id), key: `SD-${id}`, fields: { project: { key: 'SD' } } }, changelog: { items: [{ fieldId: CLIENT_FIELD }] } });

beforeEach(() => { resetSite(3); resetStore(); clearAdminCacheForTests(); waits.length = 0; });

test('a rate-limited request is retried after Retry-After, then succeeds', async () => {
  site.throttle = 2;
  const r = await call('getOrganizationIndexBatch', {});
  assert.equal(r.organizations.length, 3);
  assert.deepEqual(waits, [0, 0], 'waited as Retry-After asked, twice');
});

test('retrying gives up after 3 retries and the screen gets a plain message', async () => {
  site.throttle = 50;
  await assert.rejects(call('getOrganizationIndexBatch', {}), /Jira is busy right now/);
  assert.equal(site.requests.length, 4, 'one try plus three retries, then stop');
});

test('without Retry-After it backs off 1s, 2s, 4s', async () => {
  let n = 0;
  const flaky = retrying({ requestJira: async () => (++n <= 3 ? { status: 429, headers: { get: () => null } } : { status: 200, ok: true }) });
  assert.equal((await flaky.requestJira('/x')).status, 200);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('the admin check is cached per user for 60 seconds; a failed check is not cached', async () => {
  const ctx = { ...DEV, accountId: 'admin-1' };
  for (let i = 0; i < 5; i += 1) await call('getOrganizationIndexBatch', {}, ctx);
  assert.equal(permissionCalls(), 1, 'five screen calls, one permission check');
  site.isAdmin = false;
  await assert.rejects(call('getAppStatus', {}, { ...DEV, accountId: 'someone-else' }), /administrator permission/);
  await assert.rejects(call('getAppStatus', {}, { ...DEV, accountId: 'someone-else' }), /administrator permission/);
  assert.equal(permissionCalls(), 3, 'failed checks are re-checked every time');
});

test('the sync trigger rides out a short 429 burst and still corrects the ticket', async () => {
  await call('saveSyncConfig', settings);
  addIssue({ id: 1, key: 'SD-1', client: 'RYR' });
  site.throttle = 2;
  site.throttlePath = '/rest/api/3/issue/1';
  assert.equal(((await handleIssueEvent(updated(1), {})).organisations).status, 'needs-change');
  assert.deepEqual(orgIdsOf(1), ['10']);
});

test('if Jira keeps rate-limiting, the trigger logs it and returns instead of throwing', async () => {
  await call('saveSyncConfig', settings);
  addIssue({ id: 2, key: 'SD-2', client: 'RYR' });
  site.throttle = 50;
  site.throttlePath = '/rest/api/3/issue/2';
  const r = (await handleIssueEvent(updated(2), {})).organisations;
  assert.equal(r.status, 'rate-limited');
  const entry = (await call('getSyncLog', {})).find((e) => e.issueKey === 'SD-2');
  assert.equal(entry.source, 'failed');
  assert.match(entry.error, /rate-limiting/);
  assert.deepEqual(orgIdsOf(2), []);
});

test("Jira's task limit comes back as a message the browser recognises, and the batch can be sent again", async () => {
  const { site: mockSite } = await import('./mocks/api.mjs');
  const { handler: h } = await import('../src/index.js');
  const { isTaskLimitError } = await import('../static/src/importBatch.js');
  mockSite.taskLimit = 1;
  const send = () => h.bulkUpsertCustomers({ payload: { rows: [{ email: 'limit@x.test', displayName: 'L' }], idempotencyKey: 'limit-1' }, context: { environmentType: 'DEVELOPMENT' } });
  const error = await send().catch((e) => e);
  assert.ok(isTaskLimitError(error), error.message);
  assert.match(error.message, /limit of unfinished customer import tasks/);
  assert.equal(isTaskLimitError(new Error('Valid email required')), false);
  const task = await send();
  assert.ok(task.id, 'accepted once Jira has room');
});
