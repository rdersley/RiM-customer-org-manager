# Retail inMotion Customer & Organisation Manager

> **Retail inMotion edition.** Internal app for the Retail inMotion work site (`retailinmotion.atlassian.net`) and sandbox (`retailinmotion-sandbox1.atlassian.net`). It is a separate repository and Forge app from the Marketplace edition and is not published to the Atlassian Marketplace.
>
> Before the first deploy: run `forge register "Retail inMotion Customer & Organisation Manager"`, put the printed id in `manifest.yml` (`app.id`), and add the `FORGE_EMAIL` / `FORGE_API_TOKEN` secrets. Merges deploy to the sandbox as before; the work site is deployed only by the manual **Deploy to Retail inMotion work site** workflow. The **Brand check** workflow fails if the Marketplace brand appears anywhere in the repository.

