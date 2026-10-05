// One import batch, as run from the browser: submit the bulk upsert, wait for Jira's task to end, then
// finalise (service project + organisation membership). `invoke` is passed in so this is unit-tested
// against the real resolvers.

// Jira reports FAILED for bulk tasks that still created or updated the accounts (seen on a live site),
// so any terminal status just means "finished"; finalise decides what actually worked. A live site reports
// FINISHED; without it here every batch waited the full 10 minutes.
const TERMINAL = new Set(['FINISHED', 'COMPLETE', 'COMPLETED', 'SUCCESS', 'DONE', 'FAILED', 'CANCELLED']);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits up to 10 minutes. Moving on while a task is still running would pile up unfinished tasks, and
// Jira refuses new ones once it has too many ("Maximum number of tasks reached").
export async function waitForTask(invoke, taskId, { timeoutMs = 600000, intervalMs = 3000, sleep = defaultSleep, now = Date.now } = {}) {
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
  // A batch Jira already accepted (an earlier attempt, or a resumed import) isn't sent again: Jira refuses
  // a reused idempotency key while that task exists ("can only be retried with the same request data").
  // The retry just waits for that task and finalises.
  const task = options.taskId
    ? { id: options.taskId, importSessionId: plan.sessionId, batchNumber, totalBatches }
    : await invoke('bulkUpsertCustomers', {
      rows: chunk,
      importSessionId: plan.sessionId,
      batchNumber,
      totalBatches,
      idempotencyKey: `${plan.sessionId}-batch-${batchNumber}`,
      rowStart: chunk[0]?.rowNumber || null,
      rowEnd: chunk[chunk.length - 1]?.rowNumber || null
    });
  options.onSubmitted?.(task);
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

// The direct route (src/import/direct.js): a batch of up to 100 rows goes out as requests of
// DIRECT_ROWS customers, DIRECT_PARALLEL at a time. A request that fails (e.g. a function timeout while
// Jira rate-limits) is retried on its own after a pause; every step is safe to repeat. Then the batch is
// recorded on the import session.
export const DIRECT_ROWS = 10;
export const DIRECT_PARALLEL = 5;
const directRow = (r) => ({ rowNumber: r.rowNumber, email: r.email, displayName: r.displayName, details: r.details || {}, organizationIds: r.organizationIds || [], accountId: r.accountId || undefined, renamed: r.action === 'UPDATE' && !r.nameUnchanged ? true : undefined });

async function runLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function directImportBatch(invoke, plan, batchIndex, { sleep = defaultSleep, parallel = DIRECT_PARALLEL, retryDelays = [3000, 10000], onProgress } = {}) {
  const chunk = plan.chunks[batchIndex];
  const batchNumber = batchIndex + 1;
  const parts = [];
  for (let i = 0; i < chunk.length; i += DIRECT_ROWS) parts.push(chunk.slice(i, i + DIRECT_ROWS));
  let done = 0;
  const answers = await runLimited(parts, parallel, async (part) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const answer = await invoke('directImportCustomers', { serviceDeskId: plan.serviceDeskId, rows: part.map(directRow) });
        done += part.length;
        onProgress?.(done, chunk.length);
        return answer;
      } catch (e) {
        if (attempt >= retryDelays.length) throw e;
        await sleep(retryDelays[attempt]);
      }
    }
  });
  const results = answers.flatMap((a) => a?.results || []);
  const problems = results.filter((r) => r.status !== 'done');
  const linked = results.length - problems.length;
  await invoke('recordDirectBatch', {
    importSessionId: plan.sessionId,
    batchNumber,
    totalBatches: plan.chunks.length,
    count: chunk.length,
    linked,
    failures: problems.map((p) => ({ row: p.rowNumber, message: p.error }))
  });
  return { id: `direct-${batchNumber}`, batchNumber, submittedRows: chunk.length, linked, problems };
}

// A saved session's row plan: inline on sessions saved before chunking, otherwise read one chunk per call.
export async function loadRowPlan(invoke, session) {
  if (Array.isArray(session?.actionableRowNumbers)) return session.actionableRowNumbers.map(Number);
  const rows = [];
  for (let i = 0; i < Number(session?.rowPlanChunks || 0); i += 1) {
    const chunk = await invoke('getImportRowPlanChunk', { sessionId: session.id, index: i });
    if (!Array.isArray(chunk)) throw new Error(`The saved recovery row plan is incomplete (part ${i + 1} of ${session.rowPlanChunks} is missing). Start a new import rather than guessing.`);
    rows.push(...chunk.map(Number));
  }
  return rows;
}

// One entry from a Jira bulk task's `failures`: who it was about and why. Jira's shape isn't documented,
// so the common fields are tried and anything unrecognised is shown as the raw entry.
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(text).filter(Boolean).join('; ') : typeof v === 'object' ? (v.message || v.errorMessage || v.reason || v.code ? text(v.message || v.errorMessage || v.reason || v.code) : JSON.stringify(v)) : String(v));
export function describeFailure(failure) {
  if (failure == null || typeof failure !== 'object') return { who: '', why: text(failure) || 'No reason given', extra: '' };
  const p = failure.payload || failure.customerProfile || failure.item || {};
  const who = text(failure.email || failure.emailAddress || p.email || p.emailAddress || failure.identifier || failure.key || failure.id || (failure.row ? `Row ${failure.row}` : ''));
  const why = text(failure.errorMessage || failure.message || failure.errors || failure.error || failure.reason || failure.errorMessages || failure.code)
    || JSON.stringify(failure).slice(0, 300);
  // Everything else Jira sent (e.g. which row or field), so a bare message like "Invalid detail field value" can be traced.
  const { errorMessage, message, ...rest } = failure;
  const extra = Object.keys(rest).length ? JSON.stringify(rest).slice(0, 500) : '';
  return { who, why, extra };
}

// Failure reasons across tasks, most common first: [{ why, count }].
export function failureReasons(tasks) {
  const counts = new Map();
  for (const task of tasks || []) for (const f of task?.failures || []) {
    const { why } = describeFailure(f);
    counts.set(why, (counts.get(why) || 0) + 1);
  }
  return [...counts].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count);
}

export const isTaskLimitError = (error) => /maximum number of tasks/i.test(String(error?.message || error || ''));

// How long the import waits for Jira to work through earlier tasks before it pauses: every minute, for up to an hour.
export const TASK_LIMIT_WAIT = { intervalMs: 60000, maxWaits: 60 };

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// CSV of rows that didn't finish, in the import's own format plus the reason, so they can be fixed and re-imported.
// Customer detail columns are added (named after the fields, so the mapping matches them) when rows have any.
export function problemRowsCsv(problems, rowsByNumber) {
  const rows = problems.map((p) => rowsByNumber.get(p.rowNumber) || {});
  const detailNames = [...new Set(rows.flatMap((row) => Object.keys(row.details || {})))];
  const lines = [['Email', 'Full Name', 'Organisation', ...detailNames, 'Row', 'Problem'].map(csvCell).join(',')];
  problems.forEach((p, i) => {
    const row = rows[i];
    const details = detailNames.map((name) => [].concat(row.details?.[name] ?? []).join('; '));
    lines.push([p.email, row.displayName || '', row.organisation || '', ...details, p.rowNumber, p.error || p.status].map(csvCell).join(','));
  });
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
