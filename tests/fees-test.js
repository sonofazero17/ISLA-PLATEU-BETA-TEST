/* Phase 7: fees and taxes (admin-configured platform lines, restaurant charges, breakdown, snapshots, ledger). Self-contained.   Run:  node tests/fees-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3937, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-fee-"));
const ADMIN_PW = "Fees-Test-2026";
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
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
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
    const tuna = (await call(A.j, "POST", "/api/staff/menu", { name: "Grilled Tuna", price: 250 })).data.id, tea = (await call(B.j, "POST", "/api/staff/menu", { name: "Iced Tea", price: 60 })).data.id;
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true }); await call(B.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true });
    await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567" });
    await call(A.j, "POST", "/api/staff/payment-account/qr", png(1), { "Content-Type": "image/png" });
    await call(A.j, "PUT", "/api/staff/payment-account", { holderName: "Juan Dela Cruz", mobile: "09171234567", orderPrepay: true, reservationFee: 50 });
    const [D, T] = ph(2, "12:00"), [RD] = ph(3);
    const quote = (j, rid = "alpha-grill", item = tuna, qty = 1) => call(j, "POST", "/api/orders/quote", { restaurantId: rid, items: [{ menuItemId: item, qty }] });
    const place = (j, extra = {}, rid = "alpha-grill", item = tuna) => call(j, "POST", "/api/orders", { restaurantId: rid, pickupDate: D, pickupTime: T, items: [{ menuItemId: item, qty: 1 }], ...extra });
    const sys = (body) => call(admin.j, "POST", "/api/admin/fee-settings", body);
    const chg = (body) => call(A.j, "POST", "/api/staff/restaurant-charges", body);
    const preview = async (q) => (await call(admin.j, "GET", `/api/admin/fee-preview?${q}`)).data;
    const cents = (arr) => arr.map(l => Math.round(l.amount * 100));

    /* permissions */
    for (const [m, p, b] of [["GET", "/api/admin/fee-settings"], ["POST", "/api/admin/fee-settings", { kind: "SERVICE_FEE" }], ["PATCH", "/api/admin/fee-settings/1", {}], ["DELETE", "/api/admin/fee-settings/1", {}], ["GET", "/api/admin/fee-preview"], ["GET", "/api/admin/fee-ledger"]]) {
      ok((await call(anon, m, p, b)).status === 401 && (await call(C1, m, p, b)).status === 403 && (await call(A.j, m, p, b)).status === 403, `${m} ${p}: guests 401, customers and staff 403`);
    }
    for (const [m, p, b] of [["GET", "/api/staff/restaurant-charges"], ["POST", "/api/staff/restaurant-charges", { kind: "FEE" }]]) ok((await call(anon, m, p, b)).status === 401 && (await call(C1, m, p, b)).status === 403 && (await call(admin.j, m, p, b)).status === 403, `${m} ${p}: guests 401, customers and admins 403`);

    /* nothing is assumed by default */
    ok((await call(admin.j, "GET", "/api/admin/fee-settings")).data.lines.length === 0, "no fee or tax lines exist by default");
    const q0 = await quote(C1);
    ok(q0.data.paymentRequired === true && q0.data.breakdown.length === 1 && q0.data.total === 250 && q0.data.breakdown[0].category === "restaurant", "with nothing configured the customer pays only the restaurant's charge");
    ok((await place(C1)).status === 201 && (await call(C1, "GET", "/api/my/orders")).data[0].payment.amount === 250, "…and the payment is exactly that amount");
    ok((await call(admin.j, "GET", "/api/admin/fee-preview?amount=250")).data.total === 250, "preview with no lines = the plain amount");

    /* validation */
    const good = { kind: "SERVICE_FEE", label: "ISLA-PLATEU service fee", calc: "PERCENT", value: 5, base: "RESTAURANT_TOTAL", appliesTo: "BOTH" };
    for (const [bad, why] of [[{ label: "" }, "empty name"], [{ label: "<b>x</b>" }, "markup in name"], [{ kind: "BANANA" }, "unknown type"], [{ calc: "HALF" }, "unknown calculation"], [{ value: 0 }, "percentage 0"], [{ value: 51 }, "percentage above 50"], [{ value: "abc" }, "non-numeric value"], [{ calc: "FIXED", value: 0 }, "fixed 0"], [{ calc: "FIXED", value: 10001 }, "fixed above 10,000"], [{ base: "SERVICE_FEES" }, "a service fee cannot be based on service fees"], [{ base: "NOPE" }, "unknown base"], [{ appliesTo: "SOMETIMES" }, "unknown scope"]]) ok((await sys({ ...good, ...bad })).status === 400, `fee setting rejected: ${why}`);
    const tax = { kind: "SYSTEM_TAX", label: "Test system tax", calc: "PERCENT", value: 10, base: "SERVICE_FEES", appliesTo: "BOTH" };
    ok((await sys({ ...tax })).status === 400, "a system tax needs a recorded basis and confirmation");
    ok((await sys({ ...tax, basisNote: "short", verified: true })).status === 400, "tax basis must be described (10+ characters)");
    ok((await sys({ ...tax, basisNote: "Accountant memo 2026-11, ref TEST-1", verified: "yes" })).status === 400 && (await sys({ ...tax, basisNote: "Accountant memo 2026-11, ref TEST-1", verified: false })).status === 400, "tax needs an explicit verified=true");
    ok((await sys({ ...tax, base: "FOOD", kind: "SYSTEM_TAX", basisNote: "Accountant memo 2026-11, ref TEST-1", verified: true, active: false })).status === 201, "an inactive tax line can be saved for later (it is not applied)");
    ok((await call(admin.j, "GET", "/api/admin/fee-settings")).data.lines.length === 1, "…and is stored");
    await call(admin.j, "DELETE", `/api/admin/fee-settings/${(await call(admin.j, "GET", "/api/admin/fee-settings")).data.lines[0].id}`, {});

    /* configure: platform fee + fixed fee + tax on the fees; restaurant fee + restaurant tax */
    const s1 = await sys(good), s2 = await sys({ kind: "SERVICE_FEE", label: "Order handling fee", calc: "FIXED", value: 5, base: "FOOD", appliesTo: "ORDER" });
    const s3 = await sys({ ...tax, basisNote: "Accountant memo 2026-11, ref TEST-1", verified: true });
    ok(s1.status === 201 && s2.status === 201 && s3.status === 201, "service fee, fixed fee and a verified tax line created");
    ok((await chg({ kind: "TAX", label: "Test VAT", calc: "PERCENT", value: 12, base: "FOOD_AND_FEES" })).status === 400, "restaurant tax needs the staff member's confirmation");
    ok((await chg({ kind: "FEE", label: "Service charge", calc: "PERCENT", value: 10, base: "FOOD_AND_FEES" })).status === 400, "a restaurant fee cannot use the fees base");
    ok((await chg({ kind: "FEE", label: "", calc: "PERCENT", value: 10 })).status === 400 && (await chg({ kind: "FEE", label: "x", calc: "PERCENT", value: 0 })).status === 400 && (await chg({ kind: "FEE", label: "Fee", calc: "PERCENT", value: 51 })).status === 400, "restaurant charge validation");
    const c1 = await chg({ kind: "FEE", label: "Service charge", calc: "PERCENT", value: 10, base: "FOOD" });
    const c2 = await chg({ kind: "TAX", label: "Test VAT", calc: "PERCENT", value: 12, base: "FOOD_AND_FEES", confirmed: true });
    ok(c1.status === 201 && c2.status === 201, "staff add a restaurant fee and a confirmed tax");
    ok((await call(B.j, "PATCH", `/api/staff/restaurant-charges/${c1.data.id}`, { active: false })).status === 404 && (await call(B.j, "DELETE", `/api/staff/restaurant-charges/${c1.data.id}`, {})).status === 404, "other restaurants' staff cannot touch these charges");
    ok((await call(B.j, "GET", "/api/staff/restaurant-charges")).data.length === 0, "…or see them");
    for (let i = 0; i < 4; i++) await chg({ kind: "FEE", label: "Extra " + i, calc: "FIXED", value: 1, base: "FOOD", active: false });
    ok((await chg({ kind: "FEE", label: "Too many", calc: "FIXED", value: 1 })).status === 409, "a restaurant can have at most 6 extra charges");
    for (const x of (await call(A.j, "GET", "/api/staff/restaurant-charges")).data.filter(c => c.label.startsWith("Extra"))) await call(A.j, "DELETE", `/api/staff/restaurant-charges/${x.id}`, {});

    /* the calculation (hand-checked): 250 + fee 25 + VAT 33 = 308.00; 5% of 308 = 15.40; +5.00; tax 10% of 20.40 = 2.04; total 330.44 */
    const pv = await preview("kind=ORDER&amount=250&restaurantId=alpha-grill");
    ok(cents(pv.breakdown).join() === "25000,2500,3300,1540,500,204" && pv.total === 330.44, "order breakdown: 250.00 + 25.00 + 33.00 + 15.40 + 5.00 + 2.04 = 330.44");
    ok(pv.breakdown.map(l => l.category).join() === "restaurant,restaurant,government_tax,platform_fee,platform_fee,government_tax" && pv.breakdown.map(l => l.owner).join() === "restaurant,restaurant,restaurant,platform,platform,platform", "government taxes, restaurant charges and platform fees are labelled separately, with who owns each line");
    const pr = await preview("kind=RESERVATION&amount=50&restaurantId=alpha-grill");
    ok(cents(pr.breakdown).join() === "5000,500,660,308,31" && pr.total === 64.99, "reservation breakdown (the order-only fee is skipped): 64.99");
    ok((await preview("kind=ORDER&amount=250")).total === 269.25, "preview without a restaurant applies only platform lines (269.25)");
    ok((await preview("kind=ORDER&amount=33.5")).total === 40.85 && cents((await preview("kind=ORDER&amount=33.5")).breakdown).join() === "3350,168,500,67", "rounding: 5% of 33.50 = 1.675 -> 1.68; each line rounded, total is their sum (40.85)");
    ok((await call(admin.j, "GET", "/api/admin/fee-preview?amount=0")).status === 400 && (await call(admin.j, "GET", "/api/admin/fee-preview?amount=250&restaurantId=nope")).status === 404, "preview validates its input");

    /* customer sees the same numbers before paying, and the payment keeps a snapshot */
    const q1 = await quote(C1);
    ok(q1.data.subtotal === 250 && q1.data.total === 330.44 && cents(q1.data.breakdown).join() === "25000,2500,3300,1540,500,204", "order review shows the full breakdown and the total payable");
    ok(q1.data.breakdown[2].label === "Test VAT" && q1.data.breakdown[5].label === "Test system tax", "…with each line's own name");
    ok((await place(C1, { expectedTotal: 250 })).status === 409 && (await place(C1, { expectedTotal: 330.43 })).status === 409, "placing with a total that is not what the server computes is refused");
    const o1 = await place(C1, { expectedTotal: 330.44, pickupTime: "13:00" });
    ok(o1.status === 201 && o1.data.payable === 330.44 && o1.data.total === 250, "placing with the confirmed total works (items 250, payable 330.44)");
    const pay1 = (await call(C1, "GET", `/api/payments/${o1.data.paymentId}`)).data;
    ok(pay1.amount === 330.44 && cents(pay1.breakdown).join() === "25000,2500,3300,1540,500,204" && pay1.breakdown[3].category === "platform_fee", "the payment stores the amount and the categorised breakdown");
    ok((await call(A.j, "GET", "/api/staff/payments?filter=all")).data.payments.find(p => p.id === o1.data.paymentId).amount === 330.44, "staff see the same amount due");

    /* changing settings never alters an existing payment, and stale reviews are caught */
    const lines = (await call(admin.j, "GET", "/api/admin/fee-settings")).data.lines, svc1 = lines.find(l => l.label === "ISLA-PLATEU service fee"), svc2 = lines.find(l => l.label === "Order handling fee"), tx = lines.find(l => l.kind === "SYSTEM_TAX");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${svc1.id}`, { active: false })).status === 200, "admin switches the service fee off");
    ok((await call(C1, "GET", `/api/payments/${o1.data.paymentId}`)).data.amount === 330.44, "the existing payment is unchanged");
    ok(cents((await quote(C1)).data.breakdown).join() === "25000,2500,3300,500,50" && (await quote(C1)).data.total === 313.5, "new quotes follow the new settings (313.50)");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${svc1.id}`, { active: true })).status === 200 && (await quote(C1)).data.total === 330.44, "service fee switched back on");
    const staleTotal = (await quote(C1)).data.total;
    await call(admin.j, "PATCH", `/api/admin/fee-settings/${svc2.id}`, { calc: "FIXED", value: 6 });
    const stale = await place(C1, { expectedTotal: staleTotal, pickupTime: "14:00" });
    ok(stale.status === 409 && /changed since you reviewed/.test(stale.data.error), "fees changed while reviewing -> the order is refused and the customer is told to review again");
    await call(admin.j, "PATCH", `/api/admin/fee-settings/${svc2.id}`, { calc: "FIXED", value: 5 });

    /* tax lines must be re-verified when they change */
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { calc: "PERCENT", value: 11 })).status === 400, "changing a tax rate needs the verification again");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { calc: "PERCENT", value: 11, verified: true })).status === 200 && (await preview("kind=ORDER&amount=250&restaurantId=alpha-grill")).total === 330.64, "…and works with it (11% of 20.40 = 2.24 -> total 330.64)");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { active: false })).status === 200 && (await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { active: true })).status === 400, "re-activating a tax also needs verification");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { active: true, verified: true })).status === 200, "…and works with it");
    ok((await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { label: "Renamed tax" })).status === 200, "renaming does not need re-verification");
    ok((await call(admin.j, "PATCH", "/api/admin/fee-settings/99999", {})).status === 404, "unknown line = 404");
    await call(admin.j, "PATCH", `/api/admin/fee-settings/${tx.id}`, { calc: "PERCENT", value: 10, verified: true });

    /* restaurants without payments are unaffected */
    const qb = await quote(C1, "beta-cafe", tea);
    ok(qb.data.paymentRequired === false && qb.data.breakdown === null && qb.data.total === 60, "a restaurant that takes no payment through the system gets no fees or taxes");
    ok((await call(anon, "GET", "/api/restaurants/beta-cafe/reservation-quote")).data.feeRequired === false, "…and no reservation fee quote");

    /* reservation quote and payment */
    const rq = await call(anon, "GET", "/api/restaurants/alpha-grill/reservation-quote");
    ok(rq.data.feeRequired === true && rq.data.total === 64.99 && cents(rq.data.breakdown).join() === "5000,500,660,308,31", "public reservation quote shows the full breakdown");
    ok((await call(C1, "POST", "/api/reservations", { restaurantId: "alpha-grill", date: RD, time: "19:00", partySize: 2, expectedTotal: 50 })).status === 409, "a reservation whose reviewed total is wrong is refused");
    const rv = await call(C1, "POST", "/api/reservations", { restaurantId: "alpha-grill", date: RD, time: "19:00", partySize: 2, expectedTotal: 64.99 });
    ok(rv.status === 201 && (await call(C1, "GET", `/api/payments/${rv.data.paymentId}`)).data.amount === 64.99, "reservation payment = 64.99");

    /* ledger: only accepted payments, split by owner */
    const proof = (j, id, n, ref, amount) => call(j, "POST", `/api/payments/${id}/proof?reference=${ref}&amount=${amount}`, png(n), { "Content-Type": "image/png" });
    await proof(C1, o1.data.paymentId, 50, "LEDGER00001", 330.44);
    ok((await call(A.j, "POST", `/api/staff/payments/${o1.data.paymentId}/decision`, { decision: "ACCEPTED", verified: true })).status === 200, "staff accept the 330.44 payment");
    const o2 = await place(C2, { pickupTime: "15:00" });
    await proof(C2, o2.data.paymentId, 51, "LEDGER00002", 330.44);
    await call(A.j, "POST", `/api/staff/payments/${o2.data.paymentId}/decision`, { decision: "ACCEPTED", verified: true });
    await call(A.j, "PATCH", `/api/staff/orders/${o2.data.id}`, { status: "ACCEPTED" }); await call(A.j, "PATCH", `/api/staff/orders/${o2.data.id}`, { status: "CANCELLED", note: "test" });
    ok((await call(A.j, "POST", `/api/staff/payments/${o2.data.paymentId}/refund`, { note: "refunded" })).status === 200, "second payment accepted then refunded");
    const lg = (await call(admin.j, "GET", "/api/admin/fee-ledger")).data, row = lg.restaurants.find(r => r.restaurantId === "alpha-grill");
    ok(row && row.payments === 1 && row.collected === 330.44 && row.restaurantShare === 308 && row.platformFees === 20.4 && row.systemTaxes === 2.04, "ledger: collected 330.44 = restaurant 308.00 + ISLA-PLATEU fees 20.40 + system tax 2.04 (refunded payment excluded)");
    ok(lg.totals.platformFees === 20.4 && lg.totals.payments === 1, "ledger totals add up");
    ok((await call(admin.j, "GET", "/api/admin/fee-ledger?from=2020-01-01&to=2020-01-31")).data.restaurants.length === 0, "ledger honours the date range");
    ok((await call(admin.j, "GET", "/api/admin/fee-ledger?from=2026-02-01&to=2026-01-01")).status === 400 && (await call(admin.j, "GET", "/api/admin/fee-ledger?from=bad")).status === 400, "ledger rejects an invalid range");

    /* oversight and audit */
    const all_ = (await call(admin.j, "GET", "/api/admin/fee-settings")).data;
    ok(all_.restaurantCharges.some(c => c.restaurantName === "Alpha Grill" && c.label === "Test VAT" && c.confirmedAt), "admin can see every restaurant's own charges, with the confirmation time");
    ok(all_.lines.find(l => l.kind === "SYSTEM_TAX").verifiedAt && /Accountant memo/.test(all_.lines.find(l => l.kind === "SYSTEM_TAX").basisNote), "tax lines record the basis and when they were verified");
    ok((await call(admin.j, "DELETE", `/api/admin/fee-settings/${svc2.id}`, {})).status === 200 && (await quote(C1)).data.breakdown.every(l => l.label !== "Order handling fee"), "deleting a line removes it from new quotes");
    const logs = JSON.stringify((await call(admin.j, "GET", "/api/admin/audit-logs?limit=300")).data);
    ok(["fee_setting.created", "fee_setting.updated", "fee_setting.deleted", "restaurant_charge.created"].every(a => logs.includes(a)) && /verifiedBy/.test(logs) && /Accountant memo/.test(logs), "every configuration change is audited, including the tax basis and who verified it");
    ok((await call(admin.j, "DELETE", "/api/admin/restaurants/beta-cafe", { confirmName: "Beta Cafe" })).status === 200, "restaurants (with their charges) can still be deleted");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
