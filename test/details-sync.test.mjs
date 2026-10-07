import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite, addIssue, SECOND_FIELD } from './mocks/api.mjs';
import { store, resetStore } from './mocks/kvs.mjs';
import { handler, handleIssueEvent } from '../src/index.js';
import { evaluateTicket, readCustomerDetails, detailsJql, normaliseDetailConfig, fieldValue } from '../src/details-sync/rules.js';

const DEV = { environmentType: 'DEVELOPMENT' };
const call = (name, payload, context = DEV) => handler[name]({ payload, context });
// Ticket fields in the mock: "Brand code" (text) stands in for Crew code, "Site" (select) for Base.
const CREW = 'customfield_10060';
const BASE = SECOND_FIELD;
const settings = (over = {}) => ({
  enabled: true,
  projectKeys: ['SD'],
  mappings: [{ detailName: 'CrewCode', fieldId: CREW }, { detailName: 'Base', fieldId: BASE }],
  placeholders: ['Unknown', 'Please Update'],
  ...over
});
const customer = (accountId, details) => site.accounts.set(`${accountId}@x.test`, { accountId, displayName: accountId, emailAddress: `${accountId}@x.test`, accountType: 'customer', details });
const ticket = (id, reporter, extra = {}, project = 'SD') => addIssue({ id, key: `${project}-${id}`, project, reporter, extra });
const config = normaliseDetailConfig({ ...settings(), mappings: [{ detailName: 'CrewCode', fieldId: CREW }, { detailName: 'Base', fieldId: BASE, fieldType: 'select', options: ['MAD', 'DUB'] }] });

beforeEach(async () => {
  resetSite(0);
  resetStore();
  site.createmeta = { SD: [{ id: '1', fields: [{ fieldId: BASE, allowedValues: [{ value: 'MAD' }, { value: 'DUB' }, { value: 'Unknown' }] }] }] };
  await call('saveDetailSyncConfig', settings());
  site.requests = [];
});

test('rules: fills blanks and placeholders, keeps real values, ignores case', () => {
  const details = { CrewCode: 'ALOLUC', Base: 'MAD' };
  assert.deepEqual(evaluateTicket({ fields: {}, details, config }).changes.map((c) => [c.detailName, c.from, c.to]), [['CrewCode', '', 'ALOLUC'], ['Base', '', 'MAD']]);
  const placeholder = evaluateTicket({ fields: { [CREW]: 'please update', [BASE]: { value: 'Unknown' } }, details, config });
  assert.equal(placeholder.status, 'needs-change');
  assert.equal(placeholder.changes.length, 2);
  const real = evaluateTicket({ fields: { [CREW]: 'OTHER', [BASE]: { value: 'mad' } }, details, config });
  assert.equal(real.status, 'correct');
  assert.deepEqual(real.kept.map((k) => k.detailName), ['CrewCode']);
  assert.equal(evaluateTicket({ fields: {}, details: {}, config }).status, 'no-details');
});

test('rules: reads the common shapes of customer details, and matches select options', () => {
  assert.deepEqual(readCustomerDetails([{ name: 'Base', values: ['MAD'] }, { fieldName: 'CrewCode', value: 'X1' }, { name: 'Empty', values: [] }]), { Base: 'MAD', CrewCode: 'X1' });
  assert.deepEqual(readCustomerDetails({ details: [{ name: 'Base', values: ['DUB'] }] }), { Base: 'DUB' });
  assert.deepEqual(fieldValue(config.mappings[1], 'mad'), { value: { value: 'MAD' } });
  assert.match(fieldValue(config.mappings[1], 'STN').error, /isn't an option/);
  assert.deepEqual(fieldValue(config.mappings[0], 'X1'), { value: 'X1' });
});

test('rules: the search only asks for tickets with an empty or placeholder field', () => {
  const jql = detailsJql(config);
  assert.match(jql, /^project in \("SD"\) AND reporter IS NOT EMPTY AND \(/);
  assert.match(jql, /cf\[10060\] IS EMPTY OR cf\[10060\] ~ "\\"Unknown\\"" OR cf\[10060\] ~ "\\"Please Update\\""/);
  assert.match(jql, /cf\[10080\] IS EMPTY OR cf\[10080\] in \("Unknown", "Please Update"\)/);
});

test('saving reads the select field options and rejects a field that is not select/text', async () => {
  assert.deepEqual(store.get('detail-sync-config').mappings.map((m) => [m.detailName, m.fieldType, m.options]), [['CrewCode', 'text', []], ['Base', 'select', ['DUB', 'MAD', 'Unknown']]]);
  await assert.rejects(call('saveDetailSyncConfig', settings({ mappings: [{ detailName: 'X', fieldId: 'customfield_10070' }] })), /not a single-select or text/);
  await assert.rejects(call('saveDetailSyncConfig', settings({ mappings: [] })), /Add at least one/);
});

test('check then update: fills blanks and placeholders from the reporter, keeps real values, changes nothing while checking', async () => {
  customer('qm:a', { CrewCode: ['ALOLUC'], Base: ['MAD'] });
  customer('qm:b', { CrewCode: ['BBB'], Base: ['STN'] });
  customer('qm:none', {});
  ticket(1, 'qm:a');
  ticket(2, 'qm:a', { [CREW]: 'Please Update', [BASE]: { value: 'Unknown' } });
  ticket(3, 'qm:a', { [CREW]: 'SOMEONE', [BASE]: { value: 'MAD' } });
  ticket(4, 'qm:b');
  ticket(5, 'qm:none');
  ticket(6, 'qm:a', {}, 'OPS');

  const scan = await call('scanDetailSync', {});
  assert.equal(site.issueEdits.length, 0, 'checking changes nothing');
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.needsChange.map((x) => x.key), ['SD-1', 'SD-2', 'SD-4']);
  assert.equal(scan.correct, 1);
  assert.equal(scan.kept, 1);
  assert.equal(scan.noDetails, 1);
  assert.equal(site.requests.filter((r) => r.path.includes('/customer/qm%3Aa/details')).length, 1, 'one lookup per reporter');

  const r = await call('applyDetailSync', { issueIds: scan.needsChange.map((x) => x.id) });
  assert.deepEqual(r.updated, ['SD-1', 'SD-2', 'SD-4']);
  assert.equal(site.issues.get('1').fields[CREW], 'ALOLUC');
  assert.deepEqual(site.issues.get('1').fields[BASE], { value: 'MAD' });
  assert.equal(site.issues.get('2').fields[CREW], 'ALOLUC');
  assert.equal(site.issues.get('3').fields[CREW], 'SOMEONE', 'a real value is kept');
  assert.equal(site.issues.get('4').fields[CREW], 'BBB');
  assert.equal(site.issues.get('4').fields[BASE], null, 'STN is not a Base option, so it is skipped');
  assert.deepEqual(r.failed.map((f) => f.key), ['SD-4']);
  assert.match(r.failed[0].message, /"STN" isn't an option/);

  const log = await call('getDetailSyncLog', {});
  assert.equal(log.length, 3);
  assert.ok(!JSON.stringify(log).includes('ALOLUC'), 'the log holds field names, not customer values');
  assert.deepEqual(log.find((e) => e.issueKey === 'SD-1').fields, ['CrewCode', 'Base']);
});

test('a new ticket is filled from its reporter; an update only matters when the reporter changes', async () => {
  customer('qm:a', { CrewCode: ['ALOLUC'], Base: ['DUB'] });
  ticket(10, 'qm:a');
  const created = await handleIssueEvent({ eventType: 'avi:jira:created:issue', issue: { id: '10', key: 'SD-10', fields: { project: { key: 'SD' } } } }, {});
  assert.equal(created.details.status, 'updated');
  assert.equal(site.issues.get('10').fields[CREW], 'ALOLUC');

  ticket(11, 'qm:a');
  const summaryEdit = await handleIssueEvent({ eventType: 'avi:jira:updated:issue', issue: { id: '11', fields: { project: { key: 'SD' } } }, changelog: { items: [{ fieldId: 'summary' }] } }, {});
  assert.equal(summaryEdit.details.skipped, 'reporter-unchanged');
  const reporterEdit = await handleIssueEvent({ eventType: 'avi:jira:updated:issue', issue: { id: '11', fields: { project: { key: 'SD' } } }, changelog: { items: [{ field: 'reporter' }] } }, {});
  assert.equal(reporterEdit.details.status, 'updated');

  await call('saveDetailSyncConfig', settings({ enabled: false }));
  ticket(12, 'qm:a');
  assert.equal((await handleIssueEvent({ eventType: 'avi:jira:created:issue', issue: { id: '12', fields: { project: { key: 'SD' } } } }, {})).details.skipped, 'disabled');
});
