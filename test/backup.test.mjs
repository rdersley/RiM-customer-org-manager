import test from 'node:test';
import assert from 'node:assert/strict';
import { store, setOptions, resetStore } from './mocks/kvs.mjs';
import { exportBackupPage, importBackupBatch, validateBackupItems } from '../src/backup.js';

const exportAll = async (options) => {
  const items = []; let cursor = null; let calls = 0;
  do { const page = await exportBackupPage(cursor, options); items.push(...page.items); cursor = page.cursor; calls += 1; } while (cursor);
  return { items, calls };
};

test('a backup exports every record and restores to the same data', async () => {
  resetStore();
  for (let i = 0; i < 230; i += 1) store.set(`import-session:${String(i).padStart(3, '0')}`, { n: i, rows: [i] });
  const { items, calls } = await exportAll({ maxBytes: 4000 });
  assert.equal(items.length, 230);
  assert.ok(calls > 1);
  const before = JSON.stringify([...store.entries()].sort());
  resetStore();
  const result = await importBackupBatch(items.slice(0, 200));
  await importBackupBatch(items.slice(200));
  assert.deepEqual([result.restored, result.skipped, result.failed], [200, 0, []]);
  assert.equal(JSON.stringify([...store.entries()].sort()), before);
});

test('restore keeps the remaining time-to-live and skips expired records', async () => {
  resetStore();
  const result = await importBackupBatch([
    { key: 'cache', value: 1, expireTime: new Date(Date.now() + 60_000).toISOString() },
    { key: 'gone', value: 1, expireTime: new Date(Date.now() - 1000).toISOString() }
  ]);
  assert.deepEqual([result.restored, result.skipped], [1, 1]);
  assert.equal(setOptions.get('cache').ttl.unit, 'SECONDS');
  assert.equal(store.has('gone'), false);
});

test('restore rejects malformed batches', () => {
  assert.throws(() => validateBackupItems('nope'), /list of items/);
  assert.throws(() => validateBackupItems([{ value: 1 }]), /no valid key/);
});
