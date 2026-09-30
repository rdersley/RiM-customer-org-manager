import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite } from './mocks/api.mjs';
import { store, resetStore } from './mocks/kvs.mjs';
import { handler } from '../src/index.js';
import { detailValues, checkDetails, mergeValidation, detailSummary } from '../static/src/details.js';
import { importImpact, importSafeguard } from '../static/src/safeguards.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
const fingerprint = 'd'.repeat(64);

beforeEach(() => { resetSite(0); resetStore(); });

const FIELDS = [
  { name: 'Base', type: 'SELECT', options: ['DUB', 'STN', 'Bergamo, Italy'] },
  { name: 'Skills', type: 'MULTISELECT', options: ['First aid', 'Galley', 'Bergamo, Italy'] },
  { name: 'Device ID', type: 'NUMBER', options: [] },
  { name: 'CrewCode', type: 'TEXT', options: [] }
];
const field = (name) => FIELDS.find((f) => f.name === name);

test('select values match an option ignoring case and are sent as Jira spells them', () => {
  assert.deepEqual(detailValues(field('Base'), 'dub'), { values: ['DUB'] });
  assert.match(detailValues(field('Base'), 'LHR').error, /Base: "LHR" isn't an option \(DUB, STN/);
  assert.deepEqual(detailValues(field('Base'), 'bergamo, italy'), { values: ['Bergamo, Italy'] }, 'an option containing a comma');
});

test('multi-select cells are split on ; or , unless the whole cell is an option', () => {
  assert.deepEqual(detailValues(field('Skills'), 'first aid; galley'), { values: ['First aid', 'Galley'] });
  assert.deepEqual(detailValues(field('Skills'), 'Galley,Galley'), { values: ['Galley'] });
  assert.deepEqual(detailValues(field('Skills'), 'Bergamo, Italy'), { values: ['Bergamo, Italy'] });
  assert.match(detailValues(field('Skills'), 'Galley; Pilot').error, /"Pilot" isn't an option/);
});

test('numbers, emails, web addresses and long text are checked', () => {
  assert.deepEqual(detailValues(field('Device ID'), '004512'), { values: ['004512'] }, 'kept as written (leading zeros)');
  assert.match(detailValues(field('Device ID'), '12a').error, /isn't a number/);
  assert.match(detailValues({ name: 'Mail', type: 'EMAIL' }, 'nope').error, /isn't an email/);
  assert.match(detailValues({ name: 'Site', type: 'URL' }, 'example.com').error, /web address/);
  assert.deepEqual(detailValues({ name: 'Site', type: 'URL' }, 'https://example.com'), { values: ['https://example.com'] });
  assert.match(detailValues(field('CrewCode'), 'x'.repeat(256)).error, /255/);
});

test('checkDetails converts rows and reports bad cells in validateImport shape', () => {
  const rows = [
    { email: 'a@x.test', displayName: 'A', details: { Base: 'stn', CrewCode: 'C1' } },
    { email: 'b@x.test', displayName: 'B', details: { 'Device ID': 'abc' } },
    { email: 'c@x.test', displayName: 'C', details: { Removed: 'x' } }
  ];
  const { rows: out, errors } = checkDetails(rows, FIELDS);
  assert.deepEqual(out[0].details, { Base: ['STN'], CrewCode: ['C1'] });
  assert.deepEqual(errors.map((e) => e.row), [3, 4]);
  assert.match(errors[1].message, /no longer exists/);
  const merged = mergeValidation({ total: 3, valid: 3, errors: [] }, errors);
  assert.equal(merged.valid, 1);
  assert.equal(detailSummary(out[0]), 'Base: STN · CrewCode: C1');
});

test('an update that only sets details is not counted as a rename', () => {
  const preview = Array.from({ length: 150 }, (_, i) => ({ action: 'UPDATE', nameUnchanged: true, email: `${i}@x.test` }));
  const impact = importImpact(preview);
  assert.equal(impact.update, 150);
  assert.equal(impact.renames, 0);
  assert.equal(importSafeguard(impact).level, 'none');
});

test('getCustomerDetailFields lists the fields in Jira order, and copes with a site without them', async () => {
  assert.deepEqual(await call('getCustomerDetailFields'), { fields: [], available: false });
  site.detailFields = [
    { name: 'PhoneNumber', type: { name: 'PHONE' }, configuration: { position: 2 } },
    { name: 'Base', type: { name: 'SELECT', options: ['DUB', 'STN'] }, configuration: { position: 1 } }
  ];
  const { fields, available } = await call('getCustomerDetailFields');
  assert.equal(available, true);
  assert.deepEqual(fields.map((f) => [f.name, f.type, f.options]), [['Base', 'SELECT', ['DUB', 'STN']], ['PhoneNumber', 'PHONE', []]]);
});

test('the bulk request carries non-blank detail values and leaves out rows without any', async () => {
  await call('bulkUpsertCustomers', { rows: [
    { email: 'a@x.test', displayName: 'A', details: { Base: ['DUB'], CrewCode: [''], Skills: ['First aid', 'Galley'] } },
    { email: 'b@x.test', displayName: 'B', details: {} },
    { email: 'c@x.test', displayName: 'C' }
  ] });
  const [a, b, c] = site.bulkRequests[0].customerProfiles.map((p) => p.payload);
  assert.deepEqual(a.details, [{ name: 'Base', values: ['DUB'] }, { name: 'Skills', values: ['First aid', 'Galley'] }]);
  assert.equal('details' in b, false);
  assert.equal('details' in c, false);
});

test('saved mappings and import sessions keep First/Last and detail columns', async () => {
  await assert.rejects(call('saveImportMapping', { name: 'x', serviceDeskId: '1', emailHeader: 'Email' }), /Full name \(or First name and Last name\)/);
  const saved = await call('saveImportMapping', { name: 'Crew', serviceDeskId: '1', emailHeader: 'Email', firstNameHeader: 'FirstName', lastNameHeader: 'LastName', detailHeaders: { Base: 'Base', '': 'x', CrewCode: '' } });
  assert.deepEqual(saved.detailHeaders, { Base: 'Base' });
  assert.equal(saved.firstNameHeader, 'FirstName');
  await call('startImportSession', { id: 'd1', fingerprint, serviceDeskId: '1', actionableRowNumbers: [2], totalRows: 1, totalBatches: 1, mapping: { emailHeader: 'Email', firstNameHeader: 'FirstName', detailHeaders: { Base: 'Base' } } });
  assert.deepEqual(store.get('import-session:d1').mapping.detailHeaders, { Base: 'Base' });
});
