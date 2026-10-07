// { fieldName: value | [values] } → [{ name, values }], dropping blanks.
export function customerDetails(details) {
  if (!details || typeof details !== 'object') return [];
  return Object.entries(details).slice(0, 50).map(([name, values]) => ({
    name: String(name).trim(),
    values: [].concat(values).map((v) => String(v ?? '').trim().slice(0, 255)).filter(Boolean)
  })).filter((d) => d.name && d.values.length);
}
