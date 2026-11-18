/* Phase 11: security sweep (permission matrix over every route, CSRF, exposure, headers, hostile input, isolation, sessions, secrets). Self-contained.   Run:  node tests/security-test.js */
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto"), http = require("node:http");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3941, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-sec-"));
const ADMIN_PW = "Security-Test-2026";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR)/.test(k)));
let ipN = 1000;
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; };
async function call(j, method, p, body, extra = {}) {
  const isBin = Buffer.isBuffer(body);
  const res = await fetch(BASE + p, { method, redirect: "manual", body: body === undefined ? undefined : isBin ? body : JSON.stringify(body),
    headers: { "X-Forwarded-For": `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${++ipN & 255}`, ...(body !== undefined && !isBin ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra } });
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
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, n)]);
const rawReq = (method, p, headers = {}, body) => new Promise((res) => { const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: { "X-Forwarded-For": "10.250.0." + (++ipN & 255), ...headers } }, (x) => { let b = ""; x.on("data", d => b += d); x.on("end", () => res({ status: x.statusCode, headers: x.headers, body: b })); }); r.on("error", (e) => res({ status: 0, error: e.code, body: "", headers: {} })); if (body) r.write(body); r.end(); });

(async () => {
  const base = { ...CLEAN, PORT: String(PORT), DB_PATH: DBFILE, ADMIN_PASSWORD: ADMIN_PW, TRUST_PROXY_HOPS: "1" };
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: base });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    const mkRest = async (name) => (await call(admin.j, "POST", "/api/admin/restaurants", { name, municipality: "Larena", category: "Restaurant", address: "Larena", acceptsReservations: true })).data.id;
    const alpha = await mkRest("Alpha Grill"), beta = await mkRest("Beta Cafe");
    const mkStaff = async (n, rid) => { const s = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff " + n, email: `${n}@example.com`, restaurantId: rid }); return login("RESTAURANT_STAFF", `${n}@example.com`, s.data.temporaryPassword); };
    const A = await mkStaff("alpha", alpha), B = await mkStaff("beta", beta);
    const mkCust = async (n) => { await call(jar(), "POST", "/api/register", { fullName: n + " Customer", email: `${n}@example.com`, password: "Island2026", confirmPassword: "Island2026" }); return (await login("CUSTOMER", `${n}@example.com`, "Island2026")).j; };
    const C1 = await mkCust("cara"), C2 = await mkCust("dan"), anon = jar();

    /* ================= 1. permission matrix over EVERY route ================= */
    const { openDatabase } = require(path.join(ROOT, "lib", "db.js"));
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-rt-")), rdb = openDatabase(path.join(rdir, "r.db"), ROOT);
    const feats = require(path.join(ROOT, "features.js"))({ db: rdb, json() {}, readJson() {}, hashPassword() {}, verifyPassword() {}, crypto, ROLES: {}, send() {}, isReservedEmail() {}, verification: { enabled() { return false; } }, captcha: {}, mailer: { describe() { return {}; } }, dbPath: path.join(rdir, "r.db"), storage: {}, sessionHash() {}, clientIp() { return "x"; } });
    const table = feats.routeTable(); rdb.close(); fs.rmSync(rdir, { recursive: true, force: true });
    ok(table.length > 100, `route table read from the code: ${table.length} routes`);
    const ids = { guest: anon, CUSTOMER: C1, RESTAURANT_STAFF: A.j, ADMINISTRATOR: admin.j };
    const allowedFor = (roles, who) => roles == null ? true : roles === "ANY" ? who !== "guest" : who !== "guest" && roles.includes(who);
    const problems = [], serverErrors = [], statuses = {};
    for (const rt of table) {
      const p = rt.pattern.replace(/:([a-zA-Z]+)/g, "999999");
      for (const [who, j] of Object.entries(ids)) {
        const r = await call(j, rt.method, p, rt.method === "GET" ? undefined : {});
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (r.status >= 500) serverErrors.push(`${who} ${rt.method} ${p} -> ${r.status}`);
        if (allowedFor(rt.roles, who)) { if (r.status === 401 || r.status === 403) problems.push(`${who} was blocked from ${rt.method} ${p} (${r.status})`); }
        else if (r.status !== (who === "guest" ? 401 : 403)) problems.push(`${who} reached ${rt.method} ${p} (${r.status}, expected ${who === "guest" ? 401 : 403})`);
      }
    }
    ok(problems.length === 0, `permission matrix: ${table.length} routes x 4 identities (${table.length * 4} requests) behave exactly as declared` + (problems.length ? " | " + problems.slice(0, 6).join(" ; ") : ""));
    ok(serverErrors.length === 0, "none of those requests caused a server error (5xx)" + (serverErrors.length ? " | " + serverErrors.slice(0, 6).join(" ; ") : ""));
    const publicRoutes = table.filter(r => r.roles == null).map(r => `${r.method} ${r.pattern}`).sort();
    const expectedPublic = ["GET /api/restaurants", "GET /api/restaurants/:id", "GET /api/restaurants/:id/reservation-quote", "GET /api/restaurants/:id/tables", "GET /api/slides", "POST /api/staff-applications"].sort();
    ok(JSON.stringify(publicRoutes) === JSON.stringify(expectedPublic), "the list of routes open to guests is exactly the reviewed allow-list" + (JSON.stringify(publicRoutes) === JSON.stringify(expectedPublic) ? "" : " | " + publicRoutes.join(", ")));

    /* ================= 2. cross-site requests are refused on every state-changing route ================= */
    const csrfBad = [];
    for (const rt of table.filter(r => r.method !== "GET")) {
      const who = rt.roles == null || rt.roles === "ANY" ? "ADMINISTRATOR" : rt.roles[0], p = rt.pattern.replace(/:([a-zA-Z]+)/g, "999999");
      const r = await call(ids[who], rt.method, p, {}, { Origin: "https://evil.example" });
      if (r.status !== 403 || !/cross-site/i.test(JSON.stringify(r.data))) csrfBad.push(`${rt.method} ${p} -> ${r.status}`);
    }
    ok(csrfBad.length === 0, `a request from another website is refused on all ${table.filter(r => r.method !== "GET").length} state-changing routes` + (csrfBad.length ? " | " + csrfBad.slice(0, 5).join(" ; ") : ""));
    const csrfBuiltin = [];
    for (const [p, b] of [["/api/login", { portal: "CUSTOMER", email: "a@b.co", password: "x" }], ["/api/register", {}], ["/api/logout", {}], ["/api/verify-email", {}], ["/api/resend-verification", {}]]) { const r = await call(anon, "POST", p, b, { Origin: "https://evil.example" }); if (r.status !== 403) csrfBuiltin.push(p + " " + r.status); }
    ok(csrfBuiltin.length === 0, "login, registration, logout and verification also refuse other websites");

    /* ================= 3. files that must never be reachable ================= */
    const secrets = ["/server.js", "/features.js", "/package.json", "/lib/db.js", "/lib/mailer.js", "/lib/verification.js", "/tests/auth-test.js", "/.env", "/.env.example", "/.git/config", "/.gitignore", "/data/", "/data/restaurants.json", "/data/isla.db", "/DEPLOY_RENDER.md", "/README.md", "/scripts/backup.js", "/create-user.js", "/uploads/", "/uploads/private/x.png", "/node_modules/", "/assets/", "/lib/",
      "/../server.js", "/%2e%2e/server.js", "/assets/../server.js", "/assets/%2e%2e/server.js", "/assets/..%2fserver.js", "/%5c..%5cserver.js", "/assets/..%5cserver.js", "/uploads/public/../../server.js", "/uploads/public/%2e%2e%2fserver.js", "/uploads/public/..%2f..%2fdata%2ft.db", "/server.js%00.html", "//server.js", "/./server.js"];
    const leaked = [];
    for (const p of secrets) { const r = await rawReq("GET", p); const harmless = [400, 403, 404].includes(r.status) || (r.status === 200 && /^\s*<!doctype html/i.test(r.body)); if (!harmless || /createServer|scryptSync|CREATE TABLE|ADMIN_PASSWORD|SQLite format/.test(r.body)) leaked.push(`${p} -> ${r.status}`); }
    ok(leaked.length === 0, `${secrets.length} attempts to read source code, config, database or private files (including path tricks) all fail` + (leaked.length ? " | " + leaked.join(" ; ") : ""));
    const dbBytes = fs.readFileSync(DBFILE).subarray(0, 15).toString();
    ok(dbBytes.startsWith("SQLite format") && (await rawReq("GET", "/" + path.basename(DBFILE))).status === 404, "the database file exists on disk but is not downloadable");

    /* ================= 4. security headers and cookies ================= */
    const pages = ["/", "/map", "/login", "/register", "/register-staff", "/account", "/staff", "/admin", "/api/restaurants", "/api/config", "/nothing-here", "/assets/common.js"];
    const headerBad = [];
    for (const p of pages) {
      const r = await rawReq("GET", p), h = r.headers, csp = h["content-security-policy"] || "";
      if (h["x-content-type-options"] !== "nosniff") headerBad.push(p + ": nosniff");
      if (!/frame-ancestors 'none'/.test(csp) || !/default-src 'self'/.test(csp)) headerBad.push(p + ": CSP base");
      if (/unsafe-eval/.test(csp) || /script-src[^;]*unsafe-inline/.test(csp)) headerBad.push(p + ": CSP allows inline/eval scripts");
      if (!h["referrer-policy"]) headerBad.push(p + ": referrer-policy");
      if (h["x-powered-by"] || h["server"]) headerBad.push(p + ": reveals server software");
      if (p.startsWith("/api/") && !/no-store/.test(h["cache-control"] || "")) headerBad.push(p + ": API cacheable");
    }
    ok(headerBad.length === 0, `security headers present on ${pages.length} kinds of response` + (headerBad.length ? " | " + headerBad.join(" ; ") : ""));
    const lg = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.77.0.1" }, body: JSON.stringify({ portal: "CUSTOMER", email: "cara@example.com", password: "Island2026" }) });
    const sc = lg.headers.get("set-cookie") || "";
    ok(/HttpOnly/i.test(sc) && /SameSite=(Lax|Strict)/i.test(sc) && /Path=\//i.test(sc), "the session cookie is HttpOnly and SameSite");
    const tok = /isla_sid=([^;]+)/.exec(sc)[1];
    const dbTok = new (require("node:sqlite").DatabaseSync)(DBFILE); const sess = dbTok.prepare("SELECT token_hash FROM sessions").all(); dbTok.close();
    ok(sess.length > 0 && sess.every(s => s.token_hash !== tok && !JSON.stringify(sess).includes(tok)), "session tokens are stored only as hashes");
    const dbPw = new (require("node:sqlite").DatabaseSync)(DBFILE); const pw = dbPw.prepare("SELECT password_hash FROM users WHERE email = 'cara@example.com'").get().password_hash; dbPw.close();
    ok(!pw.includes("Island2026") && pw.length > 40, "passwords are stored only as salted hashes");

    /* production mode: HTTPS-only header, and no administrator password is ever generated or printed */
    const PROD_PORT = PORT + 100, prodEnv = { ...base, PORT: String(PROD_PORT), NODE_ENV: "production", DB_PATH: path.join(dir, "prod.db") }; delete prodEnv.ADMIN_PASSWORD;
    const prod = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: prodEnv });
    let pout = ""; prod.stdout.on("data", d => pout += d); prod.stderr.on("data", d => pout += d);
    for (let i = 0; i < 60 && !/running at/.test(pout); i++) await new Promise(r => setTimeout(r, 150));
    const prodHome = await new Promise((res) => http.get({ host: "127.0.0.1", port: PROD_PORT, path: "/" }, (x) => { x.resume(); res(x.headers); }));
    ok(/max-age=\d+/.test(prodHome["strict-transport-security"] || ""), "production mode sends the HTTPS-only (HSTS) header");
    prod.kill("SIGKILL"); await new Promise(r => setTimeout(r, 200));
    const pd = new (require("node:sqlite").DatabaseSync)(path.join(dir, "prod.db")); const adminsMade = pd.prepare("SELECT COUNT(*) AS n FROM users").get().n; pd.close();
    ok(/ADMIN_PASSWORD is not set/.test(pout) && !/Local development/.test(pout) && adminsMade === 0, "production with no ADMIN_PASSWORD creates no administrator and prints no password (it only warns)");

    /* ================= 5. hostile input ================= */
    const m1 = await rawReq("TRACE", "/"), m2 = await rawReq("OPTIONS", "/api/restaurants"), m3 = await rawReq("PUT", "/"), m4 = await rawReq("DELETE", "/api/restaurants");
    ok([400, 404, 405, 501].includes(m1.status) && !/TRACE/.test(m1.body) && m2.status !== 500 && m3.status !== 200 && m4.status !== 200, "unexpected HTTP methods are not honoured");
    ok((await rawReq("POST", "/api/login", { "Content-Type": "application/json" }, "{not json")).status === 400, "malformed JSON is a clean 400");
    const bigJson = JSON.stringify({ portal: "CUSTOMER", email: "a@b.co", password: "x".repeat(50000) });
    ok((await rawReq("POST", "/api/login", { "Content-Type": "application/json" }, bigJson)).status === 413, "an oversized JSON body that arrives in chunks gets a clear 413 reply (not a dropped connection)");
    ok((await rawReq("POST", "/api/login", { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bigJson) }, bigJson)).status === 413, "…and so does one that announces its size up front");
    const bigImg = Buffer.concat([png(1), Buffer.alloc(6 * 1024 * 1024)]);
    ok((await rawReq("POST", "/api/staff/restaurant/logo", { "Content-Type": "image/png", Cookie: A.j.get() }, bigImg)).status === 413, "a streamed upload over the size limit also gets a clear 413 reply");
    ok((await rawReq("GET", "/" + "a".repeat(20000))).status !== 500 && (await rawReq("GET", "/")).status === 200, "a 20,000-character URL does not hurt the server");
    ok((await rawReq("POST", "/api/login", { "Content-Type": "application/json" }, JSON.stringify([1, 2, 3]))).status === 400 && (await rawReq("POST", "/api/login", { "Content-Type": "application/json" }, "null")).status === 400, "JSON that is not an object is refused");
    const before = (n) => { const d = new (require("node:sqlite").DatabaseSync)(DBFILE); const c = d.prepare("SELECT COUNT(*) AS n FROM " + n).get().n; d.close(); return c; };
    const usersBefore = before("users");
    const reg = await call(jar(), "POST", "/api/register", JSON.parse('{"fullName":"Mallory","email":"mallory@example.com","password":"Island2026","confirmPassword":"Island2026","role":"ADMINISTRATOR","status":"ACTIVE","emailVerified":true,"email_verified":1,"restaurantId":"alpha-grill","__proto__":{"role":"ADMINISTRATOR"},"constructor":{"prototype":{"isAdmin":true}}}'));
    ok(reg.status === 201 && ({}).role === undefined && ({}).isAdmin === undefined, "prototype-pollution keys in a request do nothing");
    ok((await call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: "mallory@example.com", password: "Island2026" })).status !== 200 && (await call(jar(), "POST", "/api/login", { portal: "CUSTOMER", email: "mallory@example.com", password: "Island2026" })).data.user.role === "CUSTOMER", "extra fields cannot make a new account an administrator (mass assignment)");
    const dm = new (require("node:sqlite").DatabaseSync)(DBFILE); const mrow = dm.prepare("SELECT role, restaurant_id, email_verified FROM users WHERE email = 'mallory@example.com'").get(); dm.close();
    ok(mrow.role === "CUSTOMER" && mrow.restaurant_id === null && mrow.email_verified === 0, "…nor attach it to a restaurant or mark its email verified");
    const payloads = ["' OR 1=1 --", "\"; DROP TABLE users; --", "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "%00%0d%0aSet-Cookie: x=1", "\u202Eevil", "𝕏".repeat(40), "a".repeat(5000), "${7*7}{{7*7}}"];
    const targets = [
      (v) => call(A.j, "PATCH", "/api/staff/restaurant", { description: v }), (v) => call(A.j, "POST", "/api/staff/menu", { name: v, price: 10, description: v }), (v) => call(A.j, "POST", "/api/staff/tables", { label: v, capacity: 2 }),
      (v) => call(C1, "POST", "/api/reservations", { restaurantId: alpha, date: "2099-01-01", time: "12:00", partySize: 2, notes: v }), (v) => call(C1, "POST", `/api/restaurants/${alpha}/inquiries`, { message: v }), (v) => call(C1, "POST", `/api/restaurants/${alpha}/reviews`, { rating: 4, comment: v }),
      (v) => call(jar(), "POST", "/api/register", { fullName: v, email: "x" + Math.random().toString(36).slice(2) + "@example.com", password: "Island2026", confirmPassword: "Island2026" }), (v) => call(A.j, "POST", "/api/staff/location-requests", { lat: 9.2, lng: 123.5, address: v, contactPhone: "0917 123 4567", businessContact: v }), (v) => call(admin.j, "POST", "/api/admin/restaurants", { name: v, municipality: "Larena", category: "Restaurant", address: v })];
    const hostile = [];
    for (const t of targets) for (const v of payloads) { const r = await t(v); if (r.status >= 500) hostile.push(`${r.status} for ${String(v).slice(0, 20)}`); if (r.res && r.res.headers.get("set-cookie") && /x=1/.test(r.res.headers.get("set-cookie"))) hostile.push("header injection"); }
    ok(hostile.length === 0, `${targets.length * payloads.length} hostile text inputs (SQL, scripts, header injection, huge, unicode) never cause an error` + (hostile.length ? " | " + hostile.slice(0, 4).join(" ; ") : ""));
    ok(before("users") >= usersBefore && (await call(admin.j, "GET", "/api/admin/users")).status === 200, "the database is intact after all of that (no table was dropped)");
    const listing = await rawReq("GET", "/api/restaurants"), listText = listing.body;
    ok(/application\/json/.test(listing.headers["content-type"]) && listing.headers["x-content-type-options"] === "nosniff", "stored text comes back as JSON data with nosniff (never as a page), so it cannot run as a script");
    let markupRefused = true; for (const pl of payloads.filter(x => /<(script|img)/.test(x))) if ((await call(A.j, "PATCH", "/api/staff/restaurant", { description: pl })).status !== 400) markupRefused = false;
    ok(markupRefused, "markup in text fields is refused at the door");

    /* ================= 6. one restaurant (or customer) cannot touch another's data ================= */
    const mk = async (j, p, b) => (await call(j, "POST", p, b)).data;
    const tuna = (await mk(A.j, "/api/staff/menu", { name: "Grilled Tuna", price: 200 })).id, tbl = (await mk(A.j, "/api/staff/tables", { label: "T1", capacity: 4 })).id;
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true }); await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567" }); await call(A.j, "POST", "/api/staff/payment-account/qr", png(1), { "Content-Type": "image/png" }); await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: true });
    const charge = (await mk(A.j, "/api/staff/restaurant-charges", { kind: "FEE", label: "Service charge", calc: "PERCENT", value: 5 })).id;
    const dayOf = (n) => new Date(Date.now() + 8 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
    const ord = await mk(C1, "/api/orders", { restaurantId: alpha, pickupDate: dayOf(2), pickupTime: "12:00", items: [{ menuItemId: tuna, qty: 1 }] });
    const resv = await mk(C1, "/api/reservations", { restaurantId: alpha, date: dayOf(3), time: "19:00", partySize: 2 });
    await call(C1, "POST", `/api/payments/${ord.paymentId}/proof?reference=SECREF0001&amount=200`, png(9), { "Content-Type": "image/png" });
    const loc = (await call(A.j, "GET", "/api/staff/location-request")).data.request.id; // the hostile-input sweep above already left a draft request for this restaurant
    const doc = (await call(A.j, "POST", `/api/staff/location-requests/${loc}/documents?kind=DTI_SEC&name=f.png`, png(3), { "Content-Type": "application/octet-stream" })).data.id;
    ok([tuna, tbl, charge, ord.id, ord.paymentId, resv.id, loc, doc].every(x => Number.isInteger(x)), "(setup) real records exist for the isolation checks: menu item, table, charge, order, payment, reservation, location request, document");
    const idor = [
      ["B", B.j, "PATCH", `/api/staff/menu/${tuna}`, { name: "Hijack" }], ["B", B.j, "DELETE", `/api/staff/menu/${tuna}`, {}], ["B", B.j, "PATCH", `/api/staff/tables/${tbl}`, { label: "X" }], ["B", B.j, "DELETE", `/api/staff/tables/${tbl}`, {}],
      ["B", B.j, "PATCH", `/api/staff/orders/${ord.id}`, { status: "ACCEPTED" }], ["B", B.j, "PATCH", `/api/staff/reservations/${resv.id}`, { status: "CONFIRMED" }], ["B", B.j, "POST", `/api/staff/payments/${ord.paymentId}/decision`, { decision: "ACCEPTED", verified: true }], ["B", B.j, "POST", `/api/staff/payments/${ord.paymentId}/refund`, { note: "x" }],
      ["B", B.j, "PATCH", `/api/staff/restaurant-charges/${charge}`, { active: false }], ["B", B.j, "DELETE", `/api/staff/restaurant-charges/${charge}`, {}], ["B", B.j, "PATCH", `/api/staff/location-requests/${loc}`, { address: "Elsewhere" }], ["B", B.j, "POST", `/api/staff/location-requests/${loc}/submit`, {}],
      ["B", B.j, "DELETE", `/api/staff/location-documents/${doc}`, {}], ["B", B.j, "GET", `/api/staff/location-documents/${doc}/file`], ["B", B.j, "GET", `/api/payments/${ord.paymentId}/receipt`], ["B", B.j, "GET", `/api/payments/${ord.paymentId}/qr`], ["B", B.j, "POST", `/api/staff/menu/${tuna}/image`, png(1)],
      ["C2", C2, "GET", `/api/payments/${ord.paymentId}`], ["C2", C2, "GET", `/api/payments/${ord.paymentId}/receipt`], ["C2", C2, "GET", `/api/payments/${ord.paymentId}/qr`], ["C2", C2, "POST", `/api/payments/${ord.paymentId}/proof?reference=OTHER00001&amount=200`, png(50)], ["C2", C2, "POST", `/api/orders/${ord.id}/cancel`, {}], ["C2", C2, "POST", `/api/reservations/${resv.id}/cancel`, {}]];
    const idorBad = [];
    for (const [who, j, m, p, b] of idor) { const r = await call(j, m, p, b, Buffer.isBuffer(b) ? { "Content-Type": "image/png" } : {}); if (r.status !== 404) idorBad.push(`${who} ${m} ${p} -> ${r.status}`); }
    ok(idorBad.length === 0, `${idor.length} attempts by another restaurant's staff or another customer to reach someone else's data all return 404` + (idorBad.length ? " | " + idorBad.join(" ; ") : ""));
    ok((await call(A.j, "GET", "/api/staff/orders")).data.length === 1 && (await call(B.j, "GET", "/api/staff/orders")).data.length === 0 && (await call(C2, "GET", "/api/my/orders")).data.length === 0 && (await call(C2, "GET", "/api/my/reservations")).data.length === 0, "lists contain only the caller's own records");
    ok((await call(A.j, "GET", "/api/staff/payment-account")).data.mobile === "09171234567" && (await call(B.j, "GET", "/api/staff/payment-account")).data.configured === false, "each restaurant sees only its own GCash settings");

    /* ================= 7. uploads: only genuine images or documents are accepted ================= */
    const evil = [["svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")], ["html", Buffer.from("<html><script>alert(1)</script></html>")], ["exe", Buffer.from("MZ" + "x".repeat(200))], ["php", Buffer.from("<?php system($_GET['c']); ?>")], ["gif", Buffer.from("GIF89a" + "x".repeat(60))]];
    const upRoutes = [["POST", `/api/staff/restaurant/logo`, A.j], ["POST", `/api/staff/restaurant/cover`, A.j], ["POST", `/api/staff/menu/${tuna}/image`, A.j], ["POST", "/api/staff/payment-account/qr", A.j], ["POST", `/api/payments/${ord.paymentId}/proof?reference=EVIL000001&amount=200`, C1], ["POST", "/api/admin/slides?set=map&alt=abc&credit=abc&license=abc&confirm=1", admin.j]];
    const upBad = [];
    for (const [m, p, j] of upRoutes) for (const [n, buf] of evil) { const r = await call(j, m, p, buf, { "Content-Type": "image/png" }); if (r.status !== 415 && r.status !== 409) upBad.push(`${n} -> ${p.split("?")[0]} ${r.status}`); }
    const docBad = []; for (const [n, buf] of evil) { const r = await call(A.j, "POST", `/api/staff/location-requests/${loc}/documents?kind=OTHER&name=x.png`, buf, { "Content-Type": "application/octet-stream" }); if (r.status !== 415) docBad.push(n + " " + r.status); }
    ok(upBad.length === 0 && docBad.length === 0, `${upRoutes.length * evil.length + evil.length} attempts to upload scripts, executables, SVG or GIF as images or documents are refused (415)` + (upBad.concat(docBad).length ? " | " + upBad.concat(docBad).join(" ; ") : ""));
    const pubFiles = fs.readdirSync(path.join(dir, "uploads", "public")), privFiles = fs.readdirSync(path.join(dir, "uploads", "private"));
    ok(pubFiles.every(f => /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(f)) && privFiles.every(f => /^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(f)), "every stored file has a random generated name and a safe extension");
    let publicPrivateLeak = 0; for (const f of privFiles) if ((await rawReq("GET", `/uploads/public/${f}`)).status === 200 || (await rawReq("GET", `/uploads/private/${f}`)).status === 200) publicPrivateLeak++;
    ok(publicPrivateLeak === 0, "private files (receipts, QR codes, evidence) cannot be fetched by name from any public path");

    /* ================= 8. sessions ================= */
    const sj = jar(); await call(sj, "POST", "/api/login", { portal: "RESTAURANT_STAFF", email: "beta@example.com", password: "wrong" });
    const st = (await call(admin.j, "GET", "/api/admin/users?q=beta")).data.users.find(u => u.email === "beta@example.com");
    ok((await call(B.j, "GET", "/api/staff/restaurant")).status === 200, "(staff B is signed in)");
    ok((await call(admin.j, "PATCH", `/api/admin/users/${st.id}`, { status: "DISABLED" })).status === 200 && [401, 403].includes((await call(B.j, "GET", "/api/staff/restaurant")).status), "disabling an account ends its sessions immediately");
    await call(admin.j, "PATCH", `/api/admin/users/${st.id}`, { status: "ACTIVE" });
    const lj = jar(); await call(lj, "POST", "/api/login", { portal: "CUSTOMER", email: "dan@example.com", password: "Island2026" }); const oldCookie = lj.get();
    ok((await call(lj, "GET", "/api/me")).data.user.email === "dan@example.com" && (await call(lj, "POST", "/api/logout", {})).status === 200, "logging out works");
    const stale = jar(); stale.set(`isla_sid=${oldCookie.split("=")[1]}`);
    ok((await call({ get: () => oldCookie, set() {} }, "GET", "/api/me")).data.user === undefined || (await call({ get: () => oldCookie, set() {} }, "GET", "/api/me")).status === 401, "a logged-out session cookie no longer works");
    const f1 = await call(jar(), "GET", "/api/me", undefined, { Cookie: "isla_sid=" + "a".repeat(43) }), f2 = await call(jar(), "GET", "/api/me", undefined, { Cookie: "isla_sid='; DROP TABLE sessions;--" });
    ok(f1.status === 401 && f2.status === 401 && before("users") > 0, "a made-up or hostile session cookie is simply not signed in");
    let locked = 0; const lk = jar(); for (let i = 0; i < 12; i++) { const r = await call(lk, "POST", "/api/login", { portal: "CUSTOMER", email: "cara@example.com", password: "Wrong" + i }, { "X-Forwarded-For": "10.99.0.5" }); if (r.status === 429) locked++; }
    ok(locked > 0, "repeated wrong passwords from one place are locked out for a while");
    ok((await call(jar(), "POST", "/api/login", { portal: "CUSTOMER", email: "cara@example.com", password: "Island2026" }, { "X-Forwarded-For": "10.99.1.9" })).status === 200, "…without locking the genuine owner out from elsewhere");

    /* ================= 9. secrets and sensitive files are not in the project ================= */
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === "node_modules" || e.name === ".git" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const files = walk(ROOT).filter(f => !/[\\/]tests[\\/]/.test(f)), found = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if ((/\.(db|db-wal|db-shm|pem|key|p12|pfx|zip|sqlite)$/i.test(rel) && rel !== "data/islaplateu.db") || /(^|[\\/])\.env(\.|$)/.test(rel) && rel !== ".env.example") found.push("sensitive file: " + rel);
      if (/\.(js|json|html|md|css|example)$/.test(rel)) { const t = fs.readFileSync(f, "utf8");
        for (const [re, what] of [[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"], [/\b(sk_live|rk_live)_[A-Za-z0-9]{10,}/, "payment key"], [/\bAKIA[0-9A-Z]{16}\b/, "AWS key"], [/\bghp_[A-Za-z0-9]{30,}/, "GitHub token"], [/\bxox[abp]-[A-Za-z0-9-]{10,}/, "Slack token"], [/\bre_[A-Za-z0-9]{20,}/, "Resend key"], [/\bxkeysib-[a-f0-9]{30,}/, "Brevo key"], [/\b0x4AAAAAAA[A-Za-z0-9_-]{10,}/, "Turnstile secret"], [/(SMTP_PASS|EMAIL_APP_PASSWORD|CAPTCHA_SECRET_KEY|RESEND_API_KEY|BREVO_API_KEY|ADMIN_PASSWORD)\s*=\s*['"]?[A-Za-z0-9+/_-]{8,}(?!.*\.\.\.)/, "credential assigned a value"]]) if (re.test(t) && !(rel === ".env.example")) found.push(`${what} in ${rel}`); }
    }
    ok(found.length === 0, "no secrets, keys, tokens, passwords or .env files (the local runtime DB is gitignored and not downloadable) are in the project folder" + (found.length ? " | " + found.join(" ; ") : ""));
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    ok(["*.db", ".env", "uploads/", "backups/", "node_modules/"].every(x => gi.includes(x)), ".gitignore keeps databases, uploads, backups and .env out of GitHub");
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    ok(Object.keys(pj.dependencies || {}).length === 1 && pj.dependencies.nodemailer && !pj.devDependencies && !fs.existsSync(path.join(ROOT, "node_modules")), "Nodemailer is the sole declared dependency for Gmail SMTP; no extra packages are present in the test checkout");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
