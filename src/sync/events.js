// Issue event trigger for Client → Organisation sync. Runs as the app (no user in background events).
// The manifest filter skips unlicensed sites and the app's own edits; see manifest.yml.
import api from '@forge/api';
import { retrying } from '../http.js';
import { changelogTouchesField, inScope } from './rules.js';
import { getConfig, fetchSyncIssue, setOrganisations, evaluateIssue, logCorrection } from './jira.js';
import { triggerLicenseAllows } from '../license.js';
import { handleDetailSyncEvent } from '../details-sync/resolvers.js';

// One trigger runs both syncs; a failure in one doesn't stop the other.
export async function handleIssueEvent(event, context) {
  if (!triggerLicenseAllows(context)) return { skipped: 'unlicensed' };
  const [organisations, details] = await Promise.allSettled([handleOrgSyncEvent(event), handleDetailSyncEvent(event)]);
  const outcome = (r) => (r.status === 'fulfilled' ? r.value : { status: 'error', error: String(r.reason?.message || r.reason).slice(0, 300) });
  return { organisations: outcome(organisations), details: outcome(details) };
}

export async function handleOrgSyncEvent(event) {
  const config = await getConfig();
  if (!config?.enabled) return { skipped: 'disabled' };

  const isUpdate = event?.eventType === 'avi:jira:updated:issue';
  const relevant = changelogTouchesField(event?.changelog, config.clientFieldId)
    || (config.secondaryFieldId && changelogTouchesField(event?.changelog, config.secondaryFieldId));
  if (isUpdate && !relevant) return { skipped: 'client-unchanged' };
  const eventProject = event?.issue?.fields?.project?.key;
  if (eventProject && !config.projectKeys.includes(eventProject)) return { skipped: 'out-of-scope' };

  const issueId = event?.issue?.id;
  if (!issueId) return { skipped: 'no-issue' };
  const jira = retrying(api.asApp());
  let issue;
  try {
    issue = await fetchSyncIssue(jira, issueId, config);
  } catch (error) {
    if (error.status !== 429 && error.status !== 503) throw error;
    // Still rate-limited after backing off: record it and stop. Check tickets (or the next change) fixes it.
    await logCorrection({ issueKey: event?.issue?.key || issueId, clientValue: '', from: [], to: [], source: 'failed', error: 'Jira was rate-limiting the app, so this ticket was not checked. Run Check tickets later to fix it.' });
    return { status: 'rate-limited' };
  }
  if (!inScope(config, issue)) return { skipped: 'out-of-scope' };

  const result = evaluateIssue(issue, config);
  if (result.status === 'needs-change') {
    try {
      await setOrganisations(jira, issue.id, config, result.target);
    } catch (error) {
      // Most often the mapped organisation isn't added to the ticket's service project. Log it so admins see it.
      await logCorrection({ issueKey: issue.key, clientValue: result.clientValue, from: result.current, to: result.target, source: 'failed', error: String(error.message).slice(0, 300) });
      return { status: 'failed', issueKey: issue.key };
    }
    await logCorrection({ issueKey: issue.key, clientValue: result.clientValue, secondaryValue: result.secondaryValue || undefined, from: result.current, to: result.target, source: isUpdate ? 'client-changed' : 'created' });
  } else if (result.status === 'missing-mapping') {
    await logCorrection({ issueKey: issue.key, clientValue: result.clientValue, secondaryValue: result.secondaryValue || undefined, from: result.current, to: result.current, source: 'missing-mapping' });
  }
  return { status: result.status, issueKey: issue.key };
}
