// When an import needs an explicit confirmation before it runs. Pure; unit-tested in test/safeguards.test.mjs.

export const CONFIRM_AT = { changes: 500, renames: 100, newOrganisations: 10 };
export const TYPED_CONFIRM_AT = 5000;

// Summarises the preview: new customers, renames of existing ones, and organisations the import will create.
export function importImpact(preview) {
  const newOrganisations = new Set();
  let create = 0;
  let update = 0;
  for (const row of preview || []) {
    if (row.action !== 'CREATE' && row.action !== 'UPDATE') continue;
    if (row.action === 'CREATE') create += 1; else update += 1;
    if (row.organisation && /will be created/.test(row.reason || '')) newOrganisations.add(row.organisation.trim());
  }
  return { create, update, changes: create + update, newOrganisations: [...newOrganisations].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
}

/**
 * level: 'none' (import straight away), 'confirm' (confirm first) or 'typed' (type the number of changes).
 * reasons: why a confirmation is needed, in plain words.
 */
export function importSafeguard(impact) {
  const reasons = [];
  if (impact.changes >= CONFIRM_AT.changes) reasons.push(`${impact.changes.toLocaleString()} customer changes`);
  if (impact.update >= CONFIRM_AT.renames) reasons.push(`${impact.update.toLocaleString()} existing customers renamed`);
  if (impact.newOrganisations.length >= CONFIRM_AT.newOrganisations) reasons.push(`${impact.newOrganisations.length.toLocaleString()} new organisations`);
  if (!reasons.length) return { level: 'none', reasons };
  return { level: impact.changes >= TYPED_CONFIRM_AT ? 'typed' : 'confirm', reasons };
}

// For 'typed': the text the admin must type (the number of changes, digits only; separators are ignored).
export const typedConfirmationMatches = (typed, changes) => String(typed ?? '').replace(/[\s,._']/g, '') === String(changes);
