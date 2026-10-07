# Retail inMotion Customer & Organisation Manager

> **Retail inMotion edition.** Internal app for the Retail inMotion work site (`retailinmotion.atlassian.net`) and sandbox (`retailinmotion-sandbox1.atlassian.net`). It is a separate repository and Forge app from the Marketplace edition and is not published to the Atlassian Marketplace.
>
> Before the first deploy: add the `FORGE_EMAIL` / `FORGE_API_TOKEN` secrets, then run the **Register Forge app** workflow (Actions tab), which registers this app with Forge and commits its id to `manifest.yml`. The work site runs the Forge `production` environment; there is no licence check (`src/license.js` allows every installation). Moving a site over from the Marketplace app: `docs/WORK_SITE_ROLLOUT.md`. Merges deploy to the sandbox as before; the work site is deployed only by the manual **Deploy to Retail inMotion work site** workflow. The **Brand check** workflow fails if the Marketplace brand appears anywhere in the repository.

