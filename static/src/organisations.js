// Organisation lookup/creation helpers. `invoke` is passed in (the @forge/bridge invoke in the app,
// a stub in tests) so this module has no Forge dependency.

export const organisationKey = (name) => String(name || '').trim().toLowerCase();

function uniqueNames(names) {
  const byKey = new Map();
  (names || []).map((n) => String(n || '').trim()).filter(Boolean)
    .forEach((n) => { if (!byKey.has(organisationKey(n))) byKey.set(organisationKey(n), n); });
  return [...byKey.values()];
}

// Pages through every Jira organisation (in resumable resolver calls) looking for the given names.
// Throws rather than returning a partial answer, so callers never treat an unscanned org as missing.
export async function lookupOrganisations(invoke, names) {
  const found = new Map();
  let remaining = uniqueNames(names);
  let start = 0;
  for (let calls = 0; remaining.length; calls += 1) {
    if (calls >= 500) throw new Error('Organisation lookup safety limit reached before Jira reported the final page.');
    const r = await invoke('getImportOrganizations', { names: remaining, start });
    (r.organizations || []).forEach((o) => found.set(organisationKey(o.name), o));
    remaining = remaining.filter((n) => !found.has(organisationKey(n)));
    if (r.complete) break;
    const nextStart = Number(r.nextStart);
    if (remaining.length && (!Number.isFinite(nextStart) || nextStart <= start)) {
      throw new Error('Jira organisation pagination stopped before the lookup was complete.');
    }
    start = nextStart;
  }
  return { found, missing: remaining };
}

// Finds existing organisations and creates only those a complete scan proved are missing.
export async function prepareOrganisations(invoke, names) {
  const { found, missing } = await lookupOrganisations(invoke, names);
  const created = [];
  for (let i = 0; i < missing.length; i += 20) {
    const r = await invoke('createImportOrganizations', { names: missing.slice(i, i + 20) });
    created.push(...(r.created || []));
  }
  return { organizations: [...found.values(), ...created], created };
}

// Finds or creates every organisation the rows name, then returns the rows with organizationIds attached.
export async function attachOrganisationIds(invoke, rows) {
  const prepared = await prepareOrganisations(invoke, rows.map((r) => r.organisation));
  const idByKey = new Map(prepared.organizations.map((o) => [organisationKey(o.name), o.id]));
  return {
    rows: rows.map((r) => {
      const key = organisationKey(r.organisation);
      return { ...r, organizationIds: idByKey.has(key) ? [idByKey.get(key)] : [] };
    }),
    created: prepared.created
  };
}

// Loads every organisation on the site, reporting the running list to `onProgress` after each call.
export async function loadAllOrganisations(invoke, onProgress = () => {}) {
  const organizations = [];
  let start = 0;
  for (let calls = 0; ; calls += 1) {
    if (calls >= 500) throw new Error('Organisation list safety limit reached before Jira reported the final page.');
    const r = await invoke('getOrganizationIndexBatch', { start });
    organizations.push(...(r.organizations || []));
    onProgress(organizations, Boolean(r.complete));
    if (r.complete) return organizations;
    const nextStart = Number(r.nextStart);
    if (!Number.isFinite(nextStart) || nextStart <= start) {
      throw new Error('Jira organisation pagination stopped before the list was complete.');
    }
    start = nextStart;
  }
}

// Adds the "will be created" note to preview rows whose organisation does not exist yet.
export function organisationNote(row, existingKeys) {
  return row.organisation && !existingKeys.has(organisationKey(row.organisation))
    ? `Organisation “${row.organisation}” will be created.` : '';
}
