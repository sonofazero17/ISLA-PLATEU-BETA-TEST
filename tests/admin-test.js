/* Phase 10: admin oversight (monitoring, restaurant overview, attention queue, users, audit search/export). Self-contained.   Run:  node tests/admin-test.js */
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3940, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-adm-"));
const ADMIN_PW = "Admin-Test-2026";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR)/.test(k)));
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; };
async function call(j, method, p, body, extra = {}) {
  const isBin = Buffer.isBuffer(body);
  const res = await fetch(BASE + p, { method, redirect: "manual", body: body === undefined ? undefined : isBin ? body : JSON.stringify(body),
    headers: { ...(body !== undefined && !isBin ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra } });
  j.set(res.headers.get("set-cookie"));
  let data = null; if ((res.headers.get("content-type") || "").includes("json")) { try { data = await res.json(); } catch {} }
  return { status: res.status, data, res };
}
const img = {
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([200, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(200, 3)])
};

const DBFILE = path.join(dir, "t.db");
const ph = (days, hh = "19:00") => { const d = new Date(Date.now() + 8 * 3600e3 + days * 864e5); return [d.toISOString().slice(0, 10), hh]; };
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, n)]);
const sql = (fn) => { const d = new DatabaseSync(DBFILE); try { return fn(d); } finally { d.close(); } };

(async () => {
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: DBFILE, ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    const mk = async (name) => (await call(admin.j, "POST", "/api/admin/restaurants", { name, municipality: "Larena", category: "Restaurant", address: "Larena", acceptsReservations: true })).data.id;
    const alpha = await mk("Alpha Grill"), beta = await mk("Beta Cafe");
    const mkStaff = async (n, rid, name) => { const s = await call(admin.j, "POST", "/api/admin/staff", { fullName: name || "Staff " + n, email: `${n}@example.com`, restaurantId: rid }); return { ...(await login("RESTAURANT_STAFF", `${n}@example.com`, s.data.temporaryPassword)), pw: s.data.temporaryPassword }; };
    const A = await mkStaff("alpha", alpha, "=1+1+cmd|' /C calc'!A0"), B = await mkStaff("beta", beta);
    const mkCust = async (n) => { await call(jar(), "POST", "/api/register", { fullName: n + " Customer", email: `${n}@example.com`, password: "Island2026", confirmPassword: "Island2026" }); return (await login("CUSTOMER", `${n}@example.com`, "Island2026")).j; };
    const C1 = await mkCust("cara"), C2 = await mkCust("dan"), anon = jar();
    const get = (p, j = admin.j) => call(j, "GET", p);

    /* ---- permissions on every new route ---- */
    const routes = [["GET", "/api/admin/reservations"], ["GET", "/api/admin/orders"], ["GET", "/api/admin/payments"], ["GET", "/api/admin/tables-overview"], ["GET", "/api/admin/menus"], [ "GET", `/api/admin/restaurants/${alpha}/menu`], ["GET", `/api/admin/restaurants/${alpha}/overview`], ["GET", "/api/admin/attention"],
      ["GET", "/api/admin/audit-search"], ["GET", "/api/admin/audit-export"], ["PATCH", "/api/admin/menu/1", { available: false }], ["DELETE", "/api/admin/menu/1", {}], ["POST", "/api/admin/users/1/resend-verification", {}], ["GET", "/api/admin/users"]];
    for (const [m, p, b] of routes) ok((await call(anon, m, p, b)).status === 401 && (await call(C1, m, p, b)).status === 403 && (await call(A.j, m, p, b)).status === 403, `${m} ${p}: guests 401, customers and staff 403`);

    /* ---- seed realistic data ---- */
    const food = async (j, name, price) => (await call(j, "POST", "/api/staff/menu", { name, price, category: "Main dish" })).data.id;
    const tuna = await food(A.j, "Grilled Tuna", 200), rice = await food(A.j, "Garlic Rice", 40); await food(B.j, "Iced Tea", 60);
    await call(A.j, "POST", `/api/staff/menu/${tuna}/image`, png(1), { "Content-Type": "image/png" });
    await call(A.j, "PATCH", `/api/staff/menu/${rice}`, { available: false });
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true });
    await call(A.j, "POST", "/api/staff/tables/bulk", { count: 3, capacity: 4 });
    await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567" });
    await call(A.j, "POST", "/api/staff/payment-account/qr", png(2), { "Content-Type": "image/png" });
    await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: true, reservationFee: 0 });
    const [D, T] = ph(2, "12:00"), [RD] = ph(3);
    const o1 = (await call(C1, "POST", "/api/orders", { restaurantId: alpha, pickupDate: D, pickupTime: T, items: [{ menuItemId: tuna, qty: 2 }] })).data;
    const o2 = (await call(C2, "POST", "/api/orders", { restaurantId: alpha, pickupDate: D, pickupTime: "13:00", items: [{ menuItemId: tuna, qty: 1 }] })).data;
    const proof = (j, id, n, ref, amt) => call(j, "POST", `/api/payments/${id}/proof?reference=${ref}&amount=${amt}`, png(n), { "Content-Type": "image/png" });
    await proof(C1, o1.paymentId, 10, "ADMINREF0001", 400);
    const r1 = (await call(C1, "POST", "/api/reservations", { restaurantId: alpha, date: RD, time: "19:00", partySize: 2 })).data, r2 = (await call(C2, "POST", "/api/reservations", { restaurantId: alpha, date: RD, time: "20:00", partySize: 3 })).data;
    await call(A.j, "PATCH", `/api/staff/reservations/${r1.id}`, { status: "CONFIRMED" });
    const rb = (await call(C1, "POST", "/api/reservations", { restaurantId: beta, date: RD, time: "18:00", partySize: 2 })).data;

    /* ---- reservations monitor ---- */
    const rv = (await get("/api/admin/reservations")).data;
    ok(rv.total === 3 && rv.rows.length === 3 && rv.counts.CONFIRMED === 1 && rv.counts.PENDING === 2 && rv.rows.some(v => v.id === r1.id && v.tableLabel && v.status === "CONFIRMED" && v.customerEmail === "cara@example.com"), "reservation monitor lists every reservation with customer, table and status, plus counts");
    ok((await get(`/api/admin/reservations?restaurantId=${beta}`)).data.rows.length === 1 && (await get("/api/admin/reservations?status=confirmed")).data.rows.length === 1 && (await get("/api/admin/reservations?status=all")).data.total === 3, "filters: restaurant and status");
    ok((await get("/api/admin/reservations?q=dan")).data.rows.every(v => v.customerName.includes("dan")) && (await get("/api/admin/reservations?q=Beta")).data.rows.length === 1, "search by customer and by restaurant name");
    ok((await get(`/api/admin/reservations?from=${RD}&to=${RD}`)).data.total === 3 && (await get("/api/admin/reservations?from=2001-01-01&to=2001-12-31")).data.total === 0, "date range filter");
    ok((await get("/api/admin/reservations?from=nope")).status === 400, "a malformed date is rejected");
    const pg = (await get("/api/admin/reservations?limit=2&page=2")).data;
    ok(pg.rows.length === 1 && pg.pages === 2 && pg.total === 3, "paging works");
    ok((await get("/api/admin/reservations?q=%25")).data.total === 0 && (await get("/api/admin/reservations?q=_")).data.total === 0, "wildcard characters in a search are taken literally");
    const inj = await get("/api/admin/reservations?q=" + encodeURIComponent("' OR 1=1 --") + "&status=" + encodeURIComponent("x' OR '1'='1"));
    ok(inj.status === 200 && inj.data.total === 0, "SQL injection attempts in search or status match nothing and cause no error");
    sql(d => d.prepare("UPDATE reservations SET created_at = datetime('now', '-30 hours') WHERE id = ?").run(r2.id));
    ok((await get("/api/admin/reservations")).data.rows.find(v => v.id === r2.id).stale === true && (await get("/api/admin/reservations")).data.rows.find(v => v.id === r1.id).stale === false, "an unanswered request older than 24 hours is flagged");

    /* ---- orders monitor ---- */
    const od = (await get("/api/admin/orders")).data;
    ok(od.total === 2 && od.rows.find(o => o.id === o1.id).items === "2 x Grilled Tuna" && od.rows.find(o => o.id === o1.id).total === 400 && od.rows.find(o => o.id === o1.id).payment.status === "UNDER_REVIEW" && od.rows.find(o => o.id === o1.id).fulfillment === "PICKUP", "order monitor shows items, total, fulfilment and payment status");
    ok((await get("/api/admin/orders?status=pending")).data.total === 2 && (await get(`/api/admin/orders?q=cara`)).data.total === 1 && (await get(`/api/admin/orders?restaurantId=${beta}`)).data.total === 0 && od.counts.PENDING === 2, "order filters and counts");

    /* ---- payments monitor ---- */
    const pm = (await get("/api/admin/payments")).data;
    ok(pm.total === 2 && pm.rows[0].status === "UNDER_REVIEW" && pm.rows[0].latest.reference === "ADMINREF0001" && pm.rows[0].attempts === 1 && pm.rows[0].label === `Order #${o1.id}` && pm.rows[0].customerEmail === "cara@example.com", "payment monitor puts receipts under review first, with reference and attempts");
    ok((await get("/api/admin/payments?q=ADMINREF")).data.total === 1 && (await get("/api/admin/payments?status=awaiting_proof")).data.total === 1 && (await get("/api/admin/payments?kind=RESERVATION")).data.total === 0 && pm.counts.UNDER_REVIEW === 1, "search by reference, status and kind filters, counts");
    ok(pm.rows[0].waitingTooLong === false, "a fresh receipt is not flagged");
    sql(d => d.prepare("UPDATE payment_submissions SET created_at = datetime('now', '-30 hours')").run());
    ok((await get("/api/admin/payments")).data.rows[0].waitingTooLong === true, "a receipt the restaurant has not checked for 24 hours is flagged");
    const payId = pm.rows[0].id;
    ok((await call(admin.j, "POST", `/api/staff/payments/${payId}/decision`, { decision: "ACCEPTED", verified: true })).status === 403 && (await call(admin.j, "POST", `/api/staff/payments/${payId}/refund`, { note: "x" })).status === 403, "administrators cannot accept, reject or refund payments (only the restaurant can check its GCash records)");
    const rcp = await fetch(BASE + `/api/payments/${payId}/receipt`, { headers: { Cookie: admin.j.get() } });
    ok(rcp.status === 200 && /no-store/.test(rcp.headers.get("cache-control")), "an administrator can open a receipt (private, no-store)");
    ok((await get("/api/staff/payments?filter=all", A.j)).data.payments.find(p => p.id === payId).events.some(e => e.action === "receipt.viewed" && e.by === "System Administrator"), "…and the restaurant's verification log records that the administrator viewed it");

    /* ---- tables overview ---- */
    const tv = (await get("/api/admin/tables-overview")).data, ta = tv.find(r => r.id === alpha), tb = tv.find(r => r.id === beta);
    ok(ta.summary.total === 3 && ta.summary.seats === 12 && ta.upcomingConfirmed === 1 && ta.pendingRequests === 1 && ta.tables.length === 3 && ta.reservationMinutes === 90, "table overview: counts, seats, upcoming confirmed bookings and pending requests per restaurant");
    ok(tb.summary === null && tb.pendingRequests === 1, "a restaurant with no tables shows no summary");

    /* ---- menus ---- */
    const mn = (await get("/api/admin/menus")).data, ma = mn.find(r => r.id === alpha);
    ok(ma.items === 2 && ma.available === 1 && ma.withImages === 1 && ma.categories === 1 && ma.ordersEnabled === true, "menu overview: items, available, with photos, categories");
    const ml = (await get(`/api/admin/restaurants/${alpha}/menu`)).data;
    ok(ml.items.length === 2 && ml.items.find(i => i.id === tuna).image && ml.restaurant.name === "Alpha Grill", "an administrator can see a restaurant's whole menu");
    ok((await call(admin.j, "PATCH", `/api/admin/menu/${tuna}`, { available: "no" })).status === 400 && (await call(admin.j, "PATCH", "/api/admin/menu/99999", { available: false })).status === 404, "menu moderation validates its input");
    ok((await call(admin.j, "PATCH", `/api/admin/menu/${tuna}`, { available: false })).status === 200 && (await get(`/api/restaurants/${alpha}`, anon)).data.menu.find(i => i.id === tuna).available === false, "an administrator can hide an item (it shows as unavailable to customers)");
    await call(admin.j, "PATCH", `/api/admin/menu/${tuna}`, { available: true });
    const priv0 = fs.readdirSync(path.join(dir, "uploads", "public")).length;
    ok((await call(admin.j, "DELETE", `/api/admin/menu/${rice}`, {})).status === 200 && (await get(`/api/admin/restaurants/${alpha}/menu`)).data.items.length === 1, "an administrator can delete an inappropriate item");
    ok(fs.readdirSync(path.join(dir, "uploads", "public")).length === priv0, "(deleting an item without a photo leaves other photos alone)");

    /* ---- restaurant overview ---- */
    sql(d => d.prepare("UPDATE users SET email_verified = 1 WHERE email = 'alpha@example.com'").run());
    const ov = await get(`/api/admin/restaurants/${alpha}/overview`);
    const ovText = JSON.stringify(ov.data);
    ok(ov.status === 200 && ov.data.restaurant.name === "Alpha Grill" && ov.data.staff.length === 1 && ov.data.staff[0].emailVerified === true && ov.data.tables.total === 3 && ov.data.menu.items === 1 && ov.data.menu.withImages === 1, "restaurant overview: profile, staff with verification, tables, menu");
    ok(ov.data.payments.gcashConfigured === true && ov.data.payments.orderPrepay === true && ov.data.payments.UNDER_REVIEW === 1 && ov.data.activity.orders.PENDING === 2 && ov.data.activity.reservations.CONFIRMED === 1 && ov.data.location === null, "…payment set-up, payment and booking counts, no location request yet");
    ok(!ovText.includes("09171234567") && !ovText.includes("Juan Dela Cruz") && !/qr_file|qrUrl/.test(ovText), "the overview never shows the GCash number, holder name or QR code");
    ok((await get("/api/admin/restaurants/nope/overview")).status === 404, "unknown restaurant = 404");

    /* ---- attention queue ---- */
    const app = (email) => call(jar(), "POST", "/api/staff-applications", { fullName: "Pia Owner", email, contactNumber: "09171234567", password: "Island2026", confirmPassword: "Island2026", restaurantMode: "new", restaurantName: "Grill " + email.split("@")[0], restaurantContact: "09181234567", restaurantAddress: "Poblacion, Larena", municipality: "Larena", barangay: "Poblacion", category: "Restaurant", description: "A small grill serving local dishes.", position: "Owner", permitNumber: "BP-1", note: "" }, { "X-Forwarded-For": "10.0.0." + Math.floor(Math.random() * 200 + 10) });
    ok((await app("pia@example.com")).status === 201 && (await app("quin@example.com")).status === 201 && (await app("rey@example.com")).status === 201, "(setup) three staff applications");
    const loc = (await call(A.j, "POST", "/api/staff/location-requests", { lat: 9.2, lng: 123.52, address: "Poblacion, Larena", contactPhone: "0917 123 4567", businessContact: "x" })).data.id;
    for (const [k, n] of [["DTI_SEC", 3], ["STOREFRONT_PHOTO", 4], ["AUTHORIZATION", 5]]) await call(A.j, "POST", `/api/staff/location-requests/${loc}/documents?kind=${k}&name=f.png`, png(n), { "Content-Type": "application/octet-stream" });
    await call(A.j, "POST", `/api/staff/location-requests/${loc}/submit`, {});
    sql(d => d.prepare("UPDATE users SET verification_required = 1, email_verified = 0 WHERE email IN ('cara@example.com','dan@example.com')").run());
    const at = (await get("/api/admin/attention")).data, by = Object.fromEntries(at.items.map(i => [i.key, i.count]));
    ok(by.applications === 3 && by.locations === 1 && by.payments === 1 && by.reservations === 1 && by.orders === 0 && by.verify === 2 && at.total === by.applications + by.locations + by.payments, "attention queue counts what needs the administrator: applications, location requests, stale receipts, old requests, unverified accounts");
    ok(at.items.every(i => i.tab && typeof i.urgent === "boolean"), "each item says which screen to open");
    const loc2 = (await get("/api/admin/restaurants/" + alpha + "/overview")).data.location;
    ok(loc2 && loc2.status === "PENDING" && loc2.documents === 3 && loc2.documentKinds.includes("DTI_SEC"), "the restaurant overview shows the latest location request and its evidence");

    /* ---- users ---- */
    const us = (await get("/api/admin/users")).data;
    ok(us.total >= 6 && us.users.every(u => typeof u.emailVerified === "boolean" && typeof u.verificationRequired === "boolean") && !JSON.stringify(us).includes("password"), "user list includes email-verification status and no password data");
    ok(us.counts.waiting === 2 && us.counts.verified >= 1, "user counts: verified, not verified, waiting to verify");
    ok((await get("/api/admin/users?verified=waiting")).data.users.length === 2 && (await get("/api/admin/users?verified=yes")).data.users.every(u => u.emailVerified) && (await get("/api/admin/users?verified=no")).data.users.every(u => !u.emailVerified), "verification filters");
    ok((await get("/api/admin/users?role=customer")).data.users.every(u => u.role === "CUSTOMER") && (await get("/api/admin/users?q=beta")).data.users.some(u => u.email === "beta@example.com") && (await get("/api/admin/users?status=active")).data.users.every(u => u.status === "ACTIVE"), "role, search and status filters");
    ok((await get("/api/admin/users?limit=2&page=2")).data.users.length === 2, "paging");
    ok((await get("/api/admin/users?q=" + encodeURIComponent("' OR 1=1 --"))).data.users.length === 0, "SQL injection in the user search matches nothing");
    const cid = us.users.find(u => u.email === "cara@example.com").id;
    ok((await call(admin.j, "POST", `/api/admin/users/${cid}/resend-verification`, {})).status === 503 && (await call(admin.j, "POST", "/api/admin/users/99999/resend-verification", {})).status === 404, "resending a code needs email delivery to be set up, and a real account");

    /* ---- every administrator action is audited ---- */
    const bid = us.users.find(u => u.email === "beta@example.com").id;
    await call(admin.j, "PATCH", `/api/admin/users/${bid}`, { status: "DISABLED" }); await call(admin.j, "PATCH", `/api/admin/users/${bid}`, { status: "ACTIVE" });
    const reset = await call(admin.j, "POST", `/api/admin/users/${bid}/reset-password`, {});
    const newStaff = await call(admin.j, "POST", "/api/admin/staff", { fullName: "New Staff", email: "newstaff@example.com", restaurantId: beta });
    await call(admin.j, "PUT", `/api/admin/restaurants/${beta}`, { name: "Beta Cafe", lat: 9.15, lng: 123.55 });
    const apps = (await get("/api/admin/applications?status=pending")).data.applications, ids = Object.fromEntries(apps.map(a => [a.applicantEmail, a.id]));
    await call(admin.j, "POST", `/api/admin/applications/${ids["pia@example.com"]}/approve`, { confirm: true });
    await call(admin.j, "POST", `/api/admin/applications/${ids["quin@example.com"]}/reject`, { note: "Incomplete", confirm: true });
    await call(admin.j, "POST", `/api/admin/applications/${ids["quin@example.com"]}/reopen`, { confirm: true });
    await call(admin.j, "DELETE", `/api/admin/restaurants/${alpha}/logo`, {});
    await call(admin.j, "DELETE", `/api/admin/menu/${tuna}/image`, {});
    await fetch(BASE + "/api/admin/backup", { headers: { Cookie: admin.j.get() } });
    const au = (await get("/api/admin/audit-search?limit=200")).data, acts = au.entries.map(e => e.action);
    for (const a of ["restaurant.created", "restaurant.updated", "user.staff_created", "user.updated", "user.password_reset", "application.approved", "application.rejected", "application.reopened", "restaurant_image.removed", "menu_image.removed", "menu_item.hidden", "menu_item.deleted", "backup.downloaded"]) ok(acts.includes(a), `audited: ${a}`);
    const alltext = JSON.stringify(au.entries);
    ok(!alltext.includes(reset.data.temporaryPassword) && !alltext.includes(newStaff.data.temporaryPassword) && !alltext.includes(A.pw) && !alltext.includes("09171234567"), "no password or GCash number ever appears in the audit log");
    const upd = au.entries.find(e => e.action === "restaurant.updated" && e.targetId === beta);
    ok(upd && /"pin"/.test(upd.detail) && /9.15/.test(upd.detail), "a pin set directly by an administrator is recorded with its coordinates");
    ok(au.entries.find(e => e.action === "user.updated").detail.includes("DISABLED") || au.entries.filter(e => e.action === "user.updated").some(e => e.detail.includes("DISABLED")), "account status changes record before and after");
    ok(au.entries[0].actor === "System Administrator", "each entry names the administrator");

    /* ---- audit search ---- */
    ok(au.actions.includes("user.updated") && au.actions.includes("restaurant.created"), "the search returns the list of actions for the filter menu");
    ok((await get("/api/admin/audit-search?action=application")).data.entries.every(e => e.action.startsWith("application.")) && (await get("/api/admin/audit-search?action=application")).data.entries.length === 3, "filter by action prefix");
    ok((await get("/api/admin/audit-search?actor=Administrator")).data.entries.length > 5 && (await get("/api/admin/audit-search?actor=nobody-here")).data.entries.length === 0, "filter by who did it");
    ok((await get("/api/admin/audit-search?targetType=menu_item")).data.entries.every(e => e.targetType === "menu_item") && (await get("/api/admin/audit-search?q=Beta")).data.entries.length >= 1, "filter by target type and free text");
    const today = ph(0)[0];
    ok((await get(`/api/admin/audit-search?from=${today}&to=${today}`)).data.entries.length > 5 && (await get("/api/admin/audit-search?from=2001-01-01&to=2001-01-02")).data.entries.length === 0 && (await get("/api/admin/audit-search?from=bad")).status === 400, "date filters, and a bad date is rejected");
    const p1 = (await get("/api/admin/audit-search?limit=5")).data, p2 = (await get(`/api/admin/audit-search?limit=5&before=${p1.nextBefore}`)).data;
    ok(p1.entries.length === 5 && p1.nextBefore && p2.entries.length === 5 && p2.entries[0].id < p1.entries[4].id && !p2.actions, "paging with a cursor: older entries follow without overlap");
    ok((await get("/api/admin/audit-search?q=" + encodeURIComponent("%'; DROP TABLE admin_audit_logs;--"))).status === 200 && (await get("/api/admin/audit-search?limit=1")).data.entries.length === 1, "SQL injection in the audit search is harmless");

    /* ---- audit export ---- */
    const ex = await fetch(BASE + "/api/admin/audit-export?action=application", { headers: { Cookie: admin.j.get() } }), csv = await ex.text();
    ok(ex.status === 200 && /text\/csv/.test(ex.headers.get("content-type")) && /attachment/.test(ex.headers.get("content-disposition")), "the audit log can be exported as a CSV file");
    ok(csv.replace("\ufeff", "").split("\r\n")[0] === "id,when,actor,action,target type,target,details" && csv.split("\r\n").length === 4, "the CSV has a header and one row per matching entry");
    const exAll = await (await fetch(BASE + "/api/admin/audit-export?actor=cmd", { headers: { Cookie: admin.j.get() } })).text();
    ok(exAll.split("\r\n").length > 1 && !/(^|,)"=1\+1/.test(exAll) && /"'=1\+1\+cmd/.test(exAll), "text that a spreadsheet could run as a formula is neutralised in the export");
    ok((await get("/api/admin/audit-search?action=audit.exported")).data.entries.length >= 2, "exporting the audit log is itself recorded");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
