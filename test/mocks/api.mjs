// A fake Jira site. `site.organizations` backs the JSM organisation endpoints; `site.issues` and
// `site.fields` back the issue, field and JQL search endpoints used by Client → Organisation sync.
// Every request is logged with who made it (`user` for asUser, `app` for asApp).
export const site = { organizations: [], requests: [], bulkRequests: [], isAdmin: true, issues: new Map(), fields: [], failIssueIds: new Set(), serviceDesks: [], projectOrgs: new Map(), accounts: new Map(), deskCustomers: new Map(), orgMembers: new Map(), hideEmails: false, failMembership: new Set(), searchLag: 0, createmeta: {}, throttle: 0, throttlePath: '' };

export const CLIENT_FIELD = 'customfield_10050';
export const ORG_FIELD = 'customfield_10002';
export const REQUEST_TYPE_FIELD = 'customfield_10010';
export const SECOND_FIELD = 'customfield_10080';

export function resetSite(count = 0) {
  site.organizations = Array.from({ length: count }, (_, i) => ({ id: String(i + 1), name: `Org ${i + 1}` }));
  site.requests = [];
  site.bulkRequests = [];
  // Customer accounts by email (created by the bulk API), service project customers, and organisation members.
  site.accounts = new Map();
  site.deskCustomers = new Map();
  site.orgMembers = new Map();
  site.hideEmails = false; // Jira hides emailAddress for some accounts
  site.failMembership = new Set(); // e.g. 'org:30' makes adding members to org 30 fail
  site.throttle = 0; // the next N matching requests get 429 (like Jira rate limiting)
  site.throttlePath = '';
  site.createmeta = {}; // projectKey -> [{ id, fields: [{ fieldId, allowedValues }] }]; a project set to 'forbidden' returns 403
  site.searchLag = 0; // like the live site: a new account is only found by user search after this many searches
  site.isAdmin = true;
  site.taskLimit = 0; // the next N bulk calls are refused like the live site: 400 Maximum number of tasks reached
  site.detailFields = null; // customer detail field definitions (CSM); null = the site has none (404)
  site.issues = new Map();
  site.issueEdits = [];
  site.failIssueIds = new Set();
  // Service projects, and the organisations added to each (Jira only accepts those on a ticket).
  site.serviceDesks = [{ id: '1', projectKey: 'SD', projectName: 'Service desk' }, { id: '2', projectKey: 'OPS', projectName: 'Operations' }];
  site.projectOrgs = new Map();
  site.fields = [
    { id: 'summary', name: 'Summary', custom: false, schema: { system: 'summary' } },
    { id: CLIENT_FIELD, name: 'Client', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: 'customfield_10060', name: 'Brand code', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
    { id: 'customfield_10070', name: 'Story points', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
    { id: SECOND_FIELD, name: 'Site', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: ORG_FIELD, name: 'Organizations', custom: true, schema: { custom: 'com.atlassian.servicedesk:sd-customer-organizations' } },
    { id: REQUEST_TYPE_FIELD, name: 'Request Type', custom: true, schema: { custom: 'com.atlassian.servicedesk:vp-origin' } }
  ];
}

// Adds a ticket. `orgIds` are organisation ids already on it.
export function addIssue({ id, key, project = 'SD', client = null, second = null, orgIds = [], requestTypeId = '1', reporter = null, extra = {} }) {
  site.issues.set(String(id), {
    id: String(id),
    key,
    fields: {
      project: { key: project },
      [CLIENT_FIELD]: client == null ? null : { value: client, id: `opt-${client}` },
      [SECOND_FIELD]: second == null ? null : { value: second, id: `opt-${second}` },
      [ORG_FIELD]: orgIds.map((o) => ({ id: Number(o), name: `Org ${o}` })),
      [REQUEST_TYPE_FIELD]: { requestType: { id: requestTypeId } },
      reporter: reporter ? { accountId: reporter } : null,
      ...extra
    }
  });
}

export const orgIdsOf = (id) => site.issues.get(String(id)).fields[ORG_FIELD].map((o) => String(o.id));

export const route = (strings, ...values) =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');

const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

function findIssue(idOrKey) {
  return site.issues.get(String(idOrKey)) || [...site.issues.values()].find((i) => i.key === idOrKey);
}

async function requestJira(as, path, options = {}) {
  const method = options.method || 'GET';
  site.requests.push({ as, method, path });
  if (site.throttle > 0 && (!site.throttlePath || path.includes(site.throttlePath))) {
    site.throttle -= 1;
    return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0' : null) }, text: async () => '<html>The request has been rate-limited.</html>', json: async () => ({}) };
  }
  if (path.startsWith('/rest/api/3/mypermissions')) {
    return json({ permissions: { ADMINISTER: { havePermission: site.isAdmin } } });
  }
  if (path === '/rest/api/3/field') return json(site.fields);
  const cm = path.match(/^\/rest\/api\/3\/issue\/createmeta\/([^/?]+)\/issuetypes(?:\/([^/?]+))?\?(.*)$/);
  if (cm) {
    const types = site.createmeta[decodeURIComponent(cm[1])];
    if (types === 'forbidden') return json({ errorMessages: ['No permission'] }, 403);
    if (!cm[2]) return json({ issueTypes: (types || []).map((t) => ({ id: t.id })) });
    const q = new URLSearchParams(cm[3]);
    const all = (types || []).find((t) => t.id === cm[2])?.fields || [];
    const startAt = Number(q.get('startAt') || 0);
    return json({ fields: all.slice(startAt, startAt + Number(q.get('maxResults') || 50)), total: all.length, startAt });
  }
  if (path.startsWith('/rest/api/3/jql/autocompletedata/suggestions')) {
    return json({ results: [{ value: 'RYR', displayName: 'RYR' }, { value: '"Other Client"', displayName: 'Other Client' }] });
  }
  if (path === '/rest/api/3/search/jql' && method === 'POST') {
    const body = JSON.parse(options.body);
    const projects = [...body.jql.split(')')[0].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    // Ticket details sync searches by reporter (its field conditions are re-checked by the app).
    const byReporter = body.jql.includes('reporter IS NOT EMPTY');
    site.lastJql = body.jql;
    const all = [...site.issues.values()]
      .filter((i) => projects.includes(i.fields.project.key) && (byReporter ? i.fields.reporter != null : i.fields[CLIENT_FIELD] != null))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const start = Number(body.nextPageToken || 0);
    const issues = all.slice(start, start + body.maxResults).map((i) => structuredClone(i));
    const next = start + body.maxResults < all.length ? String(start + body.maxResults) : undefined;
    return json({ issues, nextPageToken: next, isLast: !next });
  }
  const issueMatch = path.match(/^\/rest\/api\/3\/issue\/([^/?]+)(\?.*)?$/);
  if (issueMatch) {
    const issue = findIssue(decodeURIComponent(issueMatch[1]));
    if (!issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
    if (method === 'GET') return json(structuredClone(issue));
    if (method === 'PUT') {
      if (site.failIssueIds.has(issue.id)) return json({ errorMessages: ['You do not have permission to edit issues in this project.'] }, 403);
      const { fields } = JSON.parse(options.body);
      const allowed = site.projectOrgs.get(issue.fields.project.key);
      if (fields[ORG_FIELD] && allowed && fields[ORG_FIELD].some((id) => !allowed.includes(String(id)))) {
        return json({ errorMessages: ['Invalid organization ids specified.'], errors: { [ORG_FIELD]: 'Specify a valid value for Organizations ID' } }, 400);
      }
      if (fields[ORG_FIELD]) issue.fields[ORG_FIELD] = fields[ORG_FIELD].map((id) => ({ id, name: `Org ${id}` }));
      for (const [id, value] of Object.entries(fields)) if (id !== ORG_FIELD) issue.fields[id] = value;
      site.issueEdits.push({ id: issue.id, fields });
      return { ok: true, status: 204, text: async () => '' };
    }
  }
  if (path.startsWith('/rest/api/3/user/search?')) {
    const q = decodeURIComponent(new URLSearchParams(path.split('?')[1]).get('query') || '').toLowerCase();
    const matches = [...site.accounts.values()].filter((a) => {
      if (!(a.emailAddress.toLowerCase().includes(q) || a.displayName.toLowerCase().includes(q))) return false;
      if (a.searchesUntilIndexed > 0) { a.searchesUntilIndexed -= 1; return false; }
      return true;
    }).map(({ searchesUntilIndexed, ...a }) => a);
    return json(matches.map((a) => (site.hideEmails ? { accountId: a.accountId, displayName: a.displayName, accountType: a.accountType } : { ...a })));
  }
  const addToDesk = path.match(/^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/customer$/);
  if (addToDesk && method === 'POST') {
    if (site.failMembership.has(`desk:${addToDesk[1]}`)) return json({ errorMessage: 'You do not have permission to add customers.' }, 403);
    const set = site.deskCustomers.get(addToDesk[1]) || new Set();
    JSON.parse(options.body).accountIds.forEach((id) => set.add(id));
    site.deskCustomers.set(addToDesk[1], set);
    return { ok: true, status: 204, text: async () => '' };
  }
  const addToOrg = path.match(/^\/rest\/servicedeskapi\/organization\/([^/]+)\/user$/);
  if (addToOrg && method === 'POST') {
    if (site.failMembership.has(`org:${addToOrg[1]}`)) return json({ errorMessage: 'Organization does not exist.' }, 404);
    const set = site.orgMembers.get(addToOrg[1]) || new Set();
    JSON.parse(options.body).accountIds.forEach((id) => set.add(id));
    site.orgMembers.set(addToOrg[1], set);
    return { ok: true, status: 204, text: async () => '' };
  }
  if (path.startsWith('/rest/servicedeskapi/servicedesk?')) return json({ values: site.serviceDesks, isLastPage: true });
  const deskOrgs = path.match(/^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/organization\?/);
  if (deskOrgs) {
    const desk = site.serviceDesks.find((d) => d.id === deskOrgs[1]);
    const ids = site.projectOrgs.get(desk?.projectKey) || [];
    return json({ values: ids.map((id) => ({ id, name: 'Org ' + id })), isLastPage: true });
  }
  if (path.startsWith('/rest/servicedeskapi/organization') && method === 'POST') {
    const { name } = JSON.parse(options.body);
    if (site.organizations.some((o) => o.name.toLowerCase() === name.toLowerCase())) {
      return json({ errorMessage: `Duplicate organisation ${name}` }, 400);
    }
    const org = { id: String(site.organizations.length + 1), name };
    site.organizations.push(org);
    return json(org, 201);
  }
  if (path.startsWith('/rest/servicedeskapi/organization?')) {
    const query = new URLSearchParams(path.split('?')[1]);
    const start = Number(query.get('start'));
    const limit = Number(query.get('limit'));
    const values = site.organizations.slice(start, start + limit);
    return json({ start, limit, size: values.length, values, isLastPage: start + limit >= site.organizations.length });
  }
  // Direct route: create a customer (400 if the email already has an account) and set one detail.
  if (path === '/rest/servicedeskapi/customer' && method === 'POST') {
    const { email, displayName } = JSON.parse(options.body);
    const key = email.toLowerCase();
    if (key.startsWith('reject-')) return json({ errorMessage: 'The email address is not valid.' }, 400);
    if (site.accounts.has(key)) return json({ errorMessage: 'An account already exists for this email' }, 400);
    const account = { accountId: `qm:${site.accounts.size + 1}`, displayName, emailAddress: email, accountType: 'customer', searchesUntilIndexed: site.searchLag };
    site.accounts.set(key, account);
    return json({ accountId: account.accountId, displayName, emailAddress: email }, 201);
  }
  // GET /customer/{id}: the customer with their detail values ('details' itself is the field list, below).
  const getDetails = path.match(/^\/jsm\/csm\/api\/v1\/customer\/([^/?]+)$/);
  if (getDetails && method === 'GET' && getDetails[1] !== 'details') {
    const account = [...site.accounts.values()].find((a) => a.accountId === decodeURIComponent(getDetails[1]));
    if (!account) return json({ errorMessage: 'Customer not found' }, 404);
    return json({ details: Object.entries(account.details || {}).map(([name, values]) => ({ name, values })) });
  }
  const setDetail = path.match(/^\/jsm\/csm\/api\/v1\/customer\/([^/]+)\/details\?fieldName=(.+)$/);
  if (setDetail && method === 'PUT') {
    const accountId = decodeURIComponent(setDetail[1]);
    const field = decodeURIComponent(setDetail[2]);
    const { values } = JSON.parse(options.body);
    if (field === 'PhoneNumber' && values.some((v) => !/^\+/.test(v))) return json({ errorMessage: 'Invalid detail field value' }, 400);
    const account = [...site.accounts.values()].find((a) => a.accountId === accountId);
    if (!account) return json({ errorMessage: 'Customer not found' }, 404);
    account.details = { ...(account.details || {}), [field]: values };
    return json({ name: field, values });
  }
  if (path === '/jsm/csm/api/v1/customer/details' && method === 'GET') {
    return site.detailFields ? json({ results: site.detailFields }) : json({ message: 'Not found' }, 404);
  }
  // Like the live site: bulk tasks end FAILED with no failures even though the accounts were written.
  if (path.startsWith('/jsm/csm/api/v1/tasks/')) return json({ id: path.split('/').pop(), status: site.taskStatus || 'FAILED', failures: [] });
  if (path === '/jsm/csm/api/v1/customer/profile/bulk' && method === 'POST') {
    if (site.taskLimit > 0) { site.taskLimit -= 1; return json({ errorMessage: 'Maximum number of tasks reached', errors: ['BAD_REQUEST'], statusCode: 400 }, 400); }
    const { customerProfiles } = JSON.parse(options.body);
    site.bulkRequests.push({ idempotencyKey: options.headers?.['Idempotency-Key'], customerProfiles });
    for (const { payload } of customerProfiles) {
      const email = payload.email.toLowerCase();
      if (email.startsWith('reject-')) continue; // simulates a row Jira refuses
      const existing = site.accounts.get(email);
      site.accounts.set(email, { ...(existing?.details ? { details: existing.details } : {}), accountId: existing?.accountId || `qm:${site.accounts.size + 1}`, displayName: payload.displayName, emailAddress: payload.email, accountType: 'customer', searchesUntilIndexed: existing ? 0 : site.searchLag });
    }
    return json({ id: `task-${site.bulkRequests.length}`, statusUrl: `/tasks/task-${site.bulkRequests.length}` }, 202);
  }
  throw new Error(`Unexpected request ${method} ${path}`);
}

export default {
  asUser: () => ({ requestJira: (path, options) => requestJira('user', path, options) }),
  asApp: () => ({ requestJira: (path, options) => requestJira('app', path, options) })
};
