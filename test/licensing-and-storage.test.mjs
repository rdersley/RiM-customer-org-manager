import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { site, resetSite } from './mocks/api.mjs';
import { store, setOptions, resetStore } from './mocks/kvs.mjs';
import { handler, APP_VERSION, IMPORT_RECORD_RETENTION } from '../src/index.js';
import { resolverLicenseAllows } from '../src/license.js';
import { loadRowPlan } from '../static/src/importBatch.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const PROD_ACTIVE = { environmentType: 'PRODUCTION', license: { active: true } };
const PROD_INACTIVE = { environmentType: 'PRODUCTION', license: { active: false } };
const PROD_MISSING = { environmentType: 'PRODUCTION' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
const fingerprint = 'a'.repeat(64);

beforeEach(() => { resetSite(3); resetStore(); delete process.env.LICENSE_OVERRIDE; });
afterEach(() => { delete process.env.LICENSE_OVERRIDE; });

test('app version matches package.json', () => {
  assert.equal(APP_VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('internal edition: every environment and licence state can read and write', async () => {
  for (const context of [PROD_ACTIVE, PROD_INACTIVE, PROD_MISSING, undefined, DEV, { ...DEV, license: { active: false } }]) {
    assert.equal(resolverLicenseAllows(context, { LICENSE_OVERRIDE: 'inactive' }), true);
  }
  const status = await call('getAppStatus', {}, PROD_MISSING);
  assert.deepEqual(status, { version: APP_VERSION, licensed: true, production: true });
  const { created } = await call('createImportOrganizations', { names: ['New Org'] }, PROD_MISSING);
  assert.equal(created.length, 1);
});

test('internal manifest does not enable Marketplace licensing', () => {
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(manifest, /licensing:\s*\n\s+enabled:\s*true/);
  assert.doesNotMatch(manifest, /appIsLicensed/);
});

test('admin check still guards every resolver', async () => {
  site.isAdmin = false;
  await assert.rejects(call('getAppStatus', {}, PROD_ACTIVE), /administrator permission/);
});

test('a 50,000-row import plan is stored in chunks within the KVS value limit and recovered intact', async () => {
  const rows = Array.from({ length: 50000 }, (_, i) => i + 2);
  await call('startImportSession', { id: 'big', fingerprint, serviceDeskId: '1', fileName: 'big.csv', actionableRowNumbers: rows, totalRows: rows.length, totalBatches: 500 });
  assert.equal(store.get('import-session:big').rowPlanChunks, 10);
  assert.equal(store.get('import-session:big').actionableRowNumbers, undefined);

  const recovered = await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' });
  assert.equal(recovered.id, 'big');
  assert.equal(recovered.actionableRowNumbers, undefined, 'the plan is read in chunks, not in one reply');
  const invoked = [];
  const invoke = (name, payload) => { invoked.push(name); return call(name, payload); };
  assert.deepEqual(await loadRowPlan(invoke, recovered), rows);
  assert.deepEqual(invoked, Array(10).fill('getImportRowPlanChunk'));
  await assert.rejects(call('getImportRowPlanChunk', { sessionId: 'big', index: 10 }), /out of range/);
});

test('session list omits row plans; recovery refuses an incomplete plan', async () => {
  await call('startImportSession', { id: 's1', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2, 3, 4], totalRows: 3, totalBatches: 1 });
  const [listed] = await call('getImportSessions', {});
  assert.equal(listed.id, 's1');
  assert.equal(listed.actionableRowNumbers, undefined);
  assert.ok(!('import-session-rows:s1:0' === listed.id));

  store.delete('import-session-rows:s1:0');
  const recovered = await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' });
  await assert.rejects(loadRowPlan(call, recovered), /row plan is incomplete/);
});

test('sessions saved before chunking (inline row numbers) still recover', async () => {
  store.set('import-session:old', { id: 'old', fingerprint, serviceDeskId: '1', actionableRowNumbers: [5, 6], status: 'IN_PROGRESS' });
  store.set(`import-recovery:1:${fingerprint}`, { sessionId: 'old' });
  const recovered = await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' });
  assert.deepEqual(await loadRowPlan(call, recovered), [5, 6]);
});

test('a session is submitted only once every batch is finalised, then the recovery pointer is cleared', async () => {
  await call('startImportSession', { id: 's2', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2, 3], totalRows: 2, totalBatches: 1 });
  const rows = [{ rowNumber: 2, email: 'a@x.test', displayName: 'A' }, { rowNumber: 3, email: 'b@x.test', displayName: 'B' }];
  await call('bulkUpsertCustomers', { rows, importSessionId: 's2', batchNumber: 1, totalBatches: 1, idempotencyKey: 's2-batch-1' });
  assert.equal(store.get('import-session:s2').status, 'IN_PROGRESS', 'submitted to Jira but not finalised yet');
  assert.equal((await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' })).id, 's2', 'still resumable until finalised');

  await call('finaliseImportBatch', { rows, serviceDeskId: '1', importSessionId: 's2', batchNumber: 1, totalBatches: 1 });
  assert.equal(store.get('import-session:s2').status, 'SUBMITTED');
  assert.equal(store.get('import-session:s2').linkedRows, 2);
  assert.equal(store.has(`import-recovery:1:${fingerprint}`), false);
  assert.equal(await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' }), null);
  assert.equal(site.bulkRequests[0].idempotencyKey, 's2-batch-1');
});

test('import records expire after 180 days; saved mappings do not', async () => {
  assert.deepEqual(IMPORT_RECORD_RETENTION, { ttl: { value: 180, unit: 'DAYS' } });
  await call('startImportSession', { id: 's3', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2, 3], totalRows: 2, totalBatches: 1 });
  await call('bulkUpsertCustomers', { rows: [{ email: 'a@x.test', displayName: 'A' }], importSessionId: 's3', batchNumber: 1, totalBatches: 1, idempotencyKey: 's3-batch-1' });
  await call('saveImportMapping', { id: 'map1', name: 'Default', serviceDeskId: '1', emailHeader: 'Email', displayNameHeader: 'Name' });

  const importKeys = [...store.keys()].filter((k) => k.startsWith('import-session') || k.startsWith('import:') || k.startsWith('import-recovery'));
  assert.ok(importKeys.length >= 3, 'expected session, row plan and history records');
  for (const key of importKeys) assert.deepEqual(setOptions.get(key), IMPORT_RECORD_RETENTION, key + ' should expire');
  assert.equal(setOptions.get('import-mapping:map1'), undefined, 'mappings are configuration and must not expire');
});

test('an import session keeps its column mapping for resume', async () => {
  await call('startImportSession', { id: 'm1', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2], totalRows: 1, totalBatches: 1, mapping: { emailHeader: 'Mail', displayNameHeader: 'Who', organisationHeader: '' } });
  const recovered = await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' });
  assert.deepEqual(recovered.mapping, { emailHeader: 'Mail', displayNameHeader: 'Who', firstNameHeader: '', lastNameHeader: '', organisationHeader: '', detailHeaders: {} });
  await call('startImportSession', { id: 'm2', fingerprint: 'c'.repeat(64), serviceDeskId: '1', actionableRowNumbers: [2], totalRows: 1, totalBatches: 1 });
  assert.equal(store.get('import-session:m2').mapping, null, 'sessions without a mapping store null');
});
