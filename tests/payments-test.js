/* Phase 6: GCash details, receipt upload, staff verification, duplicate blocking, refunds, privacy. Self-contained.   Run:  node tests/payments-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3936, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-pay-"));
const ADMIN_PW = "Payments-Test-2026";
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

const ph = (days, hh = "19:00") => { const d = new Date(Date.now() + 8 * 3600e3 + days * 864e5); return [d.toISOString().slice(0, 10), hh]; };
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, n)]);

(async () => {
  let proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    const mkRest = (name) => call(admin.j, "POST", "/api/admin/restaurants", { name, municipality: "Larena", category: "Restaurant", address: "Larena", acceptsReservations: true });
    await mkRest("Alpha Grill"); await mkRest("Beta Cafe");
    const mkStaff = async (n, rid) => { const s = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff " + n, email: `${n}@example.com`, restaurantId: rid }); return login("RESTAURANT_STAFF", `${n}@example.com`, s.data.temporaryPassword); };
    const A = await mkStaff("alpha", "alpha-grill"), B = await mkStaff("beta", "beta-cafe");
    const mkCust = async (n) => { await call(jar(), "POST", "/api/register", { fullName: n + " Customer", email: `${n}@example.com`, password: "Island2026", confirmPassword: "Island2026" }); return (await login("CUSTOMER", `${n}@example.com`, "Island2026")).j; };
    const C1 = await mkCust("cara"), C2 = await mkCust("dan"), anon = jar();
    const food = async (j, name, price) => (await call(j, "POST", "/api/staff/menu", { name, price })).data.id;
    const tuna = await food(A.j, "Grilled Tuna", 200), tea = await food(B.j, "Iced Tea", 60);
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true }); await call(B.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true });
    const privCount = () => fs.readdirSync(path.join(dir, "uploads", "private")).length;
    const [D, T] = ph(2, "12:00");
    const order = (j, rid = "alpha-grill", item = tuna, qty = 1) => call(j, "POST", "/api/orders", { restaurantId: rid, pickupDate: D, pickupTime: T, items: [{ menuItemId: item, qty }] });
    const proof = (j, id, buf, ref = "1234567890123", amount = 200) => call(j, "POST", `/api/payments/${id}/proof?reference=${encodeURIComponent(ref)}&amount=${amount}`, buf, { "Content-Type": "image/png" });
    const decide = (j, id, decision, extra = {}) => call(j, "POST", `/api/staff/payments/${id}/decision`, { decision, ...extra });
    const raw = async (j, p) => fetch(BASE + p, { headers: j.get() ? { Cookie: j.get() } : {} });
    const notes = async (j) => JSON.stringify((await call(j, "GET", "/api/notifications")).data);

    /* ---- GCash account ---- */
    ok((await call(anon, "GET", "/api/staff/payment-account")).status === 401 && (await call(C1, "GET", "/api/staff/payment-account")).status === 403, "guests and customers cannot read GCash settings");
    ok((await call(A.j, "GET", "/api/staff/payment-account")).data.configured === false, "no GCash details yet");
    for (const bad of ["abc", "12345", "08171234567", "0917123456", "091712345678", "+6391234"]) ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: bad })).status === 400, `invalid mobile rejected: ${bad}`);
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "", mobile: "09171234567" })).status === 400, "holder name required");
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "<b>x</b>", mobile: "09171234567" })).status === 400, "markup in holder name rejected");
    ok((await call(A.j, "POST", "/api/staff/payment-account/qr", png(1), { "Content-Type": "image/png" })).status === 409, "QR cannot be uploaded before the account name and number are saved");
    const sv = await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "+63 917-123-4567" });
    ok(sv.status === 200 && sv.data.mobile === "09171234567" && sv.data.holderName === "Juan Dela Cruz" && sv.data.hasQr === false && sv.data.ready === false, "valid account saved, mobile normalised to 09171234567");
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: true })).status === 400, "cannot require payment before a QR code exists");
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", reservationFee: 50 })).status === 400, "cannot set a reservation fee before a QR code exists");
    ok((await call(A.j, "POST", "/api/staff/payment-account/qr", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { "Content-Type": "image/png" })).status === 415, "SVG QR rejected");
    ok((await call(A.j, "POST", "/api/staff/payment-account/qr", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 65)]), { "Content-Type": "application/pdf" })).status === 415, "PDF QR rejected (images only)");
    ok((await call(A.j, "POST", "/api/staff/payment-account/qr", Buffer.concat([png(1), Buffer.alloc(6 * 1024 * 1024)]), { "Content-Type": "image/png" })).status === 413, "QR over 5 MB rejected");
    ok((await call(C1, "POST", "/api/staff/payment-account/qr", png(1), { "Content-Type": "image/png" })).status === 403, "customer cannot upload a QR");
    const qr1 = await call(A.j, "POST", "/api/staff/payment-account/qr", png(1), { "Content-Type": "image/png" });
    ok(qr1.status === 200 && privCount() === 6, "QR uploaded alongside all five preloaded restaurant demo QR images");
    const qrGet = await raw(A.j, "/api/staff/payment-account/qr");
    ok(qrGet.status === 200 && qrGet.headers.get("content-type") === "image/png" && /no-store/.test(qrGet.headers.get("cache-control")), "owner staff can preview the QR (private, no-store)");
    ok((await raw(B.j, "/api/staff/payment-account/qr")).status === 404 && (await raw(C1, "/api/staff/payment-account/qr")).status === 403 && (await raw(anon, "/api/staff/payment-account/qr")).status === 401, "other restaurant, customers and guests cannot read the QR");
    const priv0 = fs.readdirSync(path.join(dir, "uploads", "private"));
    for (const f of priv0) ok((await fetch(BASE + `/uploads/private/${f}`)).status === 404 && (await fetch(BASE + `/uploads/public/${f}`)).status === 404, "QR file is not reachable by URL");
    const qr2 = await call(A.j, "POST", "/api/staff/payment-account/qr", png(2), { "Content-Type": "image/png" });
    ok(qr2.status === 200 && qr2.data.hasQr === true && privCount() === 6, "replacing the QR deletes the old file and returns the updated account state");
    ok((await call(B.j, "DELETE", "/api/staff/payment-account/qr", {})).status === 404, "another restaurant's staff cannot remove this restaurant's QR");
    ok((await call(A.j, "DELETE", "/api/staff/payment-account/qr", {})).status === 200 && privCount() === 5, "staff can remove their own QR and the private file is deleted (all five demo QR images remain)");
    ok((await call(A.j, "GET", "/api/staff/payment-account")).data.hasQr === false && (await raw(A.j, "/api/staff/payment-account/qr")).status === 404, "removed QR no longer appears in settings or private image endpoint");
    ok((await call(A.j, "DELETE", "/api/staff/payment-account/qr", {})).status === 404, "removing an already-absent QR gives a clear not-found response");
    const qr3 = await call(A.j, "POST", "/api/staff/payment-account/qr", png(3), { "Content-Type": "image/png" });
    ok(qr3.status === 200 && privCount() === 6, "staff can upload a new QR after removal");
    // Restart against the same SQLite + uploads location: sessions, DB reference and private QR bytes must survive.
    await new Promise(resolve => { proc.once("exit", resolve); proc.kill("SIGKILL"); });
    proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
    let restartOut = ""; proc.stdout.on("data", d => restartOut += d); proc.stderr.on("data", d => restartOut += d);
    for (let i = 0; i < 60 && !/running at/.test(restartOut); i++) await new Promise(r => setTimeout(r, 150));
    const qrAfterRestart = await raw(A.j, "/api/staff/payment-account/qr");
    ok(/running at/.test(restartOut) && qrAfterRestart.status === 200 && Buffer.from(await qrAfterRestart.arrayBuffer()).equals(png(3)), "saved private QR image and staff session survive a server restart");
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: true, reservationFee: 50 })).data.ready === true, "payments turned on: order prepayment and a PHP 50 reservation fee");
    ok((await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", reservationFee: -1 })).status === 400 && (await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", reservationFee: 10001 })).status === 400, "reservation fee must be 0-10,000");
    const pubList = JSON.stringify((await call(anon, "GET", "/api/restaurants")).data), pubA = JSON.parse(pubList).find(r => r.id === "alpha-grill");
    ok(pubA.ordersRequirePayment === true && pubA.reservationFee === 50, "public data says payment is required and the fee, nothing more");
    ok(!pubList.includes("09171234567") && !pubList.includes("Juan Dela Cruz") && !/qr/i.test(pubList.replace(/qrcode/gi, "")), "GCash name, number and QR are not in public data");
    ok((await call(B.j, "PUT", "/api/staff/payment-account", { holderName: "Beta Owner", mobile: "09181112222" })).status === 200 && (await call(A.j, "GET", "/api/staff/payment-account")).data.holderName === "Juan Dela Cruz", "staff can only change their own restaurant's account");
    const logs = JSON.stringify((await call(admin.j, "GET", "/api/admin/audit-logs")).data);
    ok(/payment_account.updated/.test(logs) && /payment_account.qr_replaced/.test(logs) && !logs.includes("09171234567") && !logs.includes("09181112222"), "changes are audited without storing the mobile number");

    /* ---- order payment ---- */
    const o1 = await order(C1);
    ok(o1.status === 201 && o1.data.paymentRequired === true && o1.data.paymentId > 0, "order placed with a payment due");
    const pid = o1.data.paymentId;
    const pd = await call(C1, "GET", `/api/payments/${pid}`);
    ok(pd.data.status === "AWAITING_PROOF" && pd.data.amount === 200 && pd.data.breakdown[0].amount === 200 && pd.data.instructions.holderName === "Juan Dela Cruz", "customer sees the amount, breakdown and payment instructions");
    ok(pd.data.instructions.mobileMasked === "0917 ••• 4567" && !JSON.stringify(pd.data).includes("09171234567"), "the GCash number is masked for customers");
    ok((await call(C2, "GET", `/api/payments/${pid}`)).status === 404 && (await call(A.j, "GET", `/api/payments/${pid}`)).status === 403 && (await call(anon, "GET", `/api/payments/${pid}`)).status === 401, "other customers, staff routes and guests cannot open the payment page");
    for (const [j, st, who] of [[C1, 200, "owner"], [C2, 404, "other customer"], [A.j, 200, "restaurant staff"], [B.j, 404, "other restaurant"], [admin.j, 200, "admin"], [anon, 401, "guest"]]) ok((await raw(j, `/api/payments/${pid}/qr`)).status === st, `QR for a payment: ${who} -> ${st}`);
    ok((await call(A.j, "PATCH", `/api/staff/orders/${o1.data.id}`, { status: "ACCEPTED" })).status === 409, "staff cannot accept an order whose payment is not accepted");
    ok(/not been accepted/.test((await call(A.j, "PATCH", `/api/staff/orders/${o1.data.id}`, { status: "ACCEPTED" })).data.error), "…and the message says why");
    ok((await proof(C1, pid, png(10), "", 200)).status === 400 && (await proof(C1, pid, png(10), "abc", 200)).status === 400, "receipt needs a reference number");
    ok((await proof(C1, pid, png(10), "1234567890123", "")).status === 400 && (await proof(C1, pid, png(10), "1234567890123", 0)).status === 400 && (await proof(C1, pid, png(10), "1234567890123", "abc")).status === 400, "receipt needs a positive amount");
    ok((await call(C1, "POST", `/api/payments/${pid}/proof?reference=1234567890123&amount=200`, Buffer.from("<svg/>"), { "Content-Type": "image/png" })).status === 415, "SVG receipt rejected");
    ok((await call(C1, "POST", `/api/payments/${pid}/proof?reference=1234567890123&amount=200`, Buffer.from("%PDF-1.4 x" + "a".repeat(100)), { "Content-Type": "application/pdf" })).status === 415, "PDF receipt rejected (screenshots only)");
    ok((await proof(C2, pid, png(10))).status === 404 && (await proof(A.j, pid, png(10))).status === 403 && (await proof(anon, pid, png(10))).status === 401, "only the owner can submit a receipt");
    const before = privCount();
    ok((await proof(C1, pid, png(10), "1234567890123", 150)).status === 201, "customer submits a receipt (declaring PHP 150, though 200 is due)");
    ok(privCount() === before + 1, "receipt stored in private storage");
    ok((await mineOrder(C1, o1.data.id)).payment.status === "UNDER_REVIEW", "customer sees: payment under review");
    async function mineOrder(j, id) { return (await call(j, "GET", "/api/my/orders")).data.find(o => o.id === id); }
    ok((await proof(C1, pid, png(11), "9999999999999", 200)).status === 409, "cannot submit another receipt while one is under review");
    ok((await call(A.j, "PATCH", `/api/staff/orders/${o1.data.id}`, { status: "ACCEPTED" })).status === 409, "an uploaded image does NOT make the order paid (still cannot accept)");
    ok(/GCash receipt/.test(await notes(A.j)), "staff were notified of the receipt");

    /* duplicates */
    const o2 = await order(C2);
    ok((await proof(C2, o2.data.paymentId, png(10), "5555555555555", 200)).status === 409, "the same receipt image cannot be reused by another customer");
    ok((await proof(C2, o2.data.paymentId, png(20), "1234 5678 90123", 200)).status === 409, "the same reference number (any spacing) cannot be reused");
    ok(privCount() === before + 1, "blocked duplicates leave no orphaned files");
    ok((await call(C2, "GET", `/api/payments/${o2.data.paymentId}`)).data.status === "AWAITING_PROOF", "blocked duplicate leaves the second payment awaiting proof");

    /* receipts are private */
    for (const [j, st, who] of [[C1, 200, "owner"], [A.j, 200, "restaurant staff"], [admin.j, 200, "admin"], [C2, 404, "other customer"], [B.j, 404, "other restaurant's staff"], [anon, 401, "guest"]]) ok((await raw(j, `/api/payments/${pid}/receipt`)).status === st, `receipt: ${who} -> ${st}`);
    const rc = await raw(A.j, `/api/payments/${pid}/receipt`);
    ok(rc.headers.get("content-type") === "image/png" && /no-store/.test(rc.headers.get("cache-control")), "receipt served privately with no-store");
    for (const f of fs.readdirSync(path.join(dir, "uploads", "private"))) ok((await fetch(BASE + `/uploads/private/${f}`)).status === 404, "no receipt reachable by direct URL");

    /* staff review */
    const sl = (await call(A.j, "GET", "/api/staff/payments")).data;
    const sp = sl.payments.find(p => p.id === pid);
    ok(sl.counts.review === 1 && sp.status === "UNDER_REVIEW" && sp.customerEmail === "cara@example.com" && sp.submissions[0].reference === "1234567890123" && sp.submissions[0].mismatch === true && sp.parent.label === `Order #${o1.data.id}`, "staff review list shows reference, customer, order and flags the amount mismatch");
    ok((await call(B.j, "GET", "/api/staff/payments")).data.payments.length === 0, "other restaurant sees none of these payments");
    ok((await call(C1, "GET", "/api/staff/payments")).status === 403, "customers cannot list payments for review");
    ok((await decide(A.j, pid, "ACCEPTED")).status === 400 && (await decide(A.j, pid, "ACCEPTED", { verified: false })).status === 400 && (await decide(A.j, pid, "ACCEPTED", { verified: "yes" })).status === 400, "accepting requires confirming the GCash records were checked");
    ok((await decide(A.j, pid, "REJECTED", { note: "" })).status === 400, "rejecting requires a reason");
    ok((await decide(B.j, pid, "ACCEPTED", { verified: true })).status === 404 && (await decide(C1, pid, "ACCEPTED", { verified: true })).status === 403, "other restaurant's staff and customers cannot decide");
    const rj = await decide(A.j, pid, "REJECTED", { note: "Amount does not match: you sent 150." });
    ok(rj.status === 200, "staff reject the receipt with a reason");
    ok((await mineOrder(C1, o1.data.id)).payment.status === "REJECTED" && (await mineOrder(C1, o1.data.id)).payment.canSubmit === true && /does not match/.test(await notes(C1)), "customer sees the rejection reason and may upload a new receipt");
    ok((await decide(A.j, pid, "ACCEPTED", { verified: true })).status === 409, "a rejected payment cannot be accepted without a new receipt");
    ok((await proof(C1, pid, png(10), "1234567890123", 200)).status === 409, "the rejected image cannot simply be sent again");
    ok((await proof(C1, pid, png(12), "1234567890123", 200)).status === 201, "a new receipt (same reference, fixed image) is accepted for review");
    const ac = await decide(A.j, pid, "ACCEPTED", { verified: true, note: "Seen in GCash" });
    ok(ac.status === 200 && (await mineOrder(C1, o1.data.id)).payment.status === "ACCEPTED" && /accepted/.test(await notes(C1)), "staff accept after verifying; customer notified");
    ok((await decide(A.j, pid, "REJECTED", { note: "x" })).status === 409, "a decided payment cannot be decided again");
    ok((await proof(C1, pid, png(30), "7777777777777", 200)).status === 409, "no more receipts once accepted");
    ok((await call(A.j, "PATCH", `/api/staff/orders/${o1.data.id}`, { status: "ACCEPTED" })).status === 200, "now the paid order can be accepted");
    const ev = (await call(A.j, "GET", "/api/staff/payments?filter=all")).data.payments.find(p => p.id === pid).events.map(e => e.action).join();
    ok(["payment.created", "proof.submitted", "payment.rejected", "payment.accepted", "receipt.viewed"].every(a => ev.includes(a)), "verification log records every step, including who viewed the receipt");
    ok((await call(A.j, "GET", "/api/staff/payments?filter=ACCEPTED")).data.payments.every(p => p.status === "ACCEPTED"), "staff can filter by status");

    /* attempts limit */
    const o3 = await order(C1, "alpha-grill", tuna, 2); let last;
    for (let n = 0; n < 5; n++) { await proof(C1, o3.data.paymentId, png(40 + n), "AB" + String(100000 + n), 400); last = await decide(A.j, o3.data.paymentId, "REJECTED", { note: "no" }); }
    ok(last.status === 200 && (await proof(C1, o3.data.paymentId, png(60), "ZZ123456", 400)).status === 429, "after 5 receipts further uploads are refused");

    /* closing before payment, and refunds */
    const o4 = await order(C2, "alpha-grill", tuna, 3);
    ok((await call(C2, "POST", `/api/orders/${o4.data.id}/cancel`, {})).status === 200 && (await call(C2, "GET", `/api/payments/${o4.data.paymentId}`)).data.status === "VOID", "cancelling before paying voids the payment");
    ok((await proof(C2, o4.data.paymentId, png(70), "VOID123456", 600)).status === 409, "no receipt can be added to a closed order");
    const o5 = await order(C1, "alpha-grill", tuna, 4);
    await proof(C1, o5.data.paymentId, png(80), "REFUND123456", 800); await decide(A.j, o5.data.paymentId, "ACCEPTED", { verified: true });
    ok((await call(A.j, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "GCash ref 1" })).status === 409, "cannot refund while the order is still active");
    await call(A.j, "PATCH", `/api/staff/orders/${o5.data.id}`, { status: "ACCEPTED" });
    await call(A.j, "PATCH", `/api/staff/orders/${o5.data.id}`, { status: "CANCELLED", note: "Kitchen closed" });
    const rl = (await call(A.j, "GET", "/api/staff/payments")).data;
    ok(rl.counts.refundDue === 1 && rl.payments.length === 0, "staff are told a refund is due");
    ok(/Refund the customer/.test(await notes(A.j)), "staff notified that money must be refunded");
    ok((await call(A.j, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "" })).status === 400, "refund needs a note");
    ok((await call(B.j, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "x" })).status === 404 && (await call(C1, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "x" })).status === 403, "only the restaurant's staff can refund");
    ok((await call(A.j, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "GCash refund ref 998877" })).status === 200 && (await mineOrder(C1, o5.data.id)).payment.status === "REFUNDED" && /refunded/.test(await notes(C1)), "staff mark it refunded; customer notified");
    ok((await call(A.j, "POST", `/api/staff/payments/${o5.data.paymentId}/refund`, { note: "again" })).status === 409, "cannot refund twice");

    /* customer cancels while a receipt is under review */
    const o6 = await order(C2, "alpha-grill", tuna, 5);
    await proof(C2, o6.data.paymentId, png(90), "REVIEW123456", 1000);
    await call(C2, "POST", `/api/orders/${o6.data.id}/cancel`, {});
    ok((await call(C2, "GET", `/api/payments/${o6.data.paymentId}`)).data.status === "UNDER_REVIEW" && /awaiting review but its order is now closed/.test(await notes(A.j)), "a receipt under review is not discarded when the order is cancelled; staff are warned");

    /* reservation fee */
    const [RD] = ph(3);
    const rv = await call(C1, "POST", "/api/reservations", { restaurantId: "alpha-grill", date: RD, time: "19:00", partySize: 2 });
    ok(rv.status === 201 && rv.data.paymentRequired === true, "reservation with a fee creates a payment");
    const rp = await call(C1, "GET", `/api/payments/${rv.data.paymentId}`);
    ok(rp.data.amount === 50 && /Reservation fee/.test(rp.data.breakdown[0].label), "amount due is the reservation fee");
    ok((await call(A.j, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" })).status === 409, "table cannot be confirmed before payment is accepted");
    await call(C1, "POST", `/api/payments/${rv.data.paymentId}/proof?reference=RES1234567&amount=50`, png(100), { "Content-Type": "image/png" });
    ok((await call(A.j, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" })).status === 409, "an uploaded receipt alone does not confirm the table");
    await decide(A.j, rv.data.paymentId, "ACCEPTED", { verified: true });
    ok((await call(A.j, "PATCH", `/api/staff/reservations/${rv.data.id}`, { status: "CONFIRMED" })).status === 200, "after the payment is accepted staff can confirm the table");
    const myr = (await call(C1, "GET", "/api/my/reservations")).data.find(v => v.id === rv.data.id);
    ok(myr.status === "CONFIRMED" && myr.payment.status === "ACCEPTED", "customer sees confirmed + payment accepted");
    const [RD2] = ph(4);
    const rv2 = await call(C2, "POST", "/api/reservations", { restaurantId: "alpha-grill", date: RD2, time: "19:00", partySize: 2 });
    ok((await call(A.j, "PATCH", `/api/staff/reservations/${rv2.data.id}`, { status: "DECLINED" })).status === 200 && (await call(C2, "GET", `/api/payments/${rv2.data.paymentId}`)).data.status === "VOID", "declining an unpaid reservation voids its payment");

    /* restaurants without payments, and switching payments off */
    const ob = await order(C1, "beta-cafe", tea, 1);
    ok(ob.status === 201 && ob.data.paymentRequired === false && ob.data.paymentId === null, "restaurant without payments works as before");
    ok((await call(B.j, "PATCH", `/api/staff/orders/${ob.data.id}`, { status: "ACCEPTED" })).status === 200, "…and can accept immediately");
    await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: false, reservationFee: 0 });
    const o7 = await order(C1, "alpha-grill", tuna, 1);
    ok(o7.data.paymentRequired === false && (await call(A.j, "PATCH", `/api/staff/orders/${o7.data.id}`, { status: "ACCEPTED" })).status === 200, "turning payments off: new orders need no payment");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill").ordersRequirePayment === false, "public flag follows the setting");

    /* cleanup */
    const files = privCount();
    ok(files > 3, "private storage holds the QR codes and receipts");
    ok((await call(admin.j, "DELETE", "/api/admin/restaurants/alpha-grill", { confirmName: "Alpha Grill" })).status === 200 && privCount() < files, "deleting a restaurant removes its QR and receipt files");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
