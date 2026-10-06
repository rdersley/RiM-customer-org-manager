import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importImpact, importSafeguard, typedConfirmationMatches } from '../static/src/safeguards.js';

const rows = (n, action, extra = {}) => Array.from({ length: n }, () => ({ action, reason: '', ...extra }));

test('impact counts creates, renames and distinct new organisations; skips and errors are ignored', () => {
  const preview = [
    ...rows(3, 'CREATE'),
    ...rows(2, 'UPDATE'),
    { action: 'CREATE', organisation: 'Beta', reason: 'Organisation “Beta” will be created.' },
    { action: 'UPDATE', organisation: 'Alpha ', reason: 'Existing Jira customer: X. Organisation “Alpha” will be created.' },
    { action: 'CREATE', organisation: 'Beta', reason: 'Organisation “Beta” will be created.' },
    { action: 'SKIP', organisation: 'Gamma', reason: 'Customer already matches. Organisation “Gamma” will be created.' },
    { action: 'ERROR', reason: 'Valid email required' }
  ];
  assert.deepEqual(importImpact(preview), { create: 5, update: 3, changes: 8, newOrganisations: ['Alpha', 'Beta'] });
});

test('small imports need no confirmation', () => {
  assert.deepEqual(importSafeguard({ changes: 499, update: 99, newOrganisations: Array(9).fill('x') }), { level: 'none', reasons: [] });
});

test('500+ changes, 100+ renames or 10+ new organisations need a confirmation, with the reasons', () => {
  assert.equal(importSafeguard({ changes: 500, update: 0, newOrganisations: [] }).level, 'confirm');
  assert.deepEqual(importSafeguard({ changes: 120, update: 100, newOrganisations: [] }).reasons, ['100 existing customers renamed']);
  assert.deepEqual(importSafeguard({ changes: 20, update: 0, newOrganisations: Array(10).fill('o') }).reasons, ['10 new organisations']);
});

test('5,000+ changes need the number typed', () => {
  const s = importSafeguard({ changes: 16413, update: 5, newOrganisations: [] });
  assert.equal(s.level, 'typed');
  assert.equal(typedConfirmationMatches('16413', 16413), true);
  assert.equal(typedConfirmationMatches('16,413', 16413), true);
  assert.equal(typedConfirmationMatches('1641', 16413), false);
  assert.equal(typedConfirmationMatches('', 16413), false);
});
