import React, { useState } from 'react';
import { Button, Card, Notice } from '@retailinmotion/ui/react';
import { collectBackup, saveBackupFile, parseBackup, restoreBackup } from './backupClient.js';

// Backup & restore card for admin screens built with the shared UI kit. `invoke` calls the app's
// resolvers; the backend side is src/backup.js.
export default function BackupRestore({ invoke, app, filePrefix, children }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);

  const run = async (work) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };

  const download = () => run(async () => {
    setStatus('Reading app data…');
    const backup = await collectBackup(invoke, { app, onProgress: (n) => setStatus(`Reading app data… ${n.toLocaleString()} records`) });
    saveBackupFile(backup, filePrefix);
    setStatus(`Backup downloaded: ${backup.count.toLocaleString()} records.`);
  });

  const choose = (file) => run(async () => {
    setPending(null);
    if (!file) return;
    setPending({ name: file.name, backup: parseBackup(await file.text()) });
    setStatus('');
  });

  const restore = () => run(async () => {
    const { backup } = pending;
    const totals = await restoreBackup(invoke, backup, { onProgress: (done, total) => setStatus(`Restoring… ${done.toLocaleString()} of ${total.toLocaleString()}`) });
    setPending(null);
    setStatus(`Restore finished: ${totals.restored.toLocaleString()} records restored${totals.skipped ? `, ${totals.skipped.toLocaleString()} skipped (expired or not restorable)` : ''}.${totals.failed.length ? ` ${totals.failed.length} could not be written; restore again to retry them.` : ' Reload the app to see the restored data.'}`);
  });

  return <Card title="Backup & restore" description="Download everything this app stores on this site (settings and data) as one file, or restore a backup, for example to move to another installation of the app. Passwords and API keys are never included; enter them again after a restore.">
    <p><Button appearance="primary" disabled={busy} onClick={download}>Download backup</Button></p>
    <p>Restoring writes every record in the backup and replaces records with the same key. Records that are not in the backup are kept.</p>
    <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => choose(e.target.files?.[0])} />
    {pending && <p>
      <strong>{pending.name}</strong>: {(pending.backup.count ?? pending.backup.items.length).toLocaleString()} records{pending.backup.app ? ` from ${pending.backup.app}` : ''}, made {new Date(pending.backup.createdAt).toLocaleString()}.{' '}
      <Button appearance="primary" disabled={busy} onClick={restore}>Restore this backup</Button>{' '}
      <Button disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
    </p>}
    {status && <Notice kind="info">{status}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {children}
  </Card>;
}
