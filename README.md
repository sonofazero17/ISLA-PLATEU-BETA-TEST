# ISLA-PLATEU: Restaurant Locator and Reservation System for Selected Restaurants in Siquijor

> **Deploying on Render?** Read [DEPLOY_RENDER.md](DEPLOY_RENDER.md): persistent disk, environment variables, administrator provisioning/recovery, backups, GitHub update steps.

**Flow:** Introduction page (`/`) → Public restaurant map (`/map`) → Log in / Sign up only when a feature needs an account → Role-based page.

## Run it in VS Code

1. Install **Node.js 22.13 or newer** (LTS from https://nodejs.org). Check with `node -v`.
2. Extract the ZIP with **Extract All** into an empty folder and open the folder that directly contains `server.js` in VS Code.
3. In the terminal: `node server.js` (or `npm start`). Open **http://localhost:3000**. Stop with `Ctrl + C`.
4. **Local development only:** on a brand-new database the terminal prints a one-time administrator password. To choose your own, copy `.env.example` to `.env`, fill in `ADMIN_PASSWORD`, and start with `npm run dev`. The administrator is always `admin@islaplateu.local`.

No `npm install` is needed. The map, icons and fonts load from the internet. **Live Server does not work** for this project (login, roles and the database need the Node server).

The database is `data/islaplateu.db` (never committed to Git). The administrator is created once and then lives in the database; restarts never change its password. See [DEPLOY_RENDER.md](DEPLOY_RENDER.md) for production.

## Logging in and registering

The login page has **three separate forms** (Customer, Staff, Admin). Each keeps its own typed values, messages and loading state. Switching between them never copies or clears anything. The server checks the account's real role: credentials for one kind of account are refused by the other two forms (with a message pointing to the right form) and never create a session.

| Role | How the account is created | Logs in with | Lands on |
|---|---|---|---|
| Public visitor | no account | n/a | Introduction page, public map |
| Customer | **Create Account** (`/register`), always a customer | Customer form | Map; **My Account** |
| Restaurant Staff | **Apply for a staff account** (`/register-staff`), then administrator approval (or created directly by an administrator) | Staff form | `/staff` dashboard |
| Administrator | first-run bootstrap or `node create-user.js`. There is no public admin sign-up | Admin form | `/admin` dashboard |

### Staff applications
1. The applicant fills in the staff application: their account and contact number, the restaurant (choose one already listed, or register a new one with name, contact, municipality, barangay, address, category and description), and verification details (position and business permit / registration number).
2. The application is saved as **pending**. The staff account exists but cannot log in or reach anything staff-only.
3. In **Admin → Staff applications** the administrator reviews it and chooses **Approve** or **Reject** (each asks for confirmation; a rejection needs a reason). Approving activates the account and attaches it to the restaurant (a new restaurant record is created for new restaurants, with *no* map pin until the administrator adds one). Rejected applications are kept and can be reconsidered.
4. When the applicant tries the Staff form they see the current status: pending, rejected (with the reason) or, once approved, they log in normally.

All permissions are checked **on the server** (pages and API). Hiding a button is never the only protection.

## What is implemented

**Public:** introduction page; map; search; filters; restaurant details (address, hours, contact, description, ratings, menu); ratings are readable by everyone.
**Any signed-in user:** live location tracking with a directional arrow (GPS direction of travel or device compass, neutral dot when the direction is unknown), a Follow mode, and in-app routes (route line, distance, estimated time) on the ISLA-PLATEU map. The **Live location** and **Navigation** panels are independent and each can be minimized (tracking and routes keep running) and restored; notifications; change password.
**Customer:** reservation requests (date, time, party size, notes; capacity and duplicate checks); advance orders (prices always taken from the menu in the database); messages to a restaurant; one rating/review per restaurant; status tracking and cancellation in **My Account**.
**Restaurant staff (own restaurant only):** confirm/decline/complete reservations; accept and progress advance orders; reply to customer messages; read ratings (cannot edit or delete them); edit contact, hours, description, reservation capacity, order/reservation switches; manage the menu. Cannot add or delete restaurants or change names, categories, addresses or map pins.
**Administrator:** review staff applications (approve / reject / reconsider with confirmation); add / edit / delete restaurants with a validated, previewable map pin (deleting needs the typed name); create staff accounts directly, assign them to restaurants, disable/enable accounts, reset passwords; statistics from real data (registered accounts, active in the last 15 minutes, signed-in users, restaurants, reservations and orders by status, reviews).

## Navigation: what it depends on
Tracking uses the browser's geolocation (`watchPosition`), so the position updates as the user moves. Routes are calculated by the **server** through an OSRM routing engine (OpenStreetMap data) and drawn in the page, so users are never sent to Google Maps to navigate, and guests are refused by the server.
* By default the server uses the free **public OSRM demo server** (`https://router.project-osrm.org`): no key or account, but it is **driving only**, has fair-use limits, and is not meant for production. For production, run your own OSRM and start with `OSRM_URL=https://your-osrm-host`.
* Distance/time come from the routing engine; if it cannot be reached the panel says so and shows only a clearly labelled straight-line distance. Restaurants without a confirmed pin cannot be routed (nothing is guessed).
* Map tiles come from OpenStreetMap's public tile servers (fair-use limits apply).

## Needs configuration or extra infrastructure (not built in)
* **Email / SMS / phone calls:** customer messaging works inside the system. Phone numbers are shown as plain contact details; incoming calls and an email inbox need a telephony/email service (e.g. SMTP or a hosted provider). Reservation/order updates are in-app notifications, not emails.
* **Production hosting:** HTTPS with `COOKIE_SECURE=true`, a reverse proxy, backups of `data/`, and a production routing/tile service. Rate limits are in memory and reset on restart.
* **Rejected applicants** cannot resubmit with the same email: the administrator can use **Reconsider** on the rejected application. There is no document upload for permits; the permit number is entered as text and the administrator verifies it outside the system.
* **Password hashing** uses scrypt from Node's built-in crypto module (strong, no extra package). Login, registration and staff-application rate limits are in memory and reset on restart.
* **Review moderation:** nobody can edit or delete reviews yet; a moderation workflow would need to be designed.
* **Daily visitors** are not tracked (public map visits are anonymous).
* **Restaurant photos / menus:** none were invented. Add images in `assets/` and set the photo path in the admin form; staff enter their own menus. The hero photo on the introduction page is hot-linked from Wikimedia Commons (credited on the page); a local illustration is used if it cannot load.
* Restaurants now live in the database. `data/restaurants.json` is only used to fill an empty database the first time.
* Staff set to "accept advance orders" only appear orderable once they have at least one available menu item.

Optional settings: `PORT` (default 3000), `DB_PATH`, `COOKIE_SECURE`, `OSRM_URL`, `APPLY_LIMIT_PER_HOUR` (staff applications per connection, default 5), `ADMIN_EMAIL` / `ADMIN_PASSWORD` (used only when creating the very first administrator).

## Command-line accounts
```
node create-user.js --email admin2@example.com --name "Jane Doe" --role admin
node create-user.js --email someone@example.com --reset      # new password for an existing account
```

## Testing checklist
**Public visitor:** `/` shows the introduction page · "Enter and Explore the Map" opens `/map` without login · search/filter/details work · Navigate, Track my location, Reserve, Order, Message and Rate each show a login prompt · `/staff`, `/admin`, `/account` redirect to login.
**Customer:** sign up → log in → map · allow location → Track my location updates the dot · choose a restaurant with a pin → Navigate shows route distance and time · Stop ends tracking · deny location permission → clear message · make a reservation and an order → see them in My Account · `/admin` and `/staff` show "Access denied".
**Staff applicant:** open `/register-staff`, submit → "pending administrator review" · Staff form shows "waiting for review" and nothing staff-only opens · after the administrator approves, the Staff form logs in and `/staff` shows the restaurant · a rejected applicant sees the reason.
**Login forms:** type different values in the Customer, Staff and Admin forms and switch between them: each keeps its own values · customer details in the Staff form are refused with a pointer to the Customer form.
**Staff:** log in → `/staff` shows only their restaurant · confirm a reservation → the customer gets a notification · add a menu item · reply to a message · `/admin` is denied.
**Administrator:** `/admin` statistics · add a restaurant with a pin → appears on the public map · coordinates outside Siquijor are rejected · create a staff account (one-time password) · disable it → that user is signed out · delete a restaurant (type its name).

## Automated tests
No installation is needed. From the project folder:
```
npm test
```
runs three self-contained suites (each starts its own temporary server and database, so your data is never touched):
* `tests/applications-test.js`: login forms, registration, staff approval, authorization, persistence
* `tests/provisioning-test.js`: stable administrator provisioning and recovery, proxy-aware limits, cookies, backups/restore, map headers, graceful shutdown
* `tests/heading-test.js`: heading/arrow logic (GPS course vs compass vs screen rotation, smoothing, 359°/0° wraparound)

Older suites that need a running server: `tests/api-test.js` (security) and `tests/features-test.js` (reservations, orders, messages, reviews, admin tools; needs a mock routing server, see its header).

## Project structure
```text
ISLA-PLATEU/
├── server.js        core server: sessions, login/registration, pages, security headers
├── features.js      API: restaurants, routing, reservations, orders, messages, reviews, staff/admin tools
├── lib/db.js        database schema, safe migrations, first-run restaurant import
├── create-user.js   administrative account tool
├── scripts/         backup.js, restore.js
├── DEPLOY_RENDER.md  .env.example

├── landing.html  index.html (map, at /map)  login.html  register.html (customer)  register-staff.html  account.html  staff.html  admin.html
├── script.js  style.css      public map and navigation
├── assets/          logo, hero, shared CSS/JS (auth, app, landing, account, staff, admin, heading, tracking)
├── data/            restaurants.json (first-run seed) · islaplateu.db (created at runtime)
└── tests/
```
