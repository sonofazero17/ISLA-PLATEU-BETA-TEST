/* Phase 11: complete journey across Customer, Restaurant Staff and Administrator with every feature switched on together.
   Self-contained (fake mail server + fake CAPTCHA provider).   Run:  node tests/e2e-test.js */
const { spawn } = require("node:child_process");
const net = require("node:net"), http = require("node:http");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const { createMailer } = require(path.join(ROOT, "lib", "mailer.js")), { createCaptcha } = require(path.join(ROOT, "lib", "captcha.js"));
const PORT = 3942, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-e2e-")), DBFILE = path.join(dir, "t.db");
const ADMIN_PW = "E2E-Test-2026";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR|MAIL_|SMTP_|RESEND_|BREVO_|CAPTCHA_|EMAIL_)/.test(k)));
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; };
async function call(j, method, p, body, extra = {}) {
  const isBin = Buffer.isBuffer(body);
  const res = await fetch(BASE + p, { method, redirect: "manual", body: body === undefined ? undefined : isBin ? body : JSON.stringify(body), headers: { "X-Forwarded-For": "10.9.9.9", ...(body !== undefined && !isBin ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra } });
  j.set(res.headers.get("set-cookie"));
  let data = null; if ((res.headers.get("content-type") || "").includes("json")) { try { data = await res.json(); } catch {} }
  return { status: res.status, data, res };
}

/* ---- fake SMTP server ---- */
const smtp = { user: "mailer@isla.test", pass: "app-password-1234", rejectRcpt: false, messages: [], authFailures: 0 };
function startSmtp() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.write("220 fake ESMTP ready\r\n");
      let buf = "", dataMode = false, lines = [], msg = {};
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (dataMode) { if (line === ".") { dataMode = false; msg.raw = lines.join("\r\n"); smtp.messages.push(msg); msg = {}; lines = []; sock.write("250 queued\r\n"); } else lines.push(line.startsWith("..") ? line.slice(1) : line); continue; }
          if (/^EHLO/i.test(line)) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (/^AUTH PLAIN /i.test(line)) { const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0"); if (u === smtp.user && p === smtp.pass) { msg.authed = true; sock.write("235 ok\r\n"); } else { smtp.authFailures++; sock.write("535 bad credentials\r\n"); } }
          else if (/^MAIL FROM:/i.test(line)) { msg.from = /<([^>]*)>/.exec(line)[1]; sock.write("250 ok\r\n"); }
          else if (/^RCPT TO:/i.test(line)) { if (smtp.rejectRcpt) sock.write("550 mailbox unavailable\r\n"); else { msg.to = /<([^>]*)>/.exec(line)[1]; sock.write("250 ok\r\n"); } }
          else if (/^DATA/i.test(line)) { dataMode = true; sock.write("354 go\r\n"); }
          else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
          else sock.write("250 ok\r\n");
        }
      });
      sock.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const textOf = (m) => { const part = /Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n\r\n--/.exec(m.raw); return part ? Buffer.from(part[1].replace(/\r\n/g, ""), "base64").toString("utf8") : ""; };
const codeOf = (m) => (/code is: (\d{6})/.exec(textOf(m)) || [])[1];
const lastMail = (to) => [...smtp.messages].reverse().find(m => m.to === to);

/* ---- fake CAPTCHA provider ---- */
const cap = { used: new Set(), seen: [], down: false };
function startCaptcha() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        if (cap.down) { res.writeHead(500); return res.end("down"); }
        const f = new URLSearchParams(body), token = f.get("response") || "";
        cap.seen.push({ secret: f.get("secret"), token, ip: f.get("remoteip") });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (f.get("secret") !== "test-secret") return res.end(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }));
        if (token.startsWith("ok") && !cap.used.has(token)) { cap.used.add(token); return res.end(JSON.stringify({ success: true })); }
        if (token.startsWith("ok")) return res.end(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
        if (token === "expired") return res.end(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
        res.end(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
let ipN = 0; const fresh = () => ({ "X-Forwarded-For": `10.1.${(++ipN) >> 8}.${ipN & 255}` }); // every simulated visitor gets its own address
let tokenN = 0; const tok = () => "ok-" + (++tokenN) + "-" + Math.random().toString(36).slice(2);

const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, n)]);
const dayOf = (n) => new Date(Date.now() + 8 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const smtpSrv = await startSmtp(), capSrv = await startCaptcha(), smtpPort = smtpSrv.address().port, capPort = capSrv.address().port;
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: DBFILE, ADMIN_PASSWORD: ADMIN_PW, TRUST_PROXY_HOPS: "1",
    MAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "none", SMTP_USER: smtp.user, SMTP_PASS: smtp.pass, MAIL_FROM: "ISLA-PLATEU <no-reply@isla.test>",
    CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SITE_KEY: "site", CAPTCHA_SECRET_KEY: "test-secret", CAPTCHA_VERIFY_URL: `http://127.0.0.1:${capPort}/siteverify` } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  let ipN = 5000; const fresh = () => ({ "X-Forwarded-For": `10.2.${(++ipN) >> 8}.${ipN & 255}` });
  const api = (j, m, p, b, h = {}) => call(j, m, p, b, { ...fresh(), ...h });
  const money = (n) => Math.round(n * 100) / 100, cents = (a) => a.map(l => Math.round(l.amount * 100));
  try {
    const anon = jar();
    const login = async (portal, email, password) => { const j = jar(); const r = await api(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    ok(admin.r.status === 200, "ADMIN: signs in");

    /* ============ RESTAURANT STAFF: apply, verify email, get approved ============ */
    const app = await api(jar(), "POST", "/api/staff-applications", { fullName: "Pia Owner", email: "pia@example.com", contactNumber: "09171234567", password: "Island2026", confirmPassword: "Island2026", restaurantMode: "new", restaurantName: "Isla Grill", restaurantContact: "09181234567", restaurantAddress: "Poblacion, Larena", municipality: "Larena", barangay: "Poblacion", category: "Restaurant", description: "Local Siquijor dishes grilled over coals.", position: "Owner", permitNumber: "BP-2026-001", note: "", captchaToken: tok() });
    ok(app.status === 201 && app.data.needsVerification && app.data.emailSent, "STAFF: applies for a new restaurant (CAPTCHA passed) and a code is emailed");
    ok((await api(jar(), "POST", "/api/verify-email", { email: "pia@example.com", code: codeOf(lastMail("pia@example.com")) })).status === 200, "STAFF: verifies their email address");
    const pending = (await api(admin.j, "GET", "/api/admin/applications?status=pending")).data.applications.find(a => a.applicantEmail === "pia@example.com");
    ok(pending && pending.restaurantName === "Isla Grill", "ADMIN: sees the pending restaurant application");
    ok((await api(admin.j, "POST", `/api/admin/applications/${pending.id}/approve`, { confirm: true })).status === 200, "ADMIN: approves it");
    const approved = (await api(admin.j, "GET", "/api/admin/applications?status=approved")).data.applications.find(a => a.id === pending.id), RID = approved.restaurantId;
    const staff = await login("RESTAURANT_STAFF", "pia@example.com", "Island2026"), S = staff.j;
    ok(staff.r.status === 200 && RID, `STAFF: signs in to the new restaurant (${RID})`);

    /* ============ STAFF: profile, menu, tables, payments, location ============ */
    const logo = await api(S, "POST", "/api/staff/restaurant/logo", png(1), { "Content-Type": "image/png" }), cover = await api(S, "POST", "/api/staff/restaurant/cover", png(2), { "Content-Type": "image/png" });
    ok(logo.status === 200 && cover.status === 200, "STAFF: uploads the restaurant logo and profile image");
    const tuna = (await api(S, "POST", "/api/staff/menu", { name: "Grilled Tuna", price: 250, description: "Fresh catch", category: "Seafood" })).data.id, rice = (await api(S, "POST", "/api/staff/menu", { name: "Garlic Rice", price: 40, category: "Side" })).data.id;
    ok((await api(S, "POST", `/api/staff/menu/${tuna}/image`, png(3), { "Content-Type": "image/png" })).status === 200 && (await api(S, "POST", `/api/staff/menu/${rice}/image`, png(4), { "Content-Type": "image/png" })).status === 200, "STAFF: adds food items with prices, categories and photos");
    await api(S, "PATCH", "/api/staff/restaurant", { acceptsOrders: true, acceptsReservations: true, hours: "10:00 AM - 9:00 PM", description: "Local Siquijor dishes grilled over coals.", contact: "09181234567" });
    ok((await api(S, "POST", "/api/staff/tables/bulk", { count: 3, capacity: 4 })).status === 201, "STAFF: sets up three 4-seat tables");
    await api(S, "PUT", "/api/staff/payment-account", { holderName: "Pia Santos", mobile: "09171234567" }); await api(S, "POST", "/api/staff/payment-account/qr", png(5), { "Content-Type": "image/png" });
    ok((await api(S, "PUT", "/api/staff/payment-account", { holderName: "Pia Santos", mobile: "09171234567", orderPrepay: true, reservationFee: 50 })).data.ready === true, "STAFF: saves GCash name, number and QR, and turns on payments (order payment + PHP 50 reservation fee)");
    ok((await api(S, "POST", "/api/staff/restaurant-charges", { kind: "FEE", label: "Service charge", calc: "PERCENT", value: 10, base: "FOOD" })).status === 201, "STAFF: adds a 10% service charge of their own");
    const pubBefore = (await api(anon, "GET", "/api/restaurants")).data.find(r => r.id === RID);
    ok(pubBefore.lat === null, "the restaurant is listed but has NO map pin yet (a pin needs approval)");
    const loc = (await api(S, "POST", "/api/staff/location-requests", { lat: 9.2, lng: 123.52, address: "Poblacion, Larena, Siquijor", contactPhone: "0917 123 4567", businessContact: "isla@example.com" })).data.id;
    for (const [k, n] of [["DTI_SEC", 6], ["STOREFRONT_PHOTO", 7], ["AUTHORIZATION", 8]]) await api(S, "POST", `/api/staff/location-requests/${loc}/documents?kind=${k}&name=${k}.png`, png(n), { "Content-Type": "application/octet-stream" });
    ok((await api(S, "POST", `/api/staff/location-requests/${loc}/submit`, {})).data.status === "PENDING", "STAFF: pins the restaurant, adds evidence and submits the location for approval");
    ok((await api(anon, "GET", "/api/restaurants")).data.find(r => r.id === RID).lat === null, "…and it is still not on the public map while pending");

    /* ============ ADMIN: location review, fees and taxes ============ */
    const q = (await api(admin.j, "GET", "/api/admin/location-requests")).data.find(x => x.id === loc), det = (await api(admin.j, "GET", `/api/admin/location-requests/${loc}`)).data;
    ok(q && det.documents.length === 3 && det.restaurant.logo, "ADMIN: sees the location request with its address, evidence and the restaurant's logo");
    ok((await fetch(BASE + `/api/admin/location-documents/${det.documents[0].id}/file`, { headers: { Cookie: admin.j.get() } })).status === 200, "ADMIN: opens a private evidence document");
    ok((await api(admin.j, "POST", `/api/admin/location-requests/${loc}/decision`, { decision: "APPROVED", note: "Verified" })).status === 200, "ADMIN: approves the location");
    const pubAfter = (await api(anon, "GET", "/api/restaurants")).data.find(r => r.id === RID);
    ok(pubAfter.lat === 9.2 && pubAfter.locationStatus === "verified" && pubAfter.logo && pubAfter.cover && pubAfter.tables.total === 3 && pubAfter.fulfillmentOptions.includes("PICKUP"), "the approved restaurant now appears on the map with logo, cover image and table counts");
    ok((await api(admin.j, "POST", "/api/admin/fee-settings", { kind: "SERVICE_FEE", label: "ISLA-PLATEU service fee", calc: "PERCENT", value: 5, base: "RESTAURANT_TOTAL", appliesTo: "BOTH" })).status === 201 && (await api(admin.j, "POST", "/api/admin/fee-settings", { kind: "SYSTEM_TAX", label: "Sample system tax", calc: "PERCENT", value: 10, base: "SERVICE_FEES", appliesTo: "BOTH", basisNote: "Sample basis for the end-to-end test", verified: true })).status === 201, "ADMIN: configures a service fee and a verified tax line (sample numbers)");

    /* ============ CUSTOMER: register, verify, browse ============ */
    const reg = await api(jar(), "POST", "/api/register", { fullName: "Cara Customer", email: "cara@example.com", password: "Island2026", confirmPassword: "Island2026", captchaToken: tok() });
    ok(reg.status === 201 && reg.data.needsVerification, "CUSTOMER: registers (CAPTCHA passed) and is asked to verify");
    ok((await login("CUSTOMER", "cara@example.com", "Island2026")).r.data.code === "EMAIL_NOT_VERIFIED", "CUSTOMER: cannot log in before verifying");
    ok((await api(jar(), "POST", "/api/verify-email", { email: "cara@example.com", code: codeOf(lastMail("cara@example.com")) })).status === 200, "CUSTOMER: enters the emailed code");
    const C = (await login("CUSTOMER", "cara@example.com", "Island2026")).j;
    const detail = (await api(anon, "GET", `/api/restaurants/${RID}`)).data;
    ok(detail.menu.length === 2 && detail.menu.every(m => m.image && m.available && m.price > 0) && detail.restaurant.logo && detail.tableList.length === 3, "CUSTOMER: browses the restaurant: logo, food photos, prices, availability and its tables");
    const [RD] = [dayOf(3)], avail = (await api(anon, "GET", `/api/restaurants/${RID}/tables?date=${RD}&time=19:00`)).data;
    ok(avail.summary.available === 3 && avail.tables.every(t => t.capacity === 4), "CUSTOMER: checks table availability for a date and time (3 free, 4 seats each)");

    /* ============ CUSTOMER: reservation with fee, payment and staff confirmation ============ */
    const rq = (await api(anon, "GET", `/api/restaurants/${RID}/reservation-quote`)).data;
    ok(rq.total === 58.03 && cents(rq.breakdown).join() === "5000,500,275,28", "CUSTOMER: sees the reservation fee breakdown first: 50.00 + 5.00 + 2.75 + 0.28 = 58.03");
    const rv = await api(C, "POST", "/api/reservations", { restaurantId: RID, date: RD, time: "19:00", partySize: 3, tableId: avail.tables[0].id, expectedTotal: 58.03 });
    ok(rv.status === 201 && rv.data.paymentRequired, "CUSTOMER: requests a table for 3 and gets a payment to make");
    const rpay = (await api(C, "GET", `/api/payments/${rv.data.paymentId}`)).data;
    ok(rpay.amount === 58.03 && rpay.instructions.holderName === "Pia Santos" && rpay.instructions.mobileMasked === "0917 ••• 4567" && rpay.instructions.qrUrl, "CUSTOMER: sees the GCash instructions, QR code and amount (number masked)");
    ok((await api(S, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" })).status === 409, "STAFF: cannot confirm the table before the payment is accepted");
    ok((await api(C, "POST", `/api/payments/${rv.data.paymentId}/proof?reference=E2ERES000001&amount=58.03`, png(20), { "Content-Type": "image/png" })).status === 201, "CUSTOMER: uploads the GCash receipt");
    ok((await api(S, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" })).status === 409, "STAFF: still cannot confirm: an uploaded receipt is not proof");
    const spay = (await api(S, "GET", "/api/staff/payments")).data.payments.find(p => p.id === rv.data.paymentId);
    ok(spay && spay.submissions[0].reference === "E2ERES000001" && spay.customerEmail === "cara@example.com", "STAFF: sees the receipt in the payment queue");
    ok((await api(S, "POST", `/api/staff/payments/${rv.data.paymentId}/decision`, { decision: "ACCEPTED", verified: false })).status === 400, "STAFF: cannot accept without confirming they checked GCash");
    ok((await api(S, "POST", `/api/staff/payments/${rv.data.paymentId}/decision`, { decision: "ACCEPTED", verified: true })).status === 200, "STAFF: accepts the payment after checking their GCash records");
    const conf = await api(S, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" });
    ok(conf.status === 200 && conf.data.table === avail.tables[0].label, "STAFF: confirms the reservation with the requested table");
    const myRes = (await api(C, "GET", "/api/my/reservations")).data[0];
    ok(myRes.status === "CONFIRMED" && myRes.tableLabel === avail.tables[0].label && myRes.payment.status === "ACCEPTED", "CUSTOMER: tracks the reservation: confirmed, table assigned, payment accepted");
    const after = (await api(anon, "GET", `/api/restaurants/${RID}/tables?date=${RD}&time=19:30`)).data;
    ok(after.summary.reserved === 1 && after.summary.available === 2 && (await api(C, "POST", "/api/reservations", { restaurantId: RID, date: RD, time: "19:30", partySize: 2, tableId: avail.tables[0].id })).status === 409, "the table now shows as reserved and cannot be double-booked");

    /* ============ CUSTOMER: advance order, payment, kitchen workflow ============ */
    const [D, T] = [dayOf(2), "12:00"];
    const oq = (await api(C, "POST", "/api/orders/quote", { restaurantId: RID, items: [{ menuItemId: tuna, qty: 2 }, { menuItemId: rice, qty: 1 }], fulfillment: "PICKUP" })).data;
    ok(oq.subtotal === 540 && oq.total === 626.67 && cents(oq.breakdown).join() === "54000,5400,2970,297", "CUSTOMER: reviews the order: 540.00 + 54.00 (service charge) + 29.70 (ISLA-PLATEU fee) + 2.97 (tax) = 626.67");
    ok(oq.breakdown.map(l => l.category).join() === "restaurant,restaurant,platform_fee,government_tax" && oq.breakdown.every(l => l.label), "…with restaurant charges, the platform fee and the tax kept apart");
    const ord = await api(C, "POST", "/api/orders", { restaurantId: RID, pickupDate: D, pickupTime: T, items: [{ menuItemId: tuna, qty: 2 }, { menuItemId: rice, qty: 1 }], fulfillment: "PICKUP", expectedTotal: 626.67, notes: "No chili" });
    ok(ord.status === 201 && ord.data.payable === 626.67, "CUSTOMER: places the advance order (total 626.67 payable)");
    ok((await api(S, "PATCH", `/api/staff/orders/${ord.data.id}`, { status: "ACCEPTED" })).status === 409, "STAFF: cannot accept the order before it is paid");
    await api(C, "POST", `/api/payments/${ord.data.paymentId}/proof?reference=E2EORD000001&amount=626.67`, png(21), { "Content-Type": "image/png" });
    ok((await api(S, "POST", `/api/staff/payments/${ord.data.paymentId}/decision`, { decision: "ACCEPTED", verified: true })).status === 200, "STAFF: verifies and accepts the order payment");
    for (const st of ["ACCEPTED", "PREPARING", "READY", "COMPLETED"]) ok((await api(S, "PATCH", `/api/staff/orders/${ord.data.id}`, { status: st })).status === 200, `STAFF: marks the order ${st.toLowerCase()}`);
    const tr = (await api(C, "GET", "/api/my/orders")).data[0];
    ok(tr.status === "COMPLETED" && tr.history.map(h => h.status).join() === "PENDING,ACCEPTED,PREPARING,READY,COMPLETED" && tr.payment.status === "ACCEPTED" && tr.items.length === 2, "CUSTOMER: tracks the order from placed to completed, with the payment accepted");
    ok(/COMPLETED/.test(JSON.stringify((await api(C, "GET", "/api/notifications")).data)), "CUSTOMER: was notified along the way");

    /* ============ ADMIN: monitoring, ledger, audit ============ */
    const mres = (await api(admin.j, "GET", "/api/admin/reservations")).data, mord = (await api(admin.j, "GET", "/api/admin/orders")).data, mpay = (await api(admin.j, "GET", "/api/admin/payments")).data;
    ok(mres.rows[0].status === "CONFIRMED" && mres.rows[0].payment.status === "ACCEPTED" && mord.rows[0].status === "COMPLETED" && mord.rows[0].total === 540 && mpay.total === 2 && mpay.counts.ACCEPTED === 2, "ADMIN: monitors the reservation, the order and both payments");
    const lg = (await api(admin.j, "GET", "/api/admin/fee-ledger")).data.restaurants.find(r => r.restaurantId === RID);
    ok(lg.payments === 2 && lg.collected === 684.7 && lg.restaurantShare === 649 && lg.platformFees === 32.45 && lg.systemTaxes === 3.25, "ADMIN: the ledger adds up: 684.70 collected = 649.00 restaurant + 32.45 ISLA-PLATEU fees + 3.25 tax");
    const ov = (await api(admin.j, "GET", `/api/admin/restaurants/${RID}/overview`)).data, ovText = JSON.stringify(ov);
    ok(ov.location.status === "APPROVED" && ov.staff[0].emailVerified === true && ov.tables.total === 3 && ov.menu.withImages === 2 && ov.payments.gcashConfigured && !ovText.includes("09171234567") && !ovText.includes("Pia Santos"), "ADMIN: one-page restaurant overview (location approved, staff verified, tables, menu photos) without private payment details");
    const users = (await api(admin.j, "GET", "/api/admin/users")).data;
    ok(users.users.find(u => u.email === "cara@example.com").emailVerified && users.users.find(u => u.email === "pia@example.com").emailVerified, "ADMIN: sees both new accounts as email-verified");
    const att = (await api(admin.j, "GET", "/api/admin/attention")).data.items;
    ok(att.filter(i => i.urgent).every(i => i.count === 0), "ADMIN: nothing is left waiting in the attention queue");
    const audit = (await api(admin.j, "GET", "/api/admin/audit-search?limit=200")).data.entries.map(e => e.action);
    ok(["application.approved", "location_request.submitted", "location_request.approved", "fee_setting.created", "restaurant_charge.created", "payment_account.updated", "payment_account.qr_replaced"].every(a => audit.includes(a)), "ADMIN: the audit log recorded the approvals, fee settings and payment-setting changes");
    const alltext = JSON.stringify((await api(admin.j, "GET", "/api/admin/audit-search?limit=200")).data);
    ok(!alltext.includes("Island2026") && !alltext.includes("09171234567") && !alltext.includes(smtp.pass) && !alltext.includes("test-secret"), "the audit log holds no password, GCash number or secret");
    ok(!out.includes(smtp.pass) && !out.includes("test-secret") && !out.includes("Island2026") && !out.includes(ADMIN_PW), "the server's log output contains no password or secret");
    ok(!/ (500|502) /.test(out) && !/Unhandled|TypeError|ReferenceError|at .*\.js:\d+/.test(out), "the server logged no crash or stack trace during the whole journey");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL"); smtpSrv.close(); capSrv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
