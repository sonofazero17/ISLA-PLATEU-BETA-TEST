/* Phase 5: advance ordering (pricing, fulfilment, status flow, cancellation, tracking). Self-contained.   Run:  node tests/orders-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3935, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-ord-"));
const ADMIN_PW = "Orders-Test-2026";
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

(async () => {
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    const mkRest = (name) => call(admin.j, "POST", "/api/admin/restaurants", { name, municipality: "Larena", category: "Restaurant", address: "Larena" });
    await mkRest("Alpha Grill"); await mkRest("Beta Cafe"); await mkRest("Gamma Closed");
    const mkStaff = async (n, rid) => { const s = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff " + n, email: `${n}@example.com`, restaurantId: rid }); return login("RESTAURANT_STAFF", `${n}@example.com`, s.data.temporaryPassword); };
    const A = await mkStaff("alpha", "alpha-grill"), B = await mkStaff("beta", "beta-cafe"), G = await mkStaff("gamma", "gamma-closed");
    const mkCust = async (n) => { await call(jar(), "POST", "/api/register", { fullName: n + " Customer", email: `${n}@example.com`, password: "Island2026", confirmPassword: "Island2026" }); return (await login("CUSTOMER", `${n}@example.com`, "Island2026")).j; };
    const C1 = await mkCust("cara"), C2 = await mkCust("dan"), anon = jar();
    const food = async (j, name, price) => (await call(j, "POST", "/api/staff/menu", { name, price, description: name + " desc", category: "Main dish" })).data.id;
    const tuna = await food(A.j, "Grilled Tuna", 250), rice = await food(A.j, "Garlic Rice", 40), pie = await food(A.j, "Buko Pie", 90);
    await food(G.j, "Soup", 50); // Gamma never enables ordering
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true }); await call(B.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true });
    await call(A.j, "PATCH", `/api/staff/menu/${pie}`, { available: false });
    const [D, T] = ph(2, "12:00");
    const quote = (j, body) => call(j, "POST", "/api/orders/quote", { restaurantId: "alpha-grill", ...body });
    const place = (j, body = {}) => call(j, "POST", "/api/orders", { restaurantId: "alpha-grill", pickupDate: D, pickupTime: T, items: [{ menuItemId: tuna, qty: 2 }, { menuItemId: rice, qty: 3 }], ...body });
    const status = (j, id, st, extra = {}) => call(j, "PATCH", `/api/staff/orders/${id}`, { status: st, ...extra });
    const mine = async (j) => (await call(j, "GET", "/api/my/orders")).data;

    /* review step (server-priced) */
    ok((await quote(anon, { items: [{ menuItemId: tuna, qty: 1 }] })).status === 401, "guest cannot get a quote");
    ok((await quote(A.j, { items: [{ menuItemId: tuna, qty: 1 }] })).status === 403, "staff cannot use the customer quote");
    ok((await call(C1, "POST", "/api/orders/quote", { restaurantId: "nope", items: [] })).status === 404, "quote: unknown restaurant");
    ok((await call(C1, "POST", "/api/orders/quote", { restaurantId: "gamma-closed", items: [{ menuItemId: 1, qty: 1 }] })).status === 409, "quote: restaurant that does not take orders");
    ok((await quote(C1, { items: [] })).status === 400, "quote: empty basket rejected");
    ok((await quote(C1, { items: [{ menuItemId: pie, qty: 1 }] })).status === 400, "quote: unavailable item rejected");
    ok((await quote(C1, { items: [{ menuItemId: tuna, qty: 0 }] })).status === 400 && (await quote(C1, { items: [{ menuItemId: tuna, qty: 21 }] })).status === 400, "quote: quantity must be 1-20");
    ok((await quote(C1, { items: [{ menuItemId: tuna, qty: 1 }, { menuItemId: tuna, qty: 1 }] })).status === 400, "quote: duplicate lines rejected");
    ok((await quote(C1, { items: [{ menuItemId: 99999, qty: 1 }] })).status === 400, "quote: unknown item rejected");
    const g1 = await call(jar(), "GET", "/api/restaurants/gamma-closed"); const gId = g1.data.menu[0].id;
    ok((await quote(C1, { items: [{ menuItemId: gId, qty: 1 }] })).status === 400, "quote: another restaurant's item rejected");
    const q = await quote(C1, { items: [{ menuItemId: tuna, qty: 2, price: 1 }, { menuItemId: rice, qty: 3 }], fulfillment: "PICKUP" });
    ok(q.status === 200 && q.data.subtotal === 620 && q.data.total === 620 && q.data.items[0].lineTotal === 500 && q.data.items[1].lineTotal === 120, "quote: totals come from database prices (a tampered price is ignored)");
    ok(q.data.items[0].name === "Grilled Tuna" && q.data.fulfillmentLabel === "Pickup", "quote: names, fulfilment label returned");
    ok((await quote(C1, { items: [{ menuItemId: tuna, qty: 1 }], fulfillment: "DINE_IN" })).status === 409, "dine-in refused while the restaurant does not offer it");
    ok((await quote(C1, { items: [{ menuItemId: tuna, qty: 1 }], fulfillment: "DELIVERY" })).status === 400, "unsupported option (delivery) rejected");

    /* dine-in option is controlled by the restaurant */
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill").fulfillmentOptions.join() === "PICKUP", "map data: only pickup offered by default");
    ok((await call(A.j, "PATCH", "/api/staff/restaurant", { orderDineIn: true })).status === 200, "staff turns on dine-in pre-orders");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill").fulfillmentOptions.join() === "PICKUP,DINE_IN", "map data now offers pickup and dine-in");

    /* placing orders */
    ok((await place(C1, { pickupDate: ph(-1)[0] })).status === 400, "pickup date in the past rejected");
    const soon = new Date(Date.now() + 8 * 3600e3 + 10 * 60000).toISOString();
    ok((await place(C1, { pickupDate: soon.slice(0, 10), pickupTime: soon.slice(11, 16) })).status === 400, "pickup less than 30 minutes ahead rejected");
    ok((await place(C1, { notes: "<b>x</b>" })).status === 400, "markup in notes rejected");
    ok((await place(anon)).status === 401 && (await place(A.j)).status === 403, "guests and staff cannot place orders");
    const o1 = await place(C1, { notes: "No chili", items: [{ menuItemId: tuna, qty: 2, price: 1, priceCents: 1 }, { menuItemId: rice, qty: 3 }] });
    ok(o1.status === 201 && o1.data.total === 620, "order placed; tampered price ignored (total 620)");
    const list1 = await mine(C1), mo = list1.find(o => o.id === o1.data.id);
    ok(mo.fulfillment === "PICKUP" && mo.items.length === 2 && mo.items[0].lineTotal === 500 && mo.history.length === 1 && mo.history[0].status === "PENDING", "customer sees items, line totals, fulfilment and a first history entry");
    ok((await mine(C2)).length === 0, "another customer cannot see this order");
    const dine = await place(C2, { fulfillment: "DINE_IN", items: [{ menuItemId: rice, qty: 1 }] });
    ok(dine.status === 201 && (await mine(C2))[0].fulfillmentLabel.startsWith("Dine-in"), "dine-in order placed and labelled");
    const sl = (await call(A.j, "GET", "/api/staff/orders")).data;
    ok(sl.length === 2 && sl.find(o => o.id === dine.data.id).fulfillment === "DINE_IN" && sl.find(o => o.id === o1.data.id).customerEmail === "cara@example.com", "staff see both orders with fulfilment and customer details");
    ok((await call(B.j, "GET", "/api/staff/orders")).data.length === 0, "another restaurant's staff see none of them");
    ok((await status(B.j, o1.data.id, "ACCEPTED")).status === 404, "another restaurant's staff cannot update the order");
    ok((await status(C1, o1.data.id, "ACCEPTED")).status === 403, "customer cannot update order status");

    /* status flow */
    ok((await status(A.j, o1.data.id, "READY")).status === 409 && (await status(A.j, o1.data.id, "COMPLETED")).status === 409 && (await status(A.j, o1.data.id, "CANCELLED", { note: "x" })).status === 409, "cannot skip steps or cancel a pending order (reject it instead)");
    ok((await status(A.j, o1.data.id, "BANANA")).status === 409, "invalid status rejected");
    ok((await status(A.j, o1.data.id, "ACCEPTED")).status === 200, "staff accepts");
    ok((await call(C1, "POST", `/api/orders/${o1.data.id}/cancel`, {})).status === 409, "customer cannot cancel after the restaurant accepted");
    ok((await status(A.j, o1.data.id, "PREPARING")).status === 200, "staff marks preparing");
    ok((await status(A.j, o1.data.id, "ACCEPTED")).status === 409, "cannot go backwards");
    ok((await status(A.j, o1.data.id, "READY")).status === 200, "staff marks ready");
    ok((await status(A.j, o1.data.id, "COMPLETED")).status === 200, "staff marks completed");
    ok((await status(A.j, o1.data.id, "CANCELLED", { note: "late" })).status === 409, "completed orders are final");
    const tr = (await mine(C1)).find(o => o.id === o1.data.id);
    ok(tr.status === "COMPLETED" && tr.history.map(h => h.status).join() === "PENDING,ACCEPTED,PREPARING,READY,COMPLETED", "customer tracking shows every step in order");
    const nt = JSON.stringify((await call(C1, "GET", "/api/notifications")).data);
    ok(/PREPARING/.test(nt) && /READY/.test(nt) && /COMPLETED/.test(nt), "customer was notified at each step");

    /* staff cancellation with a reason */
    const o2 = await place(C1, { items: [{ menuItemId: rice, qty: 2 }] });
    await status(A.j, o2.data.id, "ACCEPTED");
    ok((await status(A.j, o2.data.id, "CANCELLED")).status === 400, "cancelling an accepted order needs a reason");
    ok((await status(A.j, o2.data.id, "CANCELLED", { note: "<i>x</i>" })).status === 400, "markup in the reason rejected");
    ok((await status(A.j, o2.data.id, "CANCELLED", { note: "Kitchen ran out of rice" })).status === 200, "staff cancels with a reason");
    const c2 = (await mine(C1)).find(o => o.id === o2.data.id);
    ok(c2.status === "CANCELLED" && c2.staffNote === "Kitchen ran out of rice" && c2.history.at(-1).note === "Kitchen ran out of rice", "customer sees the cancellation reason");
    ok(/ran out of rice/.test(JSON.stringify((await call(C1, "GET", "/api/notifications")).data)), "customer notified with the reason");

    /* reject (reason optional) and customer cancel (pending only) */
    const o3 = await place(C1, { items: [{ menuItemId: rice, qty: 1 }] }), o3b = await place(C2, { items: [{ menuItemId: rice, qty: 1 }], pickupTime: "13:00" });
    ok((await status(A.j, o3.data.id, "REJECTED", { note: "Closed that day" })).status === 200 && (await mine(C1)).find(o => o.id === o3.data.id).staffNote === "Closed that day", "staff rejects with a note");
    ok((await call(C2, "POST", `/api/orders/${o3b.data.id}/cancel`, {})).status === 200, "customer cancels a pending order");
    ok((await mine(C2)).find(o => o.id === o3b.data.id).history.at(-1).note === "Cancelled by the customer", "history records customer cancellation");
    ok((await call(C1, "POST", `/api/orders/${o3b.data.id}/cancel`, {})).status === 404, "customers cannot cancel someone else's order");

    /* snapshots and availability */
    const qBefore = await quote(C1, { items: [{ menuItemId: tuna, qty: 1 }] });
    await call(A.j, "PATCH", `/api/staff/menu/${tuna}`, { price: 300 });
    ok((await mine(C1)).find(o => o.id === o1.data.id).total === 620, "past orders keep the price they were placed at");
    ok((await quote(C1, { items: [{ menuItemId: tuna, qty: 1 }] })).data.total === 300 && qBefore.data.total === 250, "new quotes use the new menu price");
    await call(A.j, "PATCH", `/api/staff/menu/${tuna}`, { available: false });
    ok((await place(C1, { items: [{ menuItemId: tuna, qty: 1 }] })).status === 400, "an item that became unavailable cannot be ordered");
    ok((await call(A.j, "PATCH", "/api/staff/restaurant", { orderDineIn: false })).status === 200 && (await place(C1, { fulfillment: "DINE_IN", items: [{ menuItemId: rice, qty: 1 }] })).status === 409, "turning dine-in off blocks new dine-in orders");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
