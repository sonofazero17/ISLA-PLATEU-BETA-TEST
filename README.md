# ISLA-PLATEU: Restaurant Locator and Reservation System for Selected Restaurants in Siquijor

> **Deploying on Render?** Read [DEPLOY_RENDER.md](DEPLOY_RENDER.md): persistent disk, environment variables, administrator provisioning/recovery, backups, GitHub update steps.

**Flow:** Introduction page (`/`) → Public restaurant map (`/map`) → Log in / Sign up only when a feature needs an account → Role-based page.

## Run it in VS Code

1. Install **Node.js 22.13 or newer** (LTS from https://nodejs.org). Check with `node -v`.
2. Extract the ZIP with **Extract All** into an empty folder and open the folder that directly contains `server.js` in VS Code.
3. In the terminal, run `npm install` once to install Nodemailer, then `npm start`. Open **http://localhost:3000**. Stop with `Ctrl + C`.
4. **Local development only:** on a brand-new database the terminal prints a one-time administrator password. To choose your own, copy `.env.example` to `.env`, fill in `ADMIN_PASSWORD`, and start with `npm run dev`. The administrator is always `admin@islaplateu.local`.

When this repository is opened in VS Code, its auto-push task starts automatically. After 4 seconds without file edits, it stages, commits, and pushes changes on `main`; Render then deploys the pushed commit. Git's ignore rules apply, and the watcher refuses common secret, database, backup, and upload paths. Stop it with **Tasks: Terminate Task** in the Command Palette.

Nodemailer is the only npm dependency; `npm install` is required for Gmail SMTP delivery. The map, icons and fonts load from the internet. **Live Server does not work** for this project (login, roles and the database need the Node server).

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
From the project folder, run:
```
npm test
```
The script runs the self-contained integration suites against temporary databases and ports, including `tests/pagudfood-demo-test.js` for the PagudFood profile, exact menu, tables, demo QR, receipt upload and simulated staff approval. The other suites cover registration/authentication, provisioning, uploads, locations, reservations/tables, orders, payments, fees, email/CAPTCHA, slideshows, admin tools, security and end-to-end customer/staff flows. They do not use the live `data/islaplateu.db` file.

`tests/features-test.js` is an additional feature/permission test that expects a separately started fresh server and the mock routing server described in its header.

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

## Uploaded images (Phase 2)

Restaurant logos, profile/cover images and food photos are stored as files in `<folder of DB_PATH>/uploads/public`
(override with `UPLOAD_DIR`). On Render, keep this on the same persistent disk as the database, or images are lost on redeploy.
Only JPG, PNG and WEBP up to 5 MB are accepted; the real file type is checked on the server. `uploads/private` is reserved
for documents and receipts in later phases and is never served statically. Back up the uploads folder together with the database.

## Restaurant location requests (Phase 3)

Staff pin their restaurant, enter the address and contact number and upload private evidence (permit or DTI/SEC registration,
storefront photo, proof they may manage the restaurant). An administrator reviews it under **Location requests** and can mark it
under review, approve, reject (reason required) or ask for more evidence. Only an approval writes coordinates to the public
restaurant record. Documents are stored in `uploads/private`, are served only through authenticated routes (the restaurant's own
staff and administrators) and are deleted with the restaurant. Decisions and document views are recorded in the **Audit log**.

## Tables and reservation availability (Phase 4)

Staff add tables (bulk or one by one) with a name and seat count, mark each as reservable or walk-in only, and can disable a table
temporarily. A reservation holds its table for the restaurant's reservation length (default 90 minutes, configurable 30-240).
A table counts as **reserved** only for a CONFIRMED reservation; overlapping confirmed bookings on one table are refused both when
a customer asks for a table and when staff confirm (staff can pick another table, or the best-fitting free table is assigned
automatically). Customers see total, free and reserved tables and each table's seats on the map popup and details panel.
Restaurants with no tables configured keep the earlier guest-count limit.

## PagudFood Cafe demonstration seed

On a new database, and when an existing database first enables PagudFood demo mode, the app preloads the `pagudfood` restaurant record with the supplied PagudFood logo, a locally stored food cover image, nine locally stored illustrative food images, the nine menu items and their exact supplied prices, seven reservation tables (T1–T7), and a 90-minute reservation duration. Existing menu rows and existing restaurant profile edits are not overwritten. The preloaded profile is clearly identified in its description as school-project demonstration information; the supplied address is retained and no owner-verified contact details are invented. The PagudFood pin is saved as **9.2140502, 123.5119131** and is rendered by the existing Leaflet/OpenStreetMap map. Existing records without a pin are backfilled once; existing saved coordinates are preserved. The public listing pin has not been owner-confirmed.

PagudFood uses a non-scannable **DEMO PAYMENT** graphic and fictional account label/number. Restaurant staff can replace the displayed demo image from Staff > Payments > GCash QR code, and administrators can replace it from Admin > Restaurants > Overview > Payments. The payment dialog warns customers not to scan, open GCash, transfer funds, or upload real financial information. Customers can submit a mock receipt image; staff can approve or reject that submission as a simulation. Replacing the image does not enable real payments, and no real GCash API or transfer is used by the PagudFood demo.

PagudFood staff can edit the demo restaurant's public name, category, address, municipality, contact, hours, description, reservation/order switches, logo, cover image and menu through the existing Staff dashboard. Map coordinates and verification remain administrator-controlled. Changes use the same restaurant/menu database records shown to customers.

The PagudFood customer detail view uses the existing ISLA-PLATEU map marker. Selecting the profile centers the main map on its saved coordinates; no external map website is opened or required.

The menu photographs are generated illustrative demo images, not verified photographs of the actual restaurant's dishes. All menu items are preloaded as available and can be edited or disabled through Staff → Restaurant & menu.

## Cafe Infinite profile status

The Cafe Infinite profile uses the official Facebook page for contact and preserves the public post context for its Tubod location. Its map pin now uses the Google Maps business listing "Cafe Infinite - Siquijor" (Wiggle Gas, Plus Code 4GR7+R2), whose phone matches the profile and whose photos show Cafe Infinite branding. The current itemized menu/prices and dine-in hours remain unconfirmed. The one-time profile migration updates only unchanged legacy seed fields, preserving later staff edits and the verified map pin.

**Current scope note:** the existing ordering implementation supports pickup and dine-in pre-orders. Delivery checkout and its ₱40 delivery fee are not implemented in this update. The requested 5% platform service fee is also not automatically applied; the existing system's fee/tax module remains configurable by an administrator and no unverified tax is assumed. The existing reservation and receipt-upload workflows remain in place.

## Advance ordering (Phase 5)

Customers choose items with photos and quantities, pick a service (pickup, or dine-in when the restaurant offers it), choose a
date and time, and **review** a server-priced summary before placing the order. Prices always come from the database; a quote
endpoint and the order endpoint use the same pricing function. Staff accept or reject, then mark orders preparing, ready and
completed, and can cancel an accepted order with a reason the customer sees. Every step is stored in `order_status_history` and
shown to the customer as a progress tracker with history. Delivery is not supported and is deliberately not offered.

## GCash payments and receipt review (Phase 6)

Staff save their GCash account name, mobile number and QR code under **Payments**, and can require GCash payment for advance
orders and/or set a reservation fee (0 = none). The QR code and every receipt are private files in `uploads/private`, served
only to the owning customer, that restaurant's staff and administrators; customers see the name, a masked number and the QR code
only for a payment they owe. A receipt is a claim, not proof: staff must tick that they checked their own GCash records before the
server lets them accept it, and a payable order cannot be accepted (nor a payable table confirmed) until its payment is accepted.
Duplicate receipts (same image or same reference number) are blocked, a payment allows 5 attempts, every step is written to
`payment_events`, and accepted payments for cancelled orders/reservations are flagged for refund. ISLA-PLATEU never moves money:
payments go straight from the customer to the restaurant's GCash account and refunds are made by the restaurant.

## Fees and taxes (Phase 7)

No fee or tax rate is built in: until an administrator adds one, a customer pays only the restaurant's own charge. Under
**Fees & taxes** an administrator adds ISLA-PLATEU service fees and system taxes (percentage or fixed, calculated on the
restaurant's charge, the restaurant's whole total, or the service fees). A tax line must record its legal or accounting basis
and an explicit "verified" confirmation, which is asked for again whenever a tax's rate, base or status changes. Restaurants may add
their own fees or taxes under **Payments** (taxes need the staff member's confirmation). Customers always see one breakdown with
restaurant charges, government taxes and the ISLA-PLATEU service fee kept apart, plus the total payable, before they order or
reserve. Each line is rounded to the centavo and the total is the sum of the rounded lines. A payment stores a snapshot of the exact
breakdown, so later changes never alter existing payments, and an order or reservation is refused if the fees changed while the
customer was reviewing. Fees and taxes apply only when the customer pays through the system (GCash payments turned on). Every
change is audited, and the admin screen includes a calculation preview and a ledger of fees in accepted payments. The money itself
goes to the restaurant's GCash account, so settling ISLA-PLATEU fees with restaurants happens outside the app.

## Email verification and CAPTCHA (Phase 8)

**What it does.** When email delivery is configured, a new customer account or staff application receives a 6-digit code by email
(valid 10 minutes, 5 wrong guesses, stored only as a hash). The account cannot log in until the code is entered. "Send a new code"
is limited to one per minute and five per hour per account, and needs the CAPTCHA. When a CAPTCHA is configured, the token is
verified on the server with the provider for registration, staff applications, new-code requests, and logins after three failed
attempts. If the provider cannot be reached the request is refused (fail closed). Accounts created before this update can still
log in and are offered the verification from My Account. Email verification and the CAPTCHA each switch on only when configured,
and the admin Overview shows whether they are on.

**Setting up email** (environment variables; see `.env.example`):
- *Gmail:* turn on 2-Step Verification, create a Google App password, then install dependencies with `npm install` and set `MAIL_PROVIDER=gmail`, `EMAIL_USER`, `EMAIL_APP_PASSWORD`, and `MAIL_FROM`. The app uses Nodemailer with Gmail SMTP. `SMTP_USER` / `SMTP_PASS` are also accepted as aliases.
- *Password recovery:* the Forgot Password page sends a six-digit Gmail verification code (10-minute expiry, 60-second resend cooldown, five incorrect attempts). Only a successful code verification can issue the HttpOnly, short-lived authorization cookie needed to set a new password.
- *Render's free plan may block outgoing SMTP.* If Gmail SMTP cannot connect there, use an email API over HTTPS instead (`MAIL_PROVIDER=resend` or `brevo`, with an API
  key and a sender address/domain you verified with that provider), or a paid Render instance with Gmail/SMTP.
- Email format checks cannot prove an address exists; only a delivered code that the person enters does.

**Setting up the CAPTCHA** (Cloudflare Turnstile, free): in the Cloudflare dashboard open Turnstile, add a site for your domain
(add `localhost` for local testing), then set `CAPTCHA_SITE_KEY` (public) and `CAPTCHA_SECRET_KEY` (secret). `hcaptcha` and
`recaptcha` work the same way through `CAPTCHA_PROVIDER`. The page's security policy allows the provider's domains only while a
CAPTCHA is configured.

Never commit keys or passwords: set them in the host's environment settings (Render: Environment).

## Slideshow backgrounds (Phase 9)

The landing page hero and the map page banner can show rotating photos. Photos are added by an administrator under **Slideshow**
and only genuine ones are ever shown: each upload must have a description (for screen readers), a credit, a licence or permission
note, and a tick confirming the right to use it. The credit and licence are shown on the page next to the photo (with a link to
the source when given), and the upload, edit and delete actions are audited. The one built-in photo is the credited Wikimedia
Commons image the landing page already used. No logos or restaurant photos are used unless an administrator adds them with
permission; the map page keeps its normal heading until food photos are added. The slideshow fades between photos (no fade when the
visitor asks their device for reduced motion), pauses in hidden tabs, has a pause button, sits under a dark overlay so text stays
readable, never intercepts clicks, and the map and markers stay on a plain background. Photos are stored in
`uploads/public` (up to 4 MB each; compress large camera photos first). Keep the uploads folder on the persistent disk.

## Administrator oversight (Phase 10)

The Overview opens with a **Needs your attention** list (staff applications, location requests, payment receipts a restaurant has not
checked for 24 hours, refunds due, requests left unanswered for 24 hours, accounts waiting to verify their email), each with a button
to the right screen. **Monitoring** has read-only views of reservations, advance orders, payments, live table availability and menus,
with filters, search and paging. Administrators can open payment receipts (each view is recorded in the payment's verification log)
but cannot accept, reject or refund a payment: only the restaurant can check its own GCash records. Each restaurant has an
**Overview** (profile, location and evidence, staff and their email status, tables, menu, payment set-up and activity; the GCash
number, holder name and QR code are never shown). Administrators can hide or delete an inappropriate menu item or photo and remove a
restaurant's logo or cover image. **Staff & accounts** has role, status, search and email-verification filters and a "Send code"
action. The **Audit log** records every administrator action (account changes, staff creation, password resets, restaurant edits and
pins set directly, application decisions, image and menu moderation, fee settings, slideshow changes, backups and exports), never
the passwords or payment numbers, and can be filtered, paged and exported as CSV (text a spreadsheet could run as a formula is
neutralised).
