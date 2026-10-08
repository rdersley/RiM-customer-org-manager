import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { site, resetSite, addIssue, SECOND_FIELD } from './mocks/api.mjs';
import { store, resetStore } from './mocks/kvs.mjs';
import { handler, handleIssueEvent } from '../src/index.js';
import { evaluateTicket, readCustomerDetails, detailsJql, normaliseDetailConfig, normaliseScanFilter, fieldValue } from '../src/details-sync/rules.js';

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
  site.selectOptions = { [BASE]: ['MAD', 'DUB', 'Unknown', 'VHQ'] };
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
  assert.deepEqual(fieldValue(config.mappings[1], 'STN'), { value: { value: 'STN' }, unverified: true }, 'not in the saved options: still sent, Jira decides');
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
  assert.equal(site.requests.filter((r) => r.path.endsWith('/customer/qm%3Aa')).length, 1, 'one lookup per reporter');

  const r = await call('applyDetailSync', { issueIds: scan.needsChange.map((x) => x.id) });
  assert.deepEqual(r.updated, ['SD-1', 'SD-2', 'SD-4']);
  assert.equal(site.issues.get('1').fields[CREW], 'ALOLUC');
  assert.deepEqual(site.issues.get('1').fields[BASE], { value: 'MAD' });
  assert.equal(site.issues.get('2').fields[CREW], 'ALOLUC');
  assert.equal(site.issues.get('3').fields[CREW], 'SOMEONE', 'a real value is kept');
  assert.equal(site.issues.get('4').fields[CREW], 'BBB');
  assert.equal(site.issues.get('4').fields[BASE], null, 'Jira refuses STN, so Base is left alone and CrewCode is still set');
  assert.deepEqual(r.failed.map((f) => f.key), ['SD-4']);
  assert.match(r.failed[0].message, /"STN" was refused for .*Option value 'STN' is not valid/);

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

test('rules: check filters add a Created range (end day included) and field options to the search', () => {
  const jql = detailsJql(config, { createdFrom: '2026-09-01', createdTo: '2026-09-30', fieldFilters: [{ fieldId: 'customfield_10090', values: ['Ryanair', 'Buzz "Air"'] }, { fieldId: 'customfield_10091', values: [] }] });
  assert.match(jql, / AND created >= "2026-09-01" AND created < "2026-10-01" AND cf\[10090\] in \("Ryanair", "Buzz \\"Air\\""\) ORDER BY key ASC$/);
  assert.doesNotMatch(jql, /10091/, 'a field filter with no options picked is ignored');
  assert.equal(detailsJql(config, {}), detailsJql(config), 'no filter, same search as before');
  assert.throws(() => normaliseScanFilter({ createdFrom: '2026-10-02', createdTo: '2026-10-01' }), /after the "Created to"/);
  assert.deepEqual(normaliseScanFilter({ createdFrom: 'yesterday', fieldFilters: [{ fieldId: 'summary', values: ['x'] }] }), { createdFrom: '', createdTo: '', fieldFilters: [] }, 'bad input is dropped, never put into JQL');
});

test('Check tickets passes the filter to Jira, and the filter options come from the saved projects', async () => {
  await call('scanDetailSync', { filter: { createdFrom: '2026-09-01', fieldFilters: [{ fieldId: BASE, values: ['MAD'] }] } });
  assert.match(site.lastJql, /created >= "2026-09-01" AND cf\[\d+\] in \("MAD"\)/);
  const { options } = await call('getDetailFilterOptions', { fieldId: BASE });
  assert.deepEqual(options, ['DUB', 'MAD', 'Unknown']);
  await assert.rejects(call('getDetailFilterOptions', { fieldId: 'summary' }), /Choose a field/);
});

test('Fill in stops starting tickets when its time is up and hands the rest back as pending', async (t) => {
  customer('qm:a', { CrewCode: ['ALOLUC'], Base: ['MAD'] });
  for (const id of [11, 12, 13, 14, 15, 16]) ticket(id, 'qm:a');
  const realNow = Date.now;
  let calls = 0;
  t.mock.method(Date, 'now', () => (calls++ === 0 ? realNow() : realNow() + 60000));
  const r = await call('applyDetailSync', { issueIds: ['11', '12', '13', '14', '15', '16'] });
  t.mock.restoreAll();
  assert.deepEqual([...r.pending].sort(), ['11', '12', '13', '14', '15', '16']);
  assert.equal(r.updated.length, 0);
  const again = await call('applyDetailSync', { issueIds: r.pending });
  assert.equal(again.updated.length, 6, 'sent again, they are filled');
  assert.deepEqual(again.pending, []);
});

test('a Base value missing from the saved options is still set when Jira accepts it (VHQ on the work site)', async () => {
  customer('qm:v', { CrewCode: ['VHQ1'], Base: ['VHQ'] });
  ticket(21, 'qm:v');
  const r = await call('applyDetailSync', { issueIds: ['21'] });
  assert.deepEqual(r.updated, ['SD-21']);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(site.issues.get('21').fields[BASE], { value: 'VHQ' });
});

test('a rate-limited check hands back the page it was on, and carrying on from there finishes it', async () => {
  const { setSleepForTests } = await import('../src/http.js');
  setSleepForTests(async () => {});
  customer('qm:a', { CrewCode: ['ALOLUC'], Base: ['MAD'] });
  ticket(31, 'qm:a');
  ticket(32, 'qm:a');
  site.throttle = 10;
  site.throttlePath = '/jsm/csm/api/v1/customer/';
  const first = await call('scanDetailSync', {});
  assert.equal(first.rateLimited, true);
  assert.equal(first.complete, false);
  assert.equal(first.checked, 0, 'the interrupted page is not counted');
  site.throttle = 0;
  const rest = await call('scanDetailSync', { nextPageToken: first.nextPageToken });
  assert.equal(rest.complete, true);
  assert.equal(rest.checked, 2);
  assert.equal(rest.needsChange.length, 2);
});
