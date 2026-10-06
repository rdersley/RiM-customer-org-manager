// Finishing an import batch: the JSM customer bulk API creates and updates customer accounts, but it
// can't add them to a service project, and (tested on a live site) its organisation association doesn't
// happen. So after each batch's bulk task ends, the app looks up each customer's account id and adds them
// to the selected service project and to their organisations with the standard JSM APIs.
import api, { route } from '@forge/api';
import { retrying } from '../http.js';
import { kvs } from '@forge/kvs';

export const FINALISE_MAX_ROWS = 100;
const MEMBERSHIP_CHUNK = 50;
const LOOKUP_CONCURRENCY = 5;
const experimental = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' };

async function errorText(response) {
  const text = await response.text();
  try {
    const body = JSON.parse(text);
    return body?.errorMessage || body?.errorMessages?.join(' ') || body?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

// Finds the account id for an email. Jira's user search matches on email; when the result includes
// emailAddress it must match exactly, otherwise a single customer/user result is accepted.
export async function findAccountId(jira, email) {
  const res = await jira.requestJira(route`/rest/api/3/user/search?query=${email}&maxResults=10`);
  if (!res.ok) throw new Error(`User lookup failed: ${await errorText(res)}`);
  const users = (await res.json()) || [];
  const accounts = users.filter((u) => u?.accountId && u.accountType !== 'app');
  const wanted = email.trim().toLowerCase();
  const exact = accounts.filter((u) => String(u.emailAddress || '').toLowerCase() === wanted);
  if (exact.length === 1) return exact[0].accountId;
  if (exact.length > 1) throw new Error('More than one account uses this email.');
  const withoutEmail = accounts.filter((u) => !u.emailAddress);
  if (withoutEmail.length === 1 && accounts.length === 1) return withoutEmail[0].accountId;
  return null;
}

async function mapLimit(items, limit, fn) {
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

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Adds accounts to a service project or organisation in chunks. Returns the account ids that failed, with why.
async function addMembers(jira, path, accountIds) {
  const failed = new Map();
  for (const group of chunks(accountIds, MEMBERSHIP_CHUNK)) {
    const res = await jira.requestJira(path, { method: 'POST', headers: experimental, body: JSON.stringify({ accountIds: group }) });
    if (!res.ok) {
      const why = await errorText(res);
      group.forEach((id) => failed.set(id, why));
    }
  }
  return failed;
}

/**
 * rows: [{ rowNumber, email, organizationIds }]. Returns one result per row:
 *   { rowNumber, email, status: 'done' | 'not-found' | 'failed', accountId?, error? }
 */
export async function finaliseRows(jira, { serviceDeskId, rows }) {
  const results = await mapLimit(rows, LOOKUP_CONCURRENCY, async (row) => {
    const email = String(row.email || '').trim();
    try {
      const accountId = await findAccountId(jira, email);
      return accountId
        ? { rowNumber: row.rowNumber, email, status: 'done', accountId, organizationIds: (row.organizationIds || []).map(String) }
        : { rowNumber: row.rowNumber, email, status: 'not-found', error: 'Jira has no customer account for this email yet. The bulk task may still be running, or it rejected the row.' };
    } catch (e) {
      return { rowNumber: row.rowNumber, email, status: 'failed', error: e.message };
    }
  });

  const found = results.filter((r) => r.status === 'done');
  const deskFailures = await addMembers(jira, route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer`, [...new Set(found.map((r) => r.accountId))]);

  const byOrg = new Map();
  for (const r of found) for (const orgId of r.organizationIds) {
    if (!byOrg.has(orgId)) byOrg.set(orgId, new Set());
    byOrg.get(orgId).add(r.accountId);
  }
  const orgFailures = new Map();
  for (const [orgId, ids] of byOrg) {
    const failed = await addMembers(jira, route`/rest/servicedeskapi/organization/${orgId}/user`, [...ids]);
    failed.forEach((why, accountId) => orgFailures.set(`${orgId}:${accountId}`, why));
  }

  return results.map(({ organizationIds, ...r }) => {
    if (r.status !== 'done') return r;
    const problems = [];
    if (deskFailures.has(r.accountId)) problems.push(`Not added to the service project: ${deskFailures.get(r.accountId)}`);
    for (const orgId of organizationIds || []) {
      const why = orgFailures.get(`${orgId}:${r.accountId}`);
      if (why) problems.push(`Not added to organisation ${orgId}: ${why}`);
    }
    return problems.length ? { ...r, status: 'failed', error: problems.join(' ') } : r;
  });
}

// Records a batch's state on its import session and recomputes the session status. A batch counts as
// complete only once it has been finalised; the session is SUBMITTED when every batch is complete.
// Batches saved before finalising existed (no `finalised` field) count as complete. `patch` may be a
// function of the batch's current record (used by retries to add to its counts).
export async function updateSessionBatch({ importSessionId, batchNumber, totalBatches, patch, retention }) {
  const sessionKey = `import-session:${importSessionId}`;
  const previous = await kvs.get(sessionKey);
  if (!previous) throw new Error('Import recovery session was not found.');
  const prior = Array.isArray(previous.batches) ? previous.batches : [];
  const existing = prior.find((b) => Number(b.batchNumber) === batchNumber) || { batchNumber };
  const batches = [...prior.filter((b) => Number(b.batchNumber) !== batchNumber), { ...existing, ...(typeof patch === 'function' ? patch(existing) : patch) }]
    .sort((a, b) => Number(a.batchNumber) - Number(b.batchNumber));
  const total = Number(totalBatches || previous.totalBatches);
  const complete = batches.filter((b) => b.finalised !== false);
  const status = complete.length >= total ? 'SUBMITTED' : 'IN_PROGRESS';
  const updatedAt = new Date().toISOString();
  const session = {
    ...previous,
    totalBatches: total,
    batches,
    completedBatches: complete.length,
    submittedRows: batches.reduce((sum, b) => sum + Number(b.count || 0), 0),
    linkedRows: batches.reduce((sum, b) => sum + Number(b.linked || 0), 0),
    problemRows: batches.reduce((sum, b) => sum + Number(b.problems || 0), 0),
    status,
    updatedAt
  };
  await kvs.set(sessionKey, session, retention);
  if (status === 'SUBMITTED' && previous.fingerprint && previous.serviceDeskId) {
    await kvs.delete(`import-recovery:${previous.serviceDeskId}:${previous.fingerprint}`);
  }
  return session;
}

export function registerImportFinalise(secureDefine, { retention }) {
  secureDefine('finaliseImportBatch', async ({ payload }) => {
    const serviceDeskId = String(payload?.serviceDeskId || '').trim();
    if (!/^\d+$/.test(serviceDeskId)) throw new Error('serviceDeskId is required');
    const rows = (Array.isArray(payload?.rows) ? payload.rows : []).map((r) => ({
      rowNumber: Number(r?.rowNumber) || null,
      email: String(r?.email || '').trim(),
      organizationIds: (Array.isArray(r?.organizationIds) ? r.organizationIds : []).map(String).filter((id) => /^\d+$/.test(id))
    })).filter((r) => r.email);
    if (!rows.length) throw new Error('No rows supplied');
    if (rows.length > FINALISE_MAX_ROWS) throw new Error(`Finalise at most ${FINALISE_MAX_ROWS} rows per request`);

    const results = await finaliseRows(retrying(api.asUser()), { serviceDeskId, rows });
    const linked = results.filter((r) => r.status === 'done').length;
    const importSessionId = String(payload?.importSessionId || '').trim();
    if (importSessionId) {
      await updateSessionBatch({
        importSessionId,
        batchNumber: Math.max(1, Number(payload?.batchNumber || 1)),
        totalBatches: payload?.totalBatches,
        // A retry only re-checks rows that weren't found the first time: it adds to the batch's counts.
        patch: payload?.retry
          ? (b) => ({ linked: Number(b.linked || 0) + linked, problems: Math.max(0, Number(b.problems || 0) - linked), finalised: true })
          : { finalised: true, linked, problems: results.length - linked, finalisedAt: new Date().toISOString() },
        retention
      });
    }
    return { results, linked, problems: results.length - linked };
  }, { write: true });
}
