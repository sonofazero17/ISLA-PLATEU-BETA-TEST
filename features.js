/* ISLA-PLATEU feature API: restaurants, routing, reservations, advance orders, inquiries, reviews,
   notifications, staff tools and administrator tools. Every protected route is authorized HERE on the
   server (the role lists passed to add()), never only in the browser. */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = function createFeatures(ctx) {
  const { db, json, readJson, hashPassword, crypto, ROLES } = ctx;
  const routes = [];
  const ANY = "ANY";
  const CUSTOMER = ["CUSTOMER"], STAFF = ["RESTAURANT_STAFF"], ADMIN = ["ADMINISTRATOR"];
  const OSRM_URL = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
  const BOUNDS = { latMin: 9.08, latMax: 9.36, lngMin: 123.43, lngMax: 123.67 }; // Siquijor map area

  /* ---------- tiny router ---------- */
  function add(method, pattern, roles, handler) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, roles, handler });
  }

  /* ---------- helpers ---------- */
  class HttpError extends Error { constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; } }
  const fail = (status, message, fields) => { throw new HttpError(status, message, fields); };
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const iso = (s) => (s ? String(s).replace(" ", "T") + "Z" : null);
  const text = (v, max, label, { required = false, min = 0 } = {}) => {
    const s = String(v ?? "").replace(/\r\n/g, "\n").trim();
    if (required && !s) fail(400, `${label} is required.`, { [label]: `${label} is required.` });
    if (s && s.length < min) fail(400, `${label} is too short.`);
    if (s.length > max) fail(400, `${label} must be ${max} characters or fewer.`);
    if (/[<>]/.test(s)) fail(400, `${label} contains characters that are not allowed.`);
    return s;
  };
  const int = (v, min, max, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const PH_OFFSET_MS = 8 * 3600 * 1000; // restaurants are in the Philippines (UTC+8)
  function slotInstant(date, time, label) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) fail(400, `Choose a valid ${label} date and time.`);
    const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) fail(400, `Choose a valid ${label} date.`);
    return t.getTime() - PH_OFFSET_MS;
  }
  function futureSlot(date, time, label, maxDays) {
    const at = slotInstant(date, time, label);
    if (at < Date.now() + 30 * 60000) fail(400, `The ${label} must be at least 30 minutes from now (Philippine time).`);
    if (at > Date.now() + maxDays * 864e5) fail(400, `The ${label} must be within the next ${maxDays} days.`);
  }
  const money = (c) => Math.round(c) / 100;
  function notify(userId, message) { run("INSERT INTO notifications (user_id, message) VALUES (?, ?)", userId, message); }
  function notifyStaff(restaurantId, message) {
    all("SELECT id FROM users WHERE role = 'RESTAURANT_STAFF' AND restaurant_id = ? AND status = 'ACTIVE'", restaurantId).forEach(u => notify(u.id, message));
  }
  function staffRestaurant(user) {
    if (!user.restaurantId) fail(409, "No restaurant is assigned to your account yet. Ask the administrator to assign one.");
    const r = one("SELECT * FROM restaurants WHERE id = ?", user.restaurantId);
    if (!r) fail(409, "Your assigned restaurant no longer exists. Ask the administrator to reassign you.");
    return r;
  }
  const displayName = (full) => { const p = String(full).trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };
  const tempPassword = () => crypto.randomBytes(9).toString("base64url");

  const RESTAURANT_SQL = `SELECT r.*,
      (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE restaurant_id = r.id) AS rating_avg,
      (SELECT COUNT(*) FROM reviews WHERE restaurant_id = r.id) AS rating_count,
      (SELECT COUNT(*) FROM menu_items m WHERE m.restaurant_id = r.id AND m.available = 1) AS menu_count
    FROM restaurants r`;
  const mapRestaurant = (r) => ({
    id: r.id, name: r.name, municipality: r.municipality, category: r.category, address: r.address, contact: r.contact,
    hours: r.hours, description: r.description, notes: r.notes, lat: r.lat, lng: r.lng, verified: !!r.verified,
    locationStatus: r.location_status, mapSearchUrl: r.map_search_url, photo: r.photo, source: r.source,
    acceptsReservations: !!r.accepts_reservations, acceptsOrders: !!r.accepts_orders && r.menu_count > 0, ordersEnabled: !!r.accepts_orders, menuCount: r.menu_count,
    reservationCapacity: r.reservation_capacity, ratingAvg: r.rating_avg, ratingCount: r.rating_count || 0
  });
  const mapRes = (r) => ({ id: r.id, restaurantId: r.restaurant_id, restaurantName: r.restaurant_name, date: r.res_date, time: r.res_time,
    partySize: r.party_size, notes: r.notes, staffNote: r.staff_note, status: r.status, createdAt: iso(r.created_at),
    customerName: r.customer_name, customerEmail: r.customer_email });
  function mapOrder(o) {
    return { id: o.id, restaurantId: o.restaurant_id, restaurantName: o.restaurant_name, pickupDate: o.pickup_date, pickupTime: o.pickup_time,
      notes: o.notes, status: o.status, total: money(o.total_cents), createdAt: iso(o.created_at), customerName: o.customer_name,
      customerEmail: o.customer_email,
      items: all("SELECT name, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id", o.id).map(i => ({ name: i.name, price: money(i.price_cents), qty: i.qty })) };
  }
  function mapThread(i) {
    return { id: i.id, restaurantId: i.restaurant_id, restaurantName: i.restaurant_name, customerName: i.customer_name, subject: i.subject,
      updatedAt: iso(i.updated_at),
      messages: all(`SELECT m.id, m.sender_role, m.body, m.created_at, u.full_name FROM inquiry_messages m JOIN users u ON u.id = m.sender_id
        WHERE m.inquiry_id = ? ORDER BY m.id`, i.id).map(m => ({ id: m.id, from: m.sender_role, name: m.full_name, body: m.body, at: iso(m.created_at) })) };
  }

  /* ================= PUBLIC ================= */
  add("GET", "/api/restaurants", null, async ({ res }) => {
    json(res, 200, all(RESTAURANT_SQL + " ORDER BY r.name COLLATE NOCASE").map(mapRestaurant));
  });

  add("GET", "/api/restaurants/:id", null, async ({ res, user, params }) => {
    const r = one(RESTAURANT_SQL + " WHERE r.id = ?", params.id);
    if (!r) fail(404, "Restaurant not found.");
    const reviews = all(`SELECT v.rating, v.comment, v.created_at, u.full_name FROM reviews v JOIN users u ON u.id = v.customer_id
      WHERE v.restaurant_id = ? ORDER BY v.updated_at DESC LIMIT 10`, r.id)
      .map(v => ({ rating: v.rating, comment: v.comment, name: displayName(v.full_name), at: iso(v.created_at) }));
    const menu = all("SELECT id, name, description, price_cents FROM menu_items WHERE restaurant_id = ? AND available = 1 ORDER BY name COLLATE NOCASE", r.id)
      .map(m => ({ id: m.id, name: m.name, description: m.description, price: money(m.price_cents) }));
    const mine = user && user.role === "CUSTOMER" ? one("SELECT rating, comment FROM reviews WHERE restaurant_id = ? AND customer_id = ?", r.id, user.id) : null;
    json(res, 200, { restaurant: mapRestaurant(r), reviews, menu, myReview: mine || null });
  });

  /* ================= ANY SIGNED-IN USER ================= */
  const routeHits = new Map();
  add("GET", "/api/route", ANY, async ({ req, res, user }) => {
    // The server calculates the route: the browser never talks to the routing engine directly, and guests are refused.
    const now = Date.now();
    const hits = (routeHits.get(user.id) || []).filter(t => now - t < 60000);
    if (hits.length >= 30) fail(429, "Too many route requests. Please wait a moment.");
    hits.push(now); routeHits.set(user.id, hits);
    const url = new URL(req.url, "http://x");
    const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(url.searchParams.get("from") || "");
    if (!m || Math.abs(+m[1]) > 90 || Math.abs(+m[2]) > 180) fail(400, "A valid starting location is required.");
    const dest = one("SELECT name, lat, lng FROM restaurants WHERE id = ?", url.searchParams.get("restaurantId") || "");
    if (!dest) fail(404, "Restaurant not found.");
    if (dest.lat === null || dest.lng === null) fail(409, "This restaurant does not have a confirmed map location yet, so a route cannot be calculated.");
    let data;
    try {
      const r = await fetch(`${OSRM_URL}/route/v1/driving/${m[2]},${m[1]};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=false`,
        { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "ISLA-PLATEU-capstone/1.0" } });
      data = await r.json();
    } catch { fail(502, "The routing service could not be reached. Check the internet connection and try again."); }
    if (!data || data.code !== "Ok" || !data.routes || !data.routes[0]) fail(404, "No drivable route was found between your location and this restaurant.");
    const best = data.routes[0];
    json(res, 200, {
      provider: "OSRM", profile: "driving", restaurantId: url.searchParams.get("restaurantId"), restaurantName: dest.name,
      distanceMeters: best.distance, durationSeconds: best.duration,
      geometry: best.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    });
  });

  add("GET", "/api/notifications", ANY, async ({ res, user }) => {
    const items = all("SELECT id, message, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30", user.id)
      .map(n => ({ id: n.id, message: n.message, read: !!n.is_read, at: iso(n.created_at) }));
    json(res, 200, { items, unread: one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0", user.id).n });
  });
  add("POST", "/api/notifications/read", ANY, async ({ res, user }) => {
    run("UPDATE notifications SET is_read = 1 WHERE user_id = ?", user.id);
    json(res, 200, { ok: true });
  });
  add("POST", "/api/me/password", ANY, async ({ req, res, user }) => {
    const b = await readJson(req);
    const current = String(b.currentPassword ?? ""), next = String(b.newPassword ?? "");
    if (next.length < 8 || next.length > 128 || !/[A-Za-z]/.test(next) || !/\d/.test(next)) fail(400, "New password needs 8+ characters with at least one letter and one number.", { newPassword: "Use 8+ characters with a letter and a number." });
    const row = one("SELECT password_hash FROM users WHERE id = ?", user.id);
    const { verifyPassword } = ctx;
    if (!(await verifyPassword(current, row.password_hash))) fail(400, "Your current password is incorrect.", { currentPassword: "Incorrect password." });
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(next), user.id);
    run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", user.id, ctx.sessionHash(req)); // other devices are signed out
    json(res, 200, { ok: true });
  });

  /* ================= CUSTOMER ================= */
  add("POST", "/api/reservations", CUSTOMER, async ({ req, res, user }) => {
    const b = await readJson(req);
    const r = one("SELECT * FROM restaurants WHERE id = ?", String(b.restaurantId ?? ""));
    if (!r) fail(404, "Restaurant not found.");
    if (!r.accepts_reservations) fail(409, `${r.name} is not accepting reservation requests through ISLA-PLATEU right now.`);
    const date = String(b.date ?? ""), time = String(b.time ?? "");
    futureSlot(date, time, "reservation", 90);
    const party = int(b.partySize, 1, 20, "Party size");
    const notes = text(b.notes, 300, "Notes");
    if (one("SELECT id FROM reservations WHERE customer_id = ? AND restaurant_id = ? AND res_date = ? AND res_time = ? AND status IN ('PENDING','CONFIRMED')", user.id, r.id, date, time))
      fail(409, "You already have a reservation request for this restaurant at that date and time.");
    if (one("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN ('PENDING','CONFIRMED') AND res_date >= date('now')", user.id).n >= 10)
      fail(429, "You have too many open reservations. Cancel one before making another.");
    if (r.reservation_capacity) {
      const booked = one("SELECT COALESCE(SUM(party_size), 0) AS n FROM reservations WHERE restaurant_id = ? AND res_date = ? AND res_time = ? AND status IN ('PENDING','CONFIRMED')", r.id, date, time).n;
      if (booked + party > r.reservation_capacity) fail(409, `${r.name} cannot take a party of ${party} at that time. Please choose another time.`);
    }
    const info = run("INSERT INTO reservations (restaurant_id, customer_id, res_date, res_time, party_size, notes) VALUES (?,?,?,?,?,?)", r.id, user.id, date, time, party, notes);
    notifyStaff(r.id, `New reservation request from ${displayName(user.fullName)}: ${party} guest(s) on ${date} at ${time}.`);
    json(res, 201, { id: Number(info.lastInsertRowid), status: "PENDING", message: "Reservation request sent. The restaurant will confirm or decline it." });
  });
  add("GET", "/api/my/reservations", CUSTOMER, async ({ res, user }) => {
    json(res, 200, all(`SELECT v.*, r.name AS restaurant_name FROM reservations v JOIN restaurants r ON r.id = v.restaurant_id
      WHERE v.customer_id = ? ORDER BY v.res_date DESC, v.res_time DESC LIMIT 100`, user.id).map(mapRes));
  });
  add("POST", "/api/reservations/:id/cancel", CUSTOMER, async ({ res, user, params }) => {
    const v = one("SELECT * FROM reservations WHERE id = ? AND customer_id = ?", params.id, user.id);
    if (!v) fail(404, "Reservation not found.");
    if (!["PENDING", "CONFIRMED"].includes(v.status)) fail(409, `A ${v.status.toLowerCase()} reservation cannot be cancelled.`);
    run("UPDATE reservations SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?", v.id);
    notifyStaff(v.restaurant_id, `${displayName(user.fullName)} cancelled the reservation on ${v.res_date} at ${v.res_time}.`);
    json(res, 200, { ok: true });
  });

  add("POST", "/api/orders", CUSTOMER, async ({ req, res, user }) => {
    const b = await readJson(req);
    const r = one(RESTAURANT_SQL + " WHERE r.id = ?", String(b.restaurantId ?? ""));
    if (!r) fail(404, "Restaurant not found.");
    if (!r.accepts_orders || !r.menu_count) fail(409, `${r.name} does not take advance orders through ISLA-PLATEU.`);
    const date = String(b.pickupDate ?? ""), time = String(b.pickupTime ?? "");
    futureSlot(date, time, "pickup", 30);
    const notes = text(b.notes, 300, "Notes");
    if (!Array.isArray(b.items) || !b.items.length) fail(400, "Add at least one menu item to your order.");
    if (b.items.length > 20) fail(400, "An order can have at most 20 different items.");
    const lines = []; let total = 0; const seen = new Set();
    for (const it of b.items) {
      const id = Number(it && it.menuItemId);
      if (seen.has(id)) fail(400, "Each menu item can only appear once. Change its quantity instead.");
      seen.add(id);
      const qty = int(it && it.qty, 1, 20, "Quantity");
      const m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? AND available = 1", id, r.id); // prices come from the database, never from the browser
      if (!m) fail(400, "One of the selected items is no longer available. Please refresh the menu.");
      lines.push({ m, qty }); total += m.price_cents * qty;
    }
    let orderId;
    db.exec("BEGIN");
    try {
      orderId = Number(run("INSERT INTO orders (restaurant_id, customer_id, pickup_date, pickup_time, notes, total_cents) VALUES (?,?,?,?,?,?)", r.id, user.id, date, time, notes, total).lastInsertRowid);
      lines.forEach(l => run("INSERT INTO order_items (order_id, name, price_cents, qty) VALUES (?,?,?,?)", orderId, l.m.name, l.m.price_cents, l.qty));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    notifyStaff(r.id, `New advance order #${orderId} from ${displayName(user.fullName)} for pickup ${date} ${time}.`);
    json(res, 201, { id: orderId, status: "PENDING", total: money(total), message: "Advance order sent. The restaurant will accept or decline it." });
  });
  add("GET", "/api/my/orders", CUSTOMER, async ({ res, user }) => {
    json(res, 200, all(`SELECT o.*, r.name AS restaurant_name FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
      WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 100`, user.id).map(mapOrder));
  });
  add("POST", "/api/orders/:id/cancel", CUSTOMER, async ({ res, user, params }) => {
    const o = one("SELECT * FROM orders WHERE id = ? AND customer_id = ?", params.id, user.id);
    if (!o) fail(404, "Order not found.");
    if (o.status !== "PENDING") fail(409, "Only orders that the restaurant has not accepted yet can be cancelled.");
    run("UPDATE orders SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?", o.id);
    notifyStaff(o.restaurant_id, `${displayName(user.fullName)} cancelled advance order #${o.id}.`);
    json(res, 200, { ok: true });
  });

  add("POST", "/api/inquiries", CUSTOMER, async ({ req, res, user }) => {
    const b = await readJson(req);
    const r = one("SELECT id, name FROM restaurants WHERE id = ?", String(b.restaurantId ?? ""));
    if (!r) fail(404, "Restaurant not found.");
    const subject = text(b.subject, 100, "Subject", { required: true, min: 3 });
    const body = text(b.message, 1000, "Message", { required: true, min: 2 });
    if (one("SELECT COUNT(*) AS n FROM inquiries WHERE customer_id = ? AND created_at > datetime('now','-1 hour')", user.id).n >= 5) fail(429, "Too many new messages. Please wait a little before sending another.");
    const id = Number(run("INSERT INTO inquiries (restaurant_id, customer_id, subject) VALUES (?,?,?)", r.id, user.id, subject).lastInsertRowid);
    run("INSERT INTO inquiry_messages (inquiry_id, sender_id, sender_role, body) VALUES (?,?,?,?)", id, user.id, "CUSTOMER", body);
    notifyStaff(r.id, `New customer message from ${displayName(user.fullName)}: ${subject}`);
    json(res, 201, { id, message: "Message sent to the restaurant." });
  });
  add("GET", "/api/my/inquiries", CUSTOMER, async ({ res, user }) => {
    json(res, 200, all(`SELECT i.*, r.name AS restaurant_name FROM inquiries i JOIN restaurants r ON r.id = i.restaurant_id
      WHERE i.customer_id = ? ORDER BY i.updated_at DESC, i.id DESC LIMIT 50`, user.id).map(mapThread));
  });
  add("POST", "/api/inquiries/:id/messages", [...CUSTOMER, ...STAFF], async ({ req, res, user, params }) => {
    const i = one("SELECT * FROM inquiries WHERE id = ?", params.id);
    const allowed = i && (user.role === "CUSTOMER" ? i.customer_id === user.id : i.restaurant_id === user.restaurantId);
    if (!allowed) fail(404, "Conversation not found."); // same answer whether it exists or not
    const body = text((await readJson(req)).body, 1000, "Message", { required: true, min: 1 });
    run("INSERT INTO inquiry_messages (inquiry_id, sender_id, sender_role, body) VALUES (?,?,?,?)", i.id, user.id, user.role === "CUSTOMER" ? "CUSTOMER" : "STAFF", body);
    run("UPDATE inquiries SET updated_at = datetime('now') WHERE id = ?", i.id);
    if (user.role === "CUSTOMER") notifyStaff(i.restaurant_id, `${displayName(user.fullName)} replied: ${i.subject}`);
    else notify(i.customer_id, `${one("SELECT name FROM restaurants WHERE id = ?", i.restaurant_id).name} replied to your message: ${i.subject}`);
    json(res, 201, { ok: true });
  });

  add("POST", "/api/restaurants/:id/reviews", CUSTOMER, async ({ req, res, user, params }) => {
    const r = one("SELECT id, name FROM restaurants WHERE id = ?", params.id);
    if (!r) fail(404, "Restaurant not found.");
    const b = await readJson(req);
    const rating = int(b.rating, 1, 5, "Rating");
    const comment = text(b.comment, 500, "Comment");
    const existed = one("SELECT id FROM reviews WHERE restaurant_id = ? AND customer_id = ?", r.id, user.id); // one review per customer per restaurant
    run(`INSERT INTO reviews (restaurant_id, customer_id, rating, comment) VALUES (?,?,?,?)
         ON CONFLICT(restaurant_id, customer_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = datetime('now')`, r.id, user.id, rating, comment);
    if (!existed) notifyStaff(r.id, `${displayName(user.fullName)} rated ${r.name} ${rating}/5.`);
    json(res, existed ? 200 : 201, { ok: true, updated: !!existed });
  });

  /* ================= RESTAURANT STAFF (own restaurant only) ================= */
  add("GET", "/api/staff/restaurant", STAFF, async ({ res, user }) => {
    const r = one(RESTAURANT_SQL + " WHERE r.id = ?", staffRestaurant(user).id);
    json(res, 200, {
      restaurant: mapRestaurant(r),
      counts: {
        pendingReservations: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ? AND status = 'PENDING'", r.id).n,
        upcomingReservations: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ? AND status = 'CONFIRMED' AND res_date >= date('now')", r.id).n,
        pendingOrders: one("SELECT COUNT(*) AS n FROM orders WHERE restaurant_id = ? AND status = 'PENDING'", r.id).n,
        awaitingReply: one(`SELECT COUNT(*) AS n FROM inquiries i WHERE i.restaurant_id = ?
          AND (SELECT sender_role FROM inquiry_messages WHERE inquiry_id = i.id ORDER BY id DESC LIMIT 1) = 'CUSTOMER'`, r.id).n
      }
    });
  });
  add("PATCH", "/api/staff/restaurant", STAFF, async ({ req, res, user }) => {
    // staff may change operational details only: not name, category, address, coordinates, photo or deletion
    const r = staffRestaurant(user), b = await readJson(req);
    const contact = text(b.contact ?? r.contact, 80, "Contact"), hours = text(b.hours ?? r.hours, 120, "Hours");
    const description = text(b.description ?? r.description, 1000, "Description");
    const cap = b.reservationCapacity === null || b.reservationCapacity === "" ? null : b.reservationCapacity === undefined ? r.reservation_capacity : int(b.reservationCapacity, 1, 500, "Capacity");
    const acceptsRes = b.acceptsReservations === undefined ? r.accepts_reservations : b.acceptsReservations ? 1 : 0;
    const acceptsOrd = b.acceptsOrders === undefined ? r.accepts_orders : b.acceptsOrders ? 1 : 0;
    run("UPDATE restaurants SET contact=?, hours=?, description=?, reservation_capacity=?, accepts_reservations=?, accepts_orders=?, updated_at=datetime('now') WHERE id=?",
      contact, hours, description, cap, acceptsRes, acceptsOrd, r.id);
    json(res, 200, { ok: true });
  });

  const RES_NEXT = { PENDING: ["CONFIRMED", "DECLINED"], CONFIRMED: ["COMPLETED", "NO_SHOW", "CANCELLED"] };
  add("GET", "/api/staff/reservations", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    json(res, 200, all(`SELECT v.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email FROM reservations v
      JOIN restaurants r ON r.id = v.restaurant_id JOIN users u ON u.id = v.customer_id WHERE v.restaurant_id = ?
      ORDER BY (v.status = 'PENDING') DESC, v.res_date DESC, v.res_time DESC LIMIT 200`, r.id).map(mapRes));
  });
  add("PATCH", "/api/staff/reservations/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user);
    const v = one("SELECT * FROM reservations WHERE id = ? AND restaurant_id = ?", params.id, r.id); // cannot touch other restaurants' bookings
    if (!v) fail(404, "Reservation not found.");
    const b = await readJson(req);
    const next = String(b.status ?? "");
    if (!(RES_NEXT[v.status] || []).includes(next)) fail(409, `A ${v.status.toLowerCase()} reservation cannot be changed to ${next || "that status"}.`);
    const note = text(b.staffNote, 300, "Note");
    if (next === "CONFIRMED" && r.reservation_capacity) {
      const booked = one("SELECT COALESCE(SUM(party_size),0) AS n FROM reservations WHERE restaurant_id = ? AND res_date = ? AND res_time = ? AND status = 'CONFIRMED' AND id != ?", r.id, v.res_date, v.res_time, v.id).n;
      if (booked + v.party_size > r.reservation_capacity) fail(409, "Confirming this would exceed your capacity for that time.");
    }
    run("UPDATE reservations SET status = ?, staff_note = ?, updated_at = datetime('now') WHERE id = ?", next, note, v.id);
    notify(v.customer_id, `Your reservation at ${r.name} on ${v.res_date} ${v.res_time} is now ${next.replace("_", " ")}.${note ? " Note: " + note : ""}`);
    json(res, 200, { ok: true });
  });

  const ORDER_NEXT = { PENDING: ["ACCEPTED", "REJECTED"], ACCEPTED: ["PREPARING", "REJECTED"], PREPARING: ["READY"], READY: ["COMPLETED"] };
  add("GET", "/api/staff/orders", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    json(res, 200, all(`SELECT o.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email FROM orders o
      JOIN restaurants r ON r.id = o.restaurant_id JOIN users u ON u.id = o.customer_id WHERE o.restaurant_id = ?
      ORDER BY (o.status = 'PENDING') DESC, o.id DESC LIMIT 200`, r.id).map(mapOrder));
  });
  add("PATCH", "/api/staff/orders/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user);
    const o = one("SELECT * FROM orders WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!o) fail(404, "Order not found.");
    const next = String((await readJson(req)).status ?? "");
    if (!(ORDER_NEXT[o.status] || []).includes(next)) fail(409, `An order that is ${o.status.toLowerCase()} cannot be changed to ${next || "that status"}.`);
    run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", next, o.id);
    notify(o.customer_id, `Your advance order #${o.id} at ${r.name} is now ${next}.`);
    json(res, 200, { ok: true });
  });

  add("GET", "/api/staff/menu", STAFF, async ({ res, user }) => {
    json(res, 200, all("SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY name COLLATE NOCASE", staffRestaurant(user).id)
      .map(m => ({ id: m.id, name: m.name, description: m.description, price: money(m.price_cents), available: !!m.available })));
  });
  const priceCents = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 100000) fail(400, "Price must be more than 0 and at most 100,000."); return Math.round(n * 100); };
  add("POST", "/api/staff/menu", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req);
    if (one("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = ?", r.id).n >= 100) fail(409, "Menu limit reached (100 items).");
    const id = Number(run("INSERT INTO menu_items (restaurant_id, name, description, price_cents) VALUES (?,?,?,?)", r.id,
      text(b.name, 80, "Name", { required: true, min: 2 }), text(b.description, 200, "Description"), priceCents(b.price)).lastInsertRowid);
    json(res, 201, { id });
  });
  add("PATCH", "/api/staff/menu/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!m) fail(404, "Menu item not found.");
    const b = await readJson(req);
    run("UPDATE menu_items SET name=?, description=?, price_cents=?, available=? WHERE id=?",
      b.name === undefined ? m.name : text(b.name, 80, "Name", { required: true, min: 2 }),
      b.description === undefined ? m.description : text(b.description, 200, "Description"),
      b.price === undefined ? m.price_cents : priceCents(b.price),
      b.available === undefined ? m.available : b.available ? 1 : 0, m.id);
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/staff/menu/:id", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user);
    if (!run("DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id).changes) fail(404, "Menu item not found.");
    json(res, 200, { ok: true });
  });

  add("GET", "/api/staff/inquiries", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    json(res, 200, all(`SELECT i.*, r.name AS restaurant_name, u.full_name AS customer_name FROM inquiries i
      JOIN restaurants r ON r.id = i.restaurant_id JOIN users u ON u.id = i.customer_id WHERE i.restaurant_id = ?
      ORDER BY i.updated_at DESC, i.id DESC LIMIT 100`, r.id).map(mapThread));
  });
  add("GET", "/api/staff/reviews", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    const rows = all(`SELECT v.rating, v.comment, v.created_at, u.full_name FROM reviews v JOIN users u ON u.id = v.customer_id
      WHERE v.restaurant_id = ? ORDER BY v.updated_at DESC LIMIT 100`, r.id);
    const stats = one("SELECT ROUND(AVG(rating),1) AS avg, COUNT(*) AS n FROM reviews WHERE restaurant_id = ?", r.id);
    json(res, 200, { average: stats.avg, count: stats.n, reviews: rows.map(v => ({ rating: v.rating, comment: v.comment, name: displayName(v.full_name), at: iso(v.created_at) })) });
  });

  /* ================= ADMINISTRATOR ================= */
  add("GET", "/api/admin/stats", ADMIN, async ({ res }) => {
    const grouped = (sql) => Object.fromEntries(all(sql).map(r => [r.k, r.n]));
    const now = Date.now();
    json(res, 200, {
      users: {
        total: one("SELECT COUNT(*) AS n FROM users").n,
        byRole: Object.fromEntries(ROLES.map(r => [r, one("SELECT COUNT(*) AS n FROM users WHERE role = ?", r).n])),
        disabled: one("SELECT COUNT(*) AS n FROM users WHERE status != 'ACTIVE'").n
      },
      sessions: {
        signedIn: one("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ?", now).n,
        activeLast15Min: one("SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE expires_at > ? AND last_seen > ?", now, now - 15 * 60000).n
      },
      restaurants: { total: one("SELECT COUNT(*) AS n FROM restaurants").n, withMapPin: one("SELECT COUNT(*) AS n FROM restaurants WHERE lat IS NOT NULL").n },
      reservations: { total: one("SELECT COUNT(*) AS n FROM reservations").n, byStatus: grouped("SELECT status AS k, COUNT(*) AS n FROM reservations GROUP BY status") },
      orders: { total: one("SELECT COUNT(*) AS n FROM orders").n, byStatus: grouped("SELECT status AS k, COUNT(*) AS n FROM orders GROUP BY status") },
      reviews: { total: one("SELECT COUNT(*) AS n FROM reviews").n },
      applications: Object.fromEntries(["pending", "approved", "rejected"].map(k => [k, one("SELECT COUNT(*) AS n FROM staff_applications WHERE status = ?", k).n])),
      storage: { persistent: ctx.storage.persistent, warning: ctx.storage.warning },
      notTracked: ["Daily visitors (anonymous public-map visits are not recorded)"]
    });
  });

  add("GET", "/api/admin/users", ADMIN, async ({ res }) => {
    json(res, 200, { users: all(`SELECT u.id, u.full_name, u.email, u.contact_number, u.role, u.status, u.restaurant_id, u.created_at, r.name AS restaurant_name
      FROM users u LEFT JOIN restaurants r ON r.id = u.restaurant_id ORDER BY u.created_at DESC, u.id DESC`)
      .map(u => ({ id: u.id, fullName: u.full_name, email: u.email, contactNumber: u.contact_number, role: u.role, status: u.status, restaurantId: u.restaurant_id, restaurantName: u.restaurant_name, createdAt: iso(u.created_at) })) });
  });

  function validateRestaurant(b, current) {
    const c = current || {};
    const out = {
      name: text(b.name ?? c.name, 100, "Name", { required: true, min: 2 }),
      municipality: text(b.municipality ?? c.municipality, 60, "Municipality"),
      category: text(b.category ?? c.category ?? "Unconfirmed", 40, "Category", { required: true }),
      address: text(b.address ?? c.address, 200, "Address"),
      contact: text(b.contact ?? c.contact, 80, "Contact"),
      hours: text(b.hours ?? c.hours, 120, "Hours"),
      description: text(b.description ?? c.description, 1000, "Description"),
      notes: text(b.notes ?? c.notes, 500, "Notes")
    };
    const rawLat = b.lat === undefined ? c.lat : b.lat, rawLng = b.lng === undefined ? c.lng : b.lng;
    const hasLat = rawLat !== null && rawLat !== "" && rawLat !== undefined, hasLng = rawLng !== null && rawLng !== "" && rawLng !== undefined;
    if (hasLat !== hasLng) fail(400, "Enter both latitude and longitude, or leave both empty.", { lat: "Latitude and longitude go together." });
    if (hasLat) {
      const lat = Number(rawLat), lng = Number(rawLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(400, "Coordinates must be numbers.", { lat: "Coordinates must be numbers." });
      if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lngMin || lng > BOUNDS.lngMax)
        fail(400, "These coordinates are outside Siquijor. Check the latitude and longitude.", { lat: "Outside the Siquijor map area." });
      out.lat = Number(lat.toFixed(6)); out.lng = Number(lng.toFixed(6));
      out.verified = (b.verified === undefined ? c.verified : b.verified) ? 1 : 0;
      out.location_status = out.verified ? "verified" : "approximate";
    } else { out.lat = null; out.lng = null; out.verified = 0; out.location_status = "address-only"; }
    const url = String(b.mapSearchUrl ?? c.map_search_url ?? "").trim();
    if (url && (!/^https:\/\//.test(url) || url.length > 500)) fail(400, "The map link must start with https://");
    out.map_search_url = url;
    const photo = String(b.photo ?? c.photo ?? "").trim();
    if (photo && !/^\/assets\/[\w.\-]+$/.test(photo)) fail(400, "Photo must be a file inside the assets folder, e.g. /assets/photo.jpg");
    out.photo = photo;
    out.accepts_reservations = (b.acceptsReservations === undefined ? (c.accepts_reservations ?? 1) : b.acceptsReservations) ? 1 : 0;
    out.accepts_orders = (b.acceptsOrders === undefined ? (c.accepts_orders ?? 0) : b.acceptsOrders) ? 1 : 0;
    const cap = b.reservationCapacity === undefined ? c.reservation_capacity : b.reservationCapacity;
    out.reservation_capacity = cap === null || cap === "" || cap === undefined ? null : int(cap, 1, 500, "Capacity");
    return out;
  }
  const RCOLS = ["name", "municipality", "category", "address", "contact", "hours", "description", "notes", "lat", "lng", "verified", "location_status", "map_search_url", "photo", "accepts_reservations", "accepts_orders", "reservation_capacity"];

  add("POST", "/api/admin/restaurants", ADMIN, async ({ req, res }) => {
    const v = validateRestaurant(await readJson(req), null);
    let base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "restaurant", id = base, n = 2;
    while (one("SELECT 1 AS x FROM restaurants WHERE id = ?", id)) id = `${base}-${n++}`;
    run(`INSERT INTO restaurants (id, ${RCOLS.join(", ")}, source) VALUES (?, ${RCOLS.map(() => "?").join(", ")}, ?)`, id, ...RCOLS.map(k => v[k]), "Added by administrator");
    json(res, 201, { id });
  });
  add("PUT", "/api/admin/restaurants/:id", ADMIN, async ({ req, res, params }) => {
    const cur = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!cur) fail(404, "Restaurant not found.");
    const v = validateRestaurant(await readJson(req), cur);
    run(`UPDATE restaurants SET ${RCOLS.map(k => k + " = ?").join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...RCOLS.map(k => v[k]), cur.id);
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/admin/restaurants/:id", ADMIN, async ({ req, res, params }) => {
    const cur = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!cur) fail(404, "Restaurant not found.");
    const b = await readJson(req);
    if (b.confirmName !== cur.name) fail(400, "Type the restaurant's exact name to confirm deletion.", { confirmName: "Name does not match." });
    const removed = {
      reservations: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ?", cur.id).n,
      orders: one("SELECT COUNT(*) AS n FROM orders WHERE restaurant_id = ?", cur.id).n,
      reviews: one("SELECT COUNT(*) AS n FROM reviews WHERE restaurant_id = ?", cur.id).n
    };
    db.exec("BEGIN");
    try {
      run("UPDATE users SET restaurant_id = NULL WHERE restaurant_id = ?", cur.id); // staff stay, but become unassigned
      run("DELETE FROM restaurants WHERE id = ?", cur.id);                          // related bookings/orders/reviews/messages cascade
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    json(res, 200, { ok: true, removed });
  });

  add("POST", "/api/admin/staff", ADMIN, async ({ req, res }) => {
    const b = await readJson(req);
    const fullName = text(b.fullName, 80, "Full name", { required: true, min: 2 });
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(400, "Enter a valid email address.", { email: "Enter a valid email address." });
    const rid = String(b.restaurantId ?? "");
    if (!one("SELECT 1 AS x FROM restaurants WHERE id = ?", rid)) fail(400, "Choose the restaurant this staff member belongs to.", { restaurantId: "Choose a restaurant." });
    if (one("SELECT 1 AS x FROM users WHERE email = ?", email)) fail(409, "An account with this email already exists.", { email: "Already registered." });
    const password = tempPassword();
    run("INSERT INTO users (full_name, email, password_hash, role, restaurant_id) VALUES (?,?,?,?,?)", fullName, email, await hashPassword(password), "RESTAURANT_STAFF", rid);
    json(res, 201, { email, temporaryPassword: password }); // shown to the administrator once; hand it over securely
  });
  add("PATCH", "/api/admin/users/:id", ADMIN, async ({ req, res, user, params }) => {
    const target = one("SELECT * FROM users WHERE id = ?", params.id);
    if (!target) fail(404, "Account not found.");
    const b = await readJson(req);
    if (b.status !== undefined) {
      if (!["ACTIVE", "DISABLED"].includes(b.status)) fail(400, "Status must be ACTIVE or DISABLED.");
      if (["PENDING", "REJECTED"].includes(target.status)) fail(409, "This person is a staff applicant. Approve or reject the application in the Staff applications tab instead.");
      if (target.id === user.id) fail(409, "You cannot disable your own account.");
      if (target.role === "ADMINISTRATOR" && b.status === "DISABLED" && one("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMINISTRATOR' AND status = 'ACTIVE' AND id != ?", target.id).n === 0)
        fail(409, "At least one active administrator must remain.");
      run("UPDATE users SET status = ? WHERE id = ?", b.status, target.id);
      if (b.status === "DISABLED") run("DELETE FROM sessions WHERE user_id = ?", target.id); // signed out immediately
    }
    if (b.restaurantId !== undefined) {
      if (target.role !== "RESTAURANT_STAFF") fail(409, "Only restaurant staff accounts are assigned to a restaurant.");
      if (b.restaurantId !== null && !one("SELECT 1 AS x FROM restaurants WHERE id = ?", String(b.restaurantId))) fail(400, "Restaurant not found.");
      run("UPDATE users SET restaurant_id = ? WHERE id = ?", b.restaurantId === null ? null : String(b.restaurantId), target.id);
    }
    json(res, 200, { ok: true });
  });
  add("POST", "/api/admin/users/:id/reset-password", ADMIN, async ({ res, params }) => {
    const target = one("SELECT * FROM users WHERE id = ?", params.id);
    if (!target) fail(404, "Account not found.");
    const password = tempPassword();
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), target.id);
    run("DELETE FROM sessions WHERE user_id = ?", target.id);
    json(res, 200, { email: target.email, temporaryPassword: password });
  });


  /* ---------- Database backup (administrator only) ----------
     Streams a consistent copy of the database (VACUUM INTO), with active login sessions removed. It contains personal data and
     password hashes: store it somewhere private and never commit it to GitHub. */
  const { DatabaseSync } = require("node:sqlite");
  let lastBackup = 0;
  add("GET", "/api/admin/backup", ADMIN, async ({ res, user }) => {
    if (Date.now() - lastBackup < 10000) fail(429, "Please wait a few seconds before requesting another backup.");
    lastBackup = Date.now();
    const tmp = path.join(os.tmpdir(), `isla-backup-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.db`);
    let buf;
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const copy = new DatabaseSync(tmp); copy.exec("DELETE FROM sessions"); copy.exec("VACUUM"); copy.close();
      buf = fs.readFileSync(tmp);
    } finally { for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) { try { fs.unlinkSync(f); } catch { /* not there */ } } }
    console.log(`[backup] database backup downloaded by administrator #${user.id} (${buf.length} bytes)`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    ctx.send(res, 200, buf, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="isla-plateu-backup-${stamp}.db"` });
  });

  /* ================= STAFF APPLICATIONS ================= */
  const MUNICIPALITIES = ["Enrique Villanueva", "Larena", "Lazi", "Maria", "San Juan", "Siquijor"]; // the six municipalities of Siquijor
  const POSITIONS = ["Owner", "Manager", "Staff"];
  const nameKey = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const applyHits = new Map(), APPLY_LIMIT = Number(process.env.APPLY_LIMIT_PER_HOUR) || 5; // well-formed applications per IP per hour
  function applyAllowed(ip) {
    const now = Date.now(), hits = (applyHits.get(ip) || []).filter(t => now - t < 36e5);
    if (hits.length >= APPLY_LIMIT) { applyHits.set(ip, hits); return false; }
    hits.push(now); applyHits.set(ip, hits); return true;
  }
  function phoneError(v) {
    const s = String(v ?? "").trim();
    if (!s) return "Enter a contact number.";
    if (!/^[0-9+()\-\s.]+$/.test(s) || (s.includes("+") && !s.startsWith("+"))) return "Use digits only (spaces, dashes, + and brackets are fine).";
    const digits = s.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return "Enter a valid phone number (7 to 15 digits).";
    if (/^(09|639|\+?639)/.test(s.replace(/[\s\-().]/g, "")) && !/^(09\d{9}|\+?639\d{9})$/.test(s.replace(/[\s\-().]/g, ""))) return "Mobile numbers look like 09XX XXX XXXX or +63 9XX XXX XXXX.";
    return "";
  }
  function cleanText(v, max, min, errs, key, label, { required = true } = {}) {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s) { if (required) errs[key] = `${label} is required.`; return ""; }
    if (s.length < min) errs[key] = `${label} is too short.`;
    else if (s.length > max) errs[key] = `${label} must be ${max} characters or fewer.`;
    else if (/[<>]/.test(s)) errs[key] = `${label} contains characters that are not allowed.`;
    return s;
  }
  const applyDup = () => ({ email: "This email already has an account. If you applied before, log in with Staff login to see your status." });

  add("POST", "/api/staff-applications", null, async ({ req, res }) => {
    const b = await readJson(req);
    const e = {};
    const fullName = cleanText(b.fullName, 80, 2, e, "fullName", "Full name");
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!email) e.email = "Enter your email address."; else if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Enter a valid email address.";
    else if (ctx.isReservedEmail(email)) e.email = "This email address is reserved. Please use a different one.";
    const contactNumber = String(b.contactNumber ?? "").trim();
    const pe = phoneError(contactNumber); if (pe) e.contactNumber = pe;
    const password = String(b.password ?? ""), confirm = String(b.confirmPassword ?? "");
    if (!password) e.password = "Create a password."; else if (password.length < 8) e.password = "Use at least 8 characters.";
    else if (password.length > 128) e.password = "Password must be 128 characters or fewer."; else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) e.password = "Include at least one letter and one number.";
    if (!confirm) e.confirmPassword = "Confirm your password."; else if (confirm !== password) e.confirmPassword = "Passwords do not match.";
    const position = String(b.position ?? ""); if (!POSITIONS.includes(position)) e.position = "Choose your position at the restaurant.";
    const permit = cleanText(b.permitNumber, 60, 3, e, "permitNumber", "Business permit / registration number");
    if (permit && !/^[A-Za-z0-9][A-Za-z0-9\-\/ .#]*$/.test(permit)) e.permitNumber = "Use letters, numbers, dashes or slashes only.";
    const note = cleanText(b.note, 500, 0, e, "note", "Additional information", { required: false });

    const mode = b.restaurantMode === "existing" ? "existing" : b.restaurantMode === "new" ? "new" : "";
    if (!mode) e.restaurantMode = "Choose an existing restaurant or register a new one.";
    let existing = null, info = { name: "", contact: "", address: "", municipality: "", barangay: "", category: "Restaurant", description: "" };
    if (mode === "existing") {
      existing = one("SELECT id, name, municipality, address, contact, category, description FROM restaurants WHERE id = ?", String(b.restaurantId ?? ""));
      if (!existing) e.restaurantId = "Choose a restaurant from the list.";
      else info = { name: existing.name, contact: existing.contact, address: existing.address, municipality: existing.municipality, barangay: "", category: existing.category, description: existing.description };
    } else if (mode === "new") {
      info.name = cleanText(b.restaurantName, 100, 2, e, "restaurantName", "Official restaurant name");
      const rc = String(b.restaurantContact ?? "").trim(); const rce = phoneError(rc); if (rce) e.restaurantContact = rce.replace("a contact number", "the restaurant's contact number"); else info.contact = rc;
      info.address = cleanText(b.restaurantAddress, 200, 5, e, "restaurantAddress", "Restaurant address");
      info.municipality = String(b.municipality ?? ""); if (!MUNICIPALITIES.includes(info.municipality)) e.municipality = "Choose the municipality in Siquijor.";
      info.barangay = cleanText(b.barangay, 60, 2, e, "barangay", "Barangay");
      info.category = cleanText(b.category || "Restaurant", 40, 2, e, "category", "Category");
      info.description = cleanText(b.description, 1000, 10, e, "description", "Restaurant description");
      if (info.name && !e.restaurantName) {
        const key = nameKey(info.name);
        if (all("SELECT name FROM restaurants").some(r => nameKey(r.name) === key)) e.restaurantName = "A restaurant with this name is already in ISLA-PLATEU. Choose it from the list instead.";
        else if (one("SELECT 1 AS x FROM staff_applications WHERE status = 'pending' AND is_new_restaurant = 1 AND restaurant_name_key = ?", key)) e.restaurantName = "An application to register this restaurant is already waiting for review.";
      }
    }
    if (Object.keys(e).length) fail(400, "Please fix the highlighted fields.", e);
    if (!applyAllowed(ctx.clientIp(req))) fail(429, "Too many applications from this connection. Please try again later.");
    if (one("SELECT 1 AS x FROM users WHERE email = ?", email)) fail(409, "An account with this email already exists.", applyDup());

    const hash = await hashPassword(password);
    db.exec("BEGIN IMMEDIATE");
    try {
      const uid = Number(run("INSERT INTO users (full_name, email, password_hash, role, status, contact_number) VALUES (?,?,?,?,?,?)", fullName, email, hash, "RESTAURANT_STAFF", "PENDING", contactNumber).lastInsertRowid);
      run(`INSERT INTO staff_applications (user_id, restaurant_id, is_new_restaurant, restaurant_name, restaurant_name_key, restaurant_contact, restaurant_address, municipality, barangay, category, description, position, permit_number, applicant_note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, existing ? existing.id : null, mode === "new" ? 1 : 0, info.name, nameKey(info.name), info.contact, info.address, info.municipality, info.barangay, info.category, info.description, position, permit, note);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (/UNIQUE/.test(String(err.message))) {
        if (/users\.email/.test(err.message)) fail(409, "An account with this email already exists.", applyDup());
        fail(409, "An application to register this restaurant is already waiting for review.", { restaurantName: "Already waiting for review." });
      }
      throw err;
    }
    json(res, 201, { status: "pending", message: "Application received. An administrator will review it. You cannot log in as staff until it is approved." });
  });

  const mapApp = (a) => ({
    id: a.id, status: a.status, applicantName: a.full_name, applicantEmail: a.email, contactNumber: a.contact_number, accountStatus: a.user_status,
    isNewRestaurant: !!a.is_new_restaurant, restaurantId: a.restaurant_id, restaurantName: a.restaurant_name, restaurantContact: a.restaurant_contact,
    address: a.restaurant_address, municipality: a.municipality, barangay: a.barangay, category: a.category, description: a.description,
    position: a.position, permitNumber: a.permit_number, note: a.applicant_note, reviewNote: a.review_note, reviewedBy: a.reviewer_name, reviewedAt: iso(a.reviewed_at),
    submittedAt: iso(a.created_at), restaurantStaffCount: a.restaurant_id ? one("SELECT COUNT(*) AS n FROM users WHERE role = 'RESTAURANT_STAFF' AND status = 'ACTIVE' AND restaurant_id = ?", a.restaurant_id).n : 0
  });
  const APP_SQL = `SELECT a.*, u.full_name, u.email, u.contact_number, u.status AS user_status, rv.full_name AS reviewer_name
    FROM staff_applications a JOIN users u ON u.id = a.user_id LEFT JOIN users rv ON rv.id = a.reviewed_by`;

  add("GET", "/api/admin/applications", ADMIN, async ({ req, res }) => {
    const st = new URL(req.url, "http://x").searchParams.get("status") || "all";
    if (!["all", "pending", "approved", "rejected"].includes(st)) fail(400, "Unknown status filter.");
    const rows = st === "all" ? all(APP_SQL + " ORDER BY (a.status = 'pending') DESC, a.created_at DESC, a.id DESC") : all(APP_SQL + " WHERE a.status = ? ORDER BY a.created_at DESC, a.id DESC", st);
    const counts = Object.fromEntries(["pending", "approved", "rejected"].map(k => [k, one("SELECT COUNT(*) AS n FROM staff_applications WHERE status = ?", k).n]));
    json(res, 200, { counts, applications: rows.map(mapApp) });
  });

  // Every decision runs in one transaction and only succeeds while the application is still "pending" (no double processing).
  function decide(res, admin, id, body, fn) {
    if (body.confirm !== true) fail(400, "The decision must be confirmed.");
    db.exec("BEGIN IMMEDIATE");
    try {
      const a = one("SELECT * FROM staff_applications WHERE id = ?", id);
      if (!a) fail(404, "Application not found.");
      fn(a);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  }
  add("POST", "/api/admin/applications/:id/approve", ADMIN, async ({ req, res, user, params }) => {
    const body = await readJson(req); let restaurantId;
    decide(res, user, params.id, body, (a) => {
      if (a.status !== "pending") fail(409, `This application was already ${a.status}. Refresh the list.`);
      if (a.is_new_restaurant) {
        if (all("SELECT name FROM restaurants").some(r => nameKey(r.name) === a.restaurant_name_key)) fail(409, "A restaurant with this name now exists. Reject this application or ask the applicant to choose the existing restaurant.");
        let base = a.restaurant_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "restaurant", n = 2;
        restaurantId = base; while (one("SELECT 1 AS x FROM restaurants WHERE id = ?", restaurantId)) restaurantId = `${base}-${n++}`;
        run(`INSERT INTO restaurants (id, name, municipality, category, address, contact, description, notes, source) VALUES (?,?,?,?,?,?,?,?,?)`,
          restaurantId, a.restaurant_name, a.municipality, a.category, `${a.restaurant_address}, Brgy. ${a.barangay}`, a.restaurant_contact, a.description,
          "Registered through a staff application. Map pin pending: the administrator should verify the location.", `Staff application #${a.id}`);
      } else {
        if (!a.restaurant_id || !one("SELECT 1 AS x FROM restaurants WHERE id = ?", a.restaurant_id)) fail(409, "The requested restaurant no longer exists. Reject this application.");
        restaurantId = a.restaurant_id;
      }
      const upd = run("UPDATE users SET status = 'ACTIVE', restaurant_id = ? WHERE id = ? AND role = 'RESTAURANT_STAFF' AND status = 'PENDING'", restaurantId, a.user_id);
      if (!upd.changes) fail(409, "The applicant account is not waiting for approval.");
      run("UPDATE staff_applications SET status = 'approved', restaurant_id = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now'), review_note = ? WHERE id = ?", restaurantId, user.id, text(body.note, 300, "Note"), a.id);
    });
    json(res, 200, { ok: true, restaurantId });
  });
  add("POST", "/api/admin/applications/:id/reject", ADMIN, async ({ req, res, user, params }) => {
    const body = await readJson(req);
    const note = text(body.note, 300, "Reason", { required: true, min: 5 }); // the applicant sees this reason when they try to log in
    decide(res, user, params.id, body, (a) => {
      if (a.status !== "pending") fail(409, `This application was already ${a.status}. Refresh the list.`);
      run("UPDATE users SET status = 'REJECTED' WHERE id = ? AND role = 'RESTAURANT_STAFF' AND status = 'PENDING'", a.user_id);
      run("UPDATE staff_applications SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now'), review_note = ? WHERE id = ?", user.id, note, a.id);
    });
    json(res, 200, { ok: true });
  });
  add("POST", "/api/admin/applications/:id/reopen", ADMIN, async ({ req, res, user, params }) => {
    const body = await readJson(req);
    decide(res, user, params.id, body, (a) => {
      if (a.status !== "rejected") fail(409, "Only rejected applications can be reconsidered.");
      if (!run("UPDATE users SET status = 'PENDING' WHERE id = ? AND role = 'RESTAURANT_STAFF' AND status = 'REJECTED'", a.user_id).changes) fail(409, "The applicant account cannot be reopened.");
      if (a.is_new_restaurant && one("SELECT 1 AS x FROM staff_applications WHERE status = 'pending' AND is_new_restaurant = 1 AND restaurant_name_key = ? AND id != ?", a.restaurant_name_key, a.id)) fail(409, "Another pending application already exists for this restaurant name.");
      run("UPDATE staff_applications SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = '', updated_at = datetime('now') WHERE id = ?", a.id);
    });
    json(res, 200, { ok: true });
  });

  /* ---------- dispatcher ---------- */
  return async function dispatch(req, res, user, pathname, method) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.roles) {
        if (!user) { json(res, 401, { error: "Please log in to continue.", loginRequired: true }); return true; }
        if (r.roles !== ANY && !r.roles.includes(user.role)) { json(res, 403, { error: "Your account does not have permission to do this." }); return true; }
      }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try { await r.handler({ req, res, user, params }); }
      catch (err) {
        if (err instanceof HttpError) json(res, err.status, { error: err.message, fields: err.fields });
        else throw err;
      }
      return true;
    }
    return false;
  };
};
