/* Feature/permission integration test. Needs a running server started with a FRESH database and
   OSRM_URL pointing at the mock below:   node tests/features-test.js   (it starts its own mock routing server on :3444)
   Usage: BASE=http://localhost:3555 ADMIN_PW=<first-run admin password> node tests/features-test.js */
const http = require("node:http");
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; };
async function call(j, method, path, body) {
  const res = await fetch(BASE + path, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  j.set(res.headers.get("set-cookie"));
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const ph = (days, hh = "19:00") => { const d = new Date(Date.now() + 8 * 3600e3 + days * 864e5); return [d.toISOString().slice(0, 10), hh]; };
const portalFor = (email) => email === "admin@islaplateu.local" ? "ADMINISTRATOR" : /^(sam|sue)/.test(email) ? "RESTAURANT_STAFF" : "CUSTOMER";
async function login(email, password) { const j = jar(); const r = await call(j, "POST", "/api/login", { portal: portalFor(email), email, password }); return { j, r }; }
async function signup(name, email) { await call(jar(), "POST", "/api/register", { fullName: name, email, password: "Island2026", confirmPassword: "Island2026" }); return login(email, "Island2026"); }

// mock OSRM: returns a fixed 2-point route so the server-side proxy can be tested without internet
const mock = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.includes("/route/v1/driving/123.0,9.0;")) return res.end(JSON.stringify({ code: "NoRoute" }));
  res.end(JSON.stringify({ code: "Ok", routes: [{ distance: 4321.5, duration: 612.2, geometry: { type: "LineString", coordinates: [[123.5, 9.2], [123.51, 9.17]] } }] }));
}).listen(3444);

(async () => {
  const anon = jar();
  /* public */
  const list = await call(anon, "GET", "/api/restaurants");
  ok(list.status === 200 && list.data.length >= 5, "guest can read the restaurant list");
  ok((await call(anon, "GET", "/api/restaurants/la-candura")).status === 200, "guest can read restaurant details");
  ok((await call(anon, "GET", "/api/restaurants/nope")).status === 404, "unknown restaurant = 404");
  for (const [m, p] of [["GET", "/api/route?from=9.2,123.5&restaurantId=la-candura"], ["POST", "/api/reservations"], ["POST", "/api/orders"], ["POST", "/api/inquiries"], ["GET", "/api/my/reservations"], ["GET", "/api/notifications"], ["GET", "/api/staff/restaurant"], ["POST", "/api/admin/restaurants"], ["GET", "/api/admin/stats"]]) {
    const r = await call(anon, m, p, m === "POST" ? {} : undefined);
    ok(r.status === 401, `guest blocked: ${m} ${p.split("?")[0]} = 401`);
  }
  ok((await fetch(BASE + "/", { redirect: "manual" })).status === 200, "introduction page is public at /");
  ok((await fetch(BASE + "/map", { redirect: "manual" })).status === 200, "map page is public at /map");

  /* accounts */
  const admin = await login("admin@islaplateu.local", process.env.ADMIN_PW);
  ok(admin.r.status === 200, "admin login");
  const cust = await signup("Ana Reyes", `ana${Date.now()}@example.com`);
  const cust2 = await signup("Ben Cruz", `ben${Date.now()}@example.com`);
  ok(cust.r.status === 200 && cust2.r.status === 200, "two customers registered and logged in");

  /* routing (server-side proxy) */
  const rt = await call(cust.j, "GET", "/api/route?from=9.2,123.5&restaurantId=la-candura");
  ok(rt.status === 200 && rt.data.distanceMeters === 4321.5 && rt.data.durationSeconds === 612.2 && rt.data.geometry[0][0] === 9.2, "customer route returns distance, time and lat/lng geometry");
  ok((await call(cust.j, "GET", "/api/route?from=9.2,123.5&restaurantId=pagudfood")).status === 409, "no route to a restaurant without a confirmed pin (no fake location)");
  ok((await call(cust.j, "GET", "/api/route?from=abc&restaurantId=la-candura")).status === 400, "malformed start location rejected");
  ok((await call(cust.j, "GET", "/api/route?from=9.0,123.0&restaurantId=la-candura")).status === 404, "routing engine NoRoute -> clear 404");
  ok((await call(admin.j, "GET", "/api/route?from=9.2,123.5&restaurantId=dagsa-resto")).status === 200, "administrator can route too");

  /* admin: restaurant CRUD */
  ok((await call(cust.j, "POST", "/api/admin/restaurants", { name: "Hack Cafe" })).status === 403, "customer cannot add a restaurant (403)");
  const bad1 = await call(admin.j, "POST", "/api/admin/restaurants", { name: "Far Away", lat: 14.5, lng: 121 });
  ok(bad1.status === 400, "coordinates outside Siquijor rejected");
  ok((await call(admin.j, "POST", "/api/admin/restaurants", { name: "Half Pin", lat: 9.2 })).status === 400, "latitude without longitude rejected");
  ok((await call(admin.j, "POST", "/api/admin/restaurants", { name: "<b>x</b>" })).status === 400, "markup in names rejected");
  const created = await call(admin.j, "POST", "/api/admin/restaurants", { name: "Test Kitchen", municipality: "Larena", category: "Restaurant", address: "Larena", lat: 9.25, lng: 123.6, verified: true, acceptsOrders: true, reservationCapacity: 6 });
  ok(created.status === 201 && created.data.id === "test-kitchen", "administrator adds a restaurant with a validated pin");
  const second = await call(admin.j, "POST", "/api/admin/restaurants", { name: "Second Place", municipality: "Lazi" });
  ok(second.status === 201, "administrator adds an address-only restaurant (no pin)");
  const got = (await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "test-kitchen");
  ok(got && got.lat === 9.25 && got.verified === true && got.locationStatus === "verified", "new restaurant is persisted and public with its saved pin");
  ok((await call(admin.j, "PUT", "/api/admin/restaurants/second-place", { description: "Garden seating", lat: 9.15, lng: 123.55 })).status === 200, "administrator edits a restaurant and sets its pin");
  ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "second-place").locationStatus === "approximate", "pin saved as approximate until marked verified");

  /* admin: staff accounts */
  const st1 = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Sam Staff", email: `sam${Date.now()}@example.com`, restaurantId: "test-kitchen" });
  ok(st1.status === 201 && st1.data.temporaryPassword.length >= 10, "administrator creates a staff account with a one-time password");
  const st2 = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Sue Staff", email: `sue${Date.now()}@example.com`, restaurantId: "second-place" });
  ok((await call(admin.j, "POST", "/api/admin/staff", { fullName: "Dup", email: st1.data.email, restaurantId: "test-kitchen" })).status === 409, "duplicate staff email rejected");
  ok((await call(admin.j, "POST", "/api/admin/staff", { fullName: "No Rest", email: "n@x.com", restaurantId: "zzz" })).status === 400, "staff must be assigned to a real restaurant");
  ok((await call(cust.j, "POST", "/api/admin/staff", { fullName: "Eve", email: "eve@x.com", restaurantId: "test-kitchen" })).status === 403, "customer cannot create staff");
  const staff = await login(st1.data.email, st1.data.temporaryPassword), staff2 = await login(st2.data.email, st2.data.temporaryPassword);
  ok(staff.r.status === 200 && staff.r.data.redirect === "/staff", "new staff logs in -> /staff");
  ok((await call(staff.j, "GET", "/api/admin/stats")).status === 403, "staff cannot read admin statistics");
  ok((await call(staff.j, "POST", "/api/admin/restaurants", { name: "Nope" })).status === 403, "staff cannot add restaurants");
  ok((await call(staff.j, "DELETE", "/api/admin/restaurants/test-kitchen", { confirmName: "Test Kitchen" })).status === 403, "staff cannot delete restaurants");
  const sr = await call(staff.j, "GET", "/api/staff/restaurant");
  ok(sr.status === 200 && sr.data.restaurant.id === "test-kitchen", "staff sees only their assigned restaurant");
  ok((await call(staff.j, "PATCH", "/api/staff/restaurant", { hours: "9AM-9PM", contact: "+63 900 000 0000", name: "Renamed", lat: 1, lng: 1 })).status === 200, "staff can update operational details");
  const after = (await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "test-kitchen");
  ok(after.hours === "9AM-9PM" && after.name === "Test Kitchen" && after.lat === 9.25, "staff cannot change the name or coordinates (ignored)");
  ok((await call(cust.j, "GET", "/api/staff/reservations")).status === 403, "customer cannot open staff endpoints");

  /* reservations */
  const [d1, t1] = ph(2), [dPast, tPast] = ph(-1);
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: dPast, time: tPast, partySize: 2 })).status === 400, "past reservation rejected");
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: "2026-02-31", time: "19:00", partySize: 2 })).status === 400, "impossible date rejected");
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 0 })).status === 400, "party size 0 rejected");
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 2, notes: "<script>alert(1)</script>" })).status === 400, "markup in notes rejected");
  ok((await call(staff.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 2 })).status === 403, "staff cannot create reservations as a customer");
  const r1 = await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 4, notes: "Window seat" });
  ok(r1.status === 201 && r1.data.status === "PENDING", "customer reservation stored as PENDING");
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 2 })).status === 409, "duplicate reservation (same slot) rejected");
  ok((await call(cust2.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 3 })).status === 409, "capacity (6) enforced: 4 + 3 > 6 is refused");
  ok((await call(cust2.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: d1, time: t1, partySize: 2 })).status === 201, "capacity allows 4 + 2 = 6");
  const mine = await call(cust.j, "GET", "/api/my/reservations");
  ok(mine.data.length === 1 && mine.data[0].restaurantName === "Test Kitchen", "customer sees only their own reservation");
  const sres = await call(staff.j, "GET", "/api/staff/reservations");
  ok(sres.data.length === 2 && sres.data.every(v => v.restaurantId === "test-kitchen"), "staff sees both requests for their restaurant");
  ok((await call(staff2.j, "GET", "/api/staff/reservations")).data.length === 0, "other restaurant's staff sees none of them");
  ok((await call(staff2.j, "PATCH", `/api/staff/reservations/${r1.data.id}`, { status: "CONFIRMED" })).status === 404, "other restaurant's staff cannot change it (404)");
  ok((await call(staff.j, "PATCH", `/api/staff/reservations/${r1.data.id}`, { status: "COMPLETED" })).status === 409, "invalid status jump PENDING -> COMPLETED refused");
  ok((await call(staff.j, "PATCH", `/api/staff/reservations/${r1.data.id}`, { status: "CONFIRMED", staffNote: "See you!" })).status === 200, "staff confirms the reservation");
  const notes = await call(cust.j, "GET", "/api/notifications");
  ok(notes.data.unread >= 1 && /CONFIRMED/.test(notes.data.items[0].message), "customer is notified of the confirmation");
  ok((await call(cust.j, "POST", `/api/reservations/${r1.data.id}/cancel`)).status === 200, "customer cancels their reservation");
  ok((await call(cust2.j, "POST", `/api/reservations/${r1.data.id}/cancel`)).status === 404, "another customer cannot cancel it");
  await call(admin.j, "PATCH", "/api/staff/restaurant", {});
  const noRes = await call(staff.j, "PATCH", "/api/staff/restaurant", { acceptsReservations: false });
  ok((await call(cust.j, "POST", "/api/reservations", { restaurantId: "test-kitchen", date: ph(3)[0], time: "18:00", partySize: 2 })).status === 409, "restaurant that stopped accepting reservations refuses new ones");
  await call(staff.j, "PATCH", "/api/staff/restaurant", { acceptsReservations: true });

  /* menu + advance orders */
  ok((await call(cust.j, "POST", "/api/orders", { restaurantId: "test-kitchen", pickupDate: ph(2)[0], pickupTime: "12:00", items: [{ menuItemId: 1, qty: 1 }] })).status === 409, "orders refused while the restaurant has no menu");
  const m1 = await call(staff.j, "POST", "/api/staff/menu", { name: "Grilled Tuna", price: 250.5, description: "Fresh catch" });
  const m2 = await call(staff.j, "POST", "/api/staff/menu", { name: "Halo-halo", price: 90 });
  ok(m1.status === 201 && m2.status === 201, "staff builds a menu");
  ok((await call(staff.j, "POST", "/api/staff/menu", { name: "Free", price: 0 })).status === 400, "zero price rejected");
  ok((await call(staff2.j, "PATCH", `/api/staff/menu/${m1.data.id}`, { price: 1 })).status === 404, "other restaurant's staff cannot edit this menu");
  const det = await call(anon, "GET", "/api/restaurants/test-kitchen");
  ok(det.data.menu.length === 2 && det.data.restaurant.acceptsOrders === true, "public details list the menu and show ordering enabled");
  const ord = await call(cust.j, "POST", "/api/orders", { restaurantId: "test-kitchen", pickupDate: ph(1)[0], pickupTime: "12:00", notes: "No chili", items: [{ menuItemId: m1.data.id, qty: 2, price: 1 }, { menuItemId: m2.data.id, qty: 1 }] });
  ok(ord.status === 201 && ord.data.total === 591, "order total is computed from database prices (client price ignored): 2x250.50 + 90 = 591");
  ok((await call(cust.j, "POST", "/api/orders", { restaurantId: "test-kitchen", pickupDate: ph(1)[0], pickupTime: "12:00", items: [{ menuItemId: 999999, qty: 1 }] })).status === 400, "unknown menu item rejected");
  ok((await call(cust.j, "POST", "/api/orders", { restaurantId: "test-kitchen", pickupDate: ph(1)[0], pickupTime: "12:00", items: [{ menuItemId: m2.data.id, qty: 0 }] })).status === 400, "quantity 0 rejected");
  const so = await call(staff.j, "GET", "/api/staff/orders");
  ok(so.data.length === 1 && so.data[0].items.length === 2 && so.data[0].notes === "No chili", "staff sees items, quantities and notes");
  ok((await call(staff.j, "PATCH", `/api/staff/orders/${ord.data.id}`, { status: "READY" })).status === 409, "order cannot skip PENDING -> READY");
  for (const s of ["ACCEPTED", "PREPARING", "READY", "COMPLETED"]) ok((await call(staff.j, "PATCH", `/api/staff/orders/${ord.data.id}`, { status: s })).status === 200, `order status -> ${s}`);
  ok((await call(cust.j, "GET", "/api/my/orders")).data[0].status === "COMPLETED", "customer sees the final order status");
  ok((await call(cust.j, "POST", `/api/orders/${ord.data.id}/cancel`)).status === 409, "completed order cannot be cancelled");

  /* inquiries */
  const inq = await call(cust.j, "POST", "/api/inquiries", { restaurantId: "test-kitchen", subject: "Allergies", message: "Do you have nut-free dishes?" });
  ok(inq.status === 201, "customer sends an inquiry");
  ok((await call(staff.j, "GET", "/api/staff/inquiries")).data[0].messages.length === 1, "staff sees the inquiry");
  ok((await call(staff2.j, "POST", `/api/inquiries/${inq.data.id}/messages`, { body: "intruder" })).status === 404, "other restaurant's staff cannot read or reply");
  ok((await call(cust2.j, "POST", `/api/inquiries/${inq.data.id}/messages`, { body: "intruder" })).status === 404, "other customer cannot reply");
  ok((await call(staff.j, "POST", `/api/inquiries/${inq.data.id}/messages`, { body: "Yes, we do." })).status === 201, "staff replies");
  const th = (await call(cust.j, "GET", "/api/my/inquiries")).data[0];
  ok(th.messages.length === 2 && th.messages[1].from === "STAFF", "customer sees the staff reply in the thread");

  /* reviews */
  ok((await call(anon, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 5 })).status === 401, "guest cannot review");
  ok((await call(staff.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 5 })).status === 403, "staff cannot post reviews");
  ok((await call(admin.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 5 })).status === 403, "administrator cannot post reviews");
  ok((await call(cust.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 6 })).status === 400, "rating 6 rejected");
  ok((await call(cust.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 5, comment: "Great tuna" })).status === 201, "customer posts a review");
  ok((await call(cust.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 4, comment: "Great tuna, slow service" })).data.updated === true, "second submit updates (no duplicate review)");
  ok((await call(cust2.j, "POST", "/api/restaurants/test-kitchen/reviews", { rating: 3 })).status === 201, "second customer can review");
  const rv = (await call(anon, "GET", "/api/restaurants/test-kitchen")).data;
  ok(rv.restaurant.ratingCount === 2 && rv.restaurant.ratingAvg === 3.5, "public average rating = (4 + 3) / 2 = 3.5");
  ok(rv.reviews.every(v => !("email" in v)), "public reviews do not expose emails");
  const sv = (await call(staff.j, "GET", "/api/staff/reviews")).data;
  ok(sv.count === 2 && sv.reviews.length === 2, "staff can read their restaurant's reviews");
  ok((await call(staff.j, "DELETE", "/api/staff/reviews/1")).status === 404, "staff has no way to delete reviews");

  /* admin stats come from real data */
  const stats = (await call(admin.j, "GET", "/api/admin/stats")).data;
  ok(stats.users.byRole.CUSTOMER === 2 && stats.users.byRole.RESTAURANT_STAFF === 2 && stats.users.byRole.ADMINISTRATOR === 1, "stats: user counts by role match what was created");
  ok(stats.restaurants.total === 7 && stats.reservations.total === 2 && stats.orders.total === 1 && stats.reviews.total === 2, "stats: restaurants / reservations / orders / reviews counts are real");
  ok(stats.reservations.byStatus.CANCELLED === 1 && stats.orders.byStatus.COMPLETED === 1, "stats: status breakdowns are real");
  ok(stats.sessions.activeLast15Min >= 5 && stats.sessions.signedIn >= 5, "stats: active sessions measured (admin, 2 customers, 2 staff)");

  /* disable account / safety rules */
  const users = (await call(admin.j, "GET", "/api/admin/users")).data.users;
  const samId = users.find(u => u.email === st1.data.email).id, adminId = users.find(u => u.role === "ADMINISTRATOR").id;
  ok((await call(admin.j, "PATCH", `/api/admin/users/${adminId}`, { status: "DISABLED" })).status === 409, "administrator cannot disable their own account");
  ok((await call(admin.j, "PATCH", `/api/admin/users/${samId}`, { restaurantId: "second-place" })).status === 200, "administrator reassigns staff to another restaurant");
  ok((await call(staff.j, "GET", "/api/staff/restaurant")).data.restaurant.id === "second-place", "reassignment takes effect immediately");
  ok((await call(admin.j, "PATCH", `/api/admin/users/${samId}`, { status: "DISABLED" })).status === 200, "administrator disables a staff account");
  ok((await call(staff.j, "GET", "/api/staff/restaurant")).status === 401, "disabled user's existing session stops working");
  ok((await login(st1.data.email, st1.data.temporaryPassword)).r.status === 403, "disabled user cannot log in");
  ok((await call(admin.j, "PATCH", `/api/admin/users/${samId}`, { status: "ACTIVE" })).status === 200, "administrator re-enables the account");
  const rp = await call(admin.j, "POST", `/api/admin/users/${samId}/reset-password`);
  ok(rp.status === 200 && (await login(st1.data.email, rp.data.temporaryPassword)).r.status === 200, "admin password reset issues a working one-time password");

  /* delete restaurant */
  ok((await call(admin.j, "DELETE", "/api/admin/restaurants/test-kitchen", { confirmName: "wrong" })).status === 400, "deletion needs the exact restaurant name");
  const del = await call(admin.j, "DELETE", "/api/admin/restaurants/test-kitchen", { confirmName: "Test Kitchen" });
  ok(del.status === 200 && del.data.removed.reservations === 2 && del.data.removed.orders === 1, "confirmed deletion reports what was removed");
  ok(!(await call(anon, "GET", "/api/restaurants")).data.some(r => r.id === "test-kitchen"), "deleted restaurant disappears from the public list");
  ok((await call(admin.j, "GET", "/api/admin/users")).data.users.every(u => u.restaurantId !== "test-kitchen"), "staff of a deleted restaurant become unassigned");

  console.log(`\n${pass} passed, ${fail} failed`);
  mock.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
