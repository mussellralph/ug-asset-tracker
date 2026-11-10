# Owner and deployment operations

This project is maintained by the GitHub account `mussellralph`. The repository is `mussellralph/ug-asset-tracker`; GitHub Actions builds the web, database migration and job-card images on every push to `main`.

## Current deployment

| Component | Location |
|---|---|
| GitHub repository | `https://github.com/mussellralph/ug-asset-tracker` |
| Web image | `ghcr.io/mussellralph/ug-asset-tracker-web` |
| Migration image | `ghcr.io/mussellralph/ug-asset-tracker-migrate` |
| Job card image | `ghcr.io/mussellralph/ug-asset-tracker-jobcards` |
| Live TrueNAS app | `10.0.0.11`, ports `30090` (app) and `30091` (Adminer, LAN only) |
| Database data | `/mnt/SmartHome/Apps/ug-asset-tracker/pgdata` |
| Signed job-card PDFs | `/mnt/SmartHome/Jobcards/{SINABO,UES,USS}` (all three company forms enabled) |
| Public hostname | `ultimate-group.app`, Cloudflare Tunnel `ug-assets` to `http://10.0.0.11:30090` |
| Test install | `10.0.0.5`, ports `30080` and `30081`, separate database |

Keep database passwords, API keys, Cloudflare tunnel tokens and live staff PINs in the company password manager. Never commit them to this repository. Do not expose Adminer (port `30091`) through Cloudflare.

The stopped `ug-tracking-app` on `10.0.0.11` shares the live database folder. Never start it. Remove it only after confirming it is no longer needed and the live app is healthy.

## Making and deploying a change

1. Work in the local Git checkout and keep changes on a branch or commit on `main` as appropriate.
2. For local development, run `docker compose up -d --build` and open `http://localhost:30080`. The local stack uses test credentials from `docker-compose.yml`; do not reuse them on the live server.
3. Push the reviewed change to GitHub. The `Publish images` workflow builds and publishes all images, tagged `latest` and with the commit SHA.
4. Confirm the GitHub Actions run succeeds.
5. In TrueNAS, update or redeploy the `ug-asset-tracker` app. Keep its database passwords, published ports, `/mnt/SmartHome/Apps/ug-asset-tracker/pgdata` mount and `/mnt/SmartHome/Jobcards:/jobcards` mount unchanged.
6. Confirm the app is running, sign-in works, and the inventory and activity log are present. The `migrate` container normally exits after applying migrations.

For rollback, set the web, migration and job-card image tags in the TrueNAS YAML to the same known-good commit SHA, then redeploy. Do not change the persistent database or Jobcards volumes when rolling back.

## Backups and access

- Keep periodic snapshots of the `ug-asset-tracker` dataset and include it in the normal off-site backup.
- Keep the GitHub account, repository, GHCR packages, TrueNAS administrator access, Cloudflare domain and tunnel, and password manager under company control.
- If replacing the maintainer in future, give them access to those services and the password manager before removing the current maintainer's access.
- Before the app is exposed to staff, ensure every staff member has a unique PIN, the Cloudflare Tunnel routes only to port `30090`, and the database dataset is not shared over SMB/NFS.

See `README-TRUENAS.md` for installation and troubleshooting, and `CHANGES.md` for the project history and security design.
