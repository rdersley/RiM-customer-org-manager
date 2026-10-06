// UI resolvers for Client → Organisation sync. They run as the signed-in Jira administrator (asUser).
import api, { route } from '@forge/api';
import { retrying } from '../http.js';
import { kvs } from '@forge/kvs';
import { normaliseConfig, inScope } from './rules.js';
import {
  SYNC_CONFIG_KEY, SYNC_HEALTH_KEY, detectFields, getConfig, toSyncIssue, fetchSyncIssue,
  setOrganisations, evaluateIssue, logCorrection, recentCorrections, searchPage, projectOrganisationGaps, missingLabel, fieldOptions
} from './jira.js';

const SCAN_BUDGET_MS = 15000;
const SCAN_MAX_PAGES = 20;
const CORRECT_MAX_PER_CALL = 25;
const SCAN_PAGE_PAUSE_MS = 150;

export function registerSyncResolvers(secureDefine) {
  secureDefine('getSyncSetup', async () => {
    const jira = retrying(api.asUser());
    const [fields, config, health] = await Promise.all([detectFields(jira), getConfig(), kvs.get(SYNC_HEALTH_KEY)]);
    return { fields, config, health: health || null };
  });

  secureDefine('saveSyncConfig', async ({ payload }) => {
    // Field ids for Organizations and Request Type come from the site, not from the browser.
    const fields = await detectFields(retrying(api.asUser()));
    const clientField = fields.clientCandidates.find((f) => f.id === payload?.clientFieldId);
    if (payload?.clientFieldId && !clientField) throw new Error('The chosen Client field is not a single-select or text custom field on this site.');
    if (payload?.secondaryFieldId && !fields.clientCandidates.some((f) => f.id === payload.secondaryFieldId)) {
      throw new Error('The chosen second field is not a single-select or text custom field on this site.');
    }
    const config = normaliseConfig({
      ...payload,
      organisationsFieldId: fields.organisationsField?.id,
      requestTypeFieldId: fields.requestTypeField?.id
    });
    const saved = { ...config, updatedAt: new Date().toISOString() };
    await kvs.set(SYNC_CONFIG_KEY, saved);
    const warnings = saved.mappings.length ? await projectOrganisationGaps(retrying(api.asUser()), saved) : [];
    return { ...saved, warnings };
  }, { write: true });

  // Client values Jira suggests for the field (JQL autocomplete), to help fill the mapping table.
  secureDefine('getClientValueSuggestions', async ({ payload }) => {
    const fieldId = String(payload?.fieldId || '');
    if (!/^customfield_\d+$/.test(fieldId)) throw new Error('A Client field is required.');
    const fieldName = `cf[${fieldId.replace('customfield_', '')}]`;
    const fieldValue = String(payload?.query || '').slice(0, 100);
    const res = await retrying(api.asUser()).requestJira(route`/rest/api/3/jql/autocompletedata/suggestions?fieldName=${fieldName}&fieldValue=${fieldValue}`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body?.results || []).map((r) => String(r.value ?? '').replace(/^"|"$/g, '')).filter(Boolean);
  });

  // All options of a select field in the chosen projects, for the mapping dropdowns.
  secureDefine('getSyncFieldOptions', async ({ payload }) => {
    const fieldId = String(payload?.fieldId || '');
    if (!/^customfield_\d+$/.test(fieldId)) throw new Error('A field is required.');
    const projectKeys = [...new Set((Array.isArray(payload?.projectKeys) ? payload.projectKeys : []).map((k) => String(k).trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,254}$/.test(k)))];
    if (!projectKeys.length) return { found: false, options: [] };
    return fieldOptions(retrying(api.asUser()), fieldId, projectKeys);
  });

  // Checks tickets in scope, one resumable chunk per call. Changes nothing.
  secureDefine('scanSyncHealth', async ({ payload }) => {
    const config = await getConfig();
    if (!config?.clientFieldId || !config?.projectKeys?.length || !config?.organisationsFieldId) {
      throw new Error('Save the sync settings (Client field and projects) before checking tickets.');
    }
    const jira = retrying(api.asUser());
    const deadline = Date.now() + SCAN_BUDGET_MS;
    let nextPageToken = payload?.nextPageToken || null;
    const totals = { checked: 0, correct: 0, noClient: 0, ignored: 0 };
    const needsChange = [];
    const missing = {};
    let complete = false;
    for (let page = 0; page < SCAN_MAX_PAGES && Date.now() < deadline; page += 1) {
      const body = await searchPage(jira, config, nextPageToken);
      for (const raw of body?.issues || []) {
        const issue = toSyncIssue(raw, config);
        totals.checked += 1;
        if (!inScope(config, issue)) { totals.ignored += 1; continue; }
        const r = evaluateIssue(issue, config);
        if (r.status === 'correct') totals.correct += 1;
        else if (r.status === 'no-client') totals.noClient += 1;
        else if (r.status === 'missing-mapping') missing[missingLabel(r)] = (missing[missingLabel(r)] || 0) + 1;
        else needsChange.push({ id: issue.id, key: issue.key, clientValue: r.clientValue, secondaryValue: r.secondaryValue || undefined, from: r.current, to: r.target });
      }
      nextPageToken = body?.nextPageToken || null;
      if (!nextPageToken || body?.isLast) { complete = true; break; }
      await new Promise((resolve) => setTimeout(resolve, SCAN_PAGE_PAUSE_MS)); // stay well under Jira's rate limits
    }
    return { ...totals, needsChange, missing, nextPageToken, complete };
  });

  secureDefine('saveSyncHealth', async ({ payload }) => {
    const n = (v) => Math.max(0, Number(v) || 0);
    const missing = Object.fromEntries(Object.entries(payload?.missing || {}).slice(0, 500).map(([k, v]) => [String(k).slice(0, 255), n(v)]));
    const health = {
      checked: n(payload?.checked), correct: n(payload?.correct), needsChange: n(payload?.needsChange),
      corrected: n(payload?.corrected), noClient: n(payload?.noClient), ignored: n(payload?.ignored), missing,
      checkedAt: new Date().toISOString()
    };
    await kvs.set(SYNC_HEALTH_KEY, health);
    return health;
  }, { write: true });

  // Corrects up to 25 tickets. Each ticket is re-read first, so a ticket that changed since the scan is
  // only touched if it still needs it.
  secureDefine('applySyncCorrections', async ({ payload }) => {
    const config = await getConfig();
    if (!config?.organisationsFieldId || !config?.mappings?.length) throw new Error('Save the sync settings first.');
    const ids = [...new Set((Array.isArray(payload?.issueIds) ? payload.issueIds : []).map(String).filter((id) => /^\d+$/.test(id)))];
    if (!ids.length) return { corrected: [], unchanged: [], failed: [] };
    if (ids.length > CORRECT_MAX_PER_CALL) throw new Error(`Correct at most ${CORRECT_MAX_PER_CALL} tickets per call.`);
    const jira = retrying(api.asUser());
    const corrected = [];
    const unchanged = [];
    const failed = [];
    for (const id of ids) {
      try {
        const issue = await fetchSyncIssue(jira, id, config);
        const r = evaluateIssue(issue, config);
        if (!inScope(config, issue) || r.status !== 'needs-change') { unchanged.push(issue.key); continue; }
        await setOrganisations(jira, issue.id, config, r.target);
        await logCorrection({ issueKey: issue.key, clientValue: r.clientValue, secondaryValue: r.secondaryValue || undefined, from: r.current, to: r.target, source: 'backfill' });
        corrected.push(issue.key);
      } catch (e) {
        failed.push({ id, message: e.message });
      }
    }
    return { corrected, unchanged, failed };
  }, { write: true });

  secureDefine('getSyncLog', async () => recentCorrections(100));
}

