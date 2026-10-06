import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite } from './mocks/api.mjs';
import { store, resetStore } from './mocks/kvs.mjs';
import { handler } from '../src/index.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
const fingerprint = 'b'.repeat(64);
const row = (n, email, organizationIds = []) => ({ rowNumber: n, email, displayName: `Person ${n}`, organizationIds });

beforeEach(() => { resetSite(0); resetStore(); });

test('the bulk request no longer carries organisations (membership is added by finalise)', async () => {
  await call('bulkUpsertCustomers', { rows: [row(2, 'a@x.test', ['10'])] });
  assert.deepEqual(site.bulkRequests[0].customerProfiles, [{ operationType: 'UPSERT', payload: { email: 'a@x.test', displayName: 'Person 2' } }]);
});

test('finalise adds every found customer to the service project and to their organisations', async () => {
  const rows = [row(2, 'a@x.test', ['10']), row(3, 'b@x.test', ['10', '20']), row(4, 'c@x.test')];
  await call('bulkUpsertCustomers', { rows });
  const { results, linked, problems } = await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  assert.equal(linked, 3);
  assert.equal(problems, 0);
  const id = (email) => site.accounts.get(email).accountId;
  assert.deepEqual([...site.deskCustomers.get('1')].sort(), [id('a@x.test'), id('b@x.test'), id('c@x.test')].sort());
  assert.deepEqual([...site.orgMembers.get('10')].sort(), [id('a@x.test'), id('b@x.test')].sort());
  assert.deepEqual([...site.orgMembers.get('20')], [id('b@x.test')]);
  assert.ok(results.every((r) => r.status === 'done' && r.accountId));
});

test('rows Jira rejected are reported as not found; the rest still finish', async () => {
  const rows = [row(2, 'ok@x.test'), row(3, 'reject-me@x.test')];
  await call('bulkUpsertCustomers', { rows });
  const { results, linked } = await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  assert.equal(linked, 1);
  assert.equal(results.find((r) => r.rowNumber === 3).status, 'not-found');
  assert.match(results.find((r) => r.rowNumber === 3).error, /no customer account/);
});

test('an organisation that refuses members fails only the rows that needed it, with the reason', async () => {
  site.failMembership.add('org:30');
  const rows = [row(2, 'a@x.test', ['30']), row(3, 'b@x.test', ['10'])];
  await call('bulkUpsertCustomers', { rows });
  const { results } = await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  const a = results.find((r) => r.rowNumber === 2);
  assert.equal(a.status, 'failed');
  assert.match(a.error, /Not added to organisation 30: Organization does not exist/);
  assert.equal(results.find((r) => r.rowNumber === 3).status, 'done');
  assert.ok(site.deskCustomers.get('1').has(a.accountId), 'still added to the service project');
});

test('email matching: exact when Jira shows emails; one result is accepted when it hides them; ambiguity is not', async () => {
  await call('bulkUpsertCustomers', { rows: [row(2, 'sam@x.test'), row(3, 'sam@x.test.org')] });
  // "sam@x.test" also substring-matches "sam@x.test.org"; exact email match must pick the right one.
  let { results } = await call('finaliseImportBatch', { rows: [row(2, 'sam@x.test')], serviceDeskId: '1' });
  assert.equal(results[0].accountId, site.accounts.get('sam@x.test').accountId);

  site.hideEmails = true;
  await call('bulkUpsertCustomers', { rows: [row(4, 'unique@y.test')] });
  ({ results } = await call('finaliseImportBatch', { rows: [row(4, 'unique@y.test')], serviceDeskId: '1' }));
  assert.equal(results[0].status, 'done', 'a single match is accepted when emails are hidden');
  ({ results } = await call('finaliseImportBatch', { rows: [row(2, 'sam@x.test')], serviceDeskId: '1' }));
  assert.equal(results[0].status, 'not-found', 'two hidden-email matches are not guessed');
});

test('finalise is idempotent: running it twice adds no duplicates', async () => {
  const rows = [row(2, 'a@x.test', ['10'])];
  await call('bulkUpsertCustomers', { rows });
  await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  await call('finaliseImportBatch', { rows, serviceDeskId: '1' });
  assert.equal(site.deskCustomers.get('1').size, 1);
  assert.equal(site.orgMembers.get('10').size, 1);
});

test('a resumed session: submitted-but-unfinalised batches stay incomplete; legacy batches count as done', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => i + 2);
  await call('startImportSession', { id: 's', fingerprint, serviceDeskId: '1', actionableRowNumbers: rows, totalRows: 150, totalBatches: 2 });
  await call('bulkUpsertCustomers', { rows: [row(2, 'a@x.test')], importSessionId: 's', batchNumber: 1, totalBatches: 2, idempotencyKey: 's-1' });
  let session = store.get('import-session:s');
  assert.equal(session.completedBatches, 0);
  assert.equal(session.batches[0].finalised, false);
  await call('finaliseImportBatch', { rows: [row(2, 'a@x.test')], serviceDeskId: '1', importSessionId: 's', batchNumber: 1, totalBatches: 2 });
  session = store.get('import-session:s');
  assert.equal(session.completedBatches, 1);
  assert.equal(session.status, 'IN_PROGRESS');

  // A batch recorded before finalising existed (no `finalised` field) counts as complete.
  store.set('import-session:legacy', { id: 'legacy', totalBatches: 1, batches: [{ batchNumber: 1, count: 5 }] });
  await call('finaliseImportBatch', { rows: [row(2, 'a@x.test')], serviceDeskId: '1', importSessionId: 'legacy', batchNumber: 1, totalBatches: 1 });
  assert.equal(store.get('import-session:legacy').status, 'SUBMITTED');
});

test('finalise validates input and is licence-gated', async () => {
  await assert.rejects(call('finaliseImportBatch', { rows: [row(2, 'a@x.test')] }), /serviceDeskId is required/);
  await assert.rejects(call('finaliseImportBatch', { rows: [], serviceDeskId: '1' }), /No rows/);
  await assert.rejects(call('finaliseImportBatch', { rows: Array.from({ length: 101 }, (_, i) => row(i + 2, `p${i}@x.test`)), serviceDeskId: '1' }), /at most 100/);
  await assert.rejects(call('finaliseImportBatch', { rows: [row(2, 'a@x.test')], serviceDeskId: '1' }, { environmentType: 'PRODUCTION' }), /no active licence/);
});

// ---- the browser side (static/src/importBatch.js) against the real resolvers ----
import { waitForTask, submitAndFinaliseBatch, problemRowsCsv } from '../static/src/importBatch.js';
import { attachOrganisationIds } from '../static/src/organisations.js';

const invoke = (name, payload) => call(name, payload);
const fastClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('waitForTask returns on a terminal status (including FAILED) and times out otherwise', async () => {
  assert.equal(await waitForTask(invoke, 'task-1', fastClock()), 'FAILED');
  let calls = 0;
  const running = async () => { calls += 1; return { status: 'IN_PROGRESS' }; };
  assert.equal(await waitForTask(running, 't', { ...fastClock(), timeoutMs: 10000, intervalMs: 2000 }), 'TIMED_OUT');
  assert.equal(calls, 6);
});

test('a two-batch import from the browser side ends with everyone in the project and their organisation', async () => {
  resetSite(3); // orgs 1..3 exist
  const rows = Array.from({ length: 150 }, (_, i) => ({ rowNumber: i + 2, email: `p${i}@x.test`, displayName: `P${i}`, organisation: i % 2 ? 'Org 2' : 'Brand New' }));
  const { rows: mapped, created } = await attachOrganisationIds(invoke, rows);
  assert.equal(created.length, 1);
  const chunks = [mapped.slice(0, 100), mapped.slice(100)];
  await call('startImportSession', { id: 'imp', fingerprint, serviceDeskId: '1', actionableRowNumbers: mapped.map((r) => r.rowNumber), totalRows: 150, totalBatches: 2 });
  const plan = { sessionId: 'imp', serviceDeskId: '1', chunks };
  const results = [];
  for (let i = 0; i < 2; i += 1) results.push(await submitAndFinaliseBatch(invoke, plan, i, fastClock()));
  assert.deepEqual(results.map((r) => [r.linked, r.problems.length, r.taskStatus]), [[100, 0, 'FAILED'], [50, 0, 'FAILED']]);
  assert.equal(site.deskCustomers.get('1').size, 150);
  assert.equal(site.orgMembers.get('2').size, 75);
  assert.equal(site.orgMembers.get(created[0].id).size, 75);
  assert.equal(store.get('import-session:imp').status, 'SUBMITTED');
  assert.equal(store.get('import-session:imp').linkedRows, 150);
});

test('problem rows download as a CSV that can be fixed and re-imported', () => {
  const byNumber = new Map([[3, { displayName: 'Smith, Jo', organisation: 'Acme' }]]);
  const csv = problemRowsCsv([{ rowNumber: 3, email: 'jo@x.test', status: 'failed', error: 'Not added to organisation 9: "gone"' }], byNumber);
  assert.equal(csv, 'Email,Full Name,Organisation,Row,Problem\njo@x.test,"Smith, Jo",Acme,3,"Not added to organisation 9: ""gone"""\n');
});

test('new accounts that Jira search has not indexed yet are found by the end-of-import re-check', async () => {
  const { recheckNotFound } = await import('../static/src/importBatch.js');
  site.searchLag = 2; // each new account is invisible to the first two searches
  const rows = [row(2, 'lag1@x.test', ['10']), row(3, 'lag2@x.test'), row(4, 'reject-me@x.test')];
  await call('startImportSession', { id: 'lag', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2, 3, 4], totalRows: 3, totalBatches: 1 });
  const plan = { sessionId: 'lag', serviceDeskId: '1', chunks: [rows] };
  const first = await submitAndFinaliseBatch(invoke, plan, 0, fastClock());
  assert.equal(first.linked, 0);
  assert.equal(first.problems.length, 3);
  assert.equal(store.get('import-session:lag').problemRows, 3);

  const progress = [];
  const remaining = await recheckNotFound(invoke, plan, first.problems, { ...fastClock(), attempts: 5, onProgress: (p) => progress.push(p.waiting) });
  assert.deepEqual(remaining.map((p) => [p.rowNumber, p.status]), [[4, 'not-found']], 'only the row Jira rejected is left');
  assert.equal(site.orgMembers.get('10').size, 1);
  assert.equal(site.deskCustomers.get('1').size, 2);
  const session = store.get('import-session:lag');
  assert.deepEqual([session.linkedRows, session.problemRows], [2, 1], 'retries add to the batch counts');
  assert.ok(progress.length >= 2 && progress.at(-1) === 1);
});
