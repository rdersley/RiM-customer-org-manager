import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvTable, guessMapping, missingMappingFields, applyMapping, pickSavedMapping, sameMapping, toSaved, fromSaved } from '../static/src/csv.js';

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

test('guesses common column names, using each header once', () => {
  assert.deepEqual(guessMapping(['Email', 'Full Name', 'Organisation']), { email: 'Email', displayName: 'Full Name', organisation: 'Organisation' });
  assert.deepEqual(guessMapping(['Contact Name', 'E-mail Address', 'Company']), { email: 'E-mail Address', displayName: 'Contact Name', organisation: 'Company' });
  assert.deepEqual(guessMapping(['Work Email', 'Customer', 'Organization Name']), { email: 'Work Email', displayName: 'Customer', organisation: 'Organization Name' });
  assert.deepEqual(guessMapping(['Col A', 'Col B']), { email: '', displayName: '', organisation: '' });
});

test('reports required fields that are unmapped or not in the file', () => {
  assert.deepEqual(missingMappingFields({ email: 'Email', displayName: '', organisation: '' }), ['Full name']);
  assert.deepEqual(missingMappingFields({ email: 'Email', displayName: 'Name' }, ['Email']), ['Full name']);
  assert.deepEqual(missingMappingFields({ email: 'E', displayName: 'N' }, ['E', 'N']), []);
});

test('applies a mapping; an unmapped organisation is blank', () => {
  const table = parseCsvTable('Col A,Col B,Col C\nJo,jo@x.test,Acme\n');
  assert.deepEqual(applyMapping(table, { email: 'Col B', displayName: 'Col A', organisation: 'Col C' }), [{ email: 'jo@x.test', displayName: 'Jo', organisation: 'Acme' }]);
  assert.deepEqual(applyMapping(table, { email: 'Col B', displayName: 'Col A', organisation: '' }), [{ email: 'jo@x.test', displayName: 'Jo', organisation: '' }]);
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
  const m = { email: 'Mail', displayName: 'Who', organisation: '' };
  assert.deepEqual(fromSaved(toSaved(m)), m);
  assert.equal(sameMapping(m, { ...m }), true);
  assert.equal(sameMapping(m, { ...m, organisation: 'Firm' }), false);
});
