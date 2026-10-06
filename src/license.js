// Marketplace licence enforcement (same policy as Retail inMotion Follow-Up Manager).
//
// Forge only supplies `context.license` to UI resolvers, and only for paid apps
// in the PRODUCTION environment. It is undefined in DEVELOPMENT/STAGING and for
// apps that are not (yet) listed on the Marketplace.
// See https://developer.atlassian.com/platform/marketplace/listing-forge-apps/
//
// Policy:
// - Production fails closed: a missing or inactive licence means read-only.
//   Browsing and previews keep working; anything that changes Jira or app
//   storage is refused.
// - Non-production environments allow a missing licence so the app can be
//   tested. A simulated licence (`forge install --license inactive`) or the
//   LICENSE_OVERRIDE variable (`active` / `inactive`) is still honoured there.

const PRODUCTION = 'PRODUCTION';

function environmentType(context) {
  const value = context?.environmentType ?? context?.environment?.type ?? null;
  return value ? String(value).toUpperCase() : null;
}

export function isProductionContext(context) {
  // An unknown environment is treated as production so enforcement fails closed.
  const type = environmentType(context);
  return type == null || type === PRODUCTION;
}

function licenseOverride(env) {
  const value = String(env?.LICENSE_OVERRIDE ?? '').trim().toLowerCase();
  if (value === 'active' || value === 'trial') return true;
  if (value === 'inactive') return false;
  return null;
}

export function resolverLicenseAllows(context, env = process.env) {
  const license = context?.license;
  if (isProductionContext(context)) return license?.active === true;

  const override = licenseOverride(env);
  if (override != null) return override;
  return license == null || license.active === true;
}

export const UNLICENSED_MESSAGE = 'Customer & Organisation Manager is read-only because this site has no active licence. '
  + 'Browsing and previews still work; ask a Jira administrator to renew or start a trial from Manage apps to import changes.';

// Event triggers get no licence object from Forge; `filter.appIsLicensed` in manifest.yml does the real
// enforcement. This only rejects what is explicitly inactive (defence in depth).
export function triggerLicenseAllows(context, env = process.env) {
  if (licenseOverride(env) === false) return false;
  return context?.license?.active !== false;
}
