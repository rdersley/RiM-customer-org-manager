import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvTable, guessMapping, missingMappingFields, mappingFits, applyMapping, pickSavedMapping, sameMapping, toSaved, fromSaved } from '../static/src/csv.js';

test('parses quotes, escaped quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
  const text = '﻿Email,Full Name,Notes\r\n"a@x.test","Smith, Jo","Line one\nline two"\r\nb@x.test,"Say ""hi""",\r\n\r\n,,\r\n';
  const t = parseCsvTable(text);
  assert.deepEqual(t.headers, ['Email', 'Full Name', 'Notes']);
  assert.deepEqual(t.records, [['a@x.test', 'Smith, Jo', 'Line one\nline two'], ['b@x.test', 'Say "hi"', '']]);
});

test('handles a file without a trailing newline, and an empty file', () => {
  assert.deepEqual(parseCsvTable('Email\na@x.test').records, [['a@x.test']]);
  assert.deepEqual(parseCsvTable(''), { headers: [], records: [] });
});

const core = (m) => ({ email: '', displayName: '', firstName: '', lastName: '', organisation: '', details: {}, ...m });

test('guesses common column names, using each header once', () => {
  assert.deepEqual(guessMapping(['Email', 'Full Name', 'Organisation']), core({ email: 'Email', displayName: 'Full Name', organisation: 'Organisation' }));
  assert.deepEqual(guessMapping(['Contact Name', 'E-mail Address', 'Company']), core({ email: 'E-mail Address', displayName: 'Contact Name', organisation: 'Company' }));
  assert.deepEqual(guessMapping(['Work Email', 'Customer', 'Organization Name']), core({ email: 'Work Email', displayName: 'Customer', organisation: 'Organization Name' }));
  assert.deepEqual(guessMapping(['Col A', 'Col B']), core({}));
});

test('guesses First + Last name when there is no full-name column, and detail fields by name', () => {
  const fields = [{ name: 'FirstName' }, { name: 'CrewCode' }, { name: 'Device ID' }, { name: 'Base' }];
  assert.deepEqual(
    guessMapping(['Email', 'FirstName', 'Surname', 'Crew code', 'DEVICE_ID'], fields),
    core({ email: 'Email', firstName: 'FirstName', lastName: 'Surname', details: { FirstName: 'FirstName', CrewCode: 'Crew code', 'Device ID': 'DEVICE_ID' } })
  );
  const withFull = guessMapping(['Email', 'Full Name', 'First Name', 'Last Name']);
  assert.equal(withFull.displayName, 'Full Name');
  assert.equal(withFull.firstName, '', 'a full-name column wins over First/Last');
});

test('reports required fields that are unmapped or not in the file', () => {
  const name = 'Full name (or First name and Last name)';
  assert.deepEqual(missingMappingFields({ email: 'Email', displayName: '', organisation: '' }), [name]);
  assert.deepEqual(missingMappingFields({ email: 'Email', displayName: 'Name' }, ['Email']), [name]);
  assert.deepEqual(missingMappingFields({ email: 'E', displayName: 'N' }, ['E', 'N']), []);
  assert.deepEqual(missingMappingFields({ email: 'E', firstName: 'F' }, ['E', 'F']), [], 'First name alone is enough');
  assert.deepEqual(missingMappingFields({ displayName: 'N' }, ['N']), ['Email']);
});

test('a mapping only fits a file that has every column it names, including detail columns', () => {
  const m = { email: 'E', displayName: 'N', details: { Base: 'B' } };
  assert.equal(mappingFits(m, ['E', 'N', 'B']), true);
  assert.equal(mappingFits(m, ['E', 'N']), false);
});

test('applies a mapping; an unmapped organisation is blank', () => {
  const table = parseCsvTable('Col A,Col B,Col C\nJo,jo@x.test,Acme\n');
  assert.deepEqual(applyMapping(table, { email: 'Col B', displayName: 'Col A', organisation: 'Col C' }), [{ email: 'jo@x.test', displayName: 'Jo', organisation: 'Acme', details: {} }]);
  assert.deepEqual(applyMapping(table, { email: 'Col B', displayName: 'Col A', organisation: '' }), [{ email: 'jo@x.test', displayName: 'Jo', organisation: '', details: {} }]);
});

test('joins First + Last into the full name, and leaves blank detail cells out', () => {
  const table = parseCsvTable('Email,FirstName,LastName,Base,CrewCode\njo@x.test, Jo ,Bloggs,DUB,\nsam@x.test,Sam,,,C7\n');
  const rows = applyMapping(table, { email: 'Email', firstName: 'FirstName', lastName: 'LastName', details: { Base: 'Base', CrewCode: 'CrewCode', Gone: 'Not a column' } });
  assert.deepEqual(rows, [
    { email: 'jo@x.test', displayName: 'Jo Bloggs', organisation: '', details: { Base: 'DUB' } },
    { email: 'sam@x.test', displayName: 'Sam', organisation: '', details: { CrewCode: 'C7' } }
  ]);
});

test('picks the newest saved mapping that fits the file, preferring the service project', () => {
  const saved = [
    { id: '1', serviceDeskId: '9', emailHeader: 'Mail', displayNameHeader: 'Who', organisationHeader: '', updatedAt: '2026-09-01' },
    { id: '2', serviceDeskId: '1', emailHeader: 'Mail', displayNameHeader: 'Who', organisationHeader: 'Firm', updatedAt: '2026-08-01' },
    { id: '3', serviceDeskId: '1', emailHeader: 'Mail', displayNameHeader: 'Missing', organisationHeader: '', updatedAt: '2026-09-20' }
  ];
  assert.equal(pickSavedMapping(saved, ['Mail', 'Who', 'Firm'], '1').id, '2');
  assert.equal(pickSavedMapping(saved, ['Mail', 'Who'], '1').id, '1', 'falls back to another project when none of its own fit');
  assert.equal(pickSavedMapping(saved, ['Other'], '1'), null);
});

test('saved-mapping round trip and comparison', () => {
  const m = { email: 'Mail', displayName: 'Who', firstName: '', lastName: '', organisation: '', details: { Base: 'Home base' } };
  assert.deepEqual(fromSaved(toSaved(m)), m);
  assert.equal(sameMapping(m, { ...m }), true);
  assert.equal(sameMapping(m, { ...m, organisation: 'Firm' }), false);
  assert.equal(sameMapping(m, { ...m, details: {} }), false, 'detail columns are part of the mapping');
  assert.equal(sameMapping(m, { ...m, details: { Base: 'Home base', CrewCode: '' } }), true, 'an unmapped detail field is the same as none');
});
