// Backup and restore of everything this app keeps in Forge key-value storage, so a site can move
// to another installation (or another app) without losing settings or data. The same file is used
// by every app, so a backup from one edition restores into the other.
//
// - Export walks every key in pages; the UI calls exportBackupPage until the cursor runs out and
//   saves the items as one JSON file. Secrets (kvs.setSecret) are never listed or exported.
// - Restore writes the items back with batchSet. Keys not in the backup are left alone. Items that
//   carried a time-to-live keep only the time they had left; items already expired are skipped.
// Both are admin-only: each app registers the resolvers behind its own admin check.
import { kvs } from '@forge/kvs';

// MetadataField.EXPIRE_TIME, written as its value so apps whose tests mock @forge/kvs with only
// `kvs` can still load this module.
const EXPIRE_TIME = 'EXPIRE_TIME';

export const BACKUP_FORMAT = 'forge-kvs-backup';
export const BACKUP_VERSION = 1;

const QUERY_PAGE = 100;
const EXPORT_MAX_BYTES = 2_000_000;
const EXPORT_MAX_MS = 10_000;
const RESTORE_MAX_ITEMS = 500;
const BATCH_SET_SIZE = 25;

const now = () => Date.now();

// One page of the export: as many storage pages as fit in ~2 MB or ~10 s.
export async function exportBackupPage(cursor, { maxBytes = EXPORT_MAX_BYTES, maxMs = EXPORT_MAX_MS } = {}) {
  const started = now();
  const items = [];
  let bytes = 0;
  let next = cursor || undefined;
  do {
    let query = kvs.query({ metadataFields: [EXPIRE_TIME] }).limit(QUERY_PAGE);
    if (next) query = query.cursor(next);
    const page = await query.getMany();
    for (const result of page.results || []) {
      const item = { key: result.key, value: result.value };
      if (result.expireTime) item.expireTime = result.expireTime;
      items.push(item);
      bytes += JSON.stringify(item).length;
    }
    next = page.nextCursor || undefined;
  } while (next && bytes < maxBytes && now() - started < maxMs);
  return { items, cursor: next || null };
}

function ttlFor(expireTime, at) {
  if (!expireTime) return null;
  const seconds = Math.floor((Date.parse(expireTime) - at) / 1000);
  if (!Number.isFinite(seconds)) return null;
  return seconds;
}

export function validateBackupItems(items) {
  if (!Array.isArray(items)) throw new Error('Backup batch must be a list of items.');
  if (items.length > RESTORE_MAX_ITEMS) throw new Error(`Restore at most ${RESTORE_MAX_ITEMS} items per call.`);
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 500) throw new Error('Backup item has no valid key.');
    if (!('value' in item)) throw new Error(`Backup item ${item.key} has no value.`);
  }
  return items;
}

// Restores one batch. Returns how many items were written and skipped, and the keys that failed.
export async function importBackupBatch(items, { skipKey = () => false } = {}) {
  validateBackupItems(items);
  const at = now();
  const writes = [];
  let skipped = 0;
  for (const item of items) {
    if (skipKey(item.key)) { skipped += 1; continue; }
    const ttl = ttlFor(item.expireTime, at);
    if (ttl !== null && ttl <= 0) { skipped += 1; continue; }
    writes.push({ key: item.key, value: item.value, ...(ttl ? { options: { ttl: { value: ttl, unit: 'SECONDS' } } } : {}) });
  }
  const failed = [];
  for (let i = 0; i < writes.length; i += BATCH_SET_SIZE) {
    const chunk = writes.slice(i, i + BATCH_SET_SIZE);
    const result = await kvs.batchSet(chunk);
    for (const failure of result?.failedKeys || []) failed.push(failure.key);
  }
  return { restored: writes.length - failed.length, skipped, failed };
}

// Registers the two resolvers on an existing resolver. The caller is responsible for making both
// admin-only (most apps pass their admin guard's key list; see each app's index).
export function defineBackupResolvers(resolver, { skipKey } = {}) {
  resolver.define('exportBackupPage', async ({ payload }) => exportBackupPage(payload?.cursor || null));
  resolver.define('importBackupBatch', async ({ payload }) => importBackupBatch(payload?.items, { skipKey }));
}

export const BACKUP_RESOLVERS = ['exportBackupPage', 'importBackupBatch'];
