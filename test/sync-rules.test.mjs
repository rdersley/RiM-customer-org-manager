import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, readClientValue, changelogTouchesField, normaliseConfig, inScope } from '../src/sync/rules.js';

// Ryanair = 10, Buzz = 20, Lauda = 30; 99 is an org someone added by hand (not in any mapping).
const mappings = [
  { clientValue: 'RYR', organizationId: '10', organizationName: 'Ryanair' },
  { clientValue: 'RYS', organizationId: '20', organizationName: 'Buzz' },
  { clientValue: 'LDA', organizationId: '30', organizationName: 'Lauda' }
];
const orgs = (...ids) => ids.map((id) => ({ id: String(id), name: `Org ${id}` }));
const run = (client, current) => evaluate({ clientFieldValue: client == null ? null : { value: client }, organisationsFieldValue: current, mappings });

test('adds the mapped organisation when the ticket has none', () => {
  assert.deepEqual(run('RYR', []), { status: 'needs-change', clientValue: 'RYR', secondaryValue: '', current: [], target: ['10'] });
});

test('already correct: nothing to do', () => {
  assert.equal(run('RYR', orgs(10)).status, 'correct');
});

test('client changed RYR → RYS: swaps Ryanair for Buzz', () => {
  const r = run('RYS', orgs(10));
  assert.equal(r.status, 'needs-change');
  assert.deepEqual(r.target, ['20']);
});

test('organisations added by hand (not in any mapping) are kept', () => {
  const r = run('RYS', orgs(10, 99));
  assert.deepEqual(r.target.sort(), ['20', '99']);
  assert.equal(run('RYR', orgs(10, 99)).status, 'correct');
});

test('removes every other mapped organisation, not just one', () => {
  assert.deepEqual(run('LDA', orgs(10, 20, 99)).target.sort(), ['30', '99']);
});

test('empty client or unmapped value changes nothing', () => {
  assert.equal(run(null, orgs(10)).status, 'no-client');
  assert.equal(run('', orgs(10)).status, 'no-client');
  const unmapped = run('XYZ', orgs(10));
  assert.equal(unmapped.status, 'missing-mapping');
  assert.deepEqual(unmapped.target, ['10']);
});

test('client values match case-insensitively and ignore spaces', () => {
  assert.equal(run(' ryr ', orgs(10)).status, 'correct');
});

test('reads single-select, text and empty client values', () => {
  assert.equal(readClientValue({ value: 'RYR', id: '100' }), 'RYR');
  assert.equal(readClientValue('  LDA '), 'LDA');
  assert.equal(readClientValue(null), '');
  assert.equal(readClientValue({}), '');
});

test('detects whether an update changed the Client field', () => {
  const changelog = { items: [{ fieldId: 'summary' }, { fieldId: 'customfield_10050' }] };
  assert.equal(changelogTouchesField(changelog, 'customfield_10050'), true);
  assert.equal(changelogTouchesField(changelog, 'customfield_99999'), false);
  assert.equal(changelogTouchesField(undefined, 'customfield_10050'), false);
});

test('config validation: rejects duplicates, drops junk, requires a complete setup to enable', () => {
  const base = { clientFieldId: 'customfield_10050', organisationsFieldId: 'customfield_10002', projectKeys: ['sd', 'SD', 'bad key'], mappings };
  const c = normaliseConfig({ ...base, enabled: true, mappings: [...mappings, { clientValue: '', organizationId: '1' }, { clientValue: 'X', organizationId: 'abc' }] });
  assert.deepEqual(c.projectKeys, ['SD']);
  assert.equal(c.mappings.length, 3);
  assert.throws(() => normaliseConfig({ ...base, mappings: [...mappings, { clientValue: 'ryr', organizationId: '40' }] }), /mapped more than once/);
  assert.throws(() => normaliseConfig({ ...base, enabled: true, projectKeys: [] }), /at least one project/);
  assert.throws(() => normaliseConfig({ ...base, enabled: true, clientFieldId: 'summary' }), /Client field/);
  assert.equal(normaliseConfig({ enabled: false }).enabled, false, 'an incomplete config can be saved while off');
});

test('scope: project must be selected; ignored request types are skipped', () => {
  const c = { projectKeys: ['SD'], ignoredRequestTypeIds: ['7'] };
  assert.equal(inScope(c, { projectKey: 'SD', requestTypeId: '3' }), true);
  assert.equal(inScope(c, { projectKey: 'sd' }), true);
  assert.equal(inScope(c, { projectKey: 'OPS' }), false);
  assert.equal(inScope(c, { projectKey: 'SD', requestTypeId: '7' }), false);
});

// ---- second field: one client across several organisations ----
// RYR: Dublin -> 11, London -> 12, anything else -> 10 (default). LDA has no split.
const split = [
  { clientValue: 'RYR', secondaryValue: '', organizationId: '10' },
  { clientValue: 'RYR', secondaryValue: 'Dublin', organizationId: '11' },
  { clientValue: 'RYR', secondaryValue: 'London', organizationId: '12' },
  { clientValue: 'LDA', organizationId: '30' }
];
const run2 = (client, second, current) => evaluate({ clientFieldValue: { value: client }, secondaryFieldValue: second == null ? null : { value: second }, organisationsFieldValue: current, mappings: split });

test('second field: the Client + second value row wins over the client default', () => {
  assert.deepEqual(run2('RYR', 'Dublin', []).target, ['11']);
  assert.deepEqual(run2('ryr', ' london ', []).target, ['12']);
});

test('second field: empty or unmapped second value falls back to the client default', () => {
  assert.deepEqual(run2('RYR', null, []).target, ['10']);
  assert.deepEqual(run2('RYR', 'Paris', []).target, ['10']);
});

test('second field: switching Dublin -> London swaps the organisation; hand-added orgs stay', () => {
  const r = run2('RYR', 'London', orgs(11, 99));
  assert.equal(r.status, 'needs-change');
  assert.deepEqual(r.target.sort(), ['12', '99']);
});

test('second field: the default org is removed when a specific row now applies (all rows count as mapped)', () => {
  assert.deepEqual(run2('RYR', 'Dublin', orgs(10)).target, ['11']);
});

test('second field: clients without a split ignore the second value', () => {
  assert.deepEqual(run2('LDA', 'Dublin', []).target, ['30']);
});

test('second field: no default and no matching row is flagged, with both values', () => {
  const noDefault = split.filter((m) => !(m.clientValue === 'RYR' && !m.secondaryValue));
  const r = evaluate({ clientFieldValue: { value: 'RYR' }, secondaryFieldValue: { value: 'Paris' }, organisationsFieldValue: orgs(11), mappings: noDefault });
  assert.equal(r.status, 'missing-mapping');
  assert.equal(r.secondaryValue, 'Paris');
  assert.deepEqual(r.target, ['11'], 'nothing changes');
});

test('second field config: pair duplicates rejected; values need the field; field must differ from Client', () => {
  const base = { clientFieldId: 'customfield_10050', secondaryFieldId: 'customfield_10080', organisationsFieldId: 'customfield_10002', projectKeys: ['SD'] };
  assert.equal(normaliseConfig({ ...base, mappings: split }).mappings.length, 4, 'same client with different second values is fine');
  assert.throws(() => normaliseConfig({ ...base, mappings: [...split, { clientValue: 'ryr', secondaryValue: 'dublin', organizationId: '13' }] }), /with "dublin" is mapped more than once/);
  assert.throws(() => normaliseConfig({ ...base, secondaryFieldId: '', mappings: split }), /Choose the second field/);
  assert.throws(() => normaliseConfig({ ...base, secondaryFieldId: 'customfield_10050', mappings: split }), /different from the Client field/);
});
