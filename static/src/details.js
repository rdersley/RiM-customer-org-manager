// Customer detail fields (JSM Customer Service Management): checks CSV values against each field's type
// before anything is sent. Pure functions, unit-tested in test/details.test.mjs.
//
// Fields come from getCustomerDetailFields as { name, type, options }. A row's `details` (from
// applyMapping) is { fieldName: raw cell text }; blank cells are never present, so Jira keeps the
// current value for them.

const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const listOptions = (options) => {
  const shown = options.slice(0, 8).join(', ');
  return options.length > 8 ? `${shown}, …` : shown;
};

// The values to send for one cell, or an error message.
export function detailValues(field, raw) {
  const text = String(raw ?? '').trim();
  const type = String(field?.type || '').toUpperCase();
  const options = Array.isArray(field?.options) ? field.options : [];
  const pick = (value) => options.find((o) => sameText(o, value));

  if (type === 'SELECT') {
    const match = pick(text);
    return match != null ? { values: [match] } : { error: `${field.name}: "${text}" isn't an option (${listOptions(options) || 'no options set up'})` };
  }
  if (type === 'MULTISELECT') {
    // A value that is itself an option is taken whole (options can contain commas); otherwise the cell
    // is a list separated by ; or ,
    const whole = pick(text);
    if (whole != null) return { values: [whole] };
    const parts = text.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
    const unknown = parts.filter((p) => pick(p) == null);
    if (unknown.length) return { error: `${field.name}: "${unknown[0]}" isn't an option (${listOptions(options) || 'no options set up'})` };
    return { values: [...new Set(parts.map(pick))] };
  }
  if (type === 'NUMBER') {
    return /^[-+]?\d+(\.\d+)?$/.test(text) ? { values: [text] } : { error: `${field.name}: "${text}" isn't a number` };
  }
  if (type === 'EMAIL') {
    return /^\S+@\S+\.\S+$/.test(text) ? { values: [text] } : { error: `${field.name}: "${text}" isn't an email address` };
  }
  if (type === 'URL') {
    try { new URL(text); return { values: [text] }; } catch { return { error: `${field.name}: "${text}" isn't a web address (include https://)` }; }
  }
  if (text.length > 255) return { error: `${field.name}: longer than 255 characters` };
  return { values: [text] };
}

// Turns each row's raw detail text into { fieldName: [values] } and lists the cells that can't be used.
// Error rows follow validateImport's shape ({ row, field, message }) so they merge into the preview.
export function checkDetails(rows, fields) {
  const byName = new Map((fields || []).map((f) => [f.name, f]));
  const errors = [];
  const checked = rows.map((row, index) => {
    const details = {};
    for (const [name, raw] of Object.entries(row.details || {})) {
      const field = byName.get(name);
      if (!field) { errors.push({ row: index + 2, field: 'details', message: `Customer detail "${name}" no longer exists in Jira` }); continue; }
      const result = detailValues(field, raw);
      if (result.error) errors.push({ row: index + 2, field: 'details', message: result.error });
      else details[name] = result.values;
    }
    return { ...row, details };
  });
  return { rows: checked, errors };
}

// Adds detail errors to a validateImport result.
export function mergeValidation(validation, extraErrors) {
  if (!extraErrors.length) return validation;
  const errors = [...(validation?.errors || []), ...extraErrors];
  const total = Number(validation?.total || 0);
  return { ...validation, errors, valid: Math.max(0, total - new Set(errors.map((e) => e.row)).size) };
}

export const detailCount = (row) => Object.keys(row?.details || {}).length;

// Short text for the preview table, e.g. "Base: DUB · CrewCode: A12".
export const detailSummary = (row) => Object.entries(row?.details || {}).map(([name, values]) => `${name}: ${[].concat(values).join(', ')}`).join(' · ');
