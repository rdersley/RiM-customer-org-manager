// Jira calls for ticket details sync. Each takes a `jira` requester: api.asUser() from the admin page,
// api.asApp() from the issue event trigger.
import { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { readCustomerDetails, evaluateTicket, fieldValue, detailsJql, ticketMatchKey, exactDetailMatches } from './rules.js';

export const DETAIL_SYNC_CONFIG_KEY = 'detail-sync-config';
// Log entries hold issue keys and field names only (no customer values); they expire after 90 days.
const LOG_RETENTION = { ttl: { value: 90, unit: 'DAYS' } };
const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

async function json(response, what) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    const detail = body?.errorMessages?.join(' ') || Object.values(body?.errors || {}).join(' ') || body?.errorMessage || body?.message || `HTTP ${response.status}`;
    const error = new Error(`${what} failed: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export const getDetailConfig = async () => (await kvs.get(DETAIL_SYNC_CONFIG_KEY)) || null;

// A customer's detail values ({ name: value }); {} when the reporter isn't a customer with details.
// GET /customer/{id} returns { id, name, details: [{ name, values }], organizations }. (There is no GET on
// /customer/{id}/details; that path only takes PUT, and calling it made Jira ask for consent in a loop.)
// Needs read:customer and read:customer.detail.
export async function customerDetailsFor(jira, accountId) {
  const res = await jira.requestJira(route`/jsm/csm/api/v1/customer/${accountId}`, { headers });
  if (res.status === 404) return {};
  return readCustomerDetails(await json(res, 'Reading customer details'));
}

const fieldList = (config) => ['project', 'reporter', ...config.mappings.map((m) => m.fieldId)];

export function toDetailTicket(issue) {
  return {
    id: String(issue?.id ?? ''),
    key: issue?.key || '',
    projectKey: issue?.fields?.project?.key || '',
    reporterId: issue?.fields?.reporter?.accountId || '',
    fields: issue?.fields || {}
  };
}

export async function fetchDetailTicket(jira, issueIdOrKey, config) {
  const fields = fieldList(config).join(',');
  return toDetailTicket(await json(await jira.requestJira(route`/rest/api/3/issue/${issueIdOrKey}?fields=${fields}`), `Reading ${issueIdOrKey}`));
}

// Works out a ticket's changes, reading the reporter's details through `detailsOf` (cached by caller).
// Works out a ticket's changes. When the ticket has a value in the match field (e.g. Crew code), the
// customer with that detail value is used, even if the reporter is someone else; a code no customer has,
// or more than one has, changes nothing and is reported. Otherwise the reporter's details are used.
// `detailsOf` and `byDetail` are the per-run caches from detailsCache / detailSearchCache.
export async function evaluateDetailTicket(ticket, config, detailsOf, byDetail = null) {
  if (!config.projectKeys.includes(ticket.projectKey)) return { status: 'out-of-scope', changes: [], kept: [] };
  const key = byDetail ? ticketMatchKey(ticket.fields, config) : null;
  if (key) {
    const matches = await byDetail(key.detailName, key.value);
    if (matches.length !== 1) return { status: matches.length ? 'ambiguous-code' : 'unknown-code', code: key.value, changes: [], kept: [] };
    return { ...evaluateTicket({ fields: ticket.fields, details: matches[0].details, config }), matchedBy: 'code' };
  }
  if (!ticket.reporterId) return { status: 'out-of-scope', changes: [], kept: [] };
  return evaluateTicket({ fields: ticket.fields, details: await detailsOf(ticket.reporterId), config });
}

// Customers whose detail `name` has `value` (POST /customer/search-by-detail-field; read:customer).
// Returns their ids; at most 10 are asked for, since more than one already means "ambiguous".
export async function findCustomersByDetail(jira, name, value) {
  const res = await jira.requestJira(route`/jsm/csm/api/v1/customer/search-by-detail-field?maxResults=10`, {
    method: 'POST', headers, body: JSON.stringify({ detailFields: [{ name, value }] })
  });
  if (res.status === 404) return [];
  const body = await json(res, `Finding the customer with ${name} ${value}`);
  const list = body?.customers || body?.results || body?.values || [];
  return [...new Set(list.map((c) => String(c?.id ?? c?.accountId ?? '')).filter(Boolean))];
}

// Per-run cache: (detailName, value) → [{ id, details }] of customers whose detail really equals value.
export function detailSearchCache(jira, detailsOf) {
  const cache = new Map();
  return (name, value) => {
    const k = `${name}\u001f${String(value).trim().toLowerCase()}`;
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        const ids = await findCustomersByDetail(jira, name, value);
        const found = [];
        for (const id of ids) found.push({ id, details: await detailsOf(id) });
        return exactDetailMatches(found, name, value);
      })().catch((e) => { cache.delete(k); throw e; }));
    }
    return cache.get(k);
  };
}

// Sets the changed fields in one edit. A select value that isn't an option is skipped and reported.
export async function applyTicketChanges(jira, ticket, config, changes) {
  const byField = new Map(config.mappings.map((m) => [m.fieldId, m]));
  const name = (id) => byField.get(id)?.detailName || id;
  const update = {};
  const unverified = [];
  const problems = [];
  for (const c of changes) {
    const r = fieldValue(byField.get(c.fieldId) || {}, c.to);
    update[c.fieldId] = r.value;
    if (r.unverified) unverified.push(c);
  }
  const put = (fields) => jira.requestJira(route`/rest/api/3/issue/${ticket.id}`, { method: 'PUT', headers, body: JSON.stringify({ fields }) });
  if (!Object.keys(update).length) return { set: [], problems };
  const res = await put(update);
  if (res.status === 204) return { set: Object.keys(update).map(name), problems };
  // Jira refused the update. If a value that wasn't in the saved options was part of it, set the rest
  // without it and report Jira's reason for that field; otherwise it's a real failure.
  let refusal;
  try { await json(res, `Updating ${ticket.key}`); } catch (e) { refusal = e; }
  if (!unverified.length || res.status !== 400) throw refusal;
  for (const c of unverified) {
    delete update[c.fieldId];
    const m = byField.get(c.fieldId) || {};
    problems.push(`"${c.to}" was refused for ${m.fieldName || c.fieldId}: ${String(refusal?.message || '').replace(/^Updating [^:]+ failed: /, '')}`);
  }
  if (Object.keys(update).length) {
    const retry = await put(update);
    if (retry.status !== 204) await json(retry, `Updating ${ticket.key}`);
  }
  return { set: Object.keys(update).map(name), problems };
}

export async function logDetailChange(entry) {
  const at = new Date().toISOString();
  const record = Object.fromEntries(Object.entries({ ...entry, at }).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  await kvs.set(`detail-sync-log:${at}:${entry.issueKey}`, record, LOG_RETENTION);
}

export async function recentDetailChanges(limit = 100) {
  const result = await kvs.query().where('key', WhereConditions.beginsWith('detail-sync-log:')).limit(Math.min(limit, 100)).getMany();
  return (result.results || []).map((r) => r.value).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function searchDetailPage(jira, config, nextPageToken, maxResults = 50, filter = null) {
  const body = { jql: detailsJql(config, filter), fields: fieldList(config), maxResults };
  if (nextPageToken) body.nextPageToken = nextPageToken;
  return json(await jira.requestJira(route`/rest/api/3/search/jql`, { method: 'POST', headers, body: JSON.stringify(body) }), 'Searching tickets');
}

// A per-call cache of reporters' details, so tickets from the same customer cost one lookup.
export function detailsCache(jira) {
  const cache = new Map();
  return (accountId) => {
    if (!cache.has(accountId)) cache.set(accountId, customerDetailsFor(jira, accountId).catch((e) => { cache.delete(accountId); throw e; }));
    return cache.get(accountId);
  };
}
