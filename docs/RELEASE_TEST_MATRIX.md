# Release test matrix — Retail inMotion Customer & Organisation Manager

Run before every production deploy. Record the version, date and result in the release PR.

## Automated

| Check | Command | Pass |
|---|---|---|
| Unit tests (resolvers + UI helpers, licensing, storage) | `npm run test:unit` | All pass |
| No hardcoded colours | `npm run check:ui` | 0 found |
| UI build | `npm run build` | Builds |
| Forge lint | `forge lint` | No errors |
| Dependency audit | `npm audit --omit=dev` and `npm --prefix static audit --omit=dev` | No high/critical, or accepted with a reason |
| Live suite on the Retail inMotion sandbox (development) | `JIRA_BASE_URL=https://retailinmotion-sandbox1.atlassian.net npx playwright test` | 11/11. A test that fails on "iframe not visible" is a known Jira load hiccup (~1 in 33): rerun it. |

The live suite needs a saved Jira session: from the repo folder, run `npx playwright codegen --save-storage=.auth/jira.json <app admin URL>`, sign in, wait for the Customers list, then close the window.

## Manual (development, retailinmotion-sandbox1.atlassian.net)

| Area | Steps | Expected |
|---|---|---|
| Admin-only | Open the app as a non-admin user | Admin permission error; no data shown |
| Customers | Search, then Reset | Results filter and reset |
| Organisations | Open the tab | All organisations listed with a count; search filters |
| Preview (small) | Choose a CSV with a new org, an existing org, an existing customer and a bad row | Create / Skip / Update / Error, with the org note on the new org only |
| Preview (large) | Choose a 16k-row CSV | Comparison completes; Import enabled |
| Import | Import one row with a new org | One customer, one org created; Import History shows the session and task |
| Resume | Start an import, close the tab mid-way, choose the same file | Resume offered; nothing changes until Resume is clicked |
| Read-only | `forge install --upgrade --license inactive` on the dev site (or set `LICENSE_OVERRIDE=inactive`) | Read-only notice; Import and Resume disabled; direct write calls refused |
| Licensed | `--license active` | Import works |
| Dark mode | Switch Jira to dark theme | App follows the theme; text readable |

## Marketplace listing checks

- Documentation, support, and security pages published and links working
- Support portal link set on the listing
- Privacy & Security questionnaire submitted (not draft), with the scope justification from `docs/MARKETPLACE_LISTING.md`
- Listing screenshots match the current UI
