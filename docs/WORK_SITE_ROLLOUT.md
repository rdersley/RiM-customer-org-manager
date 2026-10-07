# Rolling out to the Retail inMotion sites

Retail inMotion Customer & Organisation Manager is its own Forge app, so a site that ran the
Marketplace app moves over once. Both apps can be installed side by side while you do it.

## One-off setup

1. Add the repository secrets `FORGE_EMAIL` and `FORGE_API_TOKEN`.
2. Actions → **Register Forge app** → Run (with the Developer Space id if the run asks for one). It
   registers this app with Forge and commits the new app id to `manifest.yml`.

## Work site (retailinmotion.atlassian.net)

1. In the old app (Jira settings → Apps → Customer & Organisation Manager → **Backup & restore**
   tab): **Download backup**. The file holds the saved column mappings, import history and the
   Client → Organisation sync settings and log. Customers and organisations themselves live in
   Jira, so they are not in the file and need no copying.
2. Actions → **Deploy to Retail inMotion work site** (type `DEPLOY`). It deploys the Forge
   `production` environment.
3. In the new app: **Backup & restore** tab → choose the file → **Restore this backup**, then reload.
4. Check the Organisation sync settings and Import History, then uninstall the old app from the
   site (Manage apps), so only this app remains. Until then both apps' sync triggers react to
   ticket changes, so switch Organisation sync off in one of them while both are installed.

## Sandbox (retailinmotion-sandbox1.atlassian.net)

The same steps; merges to `main` deploy the Forge `development` environment to the sandbox.
