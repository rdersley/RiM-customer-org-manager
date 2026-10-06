import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBackup, parseBackup, restoreBatches, restoreBackup, BACKUP_FORMAT } from '../static/src/backupClient.js';

test('collectBackup follows the cursor until the export is complete', async () => {
  const pages = { null: { items: [{ key: 'a', value: 1 }], cursor: 'c1' }, c1: { items: [{ key: 'b', value: 2 }], cursor: null } };
  const seen = [];
  const backup = await collectBackup(async (name, { cursor }) => { assert.equal(name, 'exportBackupPage'); return pages[cursor]; }, { app: 'Test app', onProgress: (n) => seen.push(n) });
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.deepEqual([backup.count, backup.app, seen], [2, 'Test app', [1, 2]]);
});

test('parseBackup accepts backups and explains anything else', () => {
  assert.equal(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: [] })).items.length, 0);
  assert.throws(() => parseBackup('not json'), /not valid JSON/);
  assert.throws(() => parseBackup('{"items":[]}'), /not a backup/);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, items: [] })), /newer version/);
});

test('restoreBatches keeps each call under the size and item limits', () => {
  const items = Array.from({ length: 1200 }, (_, i) => ({ key: `k${i}`, value: 'x'.repeat(i % 7 === 0 ? 3000 : 10) }));
  const batches = restoreBatches(items, { maxBytes: 50_000, maxItems: 500 });
  assert.equal(batches.flat().length, 1200);
  for (const batch of batches) {
    assert.ok(batch.length <= 500);
    assert.ok(JSON.stringify(batch).length <= 50_000 + 3100 * 1);
  }
});

test('restoreBackup sends every batch and adds up the results', async () => {
  const backup = { items: Array.from({ length: 1100 }, (_, i) => ({ key: `k${i}`, value: i })) };
  const calls = [];
  const totals = await restoreBackup(async (name, { items }) => { calls.push([name, items.length]); return { restored: items.length - 1, skipped: 1, failed: [] }; }, backup);
  assert.deepEqual(calls.map((c) => c[1]), [500, 500, 100]);
  assert.deepEqual(totals, { restored: 1097, skipped: 3, failed: [] });
});
