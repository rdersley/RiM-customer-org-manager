// Browser side of backup and restore (see the app's backend backup.js). Shared by every Custom UI.
// A backup file is JSON: { format, version, app, createdAt, count, items: [{ key, value, expireTime? }] }.
export const BACKUP_FORMAT = 'forge-kvs-backup';
export const BACKUP_VERSION = 1;
const RESTORE_BATCH_BYTES = 1_000_000;
const RESTORE_BATCH_ITEMS = 500;

export async function collectBackup(invoke, { app, onProgress } = {}) {
  const items = [];
  let cursor = null;
  do {
    const page = await invoke('exportBackupPage', { cursor });
    items.push(...(page?.items || []));
    cursor = page?.cursor || null;
    onProgress?.(items.length);
  } while (cursor);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: app || '', createdAt: new Date().toISOString(), count: items.length, items };
}

export function saveBackupFile(backup, filePrefix) {
  const stamp = backup.createdAt.slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filePrefix || 'app'}-backup-${stamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseBackup(text) {
  let backup;
  try { backup = JSON.parse(text); } catch { throw new Error('This file is not a backup (it is not valid JSON).'); }
  if (backup?.format !== BACKUP_FORMAT || !Array.isArray(backup.items)) throw new Error('This file is not a backup made by Backup & restore.');
  if (Number(backup.version) > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  return backup;
}

// Splits items into batches of at most ~1 MB and 500 items for the restore resolver.
export function restoreBatches(items, { maxBytes = RESTORE_BATCH_BYTES, maxItems = RESTORE_BATCH_ITEMS } = {}) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (batch.length && (bytes + size > maxBytes || batch.length >= maxItems)) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(item);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export async function restoreBackup(invoke, backup, { onProgress } = {}) {
  const totals = { restored: 0, skipped: 0, failed: [] };
  let done = 0;
  for (const batch of restoreBatches(backup.items)) {
    const result = await invoke('importBackupBatch', { items: batch });
    totals.restored += result?.restored || 0;
    totals.skipped += result?.skipped || 0;
    totals.failed.push(...(result?.failed || []));
    done += batch.length;
    onProgress?.(done, backup.items.length);
  }
  return totals;
}
