// Retail inMotion edition: an internal app installed only on Retail inMotion sites, with no
// Marketplace listing, so there is no licence to enforce. Every installation can read and write in
// every Forge environment (production included). The helpers keep their names so the resolvers
// and triggers stay in step with the Marketplace edition.

const PRODUCTION = 'PRODUCTION';

function environmentType(context) {
  const value = context?.environmentType ?? context?.environment?.type ?? null;
  return value ? String(value).toUpperCase() : null;
}

export function isProductionContext(context) {
  const type = environmentType(context);
  return type == null || type === PRODUCTION;
}

export function resolverLicenseAllows() {
  return true;
}

export const UNLICENSED_MESSAGE = 'Customer & Organisation Manager is read-only on this site.';

export function triggerLicenseAllows() {
  return true;
}
