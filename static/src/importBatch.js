// One import batch, as run from the browser: submit the bulk upsert, wait for Jira's task to end, then
// finalise (service project + organisation membership). `invoke` is passed in so this is unit-tested
// against the real resolvers.

// Jira reports FAILED for bulk tasks that still created or updated the accounts (seen on a live site),
// so any terminal status just means "finished"; finalise decides what actually worked.
const TERMINAL = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'DONE', 'FAILED', 'CANCELLED']);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForTask(invoke, taskId, { timeoutMs = 90000, intervalMs = 2000, sleep = defaultSleep, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let status = '';
    try {
      status = String((await invoke('getTaskStatus', { taskId }))?.status || '').toUpperCase();
    } catch {
      status = '';
    }
    if (TERMINAL.has(status)) return status;
    if (now() >= deadline) return 'TIMED_OUT';
    await sleep(intervalMs);
  }
}

export async function submitAndFinaliseBatch(invoke, plan, batchIndex, options = {}) {
  const chunk = plan.chunks[batchIndex];
  const batchNumber = batchIndex + 1;
  const totalBatches = plan.chunks.length;
  const task = await invoke('bulkUpsertCustomers', {
    rows: chunk,
    importSessionId: plan.sessionId,
    batchNumber,
    totalBatches,
    idempotencyKey: `${plan.sessionId}-batch-${batchNumber}`,
    rowStart: chunk[0]?.rowNumber || null,
    rowEnd: chunk[chunk.length - 1]?.rowNumber || null
  });
  const taskStatus = await waitForTask(invoke, task.id, options);
  const finalised = await invoke('finaliseImportBatch', {
    rows: chunk.map((r) => ({ rowNumber: r.rowNumber, email: r.email, organizationIds: r.organizationIds || [] })),
    serviceDeskId: plan.serviceDeskId,
    importSessionId: plan.sessionId,
    batchNumber,
    totalBatches
  });
  return {
    ...task,
    taskStatus,
    submittedRows: chunk.length,
    linked: finalised.linked,
    problems: (finalised.results || []).filter((r) => r.status !== 'done')
  };
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// CSV of rows that didn't finish, in the import's own format plus the reason, so they can be fixed and re-imported.
export function problemRowsCsv(problems, rowsByNumber) {
  const lines = ['Email,Full Name,Organisation,Row,Problem'];
  for (const p of problems) {
    const row = rowsByNumber.get(p.rowNumber) || {};
    lines.push([p.email, row.displayName || '', row.organisation || '', p.rowNumber, p.error || p.status].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Jira's user search only finds a newly created account a little while after the bulk task ends (minutes
// on a live site). So rows reported "not-found" are re-checked at the end of the import: every `waitMs`,
// up to `attempts` times, per batch so the session's counts stay right. Returns the problems that remain.
export async function recheckNotFound(invoke, plan, problems, { attempts = 12, waitMs = 15000, sleep = defaultSleep, onProgress = () => {} } = {}) {
  const batchOf = new Map();
  plan.chunks.forEach((chunk, i) => chunk.forEach((row) => batchOf.set(row.rowNumber, { batchIndex: i, row })));
  let remaining = problems.filter((p) => p.status === 'not-found' && batchOf.has(p.rowNumber));
  const other = problems.filter((p) => !remaining.includes(p));
  for (let attempt = 1; attempt <= attempts && remaining.length; attempt += 1) {
    onProgress({ attempt, attempts, waiting: remaining.length });
    await sleep(waitMs);
    const byBatch = new Map();
    for (const p of remaining) {
      const { batchIndex } = batchOf.get(p.rowNumber);
      if (!byBatch.has(batchIndex)) byBatch.set(batchIndex, []);
      byBatch.get(batchIndex).push(batchOf.get(p.rowNumber).row);
    }
    const next = [];
    for (const [batchIndex, rows] of byBatch) {
      const r = await invoke('finaliseImportBatch', {
        rows: rows.map((row) => ({ rowNumber: row.rowNumber, email: row.email, organizationIds: row.organizationIds || [] })),
        serviceDeskId: plan.serviceDeskId,
        importSessionId: plan.sessionId,
        batchNumber: batchIndex + 1,
        totalBatches: plan.chunks.length,
        retry: true
      });
      for (const result of r.results || []) {
        if (result.status === 'not-found') next.push(result);
        else if (result.status !== 'done') other.push(result);
      }
    }
    remaining = next;
  }
  return [...other, ...remaining].sort((a, b) => a.rowNumber - b.rowNumber);
}
