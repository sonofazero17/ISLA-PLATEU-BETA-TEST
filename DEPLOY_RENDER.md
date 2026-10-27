# Deploying ISLA-PLATEU on Render

## 1. Why the administrator login kept "stopping working"

Two real causes were found in the code (not in your password):

1. **The database was being erased.** The server used to create an administrator with a *new random password* whenever it started with an empty database. On Render the app folder is wiped on every deploy and whenever a free instance wakes from sleep, so the database was recreated empty and a new password was printed in the log. Customers, staff and sessions disappeared too. The fix is a persistent disk (section 4) plus provisioning the administrator from an environment variable.
2. **All visitors looked like one visitor.** Behind Render's load balancer every request appeared to come from the same address, so the "too many failed attempts" lock-out (and other per-visitor limits) was shared by everybody: a few failed attempts from anywhere, including bots, could lock the administrator out on every device for 15 minutes. The server now reads the real visitor address from the proxy (`TRUST_PROXY_HOPS`, automatic on Render).

Also fixed: the administrator email can no longer be registered by the public, and no password is ever printed in production.

## 2. Render service settings

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` (there are no dependencies, so this is instant) |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Node version | needs **22.13 or newer** (`engines` in package.json). If Render picks an older one, add the environment variable `NODE_VERSION=22` (or `24`) |
| Instance type | **Starter or higher** if you want a persistent disk (free instances cannot attach one) |

The server listens on Render's `PORT` automatically, on all network interfaces.

## 3. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | recommended | `production`: no passwords are generated or printed, HSTS is sent |
| `ADMIN_PASSWORD` | **yes, first deploy** | Password for `admin@islaplateu.local`. Used **only** to create the account when no administrator exists. Mark it as a secret. Changing it later does *not* change an existing account |
| `ADMIN_PASSWORD_RESET` | only for recovery | Resets the administrator password **once** per distinct value (see section 7), then can be removed |
| `DB_PATH` | **yes** | Database file on the persistent disk, e.g. `/var/data/islaplateu.db` |
| `TRUST_PROXY_HOPS` | no | Number of proxies in front of the app. Automatic (`1`) on Render; use `2` if you also put Cloudflare in front |
| `OSRM_URL` | optional | Your own OSRM routing server (the free public demo server is for light use only) |
| `TILE_URL_TEMPLATE`, `TILE_ATTRIBUTION`, `TILE_MAX_ZOOM` | optional | Use a different map-tile provider (section 9) |
| `ADMIN_EMAIL` | no | Defaults to `admin@islaplateu.local`. Leave it alone |
| `COOKIE_SECURE` | no | The `Secure` cookie flag is set automatically behind Render's HTTPS |
| `PORT`, `HOST` | no | Provided by Render. Do not set |

Never put real passwords in GitHub. `.env` is git-ignored; `.env.example` shows the names only.

## 4. Persistent database storage (Render disk)

1. Render Dashboard -> your service -> **Disks** -> **Add Disk**. Name `isla-data`, mount path `/var/data`, size 1 GB is plenty.
2. **Environment** -> add `DB_PATH=/var/data/islaplateu.db`.
3. Save and deploy. The startup log must show `database file: /var/data/islaplateu.db` and no `WARNING`. If `DB_PATH` points inside the app folder, the log and the Admin dashboard show a red warning.

Things to know: a service with a disk runs a single instance, and deploys cause a short downtime (Render's rule for disks). Render also snapshots disks; check Render's documentation for retention and do not rely on that alone: keep your own backups (section 6). If a disk is not an option, a hosted database would be needed. That is a migration and is not done without your approval.

## 5. Moving the data you already have

Do this **before** the next deploy, because a redeploy of a service without a disk erases the current database.

1. Log in to the live site as administrator -> **Overview** -> **Download backup**. You get a `.db` file with every account, restaurant, reservation and order. Keep it private.
2. Add the disk and `DB_PATH` (section 4), deploy, and check the app starts.
3. Put the backup on the disk:
   * Temporarily set the service's **Start Command** to `sleep 3600` and deploy (this keeps the container up without the app holding the database).
   * Open an SSH session to the service (Render's *SSH* documentation) and copy your backup file to `/var/data/restore.db` (for example with `scp`).
   * In that session run: `DB_PATH=/var/data/islaplateu.db node scripts/restore.js /var/data/restore.db --yes`  
     (it checks the file first and keeps the previous database next to it as `...before-restore-...`).
   * Set the Start Command back to `npm start` and deploy.
4. Log in. Your accounts are back. If the old administrator password is unknown, use section 7.

If the live database was already erased by an earlier deploy, there is nothing to move: start fresh with `ADMIN_PASSWORD`.

## 6. Backups and restoring

* **From the website (easiest):** Admin -> Overview -> **Download backup**. Do it regularly and before every risky change.
* **From a shell:** `npm run backup` writes a verified copy (sessions removed) to a `backups/` folder next to the database. Works while the app is running.
* **Restore:** stop the app (or use the `sleep 3600` trick above), then `node scripts/restore.js <backup file> --yes`.
* Backups contain personal data and password hashes. Never commit them or email them around.

## 7. Provisioning and recovering the administrator

**First setup (recommended):** set `NODE_ENV=production`, `DB_PATH`, and `ADMIN_PASSWORD` (your chosen password, 8 to 128 characters). On the first start with an empty database the log says `Administrator account created for admin@islaplateu.local`. The password is never printed. From then on the account lives in the database, so it keeps working on every device, restart and redeploy, as long as the disk and database stay.

**Forgot the password / need to take the account back:** set `ADMIN_PASSWORD_RESET` to a *new* password and deploy. The log says it was reset, old sessions are signed out. Log in, then **delete the variable**. If you leave it, nothing happens on later restarts (it is applied once per distinct value); to reset again, use a different value.

**Never** hard-code credentials in the source, and do not reuse the password anywhere else.

## 8. Updating your GitHub repository safely (Windows PowerShell)

```powershell
# 1. extract the ZIP to a NEW folder (right-click -> Extract All), e.g. C:\Work\ISLA-PLATEU-v4
# 2. clone your repo next to it
cd C:\Work
git clone https://github.com/sonofazero17/ISLA-PLATEU.git repo
# 3. copy the new files over the clone (keeps the .git folder)
robocopy C:\Work\ISLA-PLATEU-v4\ISLA-PLATEU C:\Work\repo /E /XD .git node_modules /XF *.db *.db-wal *.db-shm .env
cd C:\Work\repo
git status                      # review: there must be NO .db files and NO .env
git add -A
git commit -m "Stable admin provisioning, collapsible live/navigation panels, heading arrow, OSM fixes"
git push
```
If a database or password was ever committed in the past: change that password, run `git rm --cached <file>`, commit, and consider cleaning the history (e.g. `git filter-repo`) because deleting a file does not remove it from older commits.

Render redeploys when you push (if auto-deploy is on).

## 9. Maps: what was found and what to do

* The server sent `Referrer-Policy: same-origin`, which removes the `Referer` header from every request to another site. **OpenStreetMap's tile usage policy requires a valid Referer**, and OSM blocks requests without one ("Access blocked" tiles / HTTP 403). The policy is now `strict-origin-when-cross-origin` (only your site's origin is sent) and the tile layer states it explicitly. OSM's current single HTTPS host `https://tile.openstreetmap.org` is used and allowed by the Content-Security-Policy.
* The map container is now sized robustly (it can no longer collapse to zero height) and re-measures itself on every layout change.
* **Could not be verified from here:** whether OSM's live servers accept your site, and why it differed between phone and laptop. Check on the laptop: open the site, press F12 -> **Network**, filter `tile`. A `403` (or tiles that show the words "Access blocked") means OSM is refusing the request; a red/blocked entry means a browser extension, ad/privacy blocker, VPN or firewall. The Console also lists any Content-Security-Policy problem.
* OSM's public tile servers are a courtesy service with a fair-use policy (no heavy or commercial traffic, keep the attribution). For a public launch use a tile provider with an account (set `TILE_URL_TEMPLATE`, `TILE_ATTRIBUTION`; the Content-Security-Policy follows automatically) or host your own tiles. This app does not proxy or disguise tile requests.
* **Routing:** routes come from the free OSRM demo server (driving only, fair-use, no guarantee). It is called by your server, so Render's address is what it sees. For real use run your own OSRM and set `OSRM_URL`.

## 10. Manual tests on real devices (could not be done in the build environment)

* **Phone GPS:** Track my location outdoors; the dot appears, accuracy shown, minimize/restore the panel, walk 20 m and watch the position and arrow move; Stop Tracking and confirm the browser's location indicator disappears.
* **Arrow direction:** on Android (Chrome) and iPhone (Safari): tap *Enable compass* on iPhone, hold the phone flat and turn: the arrow should turn with you; rotate the phone to landscape and check it stays right; while walking/driving it should follow your direction of travel. Expect some error near metal and indoors; the panel shows what source is used.
* **Navigation:** pick a restaurant, minimize the panel, check distance/time stay readable, change destination, recenter, stop.
* **Laptop/desktop:** map and tiles load on Chrome, Edge and Firefox; markers show; a route draws.
* **Render:** redeploy twice and confirm the administrator password and your customers survive.
