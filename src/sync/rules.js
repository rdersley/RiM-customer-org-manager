// Client → Organisation sync rules. Pure functions: no Forge or Jira calls, so they're unit-tested directly.
//
// The Client field is authoritative. When it has a mapped value, the ticket's Organizations field must
// contain that value's organisation and no other *mapped* organisation. Organisations that aren't in any
// mapping (added by hand) are left alone. An empty Client, or a value with no mapping, changes nothing.
//
// An optional second field (one for the whole setup) splits a client across several organisations: a row
// with a Client value *and* a second-field value is used when both match; a Client-only row is that
// client's default for any other (or empty) second value.

export const clientKey = (value) => String(value ?? '').trim().toLowerCase();

// Normalises the Client field value as Jira returns it: a single-select option ({ value }), a plain
// string (text field), or empty.
export function readClientValue(fieldValue) {
  if (fieldValue == null) return '';
  if (typeof fieldValue === 'string') return fieldValue.trim();
  if (typeof fieldValue === 'object' && 'value' in fieldValue) return String(fieldValue.value ?? '').trim();
  return '';
}

// Normalises the JSM Organizations field value (an array of { id, name } objects) to string ids.
export function readOrganisationIds(fieldValue) {
  if (!Array.isArray(fieldValue)) return [];
  return fieldValue.map((org) => String(org?.id ?? org ?? '')).filter(Boolean);
}

const SEP = '\u0000';
export const mappingKey = (clientValue, secondaryValue = '') => `${clientKey(clientValue)}${SEP}${clientKey(secondaryValue)}`;

export function mappingIndex(mappings) {
  const byKey = new Map();
  const mappedOrgIds = new Set();
  for (const m of mappings || []) {
    if (!clientKey(m?.clientValue) || m?.organizationId == null) continue;
    const key = mappingKey(m.clientValue, m.secondaryValue);
    if (!byKey.has(key)) byKey.set(key, String(m.organizationId));
    mappedOrgIds.add(String(m.organizationId));
  }
  return { byKey, mappedOrgIds };
}

/**
 * Works out what the Organizations field should be.
 * Returns { status, clientValue, current, target } where status is one of:
 *   'correct'         – nothing to do
 *   'needs-change'    – `target` differs from `current`
 *   'missing-mapping' – the Client value has no mapping (nothing is changed)
 *   'no-client'       – the Client field is empty (nothing is changed)
 */
export function evaluate({ clientFieldValue, secondaryFieldValue = null, organisationsFieldValue, mappings }) {
  const clientValue = readClientValue(clientFieldValue);
  const secondaryValue = readClientValue(secondaryFieldValue);
  const current = readOrganisationIds(organisationsFieldValue);
  if (!clientValue) return { status: 'no-client', clientValue, secondaryValue, current, target: current };

  const { byKey, mappedOrgIds } = mappingIndex(mappings);
  // Most specific first: Client + second value, then the client's default (Client-only row).
  const wanted = (secondaryValue && byKey.get(mappingKey(clientValue, secondaryValue))) || byKey.get(mappingKey(clientValue));
  if (!wanted) return { status: 'missing-mapping', clientValue, secondaryValue, current, target: current };

  const target = current.filter((id) => id === wanted || !mappedOrgIds.has(id));
  if (!target.includes(wanted)) target.push(wanted);
  const same = target.length === current.length && target.every((id) => current.includes(id));
  return { status: same ? 'correct' : 'needs-change', clientValue, secondaryValue, current, target: same ? current : target };
}

// True when a Jira update event's changelog touched the Client field.
export function changelogTouchesField(changelog, fieldId) {
  return (changelog?.items || []).some((item) => item?.fieldId === fieldId || item?.field === fieldId);
}

// Validates and normalises the saved sync configuration.
export function normaliseConfig(input) {
  const config = input || {};
  const mappings = [];
  const seen = new Set();
  for (const m of Array.isArray(config.mappings) ? config.mappings : []) {
    const clientValue = String(m?.clientValue ?? '').trim().slice(0, 255);
    const secondaryValue = String(m?.secondaryValue ?? '').trim().slice(0, 255);
    const organizationId = String(m?.organizationId ?? '').trim();
    if (!clientValue || !/^\d+$/.test(organizationId)) continue;
    const key = mappingKey(clientValue, secondaryValue);
    if (seen.has(key)) throw new Error(`Client value "${clientValue}"${secondaryValue ? ` with "${secondaryValue}"` : ''} is mapped more than once.`);
    seen.add(key);
    mappings.push({ clientValue, secondaryValue, organizationId, organizationName: String(m?.organizationName ?? '').slice(0, 255) });
  }
  if (mappings.length > 2000) throw new Error('At most 2,000 client mappings are supported.');

  const fieldId = (v) => (/^customfield_\d+$/.test(String(v ?? '')) ? String(v) : '');
  const projectKeys = [...new Set((Array.isArray(config.projectKeys) ? config.projectKeys : [])
    .map((k) => String(k ?? '').trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,254}$/.test(k)))];
  const ignoredRequestTypeIds = [...new Set((Array.isArray(config.ignoredRequestTypeIds) ? config.ignoredRequestTypeIds : [])
    .map((id) => String(id ?? '').trim()).filter((id) => /^\d+$/.test(id)))];

  const normalised = {
    enabled: config.enabled === true,
    clientFieldId: fieldId(config.clientFieldId),
    secondaryFieldId: fieldId(config.secondaryFieldId),
    organisationsFieldId: fieldId(config.organisationsFieldId),
    requestTypeFieldId: fieldId(config.requestTypeFieldId),
    projectKeys,
    ignoredRequestTypeIds,
    mappings
  };
  if (normalised.secondaryFieldId && normalised.secondaryFieldId === normalised.clientFieldId) {
    throw new Error('The second field must be different from the Client field.');
  }
  if (!normalised.secondaryFieldId && normalised.mappings.some((m) => m.secondaryValue)) {
    throw new Error('Choose the second field, or remove the second-field values from the mappings.');
  }
  if (normalised.enabled) {
    if (!normalised.clientFieldId) throw new Error('Choose the Client field before turning sync on.');
    if (!normalised.organisationsFieldId) throw new Error('The JSM Organizations field could not be found on this site.');
    if (!normalised.projectKeys.length) throw new Error('Choose at least one project before turning sync on.');
    if (!normalised.mappings.length) throw new Error('Add at least one client mapping before turning sync on.');
  }
  return normalised;
}

// Whether a ticket is in scope for the configuration.
export function inScope(config, { projectKey, requestTypeId }) {
  if (!config?.projectKeys?.includes(String(projectKey || '').toUpperCase())) return false;
  if (requestTypeId && config.ignoredRequestTypeIds?.includes(String(requestTypeId))) return false;
  return true;
}
