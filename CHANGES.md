# What changed, and why

**For:** the original author of the Ultimate Group Asset & Tool Management Tracker
**Date:** 6 November 2026
**Starting point:** `asset_and_tool_management_tracker.html` (the Netlify + Supabase version), included in the export as `original/`

**Latest update:** 10 November 2026. Added UES job cards using the USS field layout, including job details, personnel, odometer and time on site, work notes, billing choice and signatures. Signed PDFs are routed to `/mnt/SmartHome/Jobcards/UES` and named `UES_JC_<job-number>.pdf`. UES now has a text header in generated PDFs. USS and SINABO behavior remains available. Earlier: the signed SINABO job-card workflow supports local drafts, an offline upload queue and a status log. SINABO PDFs are saved under `/mnt/SmartHome/Jobcards/SINABO`; Master Admin can manage the shared personnel roster. Fleet mileage entries reflow as cards on phones, the mobile logo is centered, and Go-Live is limited to the Master Admin role.

The app looks and works the same for staff: same screens, scanner, check-out/return, fleet mileage and Master Control. What changed is **where it runs**, **how sign-in is secured**, and **how updates are shipped**.

---

## The short version

| # | Change | Why |
|---|---|---|
| 1 | Moved from **Netlify + Supabase** to our own **TrueNAS server** | Company data stays in-house, with no outside service limits or monthly risk. It runs on the domain we'll buy via Cloudflare. |
| 2 | **PINs are now checked by the server**, never sent to the browser | In the old version anyone with the page could read every staff PIN, including the Master Admin's. |
| 3 | **The database can only be used through a small set of secure functions** | Before, the public key let anyone read, change or delete any table without signing in. |
| 4 | **Wrong-PIN lockout**: 5 wrong tries locks that account for 15 minutes | 4-digit PINs can otherwise be guessed in minutes by a script. |
| 5 | **Permissions are enforced by the server**, not just hidden buttons | E.g. only "Edit Assets" users can delete assets, and only Master Admins can change staff/PINs, even if someone tampers with the page. |
| 6 | **Deletions only happen when someone actually deletes** | A phone with an old list could re-delete re-imported assets or bring deleted ones back. |
| 7 | The app is packaged as **Docker images built automatically from GitHub** | Updating the server is now "push to GitHub → click Update in TrueNAS". No copying files around. |
| 8 | **Technicians can only return tools assigned to themselves**; Storemen and Master Admins can return tools for others | The rule is enforced in the app and in the database API, so a direct API request cannot bypass the screen restriction. |
| 9 | **The login screen remembers the last successfully signed-in profile on each device** | Only the profile name is stored in that browser's local storage; PINs are never remembered, and other devices are unaffected. |

---

## 1. Hosting: Netlify + Supabase → TrueNAS

**Before:** the HTML was hosted on Netlify, and the data lived in a Supabase project. Each device had to be given the Supabase URL and key, either typed into the Cloud & Go-Live tab or baked into a "Team HTML" download.

**Now:** everything runs as one app on our TrueNAS server, in five small containers:

| Container | What it does |
|---|---|
| `web` | nginx: serves the app page and forwards database requests |
| `api` | PostgREST, the same engine Supabase uses under the hood. It turns the database functions into a web API |
| `db` | PostgreSQL 17, the database itself. Its files live on a TrueNAS dataset, so they're covered by snapshots |
| `migrate` | Sets up and updates the database every time the app starts, then stops |
| `adminer` | A database viewer for IT only (office network, never exposed to the internet) |

**Why PostgREST:** the app already spoke Supabase's API. Using the same engine meant the app needed only small changes to work against our own database.

**What changed in the app for this:**
- The app now automatically talks to the server it was loaded from. There's nothing to configure on any device.
  *Code:* `SELF_HOSTED_API`, `getCleanSupabaseUrl()`, `getSupabaseCreds()`
- On the **Go-Live tab**, the Supabase URL/key boxes and the "Download Team HTML / index.html" buttons are hidden. A panel says it's connected to the in-house database instead.
  *Code:* `applySelfHostedUI()`
- Labels like "Supabase Cloud Connected" now read "In-house Database Connected".
- *(9 Nov 2026)* The **"Complete Supabase SQL Setup Script"** box on the Go-Live tab (and its Copy button, `copySqlSchema()`) was removed. Our own server sets up its database automatically (`db/02-schema.sql`), so the box was no longer needed.
- **Local-only mode still works:** if you open the HTML file directly from disk (double-click), it behaves like the original, with data saved only in that browser. This is handy for playing around without a server.

## 2–5. Security: sign-in, PINs and permissions

### What the problem was

The old database setup script (in the Go-Live tab) contained policies that let **anyone** read and write **every** table:

```sql
CREATE POLICY "Allow all public access to staff" ON public.staff_accounts FOR ALL USING (true) WITH CHECK (true);
```

Sign-in worked by **downloading the person's record, PIN included**, and comparing it in the browser. The database key is visible in the page source, so anyone who could open the site could:
- list every staff member's PIN, including Russell Ralph's (Master Admin);
- change or delete any asset, log or staff account without signing in.

There was also a hidden `__UG_STAFF_CONFIG__` row in the tools table holding **all PINs as plain text** (a fallback the app wrote automatically).

That was acceptable while it was a test on Netlify. It isn't once it's on a public company domain.

### What was done

**In the database** (`db/02-schema.sql`):
- PINs are stored **hashed** (bcrypt) in a `pin_hash` column. The plain `pin` column is removed, and existing PINs were converted automatically.
- The hidden `__UG_STAFF_CONFIG__` row is deleted and can never be written again.
- Direct table access for the public key is **revoked**. The browser can only call these functions:

| Function | Who can call it | Purpose |
|---|---|---|
| `ug_list_staff` | anyone | Names + roles for the login dropdown (no PINs) |
| `ug_login` | anyone | Checks name + PIN on the server; returns a 12-hour session token |
| `ug_logout` | signed-in | Ends the session |
| `ug_get_tools`, `ug_get_staff`, `ug_get_logs` | signed-in | Read data |
| `ug_upsert_tools`, `ug_add_log` | signed-in | Check-out/return, add/edit assets, activity log |
| `ug_delete_tool` | "Edit Assets" permission | Delete an asset |
| `ug_upsert_staff`, `ug_delete_staff` | "Master Admin" permission | Staff, roles, permissions, PINs |

- **Lockout:** 5 wrong PINs locks that account for 15 minutes (`failed_attempts`, `locked_until`).
- Suspending a staff member immediately ends their sessions.
- Activity log entries now also record **who actually did it** (`performed_by`), even when a Storeman signs out a tool for someone else.

**In the app** (`html/index.html`):
- `handleStaffLogin()`: sends name + PIN to `ug_login` and keeps only the session token. Messages for a wrong PIN, a suspended account and a locked account are unchanged or clearer.
- All sync functions (`upsertToolsToSupabase`, `deleteToolFromSupabase`, `upsertStaffToSupabase`, `pushActivityLogToSupabase`, `pullAllFromSupabase`) now call the secure functions above with the session token.
  *New helper:* `ugRpc()`
- **Master Control:** the PIN box no longer shows anyone's current PIN (it shows `••••`). Typing a new one and pressing Save sends it to the server to be hashed. Removing a staff member now also removes them on the server; before, it only removed them on that device.
- If a session expires, the app returns to the sign-in screen with a message (`handleSessionExpired()`).
- Old copies of PINs cached in a device's browser storage are overwritten on first load.

**First run:** the staff roster is created by the database (`db/03-seed.sql`), not by the browser. Russell Ralph gets a PIN chosen at install time, and **everyone else starts on 1234 and must be given their own PIN in Master Control before the app goes public.**

### PINs and updates (9 Nov 2026)

**Updates and redeploys never change anyone's PIN.** A PIN set in Master Control stays until someone changes it in Master Control again. This was tested: upgrade, redeploy and restart all keep every staff member's PIN.
- `INITIAL_ADMIN_PIN` in the TrueNAS YAML is used **once only**, when the database is brand new and empty. After that it is ignored, so it will not match Russell's PIN once he has changed it.
- **New audit trail:** every PIN change now records **when** (`pin_changed_at`) and **which admin** did it (`pin_changed_by`) on the staff record (see it in Adminer → `staff_accounts`). If a PIN ever seems to "change by itself", this shows who changed it.
- **Locked out of every Master Admin account?** In the TrueNAS YAML, uncomment `RESET_ADMIN_PIN` under `migrate`, set 4 digits and save (`db/04-admin-pin-reset.sql`). It is applied **once**; later redeploys with the same value do nothing, so it can't undo a PIN changed afterwards. Remove it when done.

## 6. Deletions only happen when someone actually deletes

**Problem 1:** each device remembered what had been deleted on it, and kept deleting those IDs from the server forever. If assets were later **re-imported** (e.g. from the old Supabase CSV) with the same IDs, any phone that had once deleted them would quietly delete them again.

**Problem 2:** every check-out/return sent the device's **whole** asset list to the server. A phone with an out-of-date list could **bring back** assets someone else had deleted.

**Fix** (in `confirmDeleteAsset()`, `pullAllFromSupabase()`, `deleteToolFromSupabase()`, `handleTransactionSubmit()`, `handleCsvImport()`):
- A device's record of a deletion is only used **until the server confirms it**. If the delete couldn't reach the server (e.g. no signal), it's retried on the next sync. After that, if the same ID is added again, it's accepted.
- Check-out, return and the in-app CSV import now send **only the asset(s) that changed**.
- When syncing, assets the server no longer has are removed from the device, except anything changed on that device in the last 5 minutes (still uploading).
- If the server refuses a delete (no permission), the asset reappears on screen instead of silently vanishing.

This was tested with two "devices" side by side: delete on one, check out on the other; re-import; delete while offline.

## 7. Packaging, GitHub and updates

- **GitHub repo** (public): `mussellralph/ug-asset-tracker`
- On every push to `main`, **GitHub Actions** (`.github/workflows/publish-images.yml`) builds three images and publishes them to GitHub Container Registry:
  - `ghcr.io/mussellralph/ug-asset-tracker-web` (nginx + `index.html`)
  - `ghcr.io/mussellralph/ug-asset-tracker-migrate` (the `db/` scripts)
  - `ghcr.io/mussellralph/ug-asset-tracker-jobcards` (signed job-card PDFs and TrueNAS share uploads)
- These images are **public** so TrueNAS can download them without a login. The source repo is currently public too. Keep passwords, API keys and live PINs out of the repository and images.
- **To update the live app:** commit + push → wait for the green tick in GitHub Actions → TrueNAS → Apps → ug-asset-tracker → Update (or Edit → Save).
- **To roll back:** every build is also tagged with its commit ID. Change `:latest` in the TrueNAS YAML to a known-good ID.

## Where it runs now

| Server | App | Adminer (IT, LAN only) | Notes |
|---|---|---|---|
| TrueNAS **10.0.0.11** (current) | http://10.0.0.11:30090 | http://10.0.0.11:30091 | Uses 30090/30091 because `haos-monitoring` already uses 30080 on this server. Database in `/mnt/SmartHome/Apps/ug-asset-tracker/pgdata` |
| TrueNAS 10.0.0.5 (first test install) | http://10.0.0.5:30080 | http://10.0.0.5:30081 | Separate database; can be removed once 10.0.0.11 is confirmed |

Passwords and the first Master Admin PIN for each server are kept outside this project (company password manager). They are not in GitHub or this export.

## Files in this project

| File / folder | What it is |
|---|---|
| `html/index.html` | **The app**, your original with the changes above |
| `db/01-roles.sql` | Database roles the API connects with |
| `db/02-schema.sql` | Tables + all secure functions (safe to re-run) |
| `db/03-seed.sql` | First-run staff roster |
| `db/migrate.sh` | Runs the three scripts on every start |
| `docker/*.Dockerfile` | How the web, migration and job-card images are built |
| `nginx.conf` | Web server settings (serves the app, forwards `/rest/v1/` to the API, no caching) |
| `docker-compose.yml` | **Run the whole thing on a PC/Mac** with Docker |
| `truenas-app.yaml` | Template to install on TrueNAS (passwords are `CHANGE_ME` placeholders) |
| `README-TRUENAS.md` | Step-by-step server install, updates, backups, Cloudflare |
| `CHANGES.md` | This file |
| `HANDOVER.md` | Current ownership, deployment and maintenance notes |
| `original/` | (export only) your original HTML, for comparison |

## How to play around with it

**Easiest, with no setup:** double-click `html/index.html`. It opens in local-only mode, the same as the original before Supabase was connected. Data stays in that browser only.

**The full thing, with the real database**, on a computer with Docker Desktop:
```bash
docker compose up -d --build
```
Then open http://localhost:30080 and sign in as **Russell Ralph**, PIN **4321** (local test PIN only). Adminer is on http://localhost:30081 (server `db`, user `postgres`, password `localdevpassword`, database `ugtracker`). To stop it: `docker compose down`.

**Using an AI assistant to make changes:** point it at `html/index.html` and this file. Two rules keep things working:
1. Keep all reads/writes going through `ugRpc('ug_…')`. Don't add direct `/rest/v1/<table>` calls, because those are blocked on purpose.
2. Anything that needs a new kind of data access needs a new `ug_…` function in `db/02-schema.sql`, with a permission check.

## Still to do before staff use it publicly

- [ ] Give every staff member their own PIN (Master Control).
- [ ] Remove SMB/NFS shares from the app's TrueNAS dataset (the database files live there).
- [ ] Set up the Cloudflare Tunnel to the app's port only (never Adminer).
- [ ] Optional: Cloudflare Access (email code) in front of the app as an extra layer.
- [ ] Import the real asset list from Supabase (CSV → Adminer, see README; skip `__UG_STAFF_CONFIG__`).
