import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite, addIssue, orgIdsOf, CLIENT_FIELD, ORG_FIELD, REQUEST_TYPE_FIELD } from './mocks/api.mjs';
import { store, resetStore } from './mocks/kvs.mjs';
import { handler, handleIssueEvent } from '../src/index.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
// Ryanair = 10, Buzz = 20, Lauda = 30; 99 is an organisation added by hand.
const mappings = [
  { clientValue: 'RYR', organizationId: '10', organizationName: 'Ryanair' },
  { clientValue: 'RYS', organizationId: '20', organizationName: 'Buzz' },
  { clientValue: 'LDA', organizationId: '30', organizationName: 'Lauda' }
];
const settings = (over = {}) => ({ enabled: true, clientFieldId: CLIENT_FIELD, projectKeys: ['SD'], ignoredRequestTypeIds: ['7'], mappings, ...over });
const updated = (id, fieldId = CLIENT_FIELD, project = 'SD') => ({
  eventType: 'avi:jira:updated:issue',
  issue: { id: String(id), key: `SD-${id}`, fields: { project: { key: project } } },
  changelog: { items: [{ fieldId }] }
});
const created = (id) => ({ eventType: 'avi:jira:created:issue', issue: { id: String(id), key: `SD-${id}`, fields: { project: { key: 'SD' } } } });
const writes = () => site.requests.filter((r) => r.method === 'PUT');

beforeEach(async () => {
  resetSite(0);
  resetStore();
  await call('saveSyncConfig', settings());
  site.requests = [];
});

test('setup detects the Organizations and Request Type fields and lists single-select/text Client candidates', async () => {
  const { fields, config } = await call('getSyncSetup', {});
  assert.deepEqual(fields.organisationsField, { id: ORG_FIELD, name: 'Organizations' });
  assert.deepEqual(fields.requestTypeField, { id: REQUEST_TYPE_FIELD, name: 'Request Type' });
  assert.deepEqual(fields.clientCandidates.map((f) => [f.name, f.type]), [['Brand code', 'text'], ['Client', 'select'], ['Site', 'select']]);
  assert.equal(config.organisationsFieldId, ORG_FIELD, 'field ids come from the site, not the browser');
});

test('saving rejects a Client field that is not a select/text custom field', async () => {
  await assert.rejects(call('saveSyncConfig', settings({ clientFieldId: 'customfield_10070' })), /not a single-select or text/);
});

test('client changed RYR → RYS: the event swaps Ryanair for Buzz, as the app, and logs it', async () => {
  addIssue({ id: 1, key: 'SD-1', client: 'RYS', orgIds: ['10', '99'] });
  const result = await handleIssueEvent(updated(1), {});
  assert.equal(result.status, 'needs-change');
  assert.deepEqual(orgIdsOf(1).sort(), ['20', '99']);
  assert.ok(writes().every((r) => r.as === 'app'));
  const [entry] = await call('getSyncLog', {});
  assert.equal(entry.issueKey, 'SD-1');
  assert.deepEqual(entry.to.sort(), ['20', '99']);
  assert.equal(entry.source, 'client-changed');
});

test('a new ticket gets its organisation on create', async () => {
  addIssue({ id: 2, key: 'SD-2', client: 'LDA' });
  await handleIssueEvent(created(2), {});
  assert.deepEqual(orgIdsOf(2), ['30']);
});

test('updates that did not touch the Client field make no API calls', async () => {
  addIssue({ id: 3, key: 'SD-3', client: 'RYR' });
  const result = await handleIssueEvent(updated(3, 'summary'), {});
  assert.equal(result.skipped, 'client-unchanged');
  assert.equal(site.requests.length, 0);
});

test('out-of-scope project, ignored request type, disabled sync, and unlicensed sites change nothing', async () => {
  addIssue({ id: 4, key: 'OPS-4', project: 'OPS', client: 'RYR' });
  assert.equal((await handleIssueEvent(updated(4, CLIENT_FIELD, 'OPS'), {})).skipped, 'out-of-scope');
  addIssue({ id: 5, key: 'SD-5', client: 'RYR', requestTypeId: '7' });
  assert.equal((await handleIssueEvent(updated(5), {})).skipped, 'out-of-scope');
  assert.equal((await handleIssueEvent(updated(5), { license: { active: false } })).skipped, 'unlicensed');
  await call('saveSyncConfig', settings({ enabled: false }));
  addIssue({ id: 6, key: 'SD-6', client: 'RYR' });
  assert.equal((await handleIssueEvent(updated(6), {})).skipped, 'disabled');
  assert.equal(writes().length, 0);
});

test('already-correct and unmapped tickets are not edited; unmapped ones are flagged in the log', async () => {
  addIssue({ id: 7, key: 'SD-7', client: 'RYR', orgIds: ['10'] });
  assert.equal((await handleIssueEvent(updated(7), {})).status, 'correct');
  addIssue({ id: 8, key: 'SD-8', client: 'NEW', orgIds: ['10'] });
  assert.equal((await handleIssueEvent(updated(8), {})).status, 'missing-mapping');
  assert.equal(writes().length, 0);
  const log = await call('getSyncLog', {});
  assert.equal(log.find((e) => e.issueKey === 'SD-8').source, 'missing-mapping');
});

test('health scan across pages counts every status and changes nothing', async () => {
  for (let i = 1; i <= 250; i += 1) addIssue({ id: i, key: `SD-${i}`, client: 'RYR', orgIds: i <= 200 ? ['10'] : [] });
  addIssue({ id: 900, key: 'SD-900', client: 'NEW' });
  addIssue({ id: 901, key: 'SD-901', client: 'NEW' });
  addIssue({ id: 902, key: 'SD-902', client: 'RYR', requestTypeId: '7' });
  addIssue({ id: 903, key: 'OPS-903', project: 'OPS', client: 'RYR' });
  const scan = await call('scanSyncHealth', {});
  assert.equal(scan.complete, true);
  assert.equal(scan.checked, 253);
  assert.equal(scan.correct, 200);
  assert.equal(scan.needsChange.length, 50);
  assert.equal(scan.ignored, 1);
  assert.deepEqual(scan.missing, { NEW: 2 });
  assert.equal(writes().length, 0);
});

test('corrections re-read each ticket, fix what still needs it, and report failures', async () => {
  addIssue({ id: 11, key: 'SD-11', client: 'RYS', orgIds: ['10'] });
  addIssue({ id: 12, key: 'SD-12', client: 'RYR', orgIds: [] });
  addIssue({ id: 13, key: 'SD-13', client: 'RYR', orgIds: [] });
  site.failIssueIds.add('13');
  const scan = await call('scanSyncHealth', {});
  site.issues.get('12').fields[ORG_FIELD] = [{ id: 10 }]; // fixed by someone else after the scan
  const result = await call('applySyncCorrections', { issueIds: scan.needsChange.map((i) => i.id) });
  assert.deepEqual(result.corrected, ['SD-11']);
  assert.deepEqual(result.unchanged, ['SD-12']);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].message, /permission/);
  assert.deepEqual(orgIdsOf(11), ['20']);
  assert.ok(writes().every((r) => r.as === 'user'), 'backfill runs as the administrator');
  await assert.rejects(call('applySyncCorrections', { issueIds: Array.from({ length: 26 }, (_, i) => String(i + 1)) }), /at most 25/);
});

test('sync settings, corrections and health are read-only without a licence in production', async () => {
  const PROD = { environmentType: 'PRODUCTION' };
  addIssue({ id: 20, key: 'SD-20', client: 'RYS', orgIds: ['10'] });
  await assert.rejects(call('saveSyncConfig', settings(), PROD), /no active licence/);
  await assert.rejects(call('applySyncCorrections', { issueIds: ['20'] }, PROD), /no active licence/);
  await assert.rejects(call('saveSyncHealth', {}, PROD), /no active licence/);
  assert.equal((await call('scanSyncHealth', {}, PROD)).needsChange.length, 1, 'checking is still allowed');
  assert.deepEqual(orgIdsOf(20), ['10']);
});

test('client value suggestions come from JQL autocomplete without quotes', async () => {
  assert.deepEqual(await call('getClientValueSuggestions', { fieldId: CLIENT_FIELD, query: 'R' }), ['RYR', 'Other Client']);
});

test('the correction log does not store names or emails', async () => {
  addIssue({ id: 30, key: 'SD-30', client: 'RYR' });
  await handleIssueEvent(updated(30), {});
  const entry = [...store.entries()].find(([k]) => k.startsWith('sync-log:'))[1];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'clientValue', 'from', 'issueKey', 'source', 'to']);
});

test('saving warns about mapped organisations that are not added to a selected project', async () => {
  site.projectOrgs.set('SD', ['10', '20']);
  const saved = await call('saveSyncConfig', settings());
  assert.deepEqual(saved.warnings, [{ projectKey: 'SD', organisations: ['Lauda'] }]);
  site.projectOrgs.set('SD', ['10', '20', '30']);
  assert.deepEqual((await call('saveSyncConfig', settings())).warnings, []);
});

test('when Jira rejects the change (org not in the project) the event logs a failure and changes nothing', async () => {
  site.projectOrgs.set('SD', ['10', '20']);
  addIssue({ id: 40, key: 'SD-40', client: 'LDA', orgIds: ['10'] });
  const result = await handleIssueEvent(updated(40), {});
  assert.equal(result.status, 'failed');
  assert.deepEqual(orgIdsOf(40), ['10']);
  const entry = (await call('getSyncLog', {})).find((e) => e.issueKey === 'SD-40');
  assert.equal(entry.source, 'failed');
  assert.match(entry.error, /Invalid organization ids/);
});

// ---- second field ----
import { SECOND_FIELD } from './mocks/api.mjs';
const splitMappings = [
  { clientValue: 'RYR', organizationId: '10', organizationName: 'Ryanair' },
  { clientValue: 'RYR', secondaryValue: 'Dublin', organizationId: '11', organizationName: 'Ryanair Dublin' },
  { clientValue: 'RYR', secondaryValue: 'London', organizationId: '12', organizationName: 'Ryanair London' }
];
const secondChanged = (id) => ({ ...updated(id), changelog: { items: [{ fieldId: SECOND_FIELD }] } });

test('second field: changing only the second field re-evaluates and swaps the organisation', async () => {
  await call('saveSyncConfig', settings({ secondaryFieldId: SECOND_FIELD, mappings: splitMappings }));
  addIssue({ id: 50, key: 'SD-50', client: 'RYR', second: 'London', orgIds: ['11'] });
  const r = await handleIssueEvent(secondChanged(50), {});
  assert.equal(r.status, 'needs-change');
  assert.deepEqual(orgIdsOf(50), ['12']);
  const entry = (await call('getSyncLog', {})).find((e) => e.issueKey === 'SD-50');
  assert.equal(entry.secondaryValue, 'London');
});

test('second field: without it configured, second-field changes are ignored', async () => {
  addIssue({ id: 51, key: 'SD-51', client: 'RYR', second: 'London', orgIds: [] });
  assert.equal((await handleIssueEvent(secondChanged(51), {})).skipped, 'client-unchanged');
});

test('second field: health check reports unmapped Client + second combinations', async () => {
  const noDefault = splitMappings.filter((m) => m.secondaryValue);
  await call('saveSyncConfig', settings({ secondaryFieldId: SECOND_FIELD, mappings: noDefault }));
  addIssue({ id: 52, key: 'SD-52', client: 'RYR', second: 'Paris' });
  addIssue({ id: 53, key: 'SD-53', client: 'RYR', second: 'Dublin' });
  const scan = await call('scanSyncHealth', {});
  assert.deepEqual(scan.missing, { 'RYR\u001fParis': 1 });
  assert.deepEqual(scan.needsChange.map((x) => [x.key, x.secondaryValue, x.to]), [['SD-53', 'Dublin', ['11']]]);
});

test('second field: saving rejects a field that is not a select/text custom field', async () => {
  await assert.rejects(call('saveSyncConfig', settings({ secondaryFieldId: 'customfield_10070', mappings: splitMappings })), /second field is not a single-select or text/);
});

// ---- mapping dropdowns: every option of a select field, from create-issue metadata ----
const opt = (...values) => values.map((value, i) => ({ id: String(i), value }));
const filler = Array.from({ length: 230 }, (_, i) => ({ fieldId: `customfield_2${i}`, allowedValues: [] }));

test('field options: merged across projects and issue types, deduplicated and sorted', async () => {
  site.createmeta = {
    SD: [
      { id: '1', fields: [{ fieldId: CLIENT_FIELD, allowedValues: opt('RYR - Ryanair', 'LDA - Lauda') }] },
      { id: '2', fields: [{ fieldId: CLIENT_FIELD, allowedValues: opt('RYR - Ryanair', 'BUZ - Buzz') }] }
    ],
    OPS: [{ id: '3', fields: [...filler, { fieldId: CLIENT_FIELD, allowedValues: opt('MAL - Malta Air') }] }], // past the first 200 fields
    NOPE: 'forbidden'
  };
  const r = await call('getSyncFieldOptions', { fieldId: CLIENT_FIELD, projectKeys: ['SD', 'ops', 'NOPE'] });
  assert.equal(r.found, true);
  assert.deepEqual(r.options, ['BUZ - Buzz', 'LDA - Lauda', 'MAL - Malta Air', 'RYR - Ryanair']);
});

test('field options: a field on no create screen (e.g. text) reports found: false', async () => {
  site.createmeta = { SD: [{ id: '1', fields: [{ fieldId: CLIENT_FIELD, allowedValues: opt('RYR - Ryanair') }] }] };
  assert.deepEqual(await call('getSyncFieldOptions', { fieldId: 'customfield_10060', projectKeys: ['SD'] }), { found: false, options: [] });
  assert.deepEqual(await call('getSyncFieldOptions', { fieldId: CLIENT_FIELD, projectKeys: [] }), { found: false, options: [] });
  await assert.rejects(call('getSyncFieldOptions', { fieldId: 'summary', projectKeys: ['SD'] }), /A field is required/);
});
