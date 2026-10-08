// Admin page resolvers for ticket details sync (as the signed-in Jira administrator), and the issue event
// handler (as the app).
import api from '@forge/api';
import { kvs } from '@forge/kvs';
import { retrying } from '../http.js';
import { detectFields, fieldOptions } from '../sync/jira.js';
import { mapLimit } from '../import/finalise.js';
import { normaliseDetailConfig, normaliseScanFilter, reporterChanged } from './rules.js';
import {
  DETAIL_SYNC_CONFIG_KEY, getDetailConfig, fetchDetailTicket, toDetailTicket, evaluateDetailTicket,
  applyTicketChanges, logDetailChange, recentDetailChanges, searchDetailPage, detailsCache
} from './jira.js';

const SCAN_BUDGET_MS = 15000;
const SCAN_PAGE_SIZE = 50;
const LOOKUP_CONCURRENCY = 3;
const CORRECT_MAX_PER_CALL = 25;
// Forge stops a resolver at 25 s. On the work site 25 tickets one by one took longer, so each call
// works on a few tickets at once, starts no new ticket after this budget, and returns the rest as
// `pending` for the page to send again.
const APPLY_BUDGET_MS = 15000;
const APPLY_CONCURRENCY = 4;

export function registerDetailSyncResolvers(secureDefine) {
  secureDefine('getDetailSyncSetup', async () => {
    const [fields, config] = await Promise.all([detectFields(retrying(api.asUser())), getDetailConfig()]);
    return { ticketFields: fields.clientCandidates, config };
  });

  secureDefine('saveDetailSyncConfig', async ({ payload }) => {
    const jira = retrying(api.asUser());
    // Field types come from the site; a select's options are read now so values can be matched to them.
    const { clientCandidates } = await detectFields(jira);
    const projectKeys = Array.isArray(payload?.projectKeys) ? payload.projectKeys : [];
    const mappings = [];
    for (const m of Array.isArray(payload?.mappings) ? payload.mappings : []) {
      const field = clientCandidates.find((f) => f.id === m?.fieldId);
      if (m?.fieldId && !field) throw new Error('A chosen ticket field is not a single-select or text custom field on this site.');
      if (!field) continue;
      const options = field.type === 'select' ? (await fieldOptions(jira, field.id, projectKeys)).options : [];
      mappings.push({ ...m, fieldName: field.name, fieldType: field.type, options });
    }
    const config = { ...normaliseDetailConfig({ ...payload, mappings }), updatedAt: new Date().toISOString() };
    await kvs.set(DETAIL_SYNC_CONFIG_KEY, config);
    return config;
  }, { write: true });

  // Checks tickets that have an empty or placeholder mapped field, one resumable chunk per call. Changes nothing.
  secureDefine('scanDetailSync', async ({ payload }) => {
    const config = await getDetailConfig();
    if (!config?.mappings?.length || !config?.projectKeys?.length) throw new Error('Save the field mappings and projects first.');
    const jira = retrying(api.asUser());
    const detailsOf = detailsCache(jira);
    const filter = normaliseScanFilter(payload?.filter);
    const deadline = Date.now() + SCAN_BUDGET_MS;
    let nextPageToken = payload?.nextPageToken || null;
    const totals = { checked: 0, correct: 0, noDetails: 0, kept: 0 };
    const needsChange = [];
    let complete = false;
    while (Date.now() < deadline) {
      let body;
      let tickets;
      let results;
      try {
        body = await searchDetailPage(jira, config, nextPageToken, SCAN_PAGE_SIZE, filter);
        tickets = (body?.issues || []).map(toDetailTicket);
        results = await mapLimit(tickets, LOOKUP_CONCURRENCY, (t) => evaluateDetailTicket(t, config, detailsOf));
      } catch (e) {
        // Jira is rate-limiting the app even after the retries in http.js. Hand back what's done and the
        // page still to do; the page waits and carries on from there.
        if (e?.status === 429 || /\b429\b/.test(String(e?.message))) return { ...totals, needsChange, nextPageToken, complete: false, rateLimited: true };
        throw e;
      }
      tickets.forEach((t, i) => {
        const r = results[i];
        totals.checked += 1;
        if (r.kept.length) totals.kept += 1;
        if (r.status === 'needs-change') needsChange.push({ id: t.id, key: t.key, changes: r.changes.map(({ detailName, from, to }) => ({ detailName, from, to })) });
        else if (r.status === 'correct') totals.correct += 1;
        else totals.noDetails += 1;
      });
      nextPageToken = body?.nextPageToken || null;
      if (!nextPageToken || body?.isLast) { complete = true; break; }
    }
    return { ...totals, needsChange, nextPageToken, complete };
  });

  // Updates up to 25 tickets, re-reading each ticket and its reporter's details first.
  secureDefine('applyDetailSync', async ({ payload }) => {
    const config = await getDetailConfig();
    if (!config?.mappings?.length) throw new Error('Save the field mappings first.');
    const ids = [...new Set((Array.isArray(payload?.issueIds) ? payload.issueIds : []).map(String).filter((id) => /^\d+$/.test(id)))];
    if (ids.length > CORRECT_MAX_PER_CALL) throw new Error(`Update at most ${CORRECT_MAX_PER_CALL} tickets per call.`);
    const jira = retrying(api.asUser());
    const detailsOf = detailsCache(jira);
    const deadline = Date.now() + (Number(payload?.budgetMs) > 0 ? Math.min(Number(payload.budgetMs), APPLY_BUDGET_MS) : APPLY_BUDGET_MS);
    const updated = [];
    const unchanged = [];
    const failed = [];
    const pending = [];
    await mapLimit(ids, APPLY_CONCURRENCY, async (id) => {
      if (Date.now() >= deadline) { pending.push(id); return; }
      try {
        const ticket = await fetchDetailTicket(jira, id, config);
        const r = await evaluateDetailTicket(ticket, config, detailsOf);
        if (r.status !== 'needs-change') { unchanged.push(ticket.key); return; }
        const { set, problems } = await applyTicketChanges(jira, ticket, config, r.changes);
        await logDetailChange({ issueKey: ticket.key, fields: set, source: 'backfill', error: problems.join(' ') || undefined });
        if (set.length) updated.push(ticket.key);
        if (problems.length) failed.push({ id, key: ticket.key, message: problems.join(' ') });
      } catch (e) {
        failed.push({ id, message: e.message });
      }
    });
    return { updated, unchanged, failed, pending };
  }, { write: true });

  secureDefine('getDetailSyncLog', async () => recentDetailChanges(100));

  // The options of a select field in the saved projects, for the Check tickets filters.
  secureDefine('getDetailFilterOptions', async ({ payload }) => {
    const fieldId = String(payload?.fieldId || '');
    if (!/^customfield_\d+$/.test(fieldId)) throw new Error('Choose a field.');
    const config = await getDetailConfig();
    return fieldOptions(retrying(api.asUser()), fieldId, config?.projectKeys || []);
  });
}

// New tickets, and tickets whose reporter changed, in the selected projects. Runs as the app.
export async function handleDetailSyncEvent(event) {
  const config = await getDetailConfig();
  if (!config?.enabled) return { skipped: 'disabled' };
  const isUpdate = event?.eventType === 'avi:jira:updated:issue';
  if (isUpdate && !reporterChanged(event?.changelog)) return { skipped: 'reporter-unchanged' };
  const project = event?.issue?.fields?.project?.key;
  if (project && !config.projectKeys.includes(project)) return { skipped: 'out-of-scope' };
  const issueId = event?.issue?.id;
  if (!issueId) return { skipped: 'no-issue' };

  const jira = retrying(api.asApp());
  const ticket = await fetchDetailTicket(jira, issueId, config);
  const r = await evaluateDetailTicket(ticket, config, detailsCache(jira));
  if (r.status !== 'needs-change') return { status: r.status, issueKey: ticket.key };
  try {
    const { set, problems } = await applyTicketChanges(jira, ticket, config, r.changes);
    await logDetailChange({ issueKey: ticket.key, fields: set, source: isUpdate ? 'reporter-changed' : 'created', error: problems.join(' ') || undefined });
    return { status: 'updated', issueKey: ticket.key };
  } catch (error) {
    await logDetailChange({ issueKey: ticket.key, source: 'failed', error: String(error.message).slice(0, 300) });
    return { status: 'failed', issueKey: ticket.key };
  }
}
