# Security — Retail inMotion Customer & Organisation Manager

_Last updated: 30 September 2026 (app version 0.7.0)._

## Architecture

Forge-native. No Forge Remote, no external fetch, no vendor servers. Compute and storage run on Atlassian Forge. See [DATA_HANDLING.md](DATA_HANDLING.md) for exactly what is read, written and stored.

## Access control

- The app is a Jira **admin page**; it only appears in Jira administration.
- **Every resolver checks the Jira Administer global permission** (`/rest/api/3/mypermissions`) before doing anything, so calling a resolver directly without admin rights fails (`secureDefine` in `src/index.js`). A unit test covers this.
- All calls from the admin page use `asUser()`: the app page can never do more than the signed-in administrator could do in Jira.
- The Client → Organisation sync trigger (`avi:jira:created:issue`, `avi:jira:updated:issue`) runs as the app (`asApp()`), because background events have no user. It only acts when an administrator has turned sync on, only on the selected projects, and only edits the Organizations field. The manifest filter skips unlicensed sites (`appIsLicensed`) and the app's own edits (`ignoreSelf`), so it can't loop.
- No anonymous endpoints, web triggers or scheduled jobs.

## Licensing

Production fails closed. Without an active licence, reads and previews work, and every write resolver (`createOrganization`, `createImportOrganizations`, `saveImportMapping`, `deleteImportMapping`, `startImportSession`, `bulkUpsertCustomers`, `finaliseImportBatch`, `saveSyncConfig`, `saveSyncHealth`, `applySyncCorrections`) refuses the call. The sync trigger doesn't run on unlicensed sites. Covered by unit tests.

## Safe import behaviour

- Organisations are created only after a scan reaches Jira's final page and proves the name is missing. If pagination stalls, nothing is created.
- Selecting a CSV never changes Jira. Changes happen only when an administrator clicks Import or Resume.
- Each 100-row batch carries an idempotency key, so a retried batch is not applied twice by Jira.
- A batch only counts as done once its customers have been added to the service project and their organisations. Every row's outcome is reported (done, not found, failed with Jira's reason), and a resumed import redoes any batch that didn't finish.
- Resolver input is validated: row counts, batch counts, SHA-256 fingerprints, at most 100 rows per bulk request, at most 50,000 rows per import plan, and at most 20 organisations created per call.

## Scopes and why each is needed

| Scope | Needed for |
|---|---|
| `storage:app` | Import sessions, row plans, bulk task records and saved mappings in Forge KVS |
| `read:jira-work` | `GET /rest/api/3/mypermissions` (the admin check on every call); reading the field list, ticket fields, JQL search and autocomplete for sync; receiving issue created/updated events |
| `read:jira-user` | Import: finding each imported customer's account id by email (`GET /rest/api/3/user/search`), so they can be added to the service project and organisations |
| `write:jira-work` | Sync: setting the Organizations field on a ticket (`PUT /rest/api/3/issue/{id}`) |
| `read:servicedesk-request` | `GET /rest/servicedeskapi/servicedesk`, listing service projects |
| `manage:servicedesk-customer` | Listing a service project's customers, listing organisations, creating organisations, and adding imported customers to the service project and to organisations (`/rest/servicedeskapi/servicedesk/{id}/customer`, `/rest/servicedeskapi/organization`, `/rest/servicedeskapi/organization/{id}/user`) |
| `write:customer:jira-service-management` | Creating and updating customers through the JSM customer bulk API |
| `write:customer.profile:jira-service-management` | Writing customer profiles (display name and customer detail values) in the same bulk API call |
| `read:task:jira-service-management` | Reading bulk task status (`/jsm/csm/api/v1/tasks/{id}`) for Import History |
| `read:customer.detail-field:jira-service-management` | Import: listing the site's customer detail fields (`GET /jsm/csm/api/v1/customer/details`: names, types and options) for the column mapping. Added in 0.7.0 |
| `write:customer.detail:jira-service-management` | Import: setting a customer's detail values directly (`PUT /jsm/csm/api/v1/customer/{id}/details`), one customer at a time, instead of through Jira's queued bulk API, which took about 8 minutes per 100 customers on a live site. Added in 0.8.0 |

Version 0.3.0 removed six scopes that nothing used: `read:user:jira`, `read:organization`, `write:organization`, `write:organization.profile`, `read:customer` and `read:customer.profile` (the last five are the `:jira-service-management` granular scopes).

## Dependencies

Runtime dependencies: `@forge/api`, `@forge/resolver`, `@forge/kvs` (backend); `@forge/bridge`, `react`, `react-dom` and `@retailinmotion/ui` (UI). Before each release: `npm audit`, `npm test` (unit tests and the colour check), `npm run build`, `forge lint`, and the live Playwright suite.

## Reporting a vulnerability

Raise security concerns with the Retail inMotion Jira administrators, with "Security" in the subject line. Include the site, app version and steps to reproduce. Don't include passwords, API tokens or customer data.
