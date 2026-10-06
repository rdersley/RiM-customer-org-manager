import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { resolverLicenseAllows, isProductionContext, UNLICENSED_MESSAGE } from './license.js';
import { retrying, RATE_LIMITED_MESSAGE } from './http.js';
import { registerSyncResolvers } from './sync/resolvers.js';
import { registerImportFinalise, updateSessionBatch } from './import/finalise.js';
export { handleIssueEvent } from './sync/events.js';

// Must match package.json (a unit test checks this).
export const APP_VERSION = '0.6.2';

const resolver = new Resolver();
// Every Jira call from the admin page goes through this: it backs off on 429/503 (src/http.js).
const asUser = () => retrying(api.asUser());

async function jsonResponse(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(response.status === 429 ? RATE_LIMITED_MESSAGE : (body?.message || body?.errorMessage || `Atlassian API error ${response.status}`));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

// A passed admin check is remembered for 60 seconds per user (in this function instance), so a busy
// screen doesn't call Jira's permission API on every click. A failed check is never cached.
const ADMIN_CHECK_TTL_MS = 60000;
const adminChecks = new Map();
export function clearAdminCacheForTests() { adminChecks.clear(); }

async function requireAdmin(accountId) {
  const cached = accountId ? adminChecks.get(accountId) : null;
  if (cached && cached > Date.now()) return;
  const res = await asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  const body = await jsonResponse(res);
  if (body?.permissions?.ADMINISTER?.havePermission) {
    if (accountId) adminChecks.set(accountId, Date.now() + ADMIN_CHECK_TTL_MS);
    return;
  }
  adminChecks.delete(accountId);
  const error = new Error('Jira administrator permission is required to use Customer & Organisation Manager.');
  error.status = 403;
  throw error;
}

// Every resolver except health needs a Jira administrator. Resolvers that change Jira or app
// storage (`{ write: true }`) also need an active licence; see src/license.js.
function secureDefine(name, handler, { write = false } = {}) {
  resolver.define(name, async (request) => {
    await requireAdmin(request?.context?.accountId);
    if (write && !resolverLicenseAllows(request?.context)) {
      const error = new Error(UNLICENSED_MESSAGE);
      error.status = 402;
      throw error;
    }
    return handler(request);
  });
}

resolver.define('health', async () => ({ ok: true, version: APP_VERSION }));

secureDefine('getAppStatus', async ({ context }) => ({
  version: APP_VERSION,
  licensed: resolverLicenseAllows(context),
  production: isProductionContext(context)
}));

secureDefine('getServiceDesks', async () => {
  const res = await asUser().requestJira(route`/rest/servicedeskapi/servicedesk?limit=100`);
  return jsonResponse(res);
});

const customerHeaders = {
  Accept: 'application/json',
  'X-ExperimentalApi': 'opt-in'
};

secureDefine('getCustomers', async ({ payload }) => {
  const serviceDeskId = String(payload?.serviceDeskId || '');
  const query = String(payload?.query || '');
  const start = Number(payload?.start || 0);
  if (!serviceDeskId) throw new Error('serviceDeskId is required');

  const res = await asUser().requestJira(
    route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?query=${query}&start=${start}&limit=50`,
    { headers: customerHeaders }
  );
  return jsonResponse(res);
});

secureDefine('getCustomerIndexBatch', async ({ payload }) => {
  const serviceDeskId = String(payload?.serviceDeskId || '');
  let start = Math.max(0, Number(payload?.start || 0));
  const pages = Math.min(10, Math.max(1, Number(payload?.pages || 10)));
  if (!serviceDeskId) throw new Error('serviceDeskId is required');

  const customers = [];
  let complete = false;
  let pagesFetched = 0;

  for (let page = 0; page < pages; page += 1) {
    const res = await asUser().requestJira(
      route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/customer?start=${start}&limit=50`,
      { headers: customerHeaders }
    );
    const body = await jsonResponse(res);
    const values = body?.values || [];
    customers.push(...values.map((customer) => ({
      accountId: customer.accountId || customer.key || '',
      displayName: customer.displayName || '',
      emailAddress: customer.emailAddress || ''
    })));
    pagesFetched += 1;

    if (body?.isLastPage || values.length === 0) {
      complete = true;
      break;
    }

    const limit = Number(body?.limit || 50);
    const returnedStart = Number(body?.start ?? start);
    const nextStart = returnedStart + limit;
    if (!Number.isFinite(nextStart) || nextStart <= start) {
      throw new Error('Jira customer pagination did not advance safely.');
    }
    start = nextStart;
  }

  return { customers, nextStart: start, complete, pagesFetched };
});

secureDefine('createOrganization', async ({ payload }) => {
  const name = String(payload?.name || '').trim();
  if (!name) throw new Error('Organisation name is required');
  const res = await asUser().requestJira(route`/rest/servicedeskapi/organization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name })
  });
  return jsonResponse(res);
}, { write: true });

const ORG_LOOKUP_MAX_PAGES = 40;
const ORG_LOOKUP_BUDGET_MS = 15000;
const ORG_CREATE_MAX_PER_CALL = 20;

function organisationKey(name) {
  return String(name || '').trim().toLowerCase();
}

function uniqueOrganisationNames(names) {
  const byKey = new Map();
  for (const value of names || []) {
    const name = String(value || '').trim();
    if (name && !byKey.has(organisationKey(name))) byKey.set(organisationKey(name), name);
  }
  return [...byKey.values()];
}

// Pages through Jira organisations from `start`, passing each page to `onPage` (return true to stop early).
// Stops at Jira's final page or when the page/time budget runs out; callers resume from `nextStart` until `complete`.
async function scanOrganizations(startAt, pages, onPage) {
  let start = Math.max(0, Number(startAt || 0));
  const maxPages = Math.min(ORG_LOOKUP_MAX_PAGES, Math.max(1, Number(pages || ORG_LOOKUP_MAX_PAGES)));
  const deadline = Date.now() + ORG_LOOKUP_BUDGET_MS;
  let complete = false;
  let pagesFetched = 0;

  while (pagesFetched < maxPages && Date.now() < deadline) {
    const res = await asUser().requestJira(route`/rest/servicedeskapi/organization?start=${start}&limit=50`);
    const body = await jsonResponse(res);
    const values = body?.values || [];
    pagesFetched += 1;
    const stop = onPage(values);

    if (body?.isLastPage || values.length === 0) {
      complete = true;
      break;
    }

    const nextStart = Number(body?.start ?? start) + Number(body?.limit || 50);
    if (!Number.isFinite(nextStart) || nextStart <= start) {
      throw new Error('Jira organisation pagination did not advance safely.');
    }
    start = nextStart;
    if (stop) break;
  }

  return { nextStart: start, complete, pagesFetched };
}

secureDefine('getOrganizationIndexBatch', async ({ payload }) => {
  const organizations = [];
  const scan = await scanOrganizations(payload?.start, payload?.pages, (values) => {
    organizations.push(...values.map((org) => ({ id: org.id, name: org.name })));
  });
  return { organizations, ...scan };
});

// Looks for the wanted names, stopping early once every one is found.
secureDefine('getImportOrganizations', async ({ payload }) => {
  const wanted = new Set(uniqueOrganisationNames(payload?.names).map(organisationKey));
  if (!wanted.size) return { organizations: [], nextStart: Number(payload?.start || 0), complete: true, allFound: true, pagesFetched: 0 };
  const organizations = [];
  const scan = await scanOrganizations(payload?.start, payload?.pages, (values) => {
    for (const org of values) {
      if (wanted.delete(organisationKey(org.name))) organizations.push({ id: org.id, name: org.name });
    }
    return wanted.size === 0;
  });
  return { organizations, ...scan, allFound: wanted.size === 0 };
});

// Only call with names that a complete getImportOrganizations scan reported as missing.
secureDefine('createImportOrganizations', async ({ payload }) => {
  const names = uniqueOrganisationNames(payload?.names);
  if (names.length > ORG_CREATE_MAX_PER_CALL) {
    throw new Error(`Create at most ${ORG_CREATE_MAX_PER_CALL} organisations per call.`);
  }
  const created = [];
  for (const name of names) {
    const res = await asUser().requestJira(route`/rest/servicedeskapi/organization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name })
    });
    const org = await jsonResponse(res);
    created.push({ id: org.id, name: org.name });
  }
  return { created };
}, { write: true });

secureDefine('getImportMappings', async () => {
  const result = await kvs.query().where('key', WhereConditions.beginsWith('import-mapping:')).limit(50).getMany();
  return (result.results || []).map((r) => r.value).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
});

secureDefine('saveImportMapping', async ({ payload }) => {
  const id = String(payload?.id || '').trim() || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  const name = String(payload?.name || '').trim().slice(0, 100);
  const serviceDeskId = String(payload?.serviceDeskId || '').trim();
  const emailHeader = String(payload?.emailHeader || '').trim().slice(0, 255);
  const displayNameHeader = String(payload?.displayNameHeader || '').trim().slice(0, 255);
  const organisationHeader = String(payload?.organisationHeader || '').trim().slice(0, 255);
  if (!name) throw new Error('Mapping name is required');
  if (!serviceDeskId) throw new Error('serviceDeskId is required');
  if (!emailHeader || !displayNameHeader) throw new Error('Email and Display Name mappings are required');

  const key = `import-mapping:${id}`;
  const existing = await kvs.get(key);
  const now = new Date().toISOString();
  const mapping = {
    id,
    name,
    serviceDeskId,
    emailHeader,
    displayNameHeader,
    organisationHeader,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await kvs.set(key, mapping);
  return mapping;
}, { write: true });

secureDefine('deleteImportMapping', async ({ payload }) => {
  const id = String(payload?.id || '').trim();
  if (!id) throw new Error('Mapping id is required');
  await kvs.delete(`import-mapping:${id}`);
  return { ok: true, id };
}, { write: true });

secureDefine('getTaskStatus', async ({ payload }) => {
  const taskId = String(payload?.taskId || '');
  if (!taskId) throw new Error('taskId is required');
  const res = await asUser().requestJira(route`/jsm/csm/api/v1/tasks/${taskId}`);
  return jsonResponse(res);
});

secureDefine('getImportHistory', async () => {
  const result = await kvs.query().where('key', WhereConditions.beginsWith('import:')).limit(100).getMany();
  return (result.results || []).map(r => r.value).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
});

// A session's row plan can hold up to 50,000 row numbers, which is more than one KVS value can store
// (240 KiB), so it is saved in chunks under import-session-rows:<id>:<n>.
const ROW_PLAN_CHUNK = 5000;

// Import records (history, sessions, row plans, recovery pointers) expire 180 days after their last
// update; saved mappings are configuration and stay until deleted. Documented in docs/DATA_HANDLING.md.
export const IMPORT_RECORD_RETENTION = { ttl: { value: 180, unit: 'DAYS' } };

async function saveRowPlan(sessionId, rowNumbers) {
  const chunks = Math.ceil(rowNumbers.length / ROW_PLAN_CHUNK);
  for (let i = 0; i < chunks; i += 1) {
    await kvs.set(`import-session-rows:${sessionId}:${i}`, rowNumbers.slice(i * ROW_PLAN_CHUNK, (i + 1) * ROW_PLAN_CHUNK), IMPORT_RECORD_RETENTION);
  }
  return chunks;
}

async function loadRowPlan(session) {
  if (Array.isArray(session?.actionableRowNumbers)) return session.actionableRowNumbers; // sessions saved before chunking
  const rows = [];
  for (let i = 0; i < Number(session?.rowPlanChunks || 0); i += 1) {
    const chunk = await kvs.get(`import-session-rows:${session.id}:${i}`);
    if (!Array.isArray(chunk)) throw new Error('The saved recovery row plan is incomplete. Start a new import rather than guessing.');
    rows.push(...chunk);
  }
  return rows;
}

// Lists sessions without their row plans (the Import History tab only needs the summary).
secureDefine('getImportSessions', async () => {
  const result = await kvs.query().where('key', WhereConditions.beginsWith('import-session:')).limit(50).getMany();
  return (result.results || []).map((r) => {
    const { actionableRowNumbers, ...session } = r.value || {};
    return session;
  }).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
});

secureDefine('getImportSessionSummaries', async () => {
  const result = await kvs.query().where('key', WhereConditions.beginsWith('import-session:')).limit(50).getMany();
  return (result.results || []).map((r) => {
    const { actionableRowNumbers, batches, fingerprint, ...summary } = r.value || {};
    return summary;
  }).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
});

secureDefine('findRecoverableImportSession', async ({ payload }) => {
  const fingerprint = String(payload?.fingerprint || '').trim().toLowerCase();
  const serviceDeskId = String(payload?.serviceDeskId || '').trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('A SHA-256 import fingerprint is required');
  if (!serviceDeskId) throw new Error('serviceDeskId is required');

  const pointer = await kvs.get(`import-recovery:${serviceDeskId}:${fingerprint}`);
  if (!pointer?.sessionId) return null;
  const session = await kvs.get(`import-session:${pointer.sessionId}`);
  if (!session || session.status === 'SUBMITTED' || session.fingerprint !== fingerprint || String(session.serviceDeskId) !== serviceDeskId) return null;
  return { ...session, actionableRowNumbers: await loadRowPlan(session) };
});

secureDefine('startImportSession', async ({ payload }) => {
  const id = String(payload?.id || '').trim();
  const fingerprint = String(payload?.fingerprint || '').trim().toLowerCase();
  const serviceDeskId = String(payload?.serviceDeskId || '').trim();
  const fileName = String(payload?.fileName || '').trim().slice(0, 255);
  const actionableRowNumbers = Array.isArray(payload?.actionableRowNumbers)
    ? payload.actionableRowNumbers.map(Number).filter((n) => Number.isInteger(n) && n >= 2)
    : [];
  const totalRows = Math.max(0, Number(payload?.totalRows || actionableRowNumbers.length));
  const totalBatches = Math.max(1, Number(payload?.totalBatches || Math.ceil(actionableRowNumbers.length / 100) || 1));
  const skipped = Math.max(0, Number(payload?.skipped || 0));
  const excludedErrors = Math.max(0, Number(payload?.excludedErrors || 0));
  // The CSV columns used for this import, so a resume reads the same columns.
  const header = (v) => String(v || '').trim().slice(0, 255);
  const mapping = payload?.mapping ? { emailHeader: header(payload.mapping.emailHeader), displayNameHeader: header(payload.mapping.displayNameHeader), organisationHeader: header(payload.mapping.organisationHeader) } : null;

  if (!id) throw new Error('Import session id is required');
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('A SHA-256 import fingerprint is required');
  if (!serviceDeskId) throw new Error('serviceDeskId is required');
  if (!actionableRowNumbers.length) throw new Error('No actionable row numbers supplied');
  if (actionableRowNumbers.length > 50000) throw new Error('Recovery metadata supports at most 50,000 actionable rows');
  if (new Set(actionableRowNumbers).size !== actionableRowNumbers.length) throw new Error('Actionable row numbers must be unique');
  if (totalRows !== actionableRowNumbers.length) throw new Error('Recovery row count does not match the actionable plan');
  if (totalBatches !== Math.ceil(totalRows / 100)) throw new Error('Recovery batch count does not match the actionable plan');

  const key = `import-session:${id}`;
  const existing = await kvs.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint || String(existing.serviceDeskId) !== serviceDeskId) {
      throw new Error('Import session identity does not match the saved recovery checkpoint');
    }
    return existing;
  }

  const createdAt = new Date().toISOString();
  const rowPlanChunks = await saveRowPlan(id, actionableRowNumbers);
  const session = {
    id,
    fingerprint,
    serviceDeskId,
    fileName,
    rowPlanChunks,
    mapping,
    totalRows,
    totalBatches,
    skipped,
    excludedErrors,
    completedBatches: 0,
    submittedRows: 0,
    status: 'READY',
    createdAt,
    updatedAt: createdAt,
    batches: []
  };
  await kvs.set(key, session, IMPORT_RECORD_RETENTION);
  await kvs.set(`import-recovery:${serviceDeskId}:${fingerprint}`, { sessionId: id, updatedAt: createdAt }, IMPORT_RECORD_RETENTION);
  return session;
}, { write: true });

secureDefine('validateImport', async ({ payload }) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const seen = new Set();
  const errors = [];
  rows.forEach((row, index) => {
    const email = String(row.email || '').trim().toLowerCase();
    const displayName = String(row.displayName || row.fullName || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) errors.push({ row: index + 2, field: 'email', message: 'Valid email required' });
    if (!displayName) errors.push({ row: index + 2, field: 'displayName', message: 'Display name required' });
    if (email && seen.has(email)) errors.push({ row: index + 2, field: 'email', message: 'Duplicate email in file' });
    if (email) seen.add(email);
  });
  return { total: rows.length, valid: Math.max(0, rows.length - new Set(errors.map(e => e.row)).size), errors };
});

secureDefine('bulkUpsertCustomers', async ({ payload }) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!rows.length) throw new Error('No rows supplied');
  if (rows.length > 100) throw new Error('This operation accepts at most 100 rows per request');

  // Creates or updates the customer accounts only. Service project and organisation membership are added
  // afterwards by finaliseImportBatch (src/import/finalise.js), because this API can't do the first and,
  // on a live site, silently didn't do the second.
  const customerProfiles = rows.map((row) => ({
    operationType: 'UPSERT',
    payload: {
      email: String(row.email || '').trim(),
      displayName: String(row.displayName || row.fullName || '').trim()
    }
  }));

  const suppliedKey = String(payload?.idempotencyKey || '').trim();
  const idempotencyKey = suppliedKey || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  if (idempotencyKey.length > 200) throw new Error('Idempotency key is too long');

  const importSessionId = String(payload?.importSessionId || '').trim() || null;
  const batchNumber = Math.max(1, Number(payload?.batchNumber || 1));
  const totalBatches = Math.max(batchNumber, Number(payload?.totalBatches || batchNumber));
  const rowStart = Number(payload?.rowStart || 0) || null;
  const rowEnd = Number(payload?.rowEnd || 0) || null;

  if (importSessionId) {
    const saved = await kvs.get(`import-session:${importSessionId}`);
    if (!saved) throw new Error('Import recovery session was not initialised before batch submission');
    if (Number(saved.totalBatches) !== totalBatches) throw new Error('Batch count does not match the saved import recovery plan');
  }

  const res = await asUser().requestJira(route`/jsm/csm/api/v1/customer/profile/bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({ customerProfiles })
  });
  const task = await jsonResponse(res);
  const createdAt = new Date().toISOString();
  const history = {
    id: idempotencyKey,
    importSessionId,
    batchNumber,
    totalBatches,
    taskId: task.id,
    statusUrl: task.statusUrl,
    count: rows.length,
    rowStart,
    rowEnd,
    createdAt,
    type: 'CUSTOMER_PROFILE_UPSERT'
  };

  await kvs.set(`import:${history.id}`, history, IMPORT_RECORD_RETENTION);

  if (importSessionId) {
    await updateSessionBatch({
      importSessionId,
      batchNumber,
      totalBatches,
      patch: { count: rows.length, taskId: task.id, idempotencyKey, rowStart, rowEnd, submittedAt: createdAt, finalised: false },
      retention: IMPORT_RECORD_RETENTION
    });
  }

  return { ...task, importSessionId, batchNumber, totalBatches, idempotencyKey };
}, { write: true });

registerSyncResolvers(secureDefine);
registerImportFinalise(secureDefine, { retention: IMPORT_RECORD_RETENTION });

export const handler = resolver.getDefinitions();