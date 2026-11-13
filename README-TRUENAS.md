# Ultimate Group Asset & Fleet Tracker — TrueNAS SCALE Deployment Guide

Self-hosted version: the app and its database both run on our TrueNAS server.
Supabase and Netlify are no longer used.

> **Current install:** TrueNAS **10.0.0.11** → app on port **30090**, Adminer on **30091** (30080 is taken by `haos-monitoring` there). The YAML below uses the live server ports 30090/30091 and the persistent database and Jobcards paths. What changed from the original Netlify version, and why, is in **CHANGES.md**. Handing the app to a new owner: **HANDOVER.md**.

## How it fits together

```text
Staff phone / PC ──HTTPS──► Cloudflare ──► TrueNAS :30090  web (nginx)
                                                 ├─ /           → the app (html/index.html)
                                                 └─ /rest/v1/   → api (PostgREST) → db (PostgreSQL)
IT only (office LAN) ─────────────────────► TrueNAS :30091  Adminer (database viewer)
```

- **Day-to-day management happens inside the app.** Add or remove assets in **Inventory**, and manage staff, roles and PINs in **Master Control**. Nobody needs a database tool.
- PINs are stored hashed in the database and checked by the server. The browser never sees them.
- 5 wrong PINs locks that person's account for 15 minutes. Sessions last 12 hours.

## Where the code lives

The code lives in the GitHub repo **mussellralph/ug-asset-tracker**, which is currently public. Every push to `main` makes GitHub Actions build three images and publish them (publicly) to GitHub Container Registry:

- `ghcr.io/mussellralph/ug-asset-tracker-web`: nginx + the app
- `ghcr.io/mussellralph/ug-asset-tracker-migrate`: the database setup scripts
- `ghcr.io/mussellralph/ug-asset-tracker-jobcards`: signed job-card PDF creation and TrueNAS folder upload

TrueNAS pulls those images. The app database lives in `pgdata`; signed job-card PDFs are written to `/mnt/SmartHome/Jobcards/<COMPANY>/` on the configured host share. Ensure the share permissions allow the app container to create files there.

```text
ug-asset-tracker/
├── .github/workflows/publish-images.yml  # Builds & publishes images on push to main
├── truenas-app.yaml     # Paste into TrueNAS "Install via YAML"
├── docker-compose.yml   # Local testing: docker compose up -d --build → http://localhost:30080
├── docker/              # web.Dockerfile, migrate.Dockerfile
├── nginx.conf           # Web server: serves the app, forwards /rest/v1/ to the API
├── db/
│   ├── migrate.sh       # Runs the three scripts below on every start
│   ├── 01-roles.sql     # Database roles the API uses
│   ├── 02-schema.sql    # Tables + secure functions (re-applied on every start, safe)
│   └── 03-seed.sql      # First-run staff roster (only when the staff table is empty)
└── html/
    └── index.html       # The app
```

---

## Step 1: Confirm the persistent TrueNAS folders

Keep the existing database directory mounted unchanged at `/mnt/SmartHome/Apps/ug-asset-tracker/pgdata`. This preserves the live staff, inventory and transaction data.

Signed job-card PDFs are saved beneath the existing `/mnt/SmartHome/Jobcards` folder, separated by company.

Create `/mnt/SmartHome/Jobcards/Technical Data` in the existing share and add reference files there. Subfolders can organize documents by company or type. Signed-in staff can browse and download the files from **Technical Data** (under **More** on mobile). Manage the source files through the share and give the app container read access to the folder.

## Step 2: Image access

The images on GitHub Container Registry are **public**, so TrueNAS pulls them without a login. The source repo is currently public too. Keep credentials out of the repository.

If they are ever made private again, add a registry login in TrueNAS → **Apps** → **Configuration** → **Manage Container Image Registries**: URI `ghcr.io`, username `mussellralph`, password a GitHub token with only `read:packages`.

## Step 3: Edit the YAML

Open `truenas-app.yaml` and change:

| Setting | What to put |
|---|---|
| `CHANGE_ME_postgres_password` (appears **3 times**, keep them identical) | A long random password, letters and numbers only |
| `CHANGE_ME_api_password` (appears **2 times**, keep them identical) | A different long random password, letters and numbers only |
| `INITIAL_ADMIN_PIN` | The 4-digit PIN Russell Ralph (Master Admin) will use on first sign-in |
| `/mnt/SmartHome/Apps/ug-asset-tracker/pgdata` | Keep this existing live database path unchanged |
| `/mnt/SmartHome/Jobcards` | The existing TrueNAS share used for signed PDF job cards; keep this host path mounted to `/jobcards` |

Store both passwords in the company password manager. **Don't commit the edited copy to GitHub.**

## Step 4: Install

1. TrueNAS → **Apps** → **Discover Apps** → top-right **⋮** → **Install via YAML**.
2. Name: `ug-asset-tracker`. Paste the edited YAML and click **Save**.
3. Wait until the app shows **Running**. The `migrate` container will show as **Exited**; that's normal, because it sets up the database and then stops.
4. Open `http://10.0.0.11:30090` on the office network.

## Step 5: First sign-in (Master Admin)

1. Sign in as **Russell Ralph** with the `INITIAL_ADMIN_PIN`.
2. Go to **Master Control** and **give every staff member their own PIN**. Everyone else starts on `1234`, so the app must not go public until this is done.
3. Remove anyone who shouldn't have access, and add any missing staff.
4. Go to **Inventory** and add or remove assets as needed. The app starts with a few sample assets.

## Step 6: Put it on the company domain (Cloudflare)

Recommended: **Cloudflare Tunnel**, which needs no router port forwarding and gives automatic HTTPS.
1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create tunnel** (cloudflared). Copy the token.
2. On TrueNAS, install the **Cloudflared** app from Discover Apps and paste the token.
3. Add a public hostname in the tunnel, e.g. `tools.yourdomain.co.za` → service `http://10.0.0.11:30090`.
4. **Only route port 30090.** Never publish 30091 (Adminer).
5. Optional extra layer: **Zero Trust → Access → Applications** can require staff to confirm their work email before the page loads.

---

## Updating the app later

1. Make changes in the repo. Test locally with `docker compose up -d --build` → http://localhost:30080.
2. Commit and push to `main`. In GitHub → **Actions**, wait for **Publish images** to go green (about 2–4 minutes).
3. TrueNAS → **Apps** → `ug-asset-tracker` → **Update** if offered. Otherwise **Edit** → **Save**, which redeploys. `pull_policy: always` makes it fetch the newest `web`, `migrate` and `jobcards` images; `migrate` applies database changes without touching data.

**Rolling back:** every build is also tagged with its commit id. In the YAML, change `:latest` to `:<commit-sha>` from a known-good build and save.

## Backups

- Add a **Periodic Snapshot Task** for the `ug-asset-tracker` dataset (e.g. hourly, keep 2 weeks), and include it in your normal replication/off-site backup.
- For a portable copy, open Adminer → **Export** → SQL.

## Adminer (IT only)

`http://10.0.0.11:30091`: System **PostgreSQL**, Server `db`, Username `postgres`, the postgres password, Database `ugtracker`.
Use it for imports, exports and fixes. Editing data here skips the app's checks, so prefer the app for normal changes.

## Moving data across from the old Supabase version

1. In Supabase → **Table Editor**, export `tools` and `activity_logs` as CSV. Don't import staff PINs; set new ones in the app instead.
2. In Adminer → select the table → **Import** → choose the CSV.
3. Skip any row with id `__UG_STAFF_CONFIG__`: it contains old plain-text PINs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Install fails pulling `ghcr.io/...` images | Check both packages are still public on GitHub (or add a registry login, see Step 2). |
| App loads but sign-in says "Cannot reach the server" | Check the `api` container is running. Check that the `CHANGE_ME_api_password` values match. |
| `migrate` keeps failing | Look at its logs in TrueNAS. Usually the postgres password doesn't match in all 3 places, or `INITIAL_ADMIN_PIN` isn't 4 digits. |
| `db` won't start, permission error on `pgdata` | Create the dataset with the **Apps** preset, or let TrueNAS set the ACL for the apps user. |
| Old phones show stale data | They may have the old Netlify version cached. Open the new address and sign in again. |
