// The direct import route. The CSM bulk profile API queues each batch as a background task, and on a
// live site Jira worked through those one at a time at about 8 minutes per 100 customers (20 hours for
// 16,000). This route uses calls that answer straight away, so the browser can run several at once:
//   1. create the customer (POST /rest/servicedeskapi/customer), which returns the account id; an existing
//      customer is found by email instead (or comes with its id from the preview),
//   2. set each customer detail (PUT /jsm/csm/api/v1/customer/{id}/details),
//   3. add the accounts to the service project and their organisations (finalise.js).
// A changed name on an existing customer can't be set with these calls, so those few rows go to the bulk
// API (without details) and Jira applies the name in the background.
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { retrying } from '../http.js';
import { errorText, findAccount, addToProjectAndOrganisations, updateSessionBatch } from './finalise.js';
import { customerDetails } from './customerDetails.js';

export const DIRECT_MAX_ROWS = 10;
const experimental = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' };
const jsonHeaders = { Accept: 'application/json', 'Content-Type': 'application/json' };

// One row: returns { rowNumber, email, status: 'done' | 'failed', accountId?, created?, rename?, detailErrors?, error? }.
export async function importCustomer(jira, row) {
  const email = String(row.email || '').trim();
  const displayName = String(row.displayName || row.fullName || '').trim();
  const base = { rowNumber: Number(row.rowNumber) || null, email, organizationIds: (row.organizationIds || []).map(String).filter((id) => /^\d+$/.test(id)) };
  try {
    let accountId = row.accountId ? String(row.accountId) : null;
    let rename = Boolean(accountId && row.renamed);
    let created = false;
    if (!accountId) {
      const res = await jira.requestJira(route`/rest/servicedeskapi/customer`, { method: 'POST', headers: experimental, body: JSON.stringify({ email, displayName }) });
      if (res.ok) {
        accountId = (await res.json())?.accountId || null;
        created = Boolean(accountId);
      } else {
        // Usually "already exists": use the existing account.
        const why = await errorText(res);
        const existing = await findAccount(jira, email);
        if (!existing) return { ...base, status: 'failed', error: `Customer not created: ${why}` };
        accountId = existing.accountId;
        rename = Boolean(displayName) && String(existing.displayName || '').trim() !== displayName;
      }
      if (!accountId) return { ...base, status: 'failed', error: 'Jira created the customer but returned no account id.' };
    }
    // A detail Jira refuses (e.g. a phone number in the wrong format) doesn't stop the others.
    const detailErrors = [];
    for (const { name, values } of customerDetails(row.details)) {
      const res = await jira.requestJira(route`/jsm/csm/api/v1/customer/${accountId}/details?fieldName=${name}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ values }) });
      if (!res.ok) detailErrors.push(`${name} not set: ${await errorText(res)}`);
    }
    return { ...base, status: 'done', accountId, created, rename, detailErrors };
  } catch (e) {
    return { ...base, status: 'failed', error: e.message };
  }
}

// Sends changed names of existing customers through the bulk API (no details, no waiting). Returns an
// error message if Jira refused the request.
async function queueRenames(jira, rows) {
  if (!rows.length) return '';
  const res = await jira.requestJira(route`/jsm/csm/api/v1/customer/profile/bulk`, {
    method: 'POST',
    headers: { ...jsonHeaders, 'Idempotency-Key': globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` },
    body: JSON.stringify({ customerProfiles: rows.map((r) => ({ operationType: 'UPSERT', payload: { email: r.email, displayName: r.displayName } })) })
  });
  return res.ok ? '' : await errorText(res);
}

export async function importCustomers(jira, { serviceDeskId, rows }) {
  const results = await Promise.all(rows.map((row) => importCustomer(jira, row)));
  const byRow = new Map(rows.map((r) => [Number(r.rowNumber), r]));
  const renameError = await queueRenames(jira, results.filter((r) => r.status === 'done' && r.rename)
    .map((r) => ({ email: r.email, displayName: String(byRow.get(r.rowNumber)?.displayName || '').trim() })).filter((r) => r.displayName));
  const withRenames = renameError
    ? results.map((r) => (r.rename ? { ...r, detailErrors: [...(r.detailErrors || []), `Name not updated: ${renameError}`] } : r))
    : results;
  const linked = await addToProjectAndOrganisations(jira, serviceDeskId, withRenames);
  return linked.map(({ rename, ...r }) => r);
}

export function registerDirectImport(secureDefine, { retention }) {
  secureDefine('directImportCustomers', async ({ payload }) => {
    const serviceDeskId = String(payload?.serviceDeskId || '').trim();
    if (!/^\d+$/.test(serviceDeskId)) throw new Error('serviceDeskId is required');
    const rows = (Array.isArray(payload?.rows) ? payload.rows : []).filter((r) => String(r?.email || '').trim());
    if (!rows.length) throw new Error('No rows supplied');
    if (rows.length > DIRECT_MAX_ROWS) throw new Error(`Import at most ${DIRECT_MAX_ROWS} customers per request`);
    return { results: await importCustomers(retrying(api.asUser()), { serviceDeskId, rows }) };
  }, { write: true });

  // Records a finished direct batch on its import session (for resume) and in Import History.
  secureDefine('recordDirectBatch', async ({ payload }) => {
    const importSessionId = String(payload?.importSessionId || '').trim();
    const batchNumber = Math.max(1, Number(payload?.batchNumber || 1));
    const totalBatches = Math.max(batchNumber, Number(payload?.totalBatches || batchNumber));
    const count = Math.max(0, Number(payload?.count || 0));
    const linked = Math.max(0, Number(payload?.linked || 0));
    // Row numbers and reasons only: import records hold no customer emails or names (docs/DATA_HANDLING.md).
    const failures = (Array.isArray(payload?.failures) ? payload.failures : []).slice(0, 100)
      .map((f) => ({ row: Number(f?.row) || null, message: String(f?.message || '').replace(/\S+@\S+/g, '[email]').slice(0, 500) }));
    if (!importSessionId) throw new Error('importSessionId is required');
    const at = new Date().toISOString();
    await updateSessionBatch({
      importSessionId,
      batchNumber,
      totalBatches,
      patch: { count, method: 'direct', submittedAt: at, finalised: true, linked, problems: Math.max(0, count - linked), finalisedAt: at },
      retention
    });
    const id = `${importSessionId}-batch-${batchNumber}`;
    await kvs.set(`import:${id}`, {
      id, importSessionId, batchNumber, totalBatches, count, createdAt: at, type: 'CUSTOMER_DIRECT',
      task: { status: 'FINISHED', failures }
    }, retention);
    return { ok: true };
  }, { write: true });
}
