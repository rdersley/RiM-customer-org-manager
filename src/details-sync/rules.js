// Ticket details sync rules: copies a reporter's JSM customer details (e.g. CrewCode, Base) into ticket
// fields. Pure functions: no Forge or Jira calls, so they're unit-tested directly.
//
// A ticket field is filled when it's empty, or when it holds one of the placeholder values the admin
// listed (e.g. "Unknown", "Please Update"). Any other value someone has set is kept. A reporter with no
// value for a detail changes nothing for that field.

const norm = (v) => String(v ?? '').trim().toLowerCase();
export const DEFAULT_PLACEHOLDERS = ['Unknown', 'Please Update'];

// A ticket field's value as text: a select option ({ value }), a string, a number, or empty.
export function readFieldText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readFieldText).filter(Boolean).join(', ');
  if (typeof value === 'object') return String(value.value ?? value.name ?? '').trim();
  return String(value).trim();
}

// A customer's details as Jira returns them, normalised to { fieldName: firstValue }. Accepts an array of
// { name, values } (or { fieldName, value }), or an object wrapping one under details / results / values.
export function readCustomerDetails(body) {
  const list = Array.isArray(body) ? body : (body?.details || body?.results || body?.values || []);
  const out = {};
  for (const d of Array.isArray(list) ? list : []) {
    const name = String(d?.name ?? d?.fieldName ?? d?.field?.name ?? '').trim();
    const raw = d?.values ?? d?.value ?? [];
    const value = String((Array.isArray(raw) ? raw[0] : raw) ?? '').trim();
    if (name && value) out[name] = value;
  }
  return out;
}

/**
 * What to change on one ticket.
 * fields: { fieldId: current Jira value }; details: { detailName: value }; config: normalised config.
 * Returns { status, changes, kept } where status is 'correct' | 'needs-change' | 'no-details', changes is
 * [{ fieldId, detailName, from, to }] and kept lists fields left alone because they hold a real value.
 */
export function evaluateTicket({ fields, details, config }) {
  const placeholders = new Set((config.placeholders || []).map(norm));
  const changes = [];
  const kept = [];
  let anyDetail = false;
  for (const m of config.mappings || []) {
    const want = String(details?.[m.detailName] ?? '').trim();
    if (!want) continue;
    anyDetail = true;
    const from = readFieldText(fields?.[m.fieldId]);
    if (norm(from) === norm(want)) continue;
    if (!from || placeholders.has(norm(from))) changes.push({ fieldId: m.fieldId, detailName: m.detailName, from, to: want });
    else kept.push({ fieldId: m.fieldId, detailName: m.detailName, from, to: want });
  }
  if (!anyDetail) return { status: 'no-details', changes, kept };
  return { status: changes.length ? 'needs-change' : 'correct', changes, kept };
}

// The value to send to Jira for a field: a select needs one of its options (matched ignoring case);
// returns { value } or { error }.
export function fieldValue(mapping, text) {
  if (mapping.fieldType !== 'select') return { value: text };
  const option = (mapping.options || []).find((o) => norm(o) === norm(text));
  return option ? { value: { value: option } } : { error: `"${text}" isn't an option of ${mapping.fieldName || mapping.fieldId}` };
}

export function normaliseDetailConfig(input) {
  const config = input || {};
  const fieldId = (v) => (/^customfield_\d+$/.test(String(v ?? '')) ? String(v) : '');
  const mappings = [];
  const seenFields = new Set();
  for (const m of Array.isArray(config.mappings) ? config.mappings : []) {
    const detailName = String(m?.detailName ?? '').trim().slice(0, 255);
    const id = fieldId(m?.fieldId);
    if (!detailName || !id) continue;
    if (seenFields.has(id)) throw new Error('Each ticket field can only be filled from one customer detail.');
    seenFields.add(id);
    mappings.push({
      detailName,
      fieldId: id,
      fieldName: String(m?.fieldName ?? '').slice(0, 255),
      fieldType: m?.fieldType === 'select' ? 'select' : 'text',
      options: (Array.isArray(m?.options) ? m.options : []).map((o) => String(o).slice(0, 255)).slice(0, 1000)
    });
  }
  const projectKeys = [...new Set((Array.isArray(config.projectKeys) ? config.projectKeys : [])
    .map((k) => String(k ?? '').trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,254}$/.test(k)))];
  const placeholders = [...new Set((Array.isArray(config.placeholders) ? config.placeholders : DEFAULT_PLACEHOLDERS)
    .map((p) => String(p ?? '').trim().slice(0, 100)).filter(Boolean))].slice(0, 20);
  const normalised = { enabled: config.enabled === true, projectKeys, mappings, placeholders };
  if (normalised.enabled) {
    if (!normalised.mappings.length) throw new Error('Add at least one customer detail → ticket field row before turning this on.');
    if (!normalised.projectKeys.length) throw new Error('Choose at least one project before turning this on.');
  }
  return normalised;
}

const jqlString = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;

// Tickets worth checking: in the projects, with a reporter, and at least one mapped field empty or
// holding a placeholder. Text fields use ~ (contains), so the rules re-check the exact value.
export function detailsJql(config) {
  const projects = config.projectKeys.map(jqlString).join(', ');
  const conditions = config.mappings.map((m) => {
    const cf = `cf[${m.fieldId.replace('customfield_', '')}]`;
    const ph = config.placeholders || [];
    if (!ph.length) return `${cf} IS EMPTY`;
    if (m.fieldType === 'select') return `${cf} IS EMPTY OR ${cf} in (${ph.map(jqlString).join(', ')})`;
    return `${cf} IS EMPTY OR ${ph.map((p) => `${cf} ~ ${jqlString(`"${p}"`)}`).join(' OR ')}`;
  });
  return `project in (${projects}) AND reporter IS NOT EMPTY AND (${conditions.join(' OR ')}) ORDER BY key ASC`;
}

// True when an update event changed the reporter.
export const reporterChanged = (changelog) => (changelog?.items || []).some((i) => i?.fieldId === 'reporter' || i?.field === 'reporter');
