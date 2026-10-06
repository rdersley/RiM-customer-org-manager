import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { site, resetSite } from './mocks/api.mjs';
import { store, setOptions, resetStore } from './mocks/kvs.mjs';
import { handler, APP_VERSION, IMPORT_RECORD_RETENTION } from '../src/index.js';
import { resolverLicenseAllows } from '../src/license.js';

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

test('licence policy: production fails closed, development allows a missing licence', () => {
  assert.equal(resolverLicenseAllows(PROD_ACTIVE, {}), true);
  assert.equal(resolverLicenseAllows(PROD_INACTIVE, {}), false);
  assert.equal(resolverLicenseAllows(PROD_MISSING, {}), false);
  assert.equal(resolverLicenseAllows(undefined, {}), false, 'unknown environment counts as production');
  assert.equal(resolverLicenseAllows(DEV, {}), true);
  assert.equal(resolverLicenseAllows({ ...DEV, license: { active: false } }, {}), false, 'simulated inactive licence is honoured');
  assert.equal(resolverLicenseAllows(DEV, { LICENSE_OVERRIDE: 'inactive' }), false);
  assert.equal(resolverLicenseAllows(PROD_MISSING, { LICENSE_OVERRIDE: 'active' }), false, 'override never unlocks production');
});

test('unlicensed production site is read-only: reads work, every write is refused', async () => {
  const orgs = await call('getOrganizationIndexBatch', {}, PROD_MISSING);
  assert.equal(orgs.organizations.length, 3);
  const status = await call('getAppStatus', {}, PROD_MISSING);
  assert.deepEqual(status, { version: APP_VERSION, licensed: false, production: true });

  const writes = [
    ['createOrganization', { name: 'X' }],
    ['createImportOrganizations', { names: ['X'] }],
    ['saveImportMapping', { name: 'm', serviceDeskId: '1', emailHeader: 'Email', displayNameHeader: 'Name' }],
    ['deleteImportMapping', { id: 'm' }],
    ['startImportSession', { id: 's', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2], totalRows: 1, totalBatches: 1 }],
    ['bulkUpsertCustomers', { rows: [{ email: 'a@x.test', displayName: 'A' }] }]
  ];
  for (const [name, payload] of writes) {
    await assert.rejects(call(name, payload, PROD_MISSING), /no active licence/, `${name} should be refused`);
  }
  assert.equal(site.organizations.length, 3);
  assert.equal(site.bulkRequests.length, 0);
  assert.equal(store.size, 0);
});

test('licensed production site can write', async () => {
  const { created } = await call('createImportOrganizations', { names: ['New Org'] }, PROD_ACTIVE);
  assert.equal(created.length, 1);
  assert.deepEqual(await call('getAppStatus', {}, PROD_ACTIVE), { version: APP_VERSION, licensed: true, production: true });
});

test('admin check runs before the licence check', async () => {
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
  assert.deepEqual(recovered.actionableRowNumbers, rows);
});

test('session list omits row plans; recovery refuses an incomplete plan', async () => {
  await call('startImportSession', { id: 's1', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2, 3, 4], totalRows: 3, totalBatches: 1 });
  const [listed] = await call('getImportSessions', {});
  assert.equal(listed.id, 's1');
  assert.equal(listed.actionableRowNumbers, undefined);
  assert.ok(!('import-session-rows:s1:0' === listed.id));

  store.delete('import-session-rows:s1:0');
  await assert.rejects(call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' }), /row plan is incomplete/);
});

test('sessions saved before chunking (inline row numbers) still recover', async () => {
  store.set('import-session:old', { id: 'old', fingerprint, serviceDeskId: '1', actionableRowNumbers: [5, 6], status: 'IN_PROGRESS' });
  store.set(`import-recovery:1:${fingerprint}`, { sessionId: 'old' });
  const recovered = await call('findRecoverableImportSession', { fingerprint, serviceDeskId: '1' });
  assert.deepEqual(recovered.actionableRowNumbers, [5, 6]);
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
  assert.deepEqual(recovered.mapping, { emailHeader: 'Mail', displayNameHeader: 'Who', organisationHeader: '' });
  await call('startImportSession', { id: 'm2', fingerprint: 'c'.repeat(64), serviceDeskId: '1', actionableRowNumbers: [2], totalRows: 1, totalBatches: 1 });
  assert.equal(store.get('import-session:m2').mapping, null, 'sessions without a mapping store null');
});
