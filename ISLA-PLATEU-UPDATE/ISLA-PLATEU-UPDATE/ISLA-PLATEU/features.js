/* ISLA-PLATEU feature API: restaurants, routing, reservations, advance orders, inquiries, reviews,
   notifications, staff tools and administrator tools. Every protected route is authorized HERE on the
   server (the role lists passed to add()), never only in the browser. */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUploads } = require("./lib/uploads.js");

module.exports = function createFeatures(ctx) {
  const { db, json, readJson, hashPassword, crypto, ROLES } = ctx;
  const routes = [];
  const uploads = createUploads(ctx.dbPath);
  const ANY = "ANY";
  const CUSTOMER = ["CUSTOMER"], STAFF = ["RESTAURANT_STAFF"], ADMIN = ["ADMINISTRATOR"];
  const OSRM_URL = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
  const BOUNDS = { latMin: 9.08, latMax: 9.36, lngMin: 123.43, lngMax: 123.67 }; // Siquijor map area

  /* ---------- tiny router ---------- */
  function add(method, pattern, roles, handler) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, roles, handler, pattern });
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

  /* ---------- tables and availability (Phase 4) ---------- */
  const phDate = (ms) => new Date(ms + PH_OFFSET_MS).toISOString().slice(0, 10);
  /* Every table of a restaurant with its status for a reservation that starts at startMs.
     A table is "reserved" when a CONFIRMED reservation on it overlaps [start, start + length). PENDING requests never block. */
  function tablesAt(r, startMs, excludeResId = 0) {
    const tables = all("SELECT * FROM restaurant_tables WHERE restaurant_id = ? ORDER BY id", r.id);
    if (!tables.length) return [];
    const len = (r.reservation_minutes || 90) * 60000, busy = new Set();
    all(`SELECT id, table_id, res_date, res_time FROM reservations WHERE restaurant_id = ? AND status = 'CONFIRMED' AND table_id IS NOT NULL
         AND res_date BETWEEN ? AND ? AND id != ?`, r.id, phDate(startMs - 864e5), phDate(startMs + 864e5), excludeResId).forEach(o => {
      const os = slotInstant(o.res_date, o.res_time, "reservation");
      if (os < startMs + len && startMs < os + len) busy.add(o.table_id);
    });
    return tables.map(t => ({ id: t.id, label: t.label, capacity: t.capacity, reservable: !!t.reservable, active: !!t.active,
      status: !t.active ? "disabled" : !t.reservable ? "walk-in" : busy.has(t.id) ? "reserved" : "available" }));
  }
  function tableSummary(r, startMs = Date.now()) {
    const t = tablesAt(r, startMs);
    if (!t.length) return null;
    const n = (st) => t.filter(x => x.status === st).length;
    return { total: t.length, available: n("available"), reserved: n("reserved"), disabled: n("disabled"), walkInOnly: n("walk-in"),
      reservable: t.filter(x => x.reservable && x.active).length, seats: t.reduce((a, x) => a + x.capacity, 0),
      largest: Math.max(...t.map(x => x.capacity)), reservationMinutes: r.reservation_minutes || 90 };
  }

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
    reservationCapacity: r.reservation_capacity, ratingAvg: r.rating_avg, ratingCount: r.rating_count || 0,
    logo: uploads.publicUrl(r.logo_file), cover: uploads.publicUrl(r.cover_file),
    ordersRequirePayment: !!r.order_prepay && payReady(r.id), reservationFee: r.reservation_fee_cents > 0 && payReady(r.id) ? money(r.reservation_fee_cents) : null,
    tables: tableSummary(r), fulfillmentOptions: ["PICKUP", ...(r.order_dine_in ? ["DINE_IN"] : [])]
  });
  const mapRes = (r) => ({ id: r.id, restaurantId: r.restaurant_id, restaurantName: r.restaurant_name, date: r.res_date, time: r.res_time,
    partySize: r.party_size, notes: r.notes, staffNote: r.staff_note, status: r.status, createdAt: iso(r.created_at),
    payment: paymentOf("RESERVATION", r.id),
    tableId: r.table_id || null, tableLabel: r.table_id ? (one("SELECT label FROM restaurant_tables WHERE id = ?", r.table_id) || {}).label || null : null,
    customerName: r.customer_name, customerEmail: r.customer_email });
  const FULFILLMENT = { PICKUP: "Pickup", DINE_IN: "Dine-in (ready when you arrive)" };
  function mapOrder(o) {
    return { id: o.id, restaurantId: o.restaurant_id, restaurantName: o.restaurant_name, pickupDate: o.pickup_date, pickupTime: o.pickup_time,
      fulfillment: o.fulfillment || "PICKUP", fulfillmentLabel: FULFILLMENT[o.fulfillment || "PICKUP"], staffNote: o.staff_note || "",
      notes: o.notes, status: o.status, total: money(o.total_cents), createdAt: iso(o.created_at), updatedAt: iso(o.updated_at), customerName: o.customer_name,
      customerEmail: o.customer_email,
      items: all("SELECT name, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id", o.id).map(i => ({ name: i.name, price: money(i.price_cents), qty: i.qty, lineTotal: money(i.price_cents * i.qty) })),
      history: all("SELECT status, note, created_at FROM order_status_history WHERE order_id = ? ORDER BY id", o.id).map(h => ({ status: h.status, note: h.note, at: iso(h.created_at) })),
      payment: paymentOf("ORDER", o.id) };
  }
  const orderEvent = (orderId, status, note = "") => run("INSERT INTO order_status_history (order_id, status, note) VALUES (?,?,?)", orderId, status, note);
  /* One pricing function for the review step and for placing the order: prices always come from the database, never the browser. */
  function priceOrder(r, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) fail(400, "Add at least one menu item to your order.");
    if (rawItems.length > 20) fail(400, "An order can have at most 20 different items.");
    const lines = []; let subtotal = 0; const seen = new Set();
    for (const it of rawItems) {
      const id = Number(it && it.menuItemId);
      if (seen.has(id)) fail(400, "Each menu item can only appear once. Change its quantity instead.");
      seen.add(id);
      const qty = int(it && it.qty, 1, 20, "Quantity");
      const m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ? AND available = 1", id, r.id);
      if (!m) fail(400, "One of the selected items is no longer available. Please refresh the menu.");
      lines.push({ m, qty }); subtotal += m.price_cents * qty;
    }
    return { lines, subtotal };
  }
  function fulfillmentFrom(r, v) {
    const f = v === undefined || v === null || v === "" ? "PICKUP" : String(v);
    if (!FULFILLMENT[f]) fail(400, "Choose pickup or dine-in.");
    if (f === "DINE_IN" && !r.order_dine_in) fail(409, `${r.name} does not offer dine-in pre-orders.`);
    return f;
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
    const menu = all("SELECT id, name, description, price_cents, image_file, category, available FROM menu_items WHERE restaurant_id = ? ORDER BY available DESC, name COLLATE NOCASE", r.id)
      .map(m => ({ id: m.id, name: m.name, description: m.description, price: money(m.price_cents), image: uploads.publicUrl(m.image_file), category: m.category, available: !!m.available }));
    const mine = user && user.role === "CUSTOMER" ? one("SELECT rating, comment FROM reviews WHERE restaurant_id = ? AND customer_id = ?", r.id, user.id) : null;
    json(res, 200, { restaurant: mapRestaurant(r), reviews, menu, myReview: mine || null, tableList: tablesAt(r, Date.now()).map(({ id, label, capacity, status }) => ({ id, label, capacity, status })) });
  });

  add("GET", "/api/restaurants/:id/tables", null, async ({ req, res, params }) => {
    const r = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!r) fail(404, "Restaurant not found.");
    const q = new URL(req.url, "http://x").searchParams, date = q.get("date"), time = q.get("time");
    const start = date || time ? slotInstant(String(date), String(time), "slot") : Date.now();
    const tables = tablesAt(r, start).map(({ id, label, capacity, status }) => ({ id, label, capacity, status }));
    json(res, 200, { restaurantId: r.id, date: date || null, time: time || null, acceptsReservations: !!r.accepts_reservations, tables, summary: tableSummary(r, start) });
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
    const slots = tablesAt(r, slotInstant(date, time, "reservation"));
    let tableId = null;
    if (slots.length) { // the restaurant uses table management: check real tables (a customer may name one, or let the restaurant assign)
      const wanted = b.tableId === undefined || b.tableId === null || b.tableId === "" ? null : Number(b.tableId);
      if (wanted !== null) {
        const t = slots.find(x => x.id === wanted);
        if (!t) fail(400, "That table does not belong to this restaurant.");
        if (t.status !== "available") fail(409, `${t.label} is not available at that time. Please choose another table or time.`);
        if (party > t.capacity) fail(409, `${t.label} seats up to ${t.capacity} guests.`);
        tableId = t.id;
      } else if (!slots.some(x => x.status === "available" && x.capacity >= party)) fail(409, `No table is free for ${party} guest(s) at that time. Please choose another time.`);
    } else if (r.reservation_capacity) { // no tables configured: the older guest-capacity rule
      const booked = one("SELECT COALESCE(SUM(party_size), 0) AS n FROM reservations WHERE restaurant_id = ? AND res_date = ? AND res_time = ? AND status IN ('PENDING','CONFIRMED')", r.id, date, time).n;
      if (booked + party > r.reservation_capacity) fail(409, `${r.name} cannot take a party of ${party} at that time. Please choose another time.`);
    }
    const bd = r.reservation_fee_cents > 0 && payReady(r.id) ? computeBreakdown("RESERVATION", r.id, r.reservation_fee_cents, "Reservation fee (restaurant)") : null;
    if (bd) checkExpected(b, bd);
    let resId, paymentId = null;
    db.exec("BEGIN");
    try {
      resId = Number(run("INSERT INTO reservations (restaurant_id, customer_id, res_date, res_time, party_size, notes, table_id) VALUES (?,?,?,?,?,?,?)", r.id, user.id, date, time, party, notes, tableId).lastInsertRowid);
      if (bd) paymentId = createPayment("RESERVATION", resId, r.id, user.id, bd.total, bd.lines);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    notifyStaff(r.id, `New reservation request from ${displayName(user.fullName)}: ${party} guest(s) on ${date} at ${time}.`);
    json(res, 201, { id: resId, status: "PENDING", paymentId, paymentRequired: !!paymentId, message: paymentId ? "Request sent. Pay the reservation fee via GCash and upload your receipt. The table is held only after the restaurant accepts your payment and confirms." : "Reservation request sent. The restaurant will confirm or decline it." });
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
    paymentParentClosed("RESERVATION", v.id);
    notifyStaff(v.restaurant_id, `${displayName(user.fullName)} cancelled the reservation on ${v.res_date} at ${v.res_time}.`);
    json(res, 200, { ok: true });
  });

  /* Review step: the server prices the basket (the same way it will when the order is placed) so the customer confirms real numbers. */
  add("POST", "/api/orders/quote", CUSTOMER, async ({ req, res }) => {
    const b = await readJson(req);
    const r = one(RESTAURANT_SQL + " WHERE r.id = ?", String(b.restaurantId ?? ""));
    if (!r) fail(404, "Restaurant not found.");
    if (!r.accepts_orders || !r.menu_count) fail(409, `${r.name} does not take advance orders through ISLA-PLATEU.`);
    const { lines, subtotal } = priceOrder(r, b.items), fulfillment = fulfillmentFrom(r, b.fulfillment);
    const bd = r.order_prepay && payReady(r.id) ? computeBreakdown("ORDER", r.id, subtotal, "Food and drinks (restaurant)") : null; // fees and taxes apply only when the customer pays through the system
    json(res, 200, { restaurantId: r.id, restaurantName: r.name, fulfillment, fulfillmentLabel: FULFILLMENT[fulfillment],
      items: lines.map(l => ({ menuItemId: l.m.id, name: l.m.name, image: uploads.publicUrl(l.m.image_file), qty: l.qty, price: money(l.m.price_cents), lineTotal: money(l.m.price_cents * l.qty) })),
      subtotal: money(subtotal), paymentRequired: !!bd, breakdown: bd ? showLines(bd.lines) : null, total: money(bd ? bd.total : subtotal) });
  });
  add("POST", "/api/orders", CUSTOMER, async ({ req, res, user }) => {
    const b = await readJson(req);
    const r = one(RESTAURANT_SQL + " WHERE r.id = ?", String(b.restaurantId ?? ""));
    if (!r) fail(404, "Restaurant not found.");
    if (!r.accepts_orders || !r.menu_count) fail(409, `${r.name} does not take advance orders through ISLA-PLATEU.`);
    const date = String(b.pickupDate ?? ""), time = String(b.pickupTime ?? "");
    futureSlot(date, time, "pickup", 30);
    const notes = text(b.notes, 300, "Notes"), fulfillment = fulfillmentFrom(r, b.fulfillment);
    const { lines, subtotal: total } = priceOrder(r, b.items);
    const bd = r.order_prepay && payReady(r.id) ? computeBreakdown("ORDER", r.id, total, "Food and drinks (restaurant)") : null;
    if (bd) checkExpected(b, bd);
    let orderId, paymentId = null;
    db.exec("BEGIN");
    try {
      orderId = Number(run("INSERT INTO orders (restaurant_id, customer_id, pickup_date, pickup_time, notes, total_cents, fulfillment) VALUES (?,?,?,?,?,?,?)", r.id, user.id, date, time, notes, total, fulfillment).lastInsertRowid);
      lines.forEach(l => run("INSERT INTO order_items (order_id, name, price_cents, qty) VALUES (?,?,?,?)", orderId, l.m.name, l.m.price_cents, l.qty));
      orderEvent(orderId, "PENDING", "Order placed");
      if (bd) paymentId = createPayment("ORDER", orderId, r.id, user.id, bd.total, bd.lines);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    notifyStaff(r.id, `New advance order #${orderId} from ${displayName(user.fullName)} for ${fulfillment === "DINE_IN" ? "dine-in" : "pickup"} ${date} ${time}.`);
    json(res, 201, { id: orderId, status: "PENDING", total: money(total), payable: money(bd ? bd.total : total), paymentId, paymentRequired: !!paymentId, message: paymentId ? "Order sent. Pay via GCash and upload your receipt so the restaurant can accept it." : "Advance order sent. The restaurant will accept or decline it." });
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
    orderEvent(o.id, "CANCELLED", "Cancelled by the customer");
    paymentParentClosed("ORDER", o.id);
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
    // Staff may manage their assigned restaurant's operations. Preloaded demo restaurant profiles allow staff to edit public identity/address fields; map pins and verification remain admin-controlled.
    const r = staffRestaurant(user), b = await readJson(req);
    const contact = text(b.contact ?? r.contact, 80, "Contact"), hours = text(b.hours ?? r.hours, 120, "Hours");
    const description = text(b.description ?? r.description, 1000, "Description");
    const canEditIdentity = ["pagudfood", "the-cafe-infinite", "luka-loko"].includes(r.id);
    const name = canEditIdentity ? text(b.name ?? r.name, 100, "Restaurant name", { required: true, min: 2 }) : r.name;
    const category = canEditIdentity ? text(b.category ?? r.category, 60, "Category", { required: true, min: 2 }) : r.category;
    const address = canEditIdentity ? text(b.address ?? r.address, 180, "Address", { required: true, min: 5 }) : r.address;
    const municipality = canEditIdentity ? text(b.municipality ?? r.municipality, 60, "Municipality", { required: true, min: 2 }) : r.municipality;
    const cap = b.reservationCapacity === null || b.reservationCapacity === "" ? null : b.reservationCapacity === undefined ? r.reservation_capacity : int(b.reservationCapacity, 1, 500, "Capacity");
    const acceptsRes = b.acceptsReservations === undefined ? r.accepts_reservations : b.acceptsReservations ? 1 : 0;
    const acceptsOrd = b.acceptsOrders === undefined ? r.accepts_orders : b.acceptsOrders ? 1 : 0;
    const mins = b.reservationMinutes === undefined ? r.reservation_minutes : int(b.reservationMinutes, 30, 240, "Reservation length (minutes)");
    run("UPDATE restaurants SET name=?, category=?, address=?, municipality=?, contact=?, hours=?, description=?, reservation_capacity=?, accepts_reservations=?, accepts_orders=?, reservation_minutes=?, order_dine_in=?, updated_at=datetime('now') WHERE id=?",
      name, category, address, municipality, contact, hours, description, cap, acceptsRes, acceptsOrd, mins, b.orderDineIn === undefined ? r.order_dine_in : b.orderDineIn ? 1 : 0, r.id);
    json(res, 200, { ok: true });
  });

  const RES_NEXT = { PENDING: ["CONFIRMED", "DECLINED"], CONFIRMED: ["COMPLETED", "NO_SHOW", "CANCELLED"] };
  add("GET", "/api/staff/reservations", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    json(res, 200, all(`SELECT v.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email FROM reservations v
      JOIN restaurants r ON r.id = v.restaurant_id JOIN users u ON u.id = v.customer_id WHERE v.restaurant_id = ?
      ORDER BY (v.status = 'PENDING') DESC, v.res_date DESC, v.res_time DESC LIMIT 200`, r.id).map(v => {
      const m = mapRes(v);
      if (v.status === "PENDING") m.freeTables = tablesAt(r, slotInstant(v.res_date, v.res_time, "reservation"), v.id).filter(t => t.status === "available" && t.capacity >= v.party_size).map(t => ({ id: t.id, label: t.label, capacity: t.capacity }));
      return m;
    }));
  });
  add("PATCH", "/api/staff/reservations/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user);
    const v = one("SELECT * FROM reservations WHERE id = ? AND restaurant_id = ?", params.id, r.id); // cannot touch other restaurants' bookings
    if (!v) fail(404, "Reservation not found.");
    const b = await readJson(req);
    const next = String(b.status ?? "");
    if (!(RES_NEXT[v.status] || []).includes(next)) fail(409, `A ${v.status.toLowerCase()} reservation cannot be changed to ${next || "that status"}.`);
    const note = text(b.staffNote, 300, "Note");
    let tableId = v.table_id, assigned = null;
    if (next === "CONFIRMED") requirePaymentAccepted("RESERVATION", v.id); // a table is confirmed only after any required payment was verified
    if (next === "CONFIRMED") {
      const slots = tablesAt(r, slotInstant(v.res_date, v.res_time, "reservation"), v.id); // excludes this reservation itself
      if (slots.length) { // double-booking guard: the table must be free for the whole reservation window
        const wanted = b.tableId === undefined || b.tableId === null || b.tableId === "" ? v.table_id : Number(b.tableId);
        let t = wanted ? slots.find(x => x.id === wanted) : null;
        if (wanted && !t) fail(400, "That table does not belong to your restaurant.");
        if (t) {
          if (t.status !== "available") fail(409, `${t.label} is not available at that time (${t.status === "reserved" ? "already reserved" : t.status === "disabled" ? "temporarily disabled" : "not set as reservable"}).`);
          if (v.party_size > t.capacity) fail(409, `${t.label} seats up to ${t.capacity} guests, but this party is ${v.party_size}.`);
        } else {
          t = slots.filter(x => x.status === "available" && x.capacity >= v.party_size).sort((a, c) => a.capacity - c.capacity || a.id - c.id)[0];
          if (!t) fail(409, `No table is free for ${v.party_size} guest(s) at that time. You can decline this request or free a table first.`);
        }
        tableId = t.id; assigned = t.label;
      } else if (r.reservation_capacity) {
        const booked = one("SELECT COALESCE(SUM(party_size),0) AS n FROM reservations WHERE restaurant_id = ? AND res_date = ? AND res_time = ? AND status = 'CONFIRMED' AND id != ?", r.id, v.res_date, v.res_time, v.id).n;
        if (booked + v.party_size > r.reservation_capacity) fail(409, "Confirming this would exceed your capacity for that time.");
      }
    }
    run("UPDATE reservations SET status = ?, staff_note = ?, table_id = ?, updated_at = datetime('now') WHERE id = ?", next, note, tableId, v.id);
    if (next === "DECLINED" || next === "CANCELLED") paymentParentClosed("RESERVATION", v.id);
    notify(v.customer_id, `Your reservation at ${r.name} on ${v.res_date} ${v.res_time} is now ${next.replace("_", " ")}.${assigned ? ` Table: ${assigned}.` : ""}${note ? " Note: " + note : ""}`);
    json(res, 200, { ok: true, table: assigned });
  });

  /* =====================================================================================================
     FEES AND TAXES (Phase 7). Nothing is assumed: with no configuration the customer pays only the restaurant's charge.
     Platform fee/tax lines are entered by an administrator (taxes need a recorded basis and an explicit "verified" confirmation);
     restaurants may add their own fees or taxes. Each payment stores a snapshot of the exact breakdown the customer saw.
     Categories: "restaurant" (restaurant charges), "government_tax" (taxes), "platform_fee" (ISLA-PLATEU service fee).
     ===================================================================================================== */
  const FEE_BASES = { SERVICE_FEE: ["FOOD", "RESTAURANT_TOTAL"], SYSTEM_TAX: ["FOOD", "RESTAURANT_TOTAL", "SERVICE_FEES"], FEE: ["FOOD"], TAX: ["FOOD", "FOOD_AND_FEES"] };
  const APPLIES = ["ORDER", "RESERVATION", "BOTH"], MAX_RESTAURANT_CHARGES = 6;
  const pctOf = (base, bp) => Math.round((base * bp) / 10000); // each line is rounded to the nearest centavo (halves round up); the total is the sum of the rounded lines
  /* One calculator for the review screen, the payment and the admin preview. restaurantId may be null (admin preview of platform lines only). */
  function computeBreakdown(kind, restaurantId, foodCents, foodLabel) {
    const applies = (x) => x.applies_to === "BOTH" || x.applies_to === kind;
    const lines = [{ label: foodLabel, category: "restaurant", owner: "restaurant", cents: foodCents }];
    const add_ = (label, category, owner, cents) => { if (cents > 0) lines.push({ label, category, owner, cents }); };
    const rc = restaurantId ? all("SELECT * FROM restaurant_charges WHERE restaurant_id = ? AND active = 1 ORDER BY id", restaurantId).filter(applies) : [];
    let fees = 0;
    for (const c of rc.filter(c => c.kind === "FEE")) { const a = c.calc === "PERCENT" ? pctOf(foodCents, c.value) : c.value; fees += a; add_(c.label, "restaurant", "restaurant", a); }
    for (const c of rc.filter(c => c.kind === "TAX")) { const a = c.calc === "PERCENT" ? pctOf(c.base === "FOOD_AND_FEES" ? foodCents + fees : foodCents, c.value) : c.value; add_(c.label, "government_tax", "restaurant", a); }
    const restaurantTotal = lines.reduce((t, l) => t + l.cents, 0);
    const sys = all("SELECT * FROM system_fee_settings WHERE active = 1 ORDER BY id").filter(applies);
    let svc = 0;
    for (const c of sys.filter(c => c.kind === "SERVICE_FEE")) { const a = c.calc === "PERCENT" ? pctOf(c.base === "RESTAURANT_TOTAL" ? restaurantTotal : foodCents, c.value) : c.value; svc += a; add_(c.label, "platform_fee", "platform", a); }
    for (const c of sys.filter(c => c.kind === "SYSTEM_TAX")) { const b = c.base === "SERVICE_FEES" ? svc : c.base === "RESTAURANT_TOTAL" ? restaurantTotal : foodCents; add_(c.label, "government_tax", "platform", c.calc === "PERCENT" ? pctOf(b, c.value) : c.value); }
    return { lines, total: lines.reduce((t, l) => t + l.cents, 0) };
  }
  const showLines = (lines) => lines.map(l => ({ label: l.label, category: l.category, owner: l.owner, amount: money(l.cents) }));
  /* If fees or taxes changed while the customer was reviewing, they must review again (what they confirmed is what they pay). */
  function checkExpected(b, bd) {
    if (b.expectedTotal === undefined || b.expectedTotal === null || b.expectedTotal === "") return;
    if (Math.round(Number(b.expectedTotal) * 100) !== bd.total) fail(409, "The fees or taxes changed since you reviewed this. Please review the new total and try again.");
  }
  function parseLine(b, kinds, cur) {
    const kind = b.kind === undefined && cur ? cur.kind : String(b.kind ?? "");
    if (!kinds.includes(kind)) fail(400, "Choose a valid type.", { kind: "Invalid type." });
    const label = b.label === undefined && cur ? cur.label : text(b.label, 60, "Name", { required: true, min: 2 });
    let calc, value;
    if (cur && b.calc === undefined && b.value === undefined) { calc = cur.calc; value = cur.value; }
    else {
      calc = String(b.calc ?? ""); const n = Number(b.value);
      if (!["PERCENT", "FIXED"].includes(calc)) fail(400, "Choose percentage or fixed amount.", { calc: "Choose one." });
      if (calc === "PERCENT" && !(Number.isFinite(n) && n >= 0.01 && n <= 50)) fail(400, "A percentage must be between 0.01 and 50.", { value: "0.01 to 50." });
      if (calc === "FIXED" && !(Number.isFinite(n) && n >= 0.01 && n <= 10000)) fail(400, "A fixed amount must be between 0.01 and 10,000 pesos.", { value: "0.01 to 10,000." });
      value = Math.round(n * 100);
    }
    const base = b.base === undefined && cur ? cur.base : String(b.base ?? "FOOD");
    if (!FEE_BASES[kind].includes(base)) fail(400, "That calculation base is not allowed for this type.", { base: "Not allowed." });
    const appliesTo = b.appliesTo === undefined && cur ? cur.applies_to : String(b.appliesTo ?? "BOTH");
    if (!APPLIES.includes(appliesTo)) fail(400, "Choose whether it applies to orders, reservations or both.", { appliesTo: "Invalid." });
    const active = b.active === undefined ? (cur ? cur.active : 1) : b.active ? 1 : 0;
    return { kind, label, calc, value, base, appliesTo, active };
  }
  const showValue = (r) => (r.calc === "PERCENT" ? r.value / 100 : money(r.value));
  const mapSys = (r) => ({ id: r.id, kind: r.kind, label: r.label, calc: r.calc, value: showValue(r), base: r.base, appliesTo: r.applies_to, active: !!r.active, basisNote: r.basis_note, verifiedAt: iso(r.verified_at), updatedAt: iso(r.updated_at) });
  const mapCharge = (r) => ({ id: r.id, restaurantId: r.restaurant_id, kind: r.kind, label: r.label, calc: r.calc, value: showValue(r), base: r.base, appliesTo: r.applies_to, active: !!r.active, confirmedAt: iso(r.confirmed_at) });
  const lineDetail = (L) => ({ kind: L.kind, label: L.label, calc: L.calc, value: L.calc === "PERCENT" ? L.value / 100 + "%" : money(L.value), base: L.base, appliesTo: L.appliesTo, active: !!L.active });

  /* ---- administrator: platform service fee and system taxes ---- */
  add("GET", "/api/admin/fee-settings", ADMIN, async ({ res }) => json(res, 200, {
    lines: all("SELECT * FROM system_fee_settings ORDER BY id").map(mapSys),
    restaurantCharges: all("SELECT c.*, r.name AS restaurant_name FROM restaurant_charges c JOIN restaurants r ON r.id = c.restaurant_id ORDER BY r.name, c.id").map(c => ({ ...mapCharge(c), restaurantName: c.restaurant_name }))
  }));
  function requireTaxProof(L, note, b, changed) {
    if (L.kind !== "SYSTEM_TAX" || !L.active || !changed) return;
    if (note.length < 10) fail(400, "Describe the legal or accounting basis for this tax (at least 10 characters).", { basisNote: "Required for taxes." });
    if (b.verified !== true) fail(400, "Confirm that you verified this tax against the applicable legal and accounting requirements.", { verified: "Confirmation required." });
  }
  add("POST", "/api/admin/fee-settings", ADMIN, async ({ req, res, user }) => {
    const b = await readJson(req), L = parseLine(b, ["SERVICE_FEE", "SYSTEM_TAX"]), note = text(b.basisNote, 300, "Legal or accounting basis");
    requireTaxProof(L, note, b, true);
    const id = Number(run(`INSERT INTO system_fee_settings (kind, label, calc, value, base, applies_to, active, basis_note, verified_by, verified_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      L.kind, L.label, L.calc, L.value, L.base, L.appliesTo, L.active, note, L.kind === "SYSTEM_TAX" ? user.id : null, L.kind === "SYSTEM_TAX" ? SQL_NOW() : null, user.id).lastInsertRowid);
    audit(user, "fee_setting.created", "system_fee_setting", id, { ...lineDetail(L), basisNote: note, verifiedBy: L.kind === "SYSTEM_TAX" ? user.fullName : null });
    json(res, 201, { id });
  });
  add("PATCH", "/api/admin/fee-settings/:id", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM system_fee_settings WHERE id = ?", params.id);
    if (!cur) fail(404, "Fee setting not found.");
    const b = await readJson(req), L = parseLine(b, ["SERVICE_FEE", "SYSTEM_TAX"], cur), note = b.basisNote === undefined ? cur.basis_note : text(b.basisNote, 300, "Legal or accounting basis");
    const changed = L.kind !== cur.kind || L.calc !== cur.calc || L.value !== cur.value || L.base !== cur.base || (L.active && !cur.active) || note !== cur.basis_note;
    requireTaxProof(L, note, b, changed);
    const reverified = L.kind === "SYSTEM_TAX" && L.active && changed;
    run(`UPDATE system_fee_settings SET kind=?, label=?, calc=?, value=?, base=?, applies_to=?, active=?, basis_note=?, verified_by = CASE WHEN ? THEN ? ELSE verified_by END,
         verified_at = CASE WHEN ? THEN ? ELSE verified_at END, updated_at = datetime('now') WHERE id = ?`, L.kind, L.label, L.calc, L.value, L.base, L.appliesTo, L.active, note, reverified ? 1 : 0, user.id, reverified ? 1 : 0, SQL_NOW(), cur.id);
    audit(user, "fee_setting.updated", "system_fee_setting", cur.id, { before: lineDetail({ ...cur, appliesTo: cur.applies_to }), after: lineDetail(L), basisNote: note });
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/admin/fee-settings/:id", ADMIN, async ({ res, user, params }) => {
    const cur = one("SELECT * FROM system_fee_settings WHERE id = ?", params.id);
    if (!cur) fail(404, "Fee setting not found.");
    run("DELETE FROM system_fee_settings WHERE id = ?", cur.id);
    audit(user, "fee_setting.deleted", "system_fee_setting", cur.id, lineDetail({ ...cur, appliesTo: cur.applies_to }));
    json(res, 200, { ok: true });
  });
  /* What a customer would see for a given amount, so the administrator can check a configuration before relying on it. */
  add("GET", "/api/admin/fee-preview", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, kind = q.get("kind") === "RESERVATION" ? "RESERVATION" : "ORDER", amount = Number(q.get("amount") || 500);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) fail(400, "Enter a sample amount between 1 and 100,000 pesos.");
    const rid = q.get("restaurantId") || null;
    if (rid && !one("SELECT 1 AS x FROM restaurants WHERE id = ?", rid)) fail(404, "Restaurant not found.");
    const bd = computeBreakdown(kind, rid, Math.round(amount * 100), kind === "ORDER" ? "Food and drinks (restaurant)" : "Reservation fee (restaurant)");
    json(res, 200, { kind, breakdown: showLines(bd.lines), total: money(bd.total) });
  });
  /* Money that passed through accepted payments, split by who it belongs to. ISLA-PLATEU never receives the money itself: customers pay the restaurant's GCash. */
  add("GET", "/api/admin/fee-ledger", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, today = phDate(Date.now()), from = q.get("from") || today.slice(0, 8) + "01", to = q.get("to") || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) fail(400, "Choose a valid date range.");
    const rows = all(`SELECT p.*, r.name AS restaurant_name FROM payments p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE p.status = 'ACCEPTED' AND date(p.reviewed_at, '+8 hours') BETWEEN ? AND ? ORDER BY r.name`, from, to);
    const by = new Map();
    for (const p of rows) {
      const e = by.get(p.restaurant_id) || { restaurantId: p.restaurant_id, restaurantName: p.restaurant_name, payments: 0, collected: 0, restaurantShare: 0, platformFees: 0, systemTaxes: 0 };
      e.payments++; e.collected += p.amount_cents;
      for (const l of JSON.parse(p.breakdown_json || "[]")) {
        const owner = l.owner || "restaurant", cat = l.category || l.kind;
        if (owner === "platform" && cat === "platform_fee") e.platformFees += l.cents; else if (owner === "platform") e.systemTaxes += l.cents; else e.restaurantShare += l.cents;
      }
      by.set(p.restaurant_id, e);
    }
    const list = [...by.values()].map(e => ({ ...e, collected: money(e.collected), restaurantShare: money(e.restaurantShare), platformFees: money(e.platformFees), systemTaxes: money(e.systemTaxes) }));
    const sum = (k) => Math.round(list.reduce((t, e) => t + e[k] * 100, 0)) / 100;
    json(res, 200, { from, to, restaurants: list, totals: { payments: list.reduce((t, e) => t + e.payments, 0), collected: sum("collected"), restaurantShare: sum("restaurantShare"), platformFees: sum("platformFees"), systemTaxes: sum("systemTaxes") } });
  });

  /* ---- staff: this restaurant's own fees and taxes ---- */
  add("GET", "/api/staff/restaurant-charges", STAFF, async ({ res, user }) => json(res, 200, all("SELECT * FROM restaurant_charges WHERE restaurant_id = ? ORDER BY id", staffRestaurant(user).id).map(mapCharge)));
  function requireTaxConfirm(L, b, changed) {
    if (L.kind === "TAX" && L.active && changed && b.confirmed !== true) fail(400, "Confirm that you are registered or authorised to charge this tax and that the rate is correct.", { confirmed: "Confirmation required." });
  }
  add("POST", "/api/staff/restaurant-charges", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req), L = parseLine(b, ["FEE", "TAX"]);
    if (one("SELECT COUNT(*) AS n FROM restaurant_charges WHERE restaurant_id = ?", r.id).n >= MAX_RESTAURANT_CHARGES) fail(409, `You can have at most ${MAX_RESTAURANT_CHARGES} extra charges.`);
    requireTaxConfirm(L, b, true);
    const id = Number(run("INSERT INTO restaurant_charges (restaurant_id, kind, label, calc, value, base, applies_to, active, confirmed_by, confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      r.id, L.kind, L.label, L.calc, L.value, L.base, L.appliesTo, L.active, L.kind === "TAX" ? user.id : null, L.kind === "TAX" ? SQL_NOW() : null).lastInsertRowid);
    audit(user, "restaurant_charge.created", "restaurant_charge", id, { restaurantId: r.id, ...lineDetail(L), confirmedBy: L.kind === "TAX" ? user.fullName : null });
    json(res, 201, { id });
  });
  add("PATCH", "/api/staff/restaurant-charges/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), cur = one("SELECT * FROM restaurant_charges WHERE id = ? AND restaurant_id = ?", params.id, r.id); // own restaurant only
    if (!cur) fail(404, "Charge not found.");
    const b = await readJson(req), L = parseLine(b, ["FEE", "TAX"], cur);
    const changed = L.kind !== cur.kind || L.calc !== cur.calc || L.value !== cur.value || L.base !== cur.base || (L.active && !cur.active);
    requireTaxConfirm(L, b, changed);
    const reconf = L.kind === "TAX" && L.active && changed;
    run(`UPDATE restaurant_charges SET kind=?, label=?, calc=?, value=?, base=?, applies_to=?, active=?, confirmed_by = CASE WHEN ? THEN ? ELSE confirmed_by END,
         confirmed_at = CASE WHEN ? THEN ? ELSE confirmed_at END, updated_at = datetime('now') WHERE id = ?`, L.kind, L.label, L.calc, L.value, L.base, L.appliesTo, L.active, reconf ? 1 : 0, user.id, reconf ? 1 : 0, SQL_NOW(), cur.id);
    audit(user, "restaurant_charge.updated", "restaurant_charge", cur.id, { restaurantId: r.id, before: lineDetail({ ...cur, appliesTo: cur.applies_to }), after: lineDetail(L) });
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/staff/restaurant-charges/:id", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), cur = one("SELECT * FROM restaurant_charges WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!cur) fail(404, "Charge not found.");
    run("DELETE FROM restaurant_charges WHERE id = ?", cur.id);
    audit(user, "restaurant_charge.deleted", "restaurant_charge", cur.id, { restaurantId: r.id, ...lineDetail({ ...cur, appliesTo: cur.applies_to }) });
    json(res, 200, { ok: true });
  });
  /* What a customer will pay for the reservation fee at this restaurant (nothing if the restaurant takes no fee through the system). */
  add("GET", "/api/restaurants/:id/reservation-quote", null, async ({ res, params }) => {
    const r = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!r) fail(404, "Restaurant not found.");
    if (!(r.reservation_fee_cents > 0 && payReady(r.id))) return json(res, 200, { feeRequired: false, breakdown: [], total: 0 });
    const bd = computeBreakdown("RESERVATION", r.id, r.reservation_fee_cents, "Reservation fee (restaurant)");
    json(res, 200, { feeRequired: true, breakdown: showLines(bd.lines), total: money(bd.total) });
  });

  /* =====================================================================================================
     PAYMENTS (Phase 6): restaurant GCash details, customer receipt upload, staff verification.
     An uploaded screenshot is NEVER proof of payment by itself: only a staff member who checked the
     transaction in their own GCash records can accept it, and the server requires them to confirm that.
     Receipts and QR codes are private files, served only to the owning customer, the restaurant's staff and admins.
     ===================================================================================================== */
  const PAY_LABEL = { UNPAID: "Unpaid", AWAITING_PROOF: "Awaiting payment proof", UNDER_REVIEW: "Payment under review", ACCEPTED: "Payment accepted", REJECTED: "Payment rejected", REFUNDED: "Refunded", VOID: "No payment due" };
  const MAX_ATTEMPTS = 5, MAX_DECLARED_CENTS = 10000000;
  const feeCents = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 10000) fail(400, "The reservation fee must be between 0 and 10,000 pesos (0 means no fee).", { reservationFee: "Between 0 and 10,000." }); return Math.round(n * 100); };
  const mobileFrom = (v) => {
    const raw = text(v, 20, "GCash mobile number", { required: true }).replace(/[\s-]/g, "");
    if (!/^(?:\+?63|0)9\d{9}$/.test(raw)) fail(400, "Enter a valid Philippine mobile number, for example 0917 123 4567.", { mobile: "Enter a valid mobile number." });
    return "0" + raw.slice(-10);
  };
  const maskMobile = (m) => (m ? `${m.slice(0, 4)} ••• ${m.slice(-4)}` : "");
  const payAccount = (rid) => one("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = ?", rid);
  const payReady = (rid) => { const a = payAccount(rid); return !!(a && a.qr_file && a.holder_name && a.mobile); };
  const payEvent = (pid, user, action, note = "") => run("INSERT INTO payment_events (payment_id, actor_id, actor_name, action, note) VALUES (?,?,?,?,?)", pid, user ? user.id : null, user ? user.fullName : "system", action, note);
  function createPayment(kind, parentId, restaurantId, customerId, amountCents, lines) {
    const id = Number(run("INSERT INTO payments (restaurant_id, customer_id, kind, order_id, reservation_id, amount_cents, breakdown_json) VALUES (?,?,?,?,?,?,?)",
      restaurantId, customerId, kind, kind === "ORDER" ? parentId : null, kind === "RESERVATION" ? parentId : null, amountCents, JSON.stringify(lines)).lastInsertRowid);
    payEvent(id, null, "payment.created", `Amount due ${money(amountCents)}`);
    return id;
  }
  const paymentFor = (kind, id) => one(kind === "ORDER" ? "SELECT * FROM payments WHERE order_id = ?" : "SELECT * FROM payments WHERE reservation_id = ?", id);
  function parentInfo(p) {
    if (p.kind === "ORDER") {
      const o = one("SELECT * FROM orders WHERE id = ?", p.order_id); if (!o) return null;
      return { kind: "ORDER", id: o.id, label: `Order #${o.id}`, status: o.status, active: !["REJECTED", "CANCELLED"].includes(o.status), when: `${o.pickup_date} ${o.pickup_time}` };
    }
    const v = one("SELECT * FROM reservations WHERE id = ?", p.reservation_id); if (!v) return null;
    return { kind: "RESERVATION", id: v.id, label: `Table reservation #${v.id}`, status: v.status, active: !["DECLINED", "CANCELLED"].includes(v.status), when: `${v.res_date} ${v.res_time}`, partySize: v.party_size };
  }
  function mapPayment(p, forStaff = false) {
    const pi = parentInfo(p), subs = all("SELECT * FROM payment_submissions WHERE payment_id = ? ORDER BY id", p.id);
    const demoPayment = !!((one("SELECT demo_payment FROM restaurants WHERE id = ?", p.restaurant_id) || {}).demo_payment);
    const out = { id: p.id, kind: p.kind, status: p.status, statusLabel: PAY_LABEL[p.status], amount: money(p.amount_cents), demoPayment,
      breakdown: JSON.parse(p.breakdown_json || "[]").map(l => ({ label: l.label, kind: l.category || l.kind, category: l.category || l.kind || "restaurant", owner: l.owner || "restaurant", amount: money(l.cents) })),
      reviewNote: p.review_note, refundNote: p.refund_note, createdAt: iso(p.created_at),
      canSubmit: ["AWAITING_PROOF", "REJECTED"].includes(p.status) && !!(pi && pi.active) && subs.length < MAX_ATTEMPTS };
    if (forStaff) {
      const c = one("SELECT full_name, email FROM users WHERE id = ?", p.customer_id) || {};
      Object.assign(out, { parent: pi, customerName: c.full_name, customerEmail: c.email, refundDue: p.status === "ACCEPTED" && !!pi && !pi.active,
        submissions: subs.map(s => ({ id: s.id, reference: s.reference, declared: money(s.declared_cents), mismatch: s.declared_cents !== p.amount_cents, at: iso(s.created_at), decision: s.decision, note: s.decision_note, verified: !!s.verified })),
        events: all("SELECT actor_name, action, note, created_at FROM payment_events WHERE payment_id = ? ORDER BY id", p.id).map(e => ({ by: e.actor_name, action: e.action, note: e.note, at: iso(e.created_at) })) });
    }
    return out;
  }
  const paymentOf = (kind, id) => { const p = paymentFor(kind, id); return p ? mapPayment(p) : null; };
  /* When an order/reservation is cancelled, rejected or declined, an unpaid payment is voided; money already received needs a refund by staff. */
  function paymentParentClosed(kind, id) {
    const p = paymentFor(kind, id); if (!p) return;
    if (["AWAITING_PROOF", "REJECTED", "UNPAID"].includes(p.status)) { run("UPDATE payments SET status = 'VOID', updated_at = datetime('now') WHERE id = ?", p.id); payEvent(p.id, null, "payment.void", "Closed before payment was accepted"); }
    else if (p.status === "ACCEPTED") notifyStaff(p.restaurant_id, `Payment #${p.id} (${money(p.amount_cents)}) was accepted but its ${kind.toLowerCase()} is now closed. Refund the customer in GCash, then mark it refunded under Payments.`);
    else if (p.status === "UNDER_REVIEW") notifyStaff(p.restaurant_id, `Payment #${p.id} is awaiting review but its ${kind.toLowerCase()} is now closed. Check your GCash records and refund if money was received.`);
  }
  /* The server enforces the gate: nothing that needs payment is accepted or confirmed until staff accepted the payment. */
  function requirePaymentAccepted(kind, id) {
    const p = paymentFor(kind, id);
    if (p && !["ACCEPTED"].includes(p.status)) fail(409, p.status === "VOID" ? "This payment was closed." : `The customer's payment has not been accepted yet (${PAY_LABEL[p.status].toLowerCase()}). Review it under Payments first.`);
  }
  function paymentAccess(user, p) {
    if (user.role === "ADMINISTRATOR") return "admin";
    if (user.role === "CUSTOMER" && p.customer_id === user.id) return "customer";
    if (user.role === "RESTAURANT_STAFF" && user.restaurantId === p.restaurant_id) return "staff";
    fail(404, "Payment not found.");
  }
  function sendPrivate(res, file, name) {
    const f = uploads.readPrivateFile(file);
    if (!f) fail(404, "The file is missing from storage.");
    ctx.send(res, 200, f.data, { "Content-Type": f.type, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Content-Disposition": `inline; filename="${name}"` });
  }

  /* ---- staff: GCash details ---- */
  const accountView = (r) => { const a = payAccount(r.id); return { configured: !!a, holderName: a ? a.holder_name : "", mobile: a ? a.mobile : "", hasQr: !!(a && a.qr_file), qrUrl: a && a.qr_file ? "/api/staff/payment-account/qr" : null,
    demoPayment: !!r.demo_payment, orderPrepay: !!r.order_prepay, reservationFee: money(r.reservation_fee_cents), ready: payReady(r.id), updatedAt: a ? iso(a.updated_at) : null }; };
  add("GET", "/api/staff/payment-account", STAFF, async ({ res, user }) => json(res, 200, accountView(staffRestaurant(user))));
  add("PUT", "/api/staff/payment-account", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req);
    const holder = text(b.holderName, 80, "Account holder name", { required: true, min: 2 }), mobile = mobileFrom(b.mobile);
    const prepay = b.orderPrepay === undefined ? !!r.order_prepay : !!b.orderPrepay;
    const fee = b.reservationFee === undefined ? r.reservation_fee_cents : feeCents(b.reservationFee === "" || b.reservationFee === null ? 0 : b.reservationFee);
    const existing = payAccount(r.id);
    if ((prepay || fee > 0) && !(existing && existing.qr_file)) fail(400, "Upload your GCash QR code before turning on payments.", { qr: "QR code required." });
    run(`INSERT INTO restaurant_payment_accounts (restaurant_id, holder_name, mobile, updated_by) VALUES (?,?,?,?)
         ON CONFLICT (restaurant_id) DO UPDATE SET holder_name = excluded.holder_name, mobile = excluded.mobile, updated_by = excluded.updated_by, updated_at = datetime('now')`, r.id, holder, mobile, user.id);
    run("UPDATE restaurants SET order_prepay = ?, reservation_fee_cents = ?, updated_at = datetime('now') WHERE id = ?", prepay ? 1 : 0, fee, r.id);
    audit(user, "payment_account.updated", "restaurant", r.id, { holderChanged: !existing || existing.holder_name !== holder, mobileChanged: !existing || existing.mobile !== mobile, orderPrepay: prepay, reservationFee: money(fee) }); // never logs the number itself
    json(res, 200, accountView(one("SELECT * FROM restaurants WHERE id = ?", r.id)));
  });
  add("POST", "/api/staff/payment-account/qr", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), a = payAccount(r.id);
    if (r.demo_payment) { req.resume(); fail(409, "PagudFood uses a fixed, non-scannable DEMO QR code. Real or scannable payment QR uploads are disabled for this demonstration restaurant."); }
    if (!a) { req.resume(); fail(409, "Save your GCash account name and number first, then upload the QR code."); }
    let saved;
    try { saved = uploads.savePrivateFile(await uploads.readBinary(req), { imagesOnly: true }); } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
    try {
      db.exec("BEGIN");
      run("UPDATE restaurant_payment_accounts SET qr_file = ?, updated_by = ?, updated_at = datetime('now') WHERE restaurant_id = ?", saved.name, user.id, r.id);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      uploads.deletePrivateFile(saved.name);
      throw e;
    }
    // Keep the old file until the database points at the new one. A failed DB update never loses the working QR.
    uploads.deletePrivateFile(a.qr_file);
    audit(user, "payment_account.qr_replaced", "restaurant", r.id, {});
    json(res, 200, { ok: true, ...accountView(one("SELECT * FROM restaurants WHERE id = ?", r.id)) });
  });
  add("DELETE", "/api/staff/payment-account/qr", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user), a = payAccount(r.id);
    if (!a || !a.qr_file) fail(404, "No GCash QR code has been uploaded for your restaurant.");
    run("UPDATE restaurant_payment_accounts SET qr_file = '', updated_by = ?, updated_at = datetime('now') WHERE restaurant_id = ?", user.id, r.id);
    uploads.deletePrivateFile(a.qr_file);
    audit(user, "payment_account.qr_removed", "restaurant", r.id, {});
    json(res, 200, { ok: true, ...accountView(one("SELECT * FROM restaurants WHERE id = ?", r.id)) });
  });
  add("GET", "/api/staff/payment-account/qr", STAFF, async ({ res, user }) => {
    const a = payAccount(staffRestaurant(user).id);
    if (!a || !a.qr_file) fail(404, "No QR code uploaded yet.");
    sendPrivate(res, a.qr_file, "gcash-qr");
  });
  add("GET", "/api/admin/restaurants/:id/payment-qr", ADMIN, async ({ res, params }) => {
    if (!one("SELECT id FROM restaurants WHERE id = ?", params.id)) fail(404, "Restaurant not found.");
    const a = payAccount(params.id);
    if (!a || !a.qr_file) fail(404, "No GCash QR code has been uploaded for this restaurant.");
    sendPrivate(res, a.qr_file, "gcash-qr");
  });
  add("POST", "/api/admin/restaurants/:id/payment-qr", ADMIN, async ({ req, res, user, params }) => {
    const r = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!r) { req.resume(); fail(404, "Restaurant not found."); }
    if (r.demo_payment) { req.resume(); fail(409, "This demonstration restaurant uses a fixed, non-scannable QR code and cannot be changed."); }
    const a = payAccount(r.id);
    if (!a) { req.resume(); fail(409, "The restaurant must save its payment account details before a QR code can be uploaded."); }
    let saved;
    try { saved = uploads.savePrivateFile(await uploads.readBinary(req), { imagesOnly: true }); } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
    try {
      db.exec("BEGIN");
      run("UPDATE restaurant_payment_accounts SET qr_file = ?, updated_by = ?, updated_at = datetime('now') WHERE restaurant_id = ?", saved.name, user.id, r.id);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      uploads.deletePrivateFile(saved.name);
      throw e;
    }
    uploads.deletePrivateFile(a.qr_file);
    audit(user, "payment_account.qr_replaced", "restaurant", r.id, { updatedByAdmin: true });
    json(res, 200, { ok: true, hasQr: true });
  });

  /* ---- customer ---- */
  add("GET", "/api/payments/:id", CUSTOMER, async ({ res, user, params }) => {
    const p = one("SELECT * FROM payments WHERE id = ? AND customer_id = ?", params.id, user.id);
    if (!p) fail(404, "Payment not found.");
    const r = one("SELECT name, demo_payment FROM restaurants WHERE id = ?", p.restaurant_id), a = payAccount(p.restaurant_id), pi = parentInfo(p), demo = !!r.demo_payment;
    json(res, 200, { ...mapPayment(p), restaurantName: r.name, demoPayment: demo, parent: pi && { label: pi.label, when: pi.when, status: pi.status },
      instructions: a ? { demo, holderName: a.holder_name, mobileMasked: demo ? "DEMO NUMBER — NOT A REAL ACCOUNT" : maskMobile(a.mobile), qrUrl: a.qr_file ? `/api/payments/${p.id}/qr` : null } : null });
  });
  add("GET", "/api/payments/:id/qr", ANY, async ({ res, user, params }) => {
    const p = one("SELECT * FROM payments WHERE id = ?", params.id); if (!p) fail(404, "Payment not found.");
    paymentAccess(user, p);
    const a = payAccount(p.restaurant_id); if (!a || !a.qr_file) fail(404, "No QR code available.");
    sendPrivate(res, a.qr_file, "gcash-qr");
  });
  add("POST", "/api/payments/:id/proof", CUSTOMER, async ({ req, res, user, params }) => {
    const p = one("SELECT * FROM payments WHERE id = ? AND customer_id = ?", params.id, user.id);
    if (!p) { req.resume(); fail(404, "Payment not found."); }
    const pi = parentInfo(p), q = new URL(req.url, "http://x").searchParams;
    const early = (s, m) => { req.resume(); fail(s, m); };
    if (!pi || !pi.active) early(409, "This order or reservation is no longer active, so no payment is needed.");
    if (!["AWAITING_PROOF", "REJECTED"].includes(p.status)) early(409, p.status === "UNDER_REVIEW" ? "Your receipt is already being reviewed. You will be notified of the decision." : `A receipt cannot be added while the payment is ${PAY_LABEL[p.status].toLowerCase()}.`);
    if (one("SELECT COUNT(*) AS n FROM payment_submissions WHERE payment_id = ?", p.id).n >= MAX_ATTEMPTS) early(429, "Too many receipts were submitted for this payment. Please message the restaurant.");
    const ref = String(q.get("reference") || "").trim();
    if (!/^[A-Za-z0-9 \-]{6,30}$/.test(ref)) early(400, "Enter the GCash reference number from your receipt (6 to 30 letters or digits).");
    const refNorm = ref.replace(/[\s-]/g, "").toUpperCase(), amount = Number(q.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) > MAX_DECLARED_CENTS) early(400, "Enter the amount you sent, in pesos.");
    let saved;
    try { saved = uploads.savePrivateFile(await uploads.readBinary(req), { imagesOnly: true }); } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
    const dupFile = one("SELECT id FROM payment_submissions WHERE restaurant_id = ? AND proof_hash = ?", p.restaurant_id, saved.hash);
    const dupRef = one("SELECT id FROM payment_submissions WHERE restaurant_id = ? AND ref_norm = ? AND payment_id != ? AND (decision IS NULL OR decision = 'ACCEPTED')", p.restaurant_id, refNorm, p.id);
    if (dupFile || dupRef) {
      uploads.deletePrivateFile(saved.name);
      payEvent(p.id, user, "proof.duplicate_blocked", dupFile ? "Same receipt image" : "Same reference number");
      fail(409, dupFile ? "This receipt image was already submitted. Please upload your own receipt for this payment." : "That GCash reference number was already used for another payment. Check the number on your receipt.");
    }
    db.exec("BEGIN");
    try {
      run("INSERT INTO payment_submissions (payment_id, restaurant_id, proof_file, proof_hash, reference, ref_norm, declared_cents, submitted_by) VALUES (?,?,?,?,?,?,?,?)",
        p.id, p.restaurant_id, saved.name, saved.hash, ref, refNorm, Math.round(amount * 100), user.id);
      run("UPDATE payments SET status = 'UNDER_REVIEW', updated_at = datetime('now') WHERE id = ?", p.id);
      payEvent(p.id, user, "proof.submitted", `Declared ${money(Math.round(amount * 100))}, ref ${ref}`);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); uploads.deletePrivateFile(saved.name); throw e; }
    notifyStaff(p.restaurant_id, `${displayName(user.fullName)} submitted a GCash receipt for ${pi.label} (${money(p.amount_cents)}). Verify it in your GCash records.`);
    json(res, 201, { ok: true, status: "UNDER_REVIEW", message: "Receipt received. The restaurant will check it against their GCash records and notify you." });
  });
  add("GET", "/api/payments/:id/receipt", ANY, async ({ req, res, user, params }) => {
    const p = one("SELECT * FROM payments WHERE id = ?", params.id); if (!p) fail(404, "Payment not found.");
    const who = paymentAccess(user, p), sid = Number(new URL(req.url, "http://x").searchParams.get("submission"));
    const s = sid ? one("SELECT * FROM payment_submissions WHERE id = ? AND payment_id = ?", sid, p.id) : one("SELECT * FROM payment_submissions WHERE payment_id = ? ORDER BY id DESC LIMIT 1", p.id);
    if (!s) fail(404, "No receipt submitted yet.");
    if (who !== "customer") payEvent(p.id, user, "receipt.viewed", `Submission #${s.id}`);
    sendPrivate(res, s.proof_file, "receipt");
  });

  /* ---- staff: review ---- */
  add("GET", "/api/staff/payments", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), f = new URL(req.url, "http://x").searchParams.get("filter") || "review";
    const where = f === "all" ? "" : f === "review" ? "AND p.status = 'UNDER_REVIEW'" : "AND p.status = ?";
    const args = ["all", "review"].includes(f) ? [] : [String(f).toUpperCase()];
    const rows = all(`SELECT p.* FROM payments p WHERE p.restaurant_id = ? ${where} ORDER BY (p.status = 'UNDER_REVIEW') DESC, p.id DESC LIMIT 200`, r.id, ...args).map(p => mapPayment(p, true));
    json(res, 200, { payments: rows, counts: { review: one("SELECT COUNT(*) AS n FROM payments WHERE restaurant_id = ? AND status = 'UNDER_REVIEW'", r.id).n,
      refundDue: all("SELECT * FROM payments WHERE restaurant_id = ? AND status = 'ACCEPTED'", r.id).filter(p => { const pi = parentInfo(p); return pi && !pi.active; }).length } });
  });
  add("POST", "/api/staff/payments/:id/decision", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), p = one("SELECT * FROM payments WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!p) fail(404, "Payment not found.");
    const b = await readJson(req), d = String(b.decision ?? "");
    if (p.status !== "UNDER_REVIEW") fail(409, `This payment is ${PAY_LABEL[p.status].toLowerCase()}, so it cannot be decided now.`);
    if (!["ACCEPTED", "REJECTED"].includes(d)) fail(400, "Choose accept or reject.");
    if (d === "ACCEPTED" && b.verified !== true) fail(400, "Confirm the payment review before accepting.", { verified: "Required." });
    const note = text(b.note, 300, "Note", { required: d === "REJECTED" });
    const s = one("SELECT * FROM payment_submissions WHERE payment_id = ? AND decision IS NULL ORDER BY id DESC LIMIT 1", p.id);
    if (!s) fail(409, "There is no receipt waiting for review.");
    db.exec("BEGIN");
    try {
      run("UPDATE payment_submissions SET decision = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?, verified = ? WHERE id = ?", d, user.id, note, d === "ACCEPTED" ? 1 : 0, s.id);
      run("UPDATE payments SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", d, note, user.id, p.id);
      payEvent(p.id, user, d === "ACCEPTED" ? "payment.accepted" : "payment.rejected", note || (d === "ACCEPTED" ? "Verified against GCash records" : ""));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const pi = parentInfo(p);
    notify(p.customer_id, d === "ACCEPTED" ? `Your payment for ${pi.label} at ${r.name} was accepted.` : `Your payment for ${pi.label} at ${r.name} was rejected: ${note} You can upload a new receipt in My Account.`);
    json(res, 200, { ok: true, status: d });
  });
  add("POST", "/api/staff/payments/:id/refund", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), p = one("SELECT * FROM payments WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!p) fail(404, "Payment not found.");
    const pi = parentInfo(p), b = await readJson(req);
    if (p.status !== "ACCEPTED") fail(409, "Only an accepted payment can be marked refunded.");
    if (pi && pi.active) fail(409, "The order or reservation is still active. Cancel or decline it first.");
    const note = text(b.note, 300, "Refund note (for example the GCash refund reference)", { required: true });
    run("UPDATE payments SET status = 'REFUNDED', refund_note = ?, refunded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", note, p.id);
    payEvent(p.id, user, "payment.refunded", note);
    notify(p.customer_id, `Your payment of ${money(p.amount_cents)} for ${pi.label} at ${r.name} was refunded. ${note}`);
    json(res, 200, { ok: true });
  });

  /* ---- Table management (Phase 4): staff manage only their own restaurant's tables ---- */
  const MAX_TABLES = 100;
  const tableLabel = (v) => text(v, 30, "Table name", { required: true });
  const upcomingConfirmed = (tableId) => one("SELECT COUNT(*) AS n FROM reservations WHERE table_id = ? AND status = 'CONFIRMED' AND res_date >= ?", tableId, phDate(Date.now())).n;
  add("GET", "/api/staff/tables", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), q = new URL(req.url, "http://x").searchParams;
    const start = q.get("date") ? slotInstant(String(q.get("date")), String(q.get("time") || "12:00"), "slot") : Date.now();
    json(res, 200, { tables: tablesAt(r, start).map(t => ({ ...t, upcoming: upcomingConfirmed(t.id) })), summary: tableSummary(r, start), reservationMinutes: r.reservation_minutes || 90, acceptsReservations: !!r.accepts_reservations });
  });
  add("POST", "/api/staff/tables", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req);
    if (one("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = ?", r.id).n >= MAX_TABLES) fail(409, `You can have at most ${MAX_TABLES} tables.`);
    const label = tableLabel(b.label), cap = int(b.capacity, 1, 50, "Seats");
    if (one("SELECT 1 AS x FROM restaurant_tables WHERE restaurant_id = ? AND label = ?", r.id, label)) fail(409, `A table named "${label}" already exists.`, { label: "Already used." });
    const id = Number(run("INSERT INTO restaurant_tables (restaurant_id, label, capacity, reservable) VALUES (?,?,?,?)", r.id, label, cap, b.reservable === false ? 0 : 1).lastInsertRowid);
    json(res, 201, { id });
  });
  add("POST", "/api/staff/tables/bulk", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req);
    const count = int(b.count, 1, 50, "Number of tables"), cap = int(b.capacity, 1, 50, "Seats per table"), prefix = text(b.prefix ?? "Table ", 20, "Name prefix");
    const have = one("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = ?", r.id).n;
    if (have + count > MAX_TABLES) fail(409, `You can have at most ${MAX_TABLES} tables (you have ${have}).`);
    let n = 1; const made = [];
    db.exec("BEGIN");
    try {
      for (let i = 0; i < count; i++) {
        let label; do { label = `${prefix.trimEnd()} ${n++}`.trim(); } while (one("SELECT 1 AS x FROM restaurant_tables WHERE restaurant_id = ? AND label = ?", r.id, label));
        run("INSERT INTO restaurant_tables (restaurant_id, label, capacity) VALUES (?,?,?)", r.id, label, cap); made.push(label);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    json(res, 201, { created: made });
  });
  add("PATCH", "/api/staff/tables/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), t = one("SELECT * FROM restaurant_tables WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!t) fail(404, "Table not found.");
    const b = await readJson(req);
    const label = b.label === undefined ? t.label : tableLabel(b.label), cap = b.capacity === undefined ? t.capacity : int(b.capacity, 1, 50, "Seats");
    if (label.toLowerCase() !== t.label.toLowerCase() && one("SELECT 1 AS x FROM restaurant_tables WHERE restaurant_id = ? AND label = ? AND id != ?", r.id, label, t.id)) fail(409, `A table named "${label}" already exists.`);
    if (cap < t.capacity) {
      const big = one("SELECT MAX(party_size) AS m FROM reservations WHERE table_id = ? AND status = 'CONFIRMED' AND res_date >= ?", t.id, phDate(Date.now())).m;
      if (big && big > cap) fail(409, `${t.label} has an upcoming confirmed reservation for ${big} guests, so it cannot seat fewer than that.`);
    }
    const reservable = b.reservable === undefined ? t.reservable : b.reservable ? 1 : 0, active = b.active === undefined ? t.active : b.active ? 1 : 0;
    run("UPDATE restaurant_tables SET label = ?, capacity = ?, reservable = ?, active = ? WHERE id = ?", label, cap, reservable, active, t.id);
    json(res, 200, { ok: true, upcomingConfirmed: (!active || !reservable) ? upcomingConfirmed(t.id) : 0 });
  });
  add("DELETE", "/api/staff/tables/:id", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), t = one("SELECT * FROM restaurant_tables WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!t) fail(404, "Table not found.");
    if (upcomingConfirmed(t.id)) fail(409, `${t.label} has upcoming confirmed reservations. Move or cancel them first, or disable the table instead.`);
    run("DELETE FROM restaurant_tables WHERE id = ?", t.id);
    json(res, 200, { ok: true });
  });

  const ORDER_NEXT = { PENDING: ["ACCEPTED", "REJECTED"], ACCEPTED: ["PREPARING", "REJECTED", "CANCELLED"], PREPARING: ["READY", "CANCELLED"], READY: ["COMPLETED", "CANCELLED"] };
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
    const b = await readJson(req), next = String(b.status ?? "");
    if (!(ORDER_NEXT[o.status] || []).includes(next)) fail(409, `An order that is ${o.status.toLowerCase()} cannot be changed to ${next || "that status"}.`);
    const note = text(b.note, 300, "Note", { required: next === "CANCELLED" }); // cancelling an accepted order needs a reason the customer can read
    if (next === "ACCEPTED") requirePaymentAccepted("ORDER", o.id); // payable orders are accepted only after the payment was verified
    run("UPDATE orders SET status = ?, staff_note = CASE WHEN ? != '' THEN ? ELSE staff_note END, updated_at = datetime('now') WHERE id = ?", next, note, note, o.id);
    orderEvent(o.id, next, note);
    if (next === "REJECTED" || next === "CANCELLED") paymentParentClosed("ORDER", o.id);
    notify(o.customer_id, `Your advance order #${o.id} at ${r.name} is now ${next}.${note ? " Note: " + note : ""}`);
    json(res, 200, { ok: true });
  });

  add("GET", "/api/staff/menu", STAFF, async ({ res, user }) => {
    json(res, 200, all("SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY name COLLATE NOCASE", staffRestaurant(user).id)
      .map(m => ({ id: m.id, name: m.name, description: m.description, price: money(m.price_cents), available: !!m.available, image: uploads.publicUrl(m.image_file), category: m.category })));
  });
  const priceCents = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 100000) fail(400, "Price must be more than 0 and at most 100,000."); return Math.round(n * 100); };
  add("POST", "/api/staff/menu", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req);
    if (one("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = ?", r.id).n >= 100) fail(409, "Menu limit reached (100 items).");
    const id = Number(run("INSERT INTO menu_items (restaurant_id, name, description, price_cents, category) VALUES (?,?,?,?,?)", r.id,
      text(b.name, 80, "Name", { required: true, min: 2 }), text(b.description, 200, "Description"), priceCents(b.price), text(b.category, 40, "Category")).lastInsertRowid);
    json(res, 201, { id });
  });
  add("PATCH", "/api/staff/menu/:id", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!m) fail(404, "Menu item not found.");
    const b = await readJson(req);
    run("UPDATE menu_items SET name=?, description=?, price_cents=?, available=?, category=? WHERE id=?",
      b.name === undefined ? m.name : text(b.name, 80, "Name", { required: true, min: 2 }),
      b.description === undefined ? m.description : text(b.description, 200, "Description"),
      b.price === undefined ? m.price_cents : priceCents(b.price),
      b.available === undefined ? m.available : b.available ? 1 : 0,
      b.category === undefined ? m.category : text(b.category, 40, "Category"), m.id);
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/staff/menu/:id", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), old = one("SELECT image_file FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!run("DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id).changes) fail(404, "Menu item not found.");
    uploads.deletePublicImage(old && old.image_file);
    json(res, 200, { ok: true });
  });

  /* ---- Images (Phase 2). The request body is the raw image; the server checks the real file type and size. ---- */
  async function receiveImage(req) {
    try { return uploads.savePublicImage(await uploads.readBinary(req)); }
    catch (e) { if (e.status) fail(e.status, e.message); throw e; }
  }
  for (const [kind, col, label] of [["logo", "logo_file", "logo"], ["cover", "cover_file", "profile image"]]) {
    add("POST", `/api/staff/restaurant/${kind}`, STAFF, async ({ req, res, user }) => {
      const r = staffRestaurant(user), name = await receiveImage(req);
      run(`UPDATE restaurants SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`, name, r.id);
      uploads.deletePublicImage(r[col]);
      json(res, 200, { ok: true, url: uploads.publicUrl(name), message: `Restaurant ${label} updated.` });
    });
    add("DELETE", `/api/staff/restaurant/${kind}`, STAFF, async ({ res, user }) => {
      const r = staffRestaurant(user);
      run(`UPDATE restaurants SET ${col} = '', updated_at = datetime('now') WHERE id = ?`, r.id);
      uploads.deletePublicImage(r[col]);
      json(res, 200, { ok: true });
    });
  }
  add("POST", "/api/staff/menu/:id/image", STAFF, async ({ req, res, user, params }) => {
    const r = staffRestaurant(user), m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id); // own restaurant's items only
    if (!m) { req.resume(); fail(404, "Menu item not found."); }
    const name = await receiveImage(req);
    run("UPDATE menu_items SET image_file = ? WHERE id = ?", name, m.id);
    uploads.deletePublicImage(m.image_file);
    json(res, 200, { ok: true, url: uploads.publicUrl(name) });
  });
  add("DELETE", "/api/staff/menu/:id/image", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), m = one("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!m) fail(404, "Menu item not found.");
    run("UPDATE menu_items SET image_file = '' WHERE id = ?", m.id);
    uploads.deletePublicImage(m.image_file);
    json(res, 200, { ok: true });
  });
  /* Administrator oversight: remove an inappropriate image from any restaurant or food item. */
  for (const [kind, col] of [["logo", "logo_file"], ["cover", "cover_file"]]) {
    add("DELETE", `/api/admin/restaurants/:id/${kind}`, ADMIN, async ({ res, user, params }) => {
      const r = one("SELECT * FROM restaurants WHERE id = ?", params.id);
      if (!r) fail(404, "Restaurant not found.");
      run(`UPDATE restaurants SET ${col} = '', updated_at = datetime('now') WHERE id = ?`, r.id);
      uploads.deletePublicImage(r[col]);
      audit(user, `restaurant_image.removed`, "restaurant", r.id, { image: kind });
      json(res, 200, { ok: true });
    });
  }
  add("DELETE", "/api/admin/menu/:id/image", ADMIN, async ({ res, user, params }) => {
    const m = one("SELECT * FROM menu_items WHERE id = ?", params.id);
    if (!m) fail(404, "Menu item not found.");
    run("UPDATE menu_items SET image_file = '' WHERE id = ?", m.id);
    uploads.deletePublicImage(m.image_file);
    audit(user, "menu_image.removed", "menu_item", m.id, { restaurantId: m.restaurant_id, name: m.name });
    json(res, 200, { ok: true });
  });

  /* =====================================================================================================
     Restaurant LOCATION REQUESTS (Phase 3). Staff can only REQUEST a pin; only an administrator's approval
     writes coordinates to the public restaurant record. Evidence documents are PRIVATE: they are readable only
     through the authenticated routes below (the owning restaurant's staff, and administrators).
     ===================================================================================================== */
  const SQL_NOW = () => new Date().toISOString().slice(0, 19).replace("T", " ");
  function audit(user, action, targetType, targetId, detail) {
    run("INSERT INTO admin_audit_logs (actor_id, actor_name, action, target_type, target_id, detail) VALUES (?,?,?,?,?,?)",
      user ? user.id : null, user ? user.fullName : "system", action, targetType, String(targetId ?? ""), typeof detail === "string" ? detail : JSON.stringify(detail || {}));
  }
  const DOC_KINDS = { MAYORS_PERMIT: "Mayor's / business permit", DTI_SEC: "DTI or SEC registration", STOREFRONT_PHOTO: "Storefront or signage photo",
    INTERIOR_PHOTO: "Interior photo", AUTHORIZATION: "Proof you may manage this restaurant", OTHER: "Other supporting document" };
  const EDITABLE = ["DRAFT", "NEEDS_EVIDENCE", "REJECTED"];
  const OPEN = ["DRAFT", "PENDING", "UNDER_REVIEW", "NEEDS_EVIDENCE"];
  const MAX_DOCS = 12;
  function pinFrom(b) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (b.lat === undefined || b.lat === null || b.lat === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) fail(400, "Pin the restaurant on the map first.", { lat: "Pin the location on the map." });
    if (lat < BOUNDS.latMin || lat > BOUNDS.latMax || lng < BOUNDS.lngMin || lng > BOUNDS.lngMax) fail(400, "That pin is outside Siquijor. Move the pin onto the island.", { lat: "Outside the Siquijor map area." });
    return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  }
  function phoneFrom(v) {
    const s = text(v, 30, "Contact number", { required: true });
    if (!/^[0-9+()\-\s]+$/.test(s) || s.replace(/\D/g, "").length < 7 || s.replace(/\D/g, "").length > 15) fail(400, "Enter a valid contact number (digits, spaces, + or -).", { contactPhone: "Enter a valid contact number." });
    return s;
  }
  const mapDoc = (d) => ({ id: d.id, kind: d.kind, kindLabel: DOC_KINDS[d.kind], name: d.original_name, mime: d.mime, size: d.size_bytes, uploadedAt: iso(d.created_at) });
  const docsOf = (reqId) => all("SELECT * FROM restaurant_verification_documents WHERE request_id = ? ORDER BY id", reqId).map(mapDoc);
  const missingKinds = (docs) => {
    const has = (k) => docs.some(d => d.kind === k), miss = [];
    if (!has("MAYORS_PERMIT") && !has("DTI_SEC")) miss.push("a Mayor's permit or a DTI/SEC registration");
    if (!has("STOREFRONT_PHOTO")) miss.push("a storefront or signage photo");
    if (!has("AUTHORIZATION")) miss.push("proof that you are authorized to manage this restaurant");
    return miss;
  };
  const mapReq = (q) => ({ id: q.id, restaurantId: q.restaurant_id, lat: q.lat, lng: q.lng, address: q.address, contactPhone: q.contact_phone, businessContact: q.business_contact,
    status: q.status, reviewNote: q.review_note, submittedAt: iso(q.submitted_at), reviewedAt: iso(q.reviewed_at), createdAt: iso(q.created_at), canEdit: EDITABLE.includes(q.status) });
  function ownRequest(user, id) {
    const r = staffRestaurant(user), q = one("SELECT * FROM restaurant_location_requests WHERE id = ? AND restaurant_id = ?", id, r.id); // own restaurant only
    if (!q) fail(404, "Location request not found.");
    return { r, q };
  }
  function sendDocument(res, d) {
    const f = uploads.readPrivateFile(d.file_name);
    if (!f) fail(404, "The file is missing from storage.");
    const safe = String(d.original_name || "document").replace(/[^\w.\- ]/g, "_");
    ctx.send(res, 200, f.data, { "Content-Type": f.type, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex",
      "Content-Disposition": `${f.type === "application/pdf" ? "attachment" : "inline"}; filename="${safe}"` });
  }

  /* ---- staff ---- */
  add("GET", "/api/staff/location-request", STAFF, async ({ res, user }) => {
    const r = staffRestaurant(user);
    const all_ = all("SELECT * FROM restaurant_location_requests WHERE restaurant_id = ? ORDER BY id DESC LIMIT 20", r.id);
    const latest = all_[0] || null;
    json(res, 200, {
      current: { lat: r.lat, lng: r.lng, address: r.address, locationStatus: r.location_status },
      request: latest ? { ...mapReq(latest), documents: docsOf(latest.id) } : null,
      history: all_.filter(q => q.status !== "DRAFT").map(q => ({ id: q.id, status: q.status, reviewNote: q.review_note, submittedAt: iso(q.submitted_at), reviewedAt: iso(q.reviewed_at) })),
      kinds: DOC_KINDS, canStartNew: !latest || !OPEN.includes(latest.status)
    });
  });
  add("POST", "/api/staff/location-requests", STAFF, async ({ req, res, user }) => {
    const r = staffRestaurant(user), b = await readJson(req), pin = pinFrom(b);
    const latest = one("SELECT * FROM restaurant_location_requests WHERE restaurant_id = ? ORDER BY id DESC LIMIT 1", r.id);
    if (latest && OPEN.includes(latest.status)) fail(409, "You already have an open location request. Finish or wait for that one first.");
    const address = text(b.address, 200, "Address", { required: true, min: 5 }), phone = phoneFrom(b.contactPhone), biz = text(b.businessContact, 200, "Business contact details");
    const id = Number(run("INSERT INTO restaurant_location_requests (restaurant_id, submitted_by, lat, lng, address, contact_phone, business_contact) VALUES (?,?,?,?,?,?,?)",
      r.id, user.id, pin.lat, pin.lng, address, phone, biz).lastInsertRowid);
    json(res, 201, { id, status: "DRAFT" });
  });
  add("PATCH", "/api/staff/location-requests/:id", STAFF, async ({ req, res, user, params }) => {
    const { q } = ownRequest(user, params.id), b = await readJson(req);
    if (!EDITABLE.includes(q.status)) fail(409, "This request is with the administrator and cannot be edited right now.");
    const pin = b.lat === undefined ? { lat: q.lat, lng: q.lng } : pinFrom(b);
    run("UPDATE restaurant_location_requests SET lat=?, lng=?, address=?, contact_phone=?, business_contact=?, updated_at=datetime('now') WHERE id=?", pin.lat, pin.lng,
      b.address === undefined ? q.address : text(b.address, 200, "Address", { required: true, min: 5 }),
      b.contactPhone === undefined ? q.contact_phone : phoneFrom(b.contactPhone),
      b.businessContact === undefined ? q.business_contact : text(b.businessContact, 200, "Business contact details"), q.id);
    json(res, 200, { ok: true });
  });
  add("POST", "/api/staff/location-requests/:id/documents", STAFF, async ({ req, res, user, params }) => {
    const { q } = ownRequest(user, params.id);
    const url = new URL(req.url, "http://x"), kind = String(url.searchParams.get("kind") || "");
    if (!EDITABLE.includes(q.status)) { req.resume(); fail(409, "Documents can only be added while the request is a draft or needs more evidence."); }
    if (!DOC_KINDS[kind]) { req.resume(); fail(400, "Choose what kind of document this is."); }
    if (one("SELECT COUNT(*) AS n FROM restaurant_verification_documents WHERE request_id = ?", q.id).n >= MAX_DOCS) { req.resume(); fail(409, `A request can have at most ${MAX_DOCS} documents.`); }
    let saved;
    try { saved = uploads.savePrivateFile(await uploads.readBinary(req, uploads.MAX_DOC_BYTES)); } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
    const orig = String(url.searchParams.get("name") || "").replace(/[^\w.\- ]/g, "_").slice(0, 80);
    const id = Number(run("INSERT INTO restaurant_verification_documents (request_id, restaurant_id, kind, file_name, original_name, mime, size_bytes, uploaded_by) VALUES (?,?,?,?,?,?,?,?)",
      q.id, q.restaurant_id, kind, saved.name, orig, saved.type, saved.size, user.id).lastInsertRowid);
    json(res, 201, { id });
  });
  add("DELETE", "/api/staff/location-documents/:id", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), d = one("SELECT d.*, q.status FROM restaurant_verification_documents d JOIN restaurant_location_requests q ON q.id = d.request_id WHERE d.id = ? AND d.restaurant_id = ?", params.id, r.id);
    if (!d) fail(404, "Document not found.");
    if (!EDITABLE.includes(d.status)) fail(409, "Documents cannot be removed while the request is with the administrator.");
    run("DELETE FROM restaurant_verification_documents WHERE id = ?", d.id);
    uploads.deletePrivateFile(d.file_name);
    json(res, 200, { ok: true });
  });
  add("GET", "/api/staff/location-documents/:id/file", STAFF, async ({ res, user, params }) => {
    const r = staffRestaurant(user), d = one("SELECT * FROM restaurant_verification_documents WHERE id = ? AND restaurant_id = ?", params.id, r.id);
    if (!d) fail(404, "Document not found.");
    sendDocument(res, d);
  });
  add("POST", "/api/staff/location-requests/:id/submit", STAFF, async ({ res, user, params }) => {
    const { r, q } = ownRequest(user, params.id);
    if (!EDITABLE.includes(q.status)) fail(409, "This request has already been submitted.");
    const miss = missingKinds(docsOf(q.id));
    if (miss.length) fail(400, `Before submitting, upload ${miss.join(", ")}.`);
    run("UPDATE restaurant_location_requests SET status='PENDING', review_note='', submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?", q.id);
    audit(user, "location_request.submitted", "restaurant_location_request", q.id, { restaurantId: r.id, resubmitted: q.status !== "DRAFT" });
    all("SELECT id FROM users WHERE role = 'ADMINISTRATOR' AND status = 'ACTIVE'").forEach(a => notify(a.id, `${r.name} submitted a map location request for review.`));
    json(res, 200, { ok: true, status: "PENDING" });
  });

  /* ---- administrator ---- */
  add("GET", "/api/admin/location-requests", ADMIN, async ({ req, res }) => {
    const st = new URL(req.url, "http://x").searchParams.get("status") || "open";
    const where = st === "all" ? "q.status != 'DRAFT'" : st === "open" ? "q.status IN ('PENDING','UNDER_REVIEW','NEEDS_EVIDENCE')" : "q.status = ?";
    const args = ["open", "all"].includes(st) ? [] : [String(st).toUpperCase()];
    json(res, 200, all(`SELECT q.*, r.name AS restaurant_name, u.full_name AS submitter,
        (SELECT COUNT(*) FROM restaurant_verification_documents d WHERE d.request_id = q.id) AS doc_count
      FROM restaurant_location_requests q JOIN restaurants r ON r.id = q.restaurant_id JOIN users u ON u.id = q.submitted_by
      WHERE ${where} ORDER BY (q.status = 'PENDING') DESC, q.submitted_at DESC, q.id DESC LIMIT 200`, ...args)
      .map(q => ({ ...mapReq(q), restaurantName: q.restaurant_name, submitter: q.submitter, documentCount: q.doc_count })));
  });
  add("GET", "/api/admin/location-requests/:id", ADMIN, async ({ res, params }) => {
    const q = one("SELECT * FROM restaurant_location_requests WHERE id = ? AND status != 'DRAFT'", params.id);
    if (!q) fail(404, "Location request not found.");
    const r = one("SELECT * FROM restaurants WHERE id = ?", q.restaurant_id), u = one("SELECT full_name, email FROM users WHERE id = ?", q.submitted_by);
    json(res, 200, {
      request: mapReq(q), submitter: u ? { name: u.full_name, email: u.email } : null,
      restaurant: { id: r.id, name: r.name, municipality: r.municipality, category: r.category, address: r.address, contact: r.contact, hours: r.hours, description: r.description,
        lat: r.lat, lng: r.lng, locationStatus: r.location_status, logo: uploads.publicUrl(r.logo_file), cover: uploads.publicUrl(r.cover_file) },
      documents: docsOf(q.id), kinds: DOC_KINDS,
      history: all("SELECT actor_name, action, detail, created_at FROM admin_audit_logs WHERE target_type = 'restaurant_location_request' AND target_id = ? ORDER BY id", String(q.id))
        .map(a => ({ by: a.actor_name, action: a.action, detail: a.detail, at: iso(a.created_at) }))
    });
  });
  add("GET", "/api/admin/location-documents/:id/file", ADMIN, async ({ res, user, params }) => {
    const d = one("SELECT * FROM restaurant_verification_documents WHERE id = ?", params.id);
    if (!d) fail(404, "Document not found.");
    audit(user, "location_document.viewed", "restaurant_verification_document", d.id, { requestId: d.request_id });
    sendDocument(res, d);
  });
  const LOC_NEXT = { PENDING: ["UNDER_REVIEW", "APPROVED", "REJECTED", "NEEDS_EVIDENCE"], UNDER_REVIEW: ["APPROVED", "REJECTED", "NEEDS_EVIDENCE"] };
  add("POST", "/api/admin/location-requests/:id/decision", ADMIN, async ({ req, res, user, params }) => {
    const q = one("SELECT * FROM restaurant_location_requests WHERE id = ? AND status != 'DRAFT'", params.id);
    if (!q) fail(404, "Location request not found.");
    const b = await readJson(req), next = String(b.decision ?? "");
    if (!(LOC_NEXT[q.status] || []).includes(next)) fail(409, `A ${q.status.replace("_", " ").toLowerCase()} request cannot be changed to ${next || "that status"}.`);
    const note = text(b.note, 500, "Note", { required: ["REJECTED", "NEEDS_EVIDENCE"].includes(next) });
    const r = one("SELECT * FROM restaurants WHERE id = ?", q.restaurant_id);
    if (next === "APPROVED") {
      const miss = missingKinds(docsOf(q.id));
      if (miss.length) fail(409, `Evidence is incomplete: missing ${miss.join(", ")}.`);
      pinFrom({ lat: q.lat, lng: q.lng }); // re-check the pin is on the island before it goes public
    }
    db.exec("BEGIN");
    try {
      run("UPDATE restaurant_location_requests SET status=?, review_note=?, reviewed_by=?, reviewed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", next, note, user.id, q.id);
      if (next === "APPROVED") {
        run("UPDATE restaurants SET lat=?, lng=?, address=?, verified=1, location_status='verified', contact = CASE WHEN contact = '' THEN ? ELSE contact END, updated_at=datetime('now') WHERE id=?",
          q.lat, q.lng, q.address, q.contact_phone, q.restaurant_id);
      }
      audit(user, `location_request.${next.toLowerCase()}`, "restaurant_location_request", q.id, { restaurantId: q.restaurant_id, from: q.status, note, ...(next === "APPROVED" ? { lat: q.lat, lng: q.lng, address: q.address } : {}) });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const msg = { UNDER_REVIEW: "is now under review.", APPROVED: "was approved. Your restaurant now appears on the public map.", REJECTED: `was rejected. Reason: ${note}`, NEEDS_EVIDENCE: `needs more evidence: ${note}` }[next];
    notifyStaff(q.restaurant_id, `Your map location request for ${r.name} ${msg}`);
    json(res, 200, { ok: true, status: next });
  });
  /* =====================================================================================================
     SLIDESHOW PHOTOS (Phase 9). Uploaded photos require credit, a licence or permission statement and an explicit confirmation.
     The built-in landing slides are clearly labeled illustrations until authorized venue photographs are supplied.
     ===================================================================================================== */
  const SLIDE_SETS = { landing: "LANDING", map: "MAP" }, MAX_SLIDES_PER_SET = 20, MAX_SLIDE_BYTES = 4 * 1024 * 1024;
  const DEFAULT_SLIDES = { LANDING: [], MAP: [] };
  const BUILTIN_PLACEHOLDERS = new Map([
    ["builtin:restaurant-photo:pagudfood", "placeholder-pagudfood.svg"],
    ["builtin:restaurant-photo:the-cafe-infinite", "placeholder-cafe-infinite.svg"],
    ["builtin:restaurant-photo:dagsa-resto", "placeholder-dagsa.svg"],
    ["builtin:restaurant-photo:la-candura", "placeholder-la-candura.svg"],
    ["builtin:restaurant-photo:luka-loko", "placeholder-luca-loko.svg"]
  ]);
  const mapSlide = (r) => {
    const placeholder = BUILTIN_PLACEHOLDERS.get(r.file_name);
    return {
      id: r.id,
      url: placeholder ? `/assets/images/restaurant-slides/${placeholder}` : uploads.publicUrl(r.file_name),
      alt: r.alt_text,
      title: r.title || r.restaurant_name || "",
      caption: r.caption,
      description: r.caption,
      buttonLabel: r.button_label || "Explore Restaurant",
      credit: r.credit,
      license: r.license,
      sourceUrl: r.source_url,
      restaurantId: r.restaurant_id,
      restaurantName: r.restaurant_name || null,
      municipality: r.restaurant_municipality || "",
      isPlaceholder: !!placeholder
    };
  };
  const SLIDE_SQL = "SELECT s.*, r.name AS restaurant_name, r.municipality AS restaurant_municipality FROM slideshow_images s LEFT JOIN restaurants r ON r.id = s.restaurant_id";
  function deleteSlideImageIfUnused(fileName) {
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(fileName || "")) return;
    const referenced = one(`SELECT 1 AS x FROM restaurants WHERE logo_file = ? OR cover_file = ?
      UNION ALL SELECT 1 FROM menu_items WHERE image_file = ?
      UNION ALL SELECT 1 FROM slideshow_images WHERE file_name = ? LIMIT 1`,
      fileName, fileName, fileName, fileName);
    if (!referenced) uploads.deletePublicImage(fileName);
  }
  function sourceUrlFrom(v) {
    const t = String(v ?? "").trim(); if (!t) return "";
    if (t.length > 300 || !/^https?:\/\/[^\s<>"']+$/i.test(t)) fail(400, "The source link must start with http:// or https://.", { source: "Invalid link." });
    return t;
  }
  add("GET", "/api/slides", null, async ({ req, res }) => {
    const set = SLIDE_SETS[String(new URL(req.url, "http://x").searchParams.get("set") || "").toLowerCase()];
    if (!set) fail(400, "Choose the landing or map slideshow.");
    const rows = all(`${SLIDE_SQL} WHERE s.slide_set = ? AND s.active = 1 ORDER BY s.sort_order, s.id`, set).map(mapSlide);
    json(res, 200, { slides: [...DEFAULT_SLIDES[set], ...rows] });
  });
  add("GET", "/api/admin/slides", ADMIN, async ({ res }) => json(res, 200, {
    landing: all(`${SLIDE_SQL} WHERE s.slide_set = 'LANDING' ORDER BY s.sort_order, s.id`).map(r => ({ ...mapSlide(r), active: !!r.active })),
    map: all(`${SLIDE_SQL} WHERE s.slide_set = 'MAP' ORDER BY s.sort_order, s.id`).map(r => ({ ...mapSlide(r), active: !!r.active })), maxPerSet: MAX_SLIDES_PER_SET, maxBytes: MAX_SLIDE_BYTES }));
  add("POST", "/api/admin/slides", ADMIN, async ({ req, res, user }) => {
    const q = new URL(req.url, "http://x").searchParams, early = (st, m, f) => { req.resume(); fail(st, m, f); };
    const set = SLIDE_SETS[String(q.get("set") || "").toLowerCase()]; if (!set) early(400, "Choose the landing page or the map page slideshow.");
    const t = (name, label, max, min) => { try { return text(q.get(name), max, label, { required: true, min }); } catch (e) { req.resume(); throw e; } };
    const alt = t("alt", "Description (alt text)", 160, 3), credit = t("credit", "Credit", 160, 3), license = t("license", "Licence or permission", 200, 3);
    const caption = text(q.get("description") ?? q.get("caption"), 300, "Description");
    const buttonLabel = text(q.get("buttonLabel") ?? "Explore Restaurant", 60, "Button label") || "Explore Restaurant";
    let source; try { source = sourceUrlFrom(q.get("source")); } catch (e) { req.resume(); throw e; }
    if (q.get("confirm") !== "1") early(400, "Confirm that you own this photo or have permission or a licence to use it on this website.", { confirm: "Required." });
    const rid = q.get("restaurantId") || null, restaurant = rid ? one("SELECT id, name FROM restaurants WHERE id = ?", rid) : null;
    if (rid && !restaurant) early(400, "That restaurant does not exist.");
    const title = text(q.get("title"), 120, "Title") || (restaurant && restaurant.name) || "";
    if (set === "LANDING" && !title) early(400, "Choose a title or an existing restaurant for this landing slide.");
    if (one("SELECT COUNT(*) AS n FROM slideshow_images WHERE slide_set = ?", set).n >= MAX_SLIDES_PER_SET) early(409, `Each slideshow can have at most ${MAX_SLIDES_PER_SET} photos.`);
    let file; try { file = uploads.savePublicImage(await uploads.readBinary(req, MAX_SLIDE_BYTES)); } catch (e) { if (e.status) fail(e.status, e.message.replace(/limit is \d+ MB/, "limit for slideshow photos is 4 MB, so please compress it")); throw e; }
    const order = (one("SELECT COALESCE(MAX(sort_order), 0) AS m FROM slideshow_images WHERE slide_set = ?", set).m || 0) + 1;
    const id = Number(run(`INSERT INTO slideshow_images (slide_set, file_name, title, alt_text, caption, button_label, credit, license, source_url, restaurant_id, sort_order, permission_confirmed_by, permission_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      set, file, title, alt, caption, buttonLabel, credit, license, source, rid, order, user.id, SQL_NOW()).lastInsertRowid);
    audit(user, "slide.created", "slideshow_image", id, { set, credit, license, source, restaurantId: rid, permissionConfirmed: true });
    json(res, 201, { id });
  });
  add("PATCH", "/api/admin/slides/:id", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM slideshow_images WHERE id = ?", params.id); if (!cur) fail(404, "Photo not found.");
    const b = await readJson(req), rid = b.restaurantId === undefined ? cur.restaurant_id : (b.restaurantId || null);
    if (rid && !one("SELECT 1 AS x FROM restaurants WHERE id = ?", rid)) fail(400, "That restaurant does not exist.");
    run("UPDATE slideshow_images SET title=?, alt_text=?, caption=?, button_label=?, credit=?, license=?, source_url=?, restaurant_id=?, active=? WHERE id=?",
      b.title === undefined ? cur.title : text(b.title, 120, "Title", { required: true, min: 2 }),
      b.alt === undefined ? cur.alt_text : text(b.alt, 160, "Description (alt text)", { required: true, min: 3 }),
      b.description === undefined && b.caption === undefined ? cur.caption : text(b.description ?? b.caption, 300, "Description"),
      b.buttonLabel === undefined ? cur.button_label : text(b.buttonLabel, 60, "Button label", { required: true, min: 2 }),
      b.credit === undefined ? cur.credit : text(b.credit, 160, "Credit", { required: true, min: 3 }), b.license === undefined ? cur.license : text(b.license, 200, "Licence or permission", { required: true, min: 3 }),
      b.sourceUrl === undefined ? cur.source_url : sourceUrlFrom(b.sourceUrl), rid, b.active === undefined ? cur.active : b.active ? 1 : 0, cur.id);
    audit(user, "slide.updated", "slideshow_image", cur.id, { fields: Object.keys(b).filter(k => b[k] !== undefined) });
    json(res, 200, { ok: true });
  });
  add("POST", "/api/admin/slides/:id/image", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM slideshow_images WHERE id = ?", params.id); if (!cur) fail(404, "Photo not found.");
    const q = new URL(req.url, "http://x").searchParams, early = (status, message, fields) => { req.resume(); fail(status, message, fields); };
    const getText = (name, label, max, min) => { try { return text(q.get(name), max, label, { required: true, min }); } catch (e) { req.resume(); throw e; } };
    const alt = getText("alt", "Description (alt text)", 160, 3);
    const credit = getText("credit", "Credit", 160, 3);
    const license = getText("license", "Licence or permission", 200, 3);
    let source; try { source = sourceUrlFrom(q.get("source")); } catch (e) { req.resume(); throw e; }
    if (q.get("confirm") !== "1") early(400, "Confirm that you own this photo or have permission or a licence to use it on this website.", { confirm: "Required." });
    let file;
    try { file = uploads.savePublicImage(await uploads.readBinary(req, MAX_SLIDE_BYTES)); }
    catch (e) { if (e.status) fail(e.status, e.message.replace(/limit is \d+ MB/, "limit for slideshow photos is 4 MB, so please compress it")); throw e; }
    db.exec("BEGIN");
    try {
      run("UPDATE slideshow_images SET file_name=?, alt_text=?, credit=?, license=?, source_url=?, permission_confirmed_by=?, permission_confirmed_at=? WHERE id=?",
        file, alt, credit, license, source, user.id, SQL_NOW(), cur.id);
      audit(user, "slide.image_replaced", "slideshow_image", cur.id, { credit, license, source, permissionConfirmed: true });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      uploads.deletePublicImage(file);
      throw e;
    }
    deleteSlideImageIfUnused(cur.file_name);
    json(res, 200, { ok: true, url: uploads.publicUrl(file) });
  });
  add("POST", "/api/admin/slides/:id/move", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM slideshow_images WHERE id = ?", params.id); if (!cur) fail(404, "Photo not found.");
    const dir = String((await readJson(req)).direction ?? ""); if (!["up", "down"].includes(dir)) fail(400, "Choose up or down.");
    const nb = one(`SELECT * FROM slideshow_images WHERE slide_set = ? AND (sort_order ${dir === "up" ? "<" : ">"} ? OR (sort_order = ? AND id ${dir === "up" ? "<" : ">"} ?)) ORDER BY sort_order ${dir === "up" ? "DESC" : "ASC"}, id ${dir === "up" ? "DESC" : "ASC"} LIMIT 1`, cur.slide_set, cur.sort_order, cur.sort_order, cur.id);
    if (nb) { db.exec("BEGIN"); try { const a = cur.sort_order === nb.sort_order ? nb.sort_order + (dir === "up" ? -1 : 1) : nb.sort_order; run("UPDATE slideshow_images SET sort_order = ? WHERE id = ?", a, cur.id); run("UPDATE slideshow_images SET sort_order = ? WHERE id = ?", cur.sort_order, nb.id); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } }
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/admin/slides/:id", ADMIN, async ({ res, user, params }) => {
    const cur = one("SELECT * FROM slideshow_images WHERE id = ?", params.id); if (!cur) fail(404, "Photo not found.");
    run("DELETE FROM slideshow_images WHERE id = ?", cur.id); deleteSlideImageIfUnused(cur.file_name);
    audit(user, "slide.deleted", "slideshow_image", cur.id, { set: cur.slide_set, credit: cur.credit });
    json(res, 200, { ok: true });
  });

  /* =====================================================================================================
     ADMIN OVERSIGHT (Phase 10): read-only monitoring of reservations, orders, payments, tables and menus, a one-page view of each
     restaurant, an attention queue, user filters (with email-verification status) and a searchable audit log. Administrators can
     SEE payment receipts (each view is logged) but cannot accept or reject payments: only the restaurant can check its own GCash
     records. Moderation actions are limited, narrow and audited.
     ===================================================================================================== */
  const likeEsc = (t) => "%" + String(t).replace(/[\\%_]/g, "\\$&") + "%";
  const pageOf = (q) => { const limit = Math.min(Math.max(Number(q.get("limit")) || 25, 1), 100), page = Math.max(Number(q.get("page")) || 1, 1); return { limit, page, offset: (page - 1) * limit }; };
  const dateParam = (q, k) => { const v = q.get(k); if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(400, "Dates must look like 2026-11-30."); return v; };
  const staleCut = () => new Date(Date.now() - 24 * 36e5).toISOString().slice(0, 19).replace("T", " ");
  const pageInfo = (total, p) => ({ total, page: p.page, pages: Math.max(1, Math.ceil(total / p.limit)) });

  add("GET", "/api/admin/reservations", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, p = pageOf(q), w = ["1=1"], a = [];
    const st = q.get("status"); if (st && st !== "all") { w.push("v.status = ?"); a.push(st.toUpperCase()); }
    const rid = q.get("restaurantId"); if (rid) { w.push("v.restaurant_id = ?"); a.push(rid); }
    const from = dateParam(q, "from"), to = dateParam(q, "to"); if (from) { w.push("v.res_date >= ?"); a.push(from); } if (to) { w.push("v.res_date <= ?"); a.push(to); }
    const t = (q.get("q") || "").trim(); if (t) { w.push("(u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')"); a.push(likeEsc(t), likeEsc(t), likeEsc(t)); }
    const base = `FROM reservations v JOIN restaurants r ON r.id = v.restaurant_id JOIN users u ON u.id = v.customer_id LEFT JOIN restaurant_tables tb ON tb.id = v.table_id LEFT JOIN payments pm ON pm.reservation_id = v.id WHERE ${w.join(" AND ")}`;
    const cut = staleCut(), total = one(`SELECT COUNT(*) AS n ${base}`, ...a).n;
    const rows = all(`SELECT v.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email, tb.label AS table_label, pm.status AS pay_status, pm.amount_cents AS pay_amount ${base} ORDER BY v.res_date DESC, v.res_time DESC, v.id DESC LIMIT ? OFFSET ?`, ...a, p.limit, p.offset)
      .map(v => ({ id: v.id, restaurantId: v.restaurant_id, restaurantName: v.restaurant_name, customerName: v.customer_name, customerEmail: v.customer_email, date: v.res_date, time: v.res_time, partySize: v.party_size, tableLabel: v.table_label,
        status: v.status, payment: v.pay_status ? { status: v.pay_status, amount: money(v.pay_amount) } : null, createdAt: iso(v.created_at), stale: v.status === "PENDING" && v.created_at < cut }));
    const counts = Object.fromEntries(all(`SELECT status, COUNT(*) AS n FROM reservations ${rid ? "WHERE restaurant_id = ?" : ""} GROUP BY status`, ...(rid ? [rid] : [])).map(r => [r.status, r.n]));
    json(res, 200, { rows, counts, ...pageInfo(total, p) });
  });
  add("GET", "/api/admin/orders", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, p = pageOf(q), w = ["1=1"], a = [];
    const st = q.get("status"); if (st && st !== "all") { w.push("o.status = ?"); a.push(st.toUpperCase()); }
    const rid = q.get("restaurantId"); if (rid) { w.push("o.restaurant_id = ?"); a.push(rid); }
    const from = dateParam(q, "from"), to = dateParam(q, "to"); if (from) { w.push("o.pickup_date >= ?"); a.push(from); } if (to) { w.push("o.pickup_date <= ?"); a.push(to); }
    const t = (q.get("q") || "").trim(); if (t) { w.push("(u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')"); a.push(likeEsc(t), likeEsc(t), likeEsc(t)); }
    const base = `FROM orders o JOIN restaurants r ON r.id = o.restaurant_id JOIN users u ON u.id = o.customer_id LEFT JOIN payments pm ON pm.order_id = o.id WHERE ${w.join(" AND ")}`;
    const cut = staleCut(), total = one(`SELECT COUNT(*) AS n ${base}`, ...a).n;
    const rows = all(`SELECT o.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email, pm.status AS pay_status, pm.amount_cents AS pay_amount,
        (SELECT substr(GROUP_CONCAT(qty || ' x ' || name, ', '), 1, 160) FROM order_items WHERE order_id = o.id) AS items ${base} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...a, p.limit, p.offset)
      .map(o => ({ id: o.id, restaurantId: o.restaurant_id, restaurantName: o.restaurant_name, customerName: o.customer_name, customerEmail: o.customer_email, date: o.pickup_date, time: o.pickup_time, fulfillment: o.fulfillment || "PICKUP",
        items: o.items || "", total: money(o.total_cents), status: o.status, payment: o.pay_status ? { status: o.pay_status, amount: money(o.pay_amount) } : null, createdAt: iso(o.created_at), stale: o.status === "PENDING" && o.created_at < cut }));
    const counts = Object.fromEntries(all(`SELECT status, COUNT(*) AS n FROM orders ${rid ? "WHERE restaurant_id = ?" : ""} GROUP BY status`, ...(rid ? [rid] : [])).map(r => [r.status, r.n]));
    json(res, 200, { rows, counts, ...pageInfo(total, p) });
  });
  add("GET", "/api/admin/payments", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, p = pageOf(q), w = ["1=1"], a = [];
    const st = q.get("status"); if (st && st !== "all") { w.push("pm.status = ?"); a.push(st.toUpperCase()); }
    const rid = q.get("restaurantId"); if (rid) { w.push("pm.restaurant_id = ?"); a.push(rid); }
    const kind = q.get("kind"); if (kind === "ORDER" || kind === "RESERVATION") { w.push("pm.kind = ?"); a.push(kind); }
    const t = (q.get("q") || "").trim(); if (t) { w.push("(u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM payment_submissions s WHERE s.payment_id = pm.id AND s.reference LIKE ? ESCAPE '\\'))"); a.push(likeEsc(t), likeEsc(t), likeEsc(t), likeEsc(t)); }
    const base = `FROM payments pm JOIN restaurants r ON r.id = pm.restaurant_id JOIN users u ON u.id = pm.customer_id WHERE ${w.join(" AND ")}`;
    const total = one(`SELECT COUNT(*) AS n ${base}`, ...a).n, cut = staleCut();
    const rows = all(`SELECT pm.*, r.name AS restaurant_name, u.full_name AS customer_name, u.email AS customer_email,
        (SELECT COUNT(*) FROM payment_submissions s WHERE s.payment_id = pm.id) AS attempts FROM payments pm JOIN restaurants r ON r.id = pm.restaurant_id JOIN users u ON u.id = pm.customer_id WHERE ${w.join(" AND ")}
        ORDER BY (pm.status = 'UNDER_REVIEW') DESC, pm.id DESC LIMIT ? OFFSET ?`, ...a, p.limit, p.offset).map(pm => {
      const s = one("SELECT id, reference, declared_cents, created_at, decision FROM payment_submissions WHERE payment_id = ? ORDER BY id DESC LIMIT 1", pm.id), pi = parentInfo(pm);
      return { id: pm.id, kind: pm.kind, label: pi ? pi.label : "Payment", parentStatus: pi ? pi.status : null, restaurantId: pm.restaurant_id, restaurantName: pm.restaurant_name, customerName: pm.customer_name, customerEmail: pm.customer_email,
        amount: money(pm.amount_cents), status: pm.status, statusLabel: PAY_LABEL[pm.status], attempts: pm.attempts, createdAt: iso(pm.created_at), updatedAt: iso(pm.updated_at),
        latest: s ? { submissionId: s.id, reference: s.reference, declared: money(s.declared_cents), at: iso(s.created_at), decision: s.decision } : null,
        waitingTooLong: pm.status === "UNDER_REVIEW" && !!s && s.created_at < cut, refundDue: pm.status === "ACCEPTED" && !!pi && !pi.active };
    });
    const counts = Object.fromEntries(all(`SELECT status, COUNT(*) AS n FROM payments ${rid ? "WHERE restaurant_id = ?" : ""} GROUP BY status`, ...(rid ? [rid] : [])).map(r => [r.status, r.n]));
    json(res, 200, { rows, counts, ...pageInfo(total, p) });
  });
  add("GET", "/api/admin/tables-overview", ADMIN, async ({ res }) => {
    const now = Date.now(), today = phDate(now);
    json(res, 200, all("SELECT * FROM restaurants ORDER BY name COLLATE NOCASE").map(r => ({ id: r.id, name: r.name, municipality: r.municipality, acceptsReservations: !!r.accepts_reservations, reservationMinutes: r.reservation_minutes || 90, guestLimit: r.reservation_capacity,
      summary: tableSummary(r, now), tables: tablesAt(r, now).map(t => ({ id: t.id, label: t.label, capacity: t.capacity, status: t.status })),
      upcomingConfirmed: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ? AND status = 'CONFIRMED' AND res_date >= ?", r.id, today).n,
      pendingRequests: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ? AND status = 'PENDING'", r.id).n })));
  });
  add("GET", "/api/admin/menus", ADMIN, async ({ res }) => json(res, 200, all(`SELECT r.id, r.name, r.accepts_orders, COUNT(m.id) AS items, COALESCE(SUM(m.available), 0) AS available, COALESCE(SUM(m.image_file != ''), 0) AS with_images,
      COUNT(DISTINCT NULLIF(m.category, '')) AS categories FROM restaurants r LEFT JOIN menu_items m ON m.restaurant_id = r.id GROUP BY r.id ORDER BY r.name COLLATE NOCASE`)
    .map(r => ({ id: r.id, name: r.name, ordersEnabled: !!r.accepts_orders, items: r.items, available: r.available, withImages: r.with_images, categories: r.categories }))));
  add("GET", "/api/admin/restaurants/:id/menu", ADMIN, async ({ res, params }) => {
    const r = one("SELECT id, name FROM restaurants WHERE id = ?", params.id); if (!r) fail(404, "Restaurant not found.");
    json(res, 200, { restaurant: r, items: all("SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY available DESC, name COLLATE NOCASE", r.id).map(m => ({ id: m.id, name: m.name, description: m.description, category: m.category, price: money(m.price_cents), available: !!m.available, image: uploads.publicUrl(m.image_file) })) });
  });
  add("PATCH", "/api/admin/menu/:id", ADMIN, async ({ req, res, user, params }) => {
    const m = one("SELECT * FROM menu_items WHERE id = ?", params.id); if (!m) fail(404, "Menu item not found.");
    const b = await readJson(req); if (typeof b.available !== "boolean") fail(400, "Choose whether the item is available.");
    run("UPDATE menu_items SET available = ? WHERE id = ?", b.available ? 1 : 0, m.id);
    audit(user, b.available ? "menu_item.shown" : "menu_item.hidden", "menu_item", m.id, { restaurantId: m.restaurant_id, name: m.name });
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/admin/menu/:id", ADMIN, async ({ res, user, params }) => {
    const m = one("SELECT * FROM menu_items WHERE id = ?", params.id); if (!m) fail(404, "Menu item not found.");
    run("DELETE FROM menu_items WHERE id = ?", m.id); uploads.deletePublicImage(m.image_file);
    audit(user, "menu_item.deleted", "menu_item", m.id, { restaurantId: m.restaurant_id, name: m.name });
    json(res, 200, { ok: true });
  });
  add("GET", "/api/admin/restaurants/:id/overview", ADMIN, async ({ res, params }) => {
    const r = one("SELECT * FROM restaurants WHERE id = ?", params.id); if (!r) fail(404, "Restaurant not found.");
    const lr = one("SELECT * FROM restaurant_location_requests WHERE restaurant_id = ? AND status != 'DRAFT' ORDER BY id DESC LIMIT 1", r.id);
    const cnt = (sql, ...a) => one(sql, ...a).n, by = (table) => Object.fromEntries(all(`SELECT status, COUNT(*) AS n FROM ${table} WHERE restaurant_id = ? GROUP BY status`, r.id).map(x => [x.status, x.n]));
    const rating = one("SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews WHERE restaurant_id = ?", r.id), acct = payAccount(r.id);
    json(res, 200, {
      restaurant: { id: r.id, name: r.name, municipality: r.municipality, category: r.category, address: r.address, contact: r.contact, hours: r.hours, description: r.description, source: r.source,
        logo: uploads.publicUrl(r.logo_file), cover: uploads.publicUrl(r.cover_file), lat: r.lat, lng: r.lng, locationStatus: r.location_status, acceptsReservations: !!r.accepts_reservations, acceptsOrders: !!r.accepts_orders, createdAt: iso(r.created_at) },
      staff: all("SELECT id, full_name, email, status, email_verified FROM users WHERE restaurant_id = ? ORDER BY id", r.id).map(u => ({ id: u.id, name: u.full_name, email: u.email, status: u.status, emailVerified: !!u.email_verified })),
      location: lr ? { requestId: lr.id, status: lr.status, submittedAt: iso(lr.submitted_at), reviewedAt: iso(lr.reviewed_at), documents: cnt("SELECT COUNT(*) AS n FROM restaurant_verification_documents WHERE request_id = ?", lr.id), documentKinds: all("SELECT DISTINCT kind FROM restaurant_verification_documents WHERE request_id = ?", lr.id).map(k => k.kind) } : null,
      tables: tableSummary(r), reservationMinutes: r.reservation_minutes || 90,
      menu: { items: cnt("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = ?", r.id), available: cnt("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = ? AND available = 1", r.id), withImages: cnt("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = ? AND image_file != ''", r.id) },
      payments: { gcashConfigured: payReady(r.id), orderPrepay: !!r.order_prepay, reservationFee: money(r.reservation_fee_cents), extraCharges: cnt("SELECT COUNT(*) AS n FROM restaurant_charges WHERE restaurant_id = ? AND active = 1", r.id), ...by("payments"), holderOnFile: !!acct, hasQr: !!(acct && acct.qr_file), demoPayment: !!r.demo_payment }, // the GCash number and QR code are not shown here
      activity: { reservations: by("reservations"), orders: by("orders"), reviews: { count: rating.n, average: rating.avg } }
    });
  });
  add("GET", "/api/admin/attention", ADMIN, async ({ res }) => {
    const cut = staleCut(), n = (sql, ...a) => one(sql, ...a).n, items = [
      { key: "applications", label: "Staff applications waiting for review", count: n("SELECT COUNT(*) AS n FROM staff_applications WHERE status = 'pending'"), tab: "applications", urgent: true },
      { key: "locations", label: "Location requests to review", count: n("SELECT COUNT(*) AS n FROM restaurant_location_requests WHERE status IN ('PENDING','UNDER_REVIEW')"), tab: "locations", urgent: true },
      { key: "evidence", label: "Location requests waiting for the restaurant's extra evidence", count: n("SELECT COUNT(*) AS n FROM restaurant_location_requests WHERE status = 'NEEDS_EVIDENCE'"), tab: "locations", urgent: false },
      { key: "payments", label: "Payment receipts the restaurant has not checked for over 24 hours", count: n("SELECT COUNT(*) AS n FROM payments p WHERE p.status = 'UNDER_REVIEW' AND (SELECT MAX(created_at) FROM payment_submissions s WHERE s.payment_id = p.id) < ?", cut), tab: "monitor", sub: "payments", urgent: true },
      { key: "refunds", label: "Accepted payments for cancelled bookings (refund due)", count: all("SELECT p.* FROM payments p WHERE p.status = 'ACCEPTED'").filter(p => { const pi = parentInfo(p); return pi && !pi.active; }).length, tab: "monitor", sub: "payments", urgent: false },
      { key: "reservations", label: "Reservation requests unanswered for over 24 hours", count: n("SELECT COUNT(*) AS n FROM reservations WHERE status = 'PENDING' AND created_at < ?", cut), tab: "monitor", sub: "reservations", urgent: false },
      { key: "orders", label: "Advance orders unanswered for over 24 hours", count: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'PENDING' AND created_at < ?", cut), tab: "monitor", sub: "orders", urgent: false },
      { key: "verify", label: "New accounts waiting to verify their email", count: n("SELECT COUNT(*) AS n FROM users WHERE verification_required = 1 AND email_verified = 0 AND status != 'REJECTED'"), tab: "accounts", urgent: false }
    ];
    json(res, 200, { items, total: items.filter(i => i.urgent).reduce((t, i) => t + i.count, 0) });
  });
  /* user list: filters, paging and email-verification status */
  add("POST", "/api/admin/users/:id/resend-verification", ADMIN, async ({ res, user, params }) => {
    const target = one("SELECT * FROM users WHERE id = ?", params.id); if (!target) fail(404, "Account not found.");
    if (!ctx.verification.enabled()) fail(503, "Email delivery is not set up, so no code can be sent.");
    if (target.email_verified) fail(409, "This email address is already verified.");
    try { await ctx.verification.issue(target); } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
    audit(user, "user.verification_sent", "user", target.id, { email: target.email });
    json(res, 200, { ok: true, message: "A new code was emailed to the user." });
  });
  /* audit log search and export (CSV cells that could be read as spreadsheet formulas are neutralised) */
  function auditQuery(q) {
    const w = ["1=1"], a = [];
    const action = (q.get("action") || "").trim(); if (action) { w.push("action LIKE ? ESCAPE '\\'"); a.push(likeEsc(action).slice(1)); } // prefix match: "fee_setting" finds fee_setting.created
    const actor = (q.get("actor") || "").trim(); if (actor) { w.push("actor_name LIKE ? ESCAPE '\\'"); a.push(likeEsc(actor)); }
    const tt = (q.get("targetType") || "").trim(); if (tt) { w.push("target_type = ?"); a.push(tt); }
    const from = dateParam(q, "from"), to = dateParam(q, "to"); if (from) { w.push("date(created_at, '+8 hours') >= ?"); a.push(from); } if (to) { w.push("date(created_at, '+8 hours') <= ?"); a.push(to); }
    const t = (q.get("q") || "").trim(); if (t) { w.push("(detail LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')"); a.push(likeEsc(t), likeEsc(t), likeEsc(t)); }
    return { where: w.join(" AND "), args: a };
  }
  const mapAudit = (x) => ({ id: x.id, actor: x.actor_name, action: x.action, targetType: x.target_type, targetId: x.target_id, detail: x.detail, at: iso(x.created_at) });
  add("GET", "/api/admin/audit-search", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, f = auditQuery(q), lim = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200), before = Number(q.get("before")) || 0;
    const rows = all(`SELECT * FROM admin_audit_logs WHERE ${f.where} ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`, ...f.args, ...(before ? [before] : []), lim + 1);
    const more = rows.length > lim; if (more) rows.pop();
    json(res, 200, { entries: rows.map(mapAudit), nextBefore: more ? rows[rows.length - 1].id : null, ...(before ? {} : { actions: all("SELECT DISTINCT action FROM admin_audit_logs ORDER BY action").map(x => x.action) }) });
  });
  add("GET", "/api/admin/audit-export", ADMIN, async ({ req, res, user }) => {
    const q = new URL(req.url, "http://x").searchParams, f = auditQuery(q);
    const rows = all(`SELECT * FROM admin_audit_logs WHERE ${f.where} ORDER BY id DESC LIMIT 5000`, ...f.args).map(mapAudit);
    const cell = (v) => { let t = String(v ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
    const csv = ["id,when,actor,action,target type,target,details", ...rows.map(r => [r.id, r.at, r.actor, r.action, r.targetType, r.targetId, r.detail].map(cell).join(","))].join("\r\n");
    audit(user, "audit.exported", "audit_log", "", { rows: rows.length, filters: Object.fromEntries([...q.entries()].filter(([, v]) => v)) });
    ctx.send(res, 200, "\ufeff" + csv, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="isla-plateu-audit-${phDate(Date.now())}.csv"` });
  });

  /* Is the account protection switched on? Shows names and counts only: never a password, key or secret. */
  add("GET", "/api/admin/security-status", ADMIN, async ({ res }) => {
    const m = ctx.mailer.describe(), n = (w) => one(`SELECT COUNT(*) AS n FROM users ${w}`).n;
    json(res, 200, { email: { enabled: m.configured, provider: m.provider, from: m.from, problems: m.problems }, captcha: { enabled: ctx.captcha.enabled, provider: ctx.captcha.provider },
      accounts: { total: n(""), verified: n("WHERE email_verified = 1"), unverified: n("WHERE email_verified = 0"), waitingToVerify: n("WHERE verification_required = 1 AND email_verified = 0") } });
  });
  add("GET", "/api/admin/audit-logs", ADMIN, async ({ req, res }) => {
    const lim = Math.min(Math.max(Number(new URL(req.url, "http://x").searchParams.get("limit")) || 100, 1), 500);
    json(res, 200, all("SELECT * FROM admin_audit_logs ORDER BY id DESC LIMIT ?", lim).map(a => ({ id: a.id, actor: a.actor_name, action: a.action, targetType: a.target_type, targetId: a.target_id, detail: a.detail, at: iso(a.created_at) })));
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

  add("GET", "/api/admin/users", ADMIN, async ({ req, res }) => {
    const q = new URL(req.url, "http://x").searchParams, w = ["1=1"], a = [];
    const role = q.get("role"); if (role && role !== "all") { w.push("u.role = ?"); a.push(role.toUpperCase()); }
    const st = q.get("status"); if (st && st !== "all") { w.push("u.status = ?"); a.push(st.toUpperCase()); }
    const ver = q.get("verified"); if (ver === "yes") w.push("u.email_verified = 1"); else if (ver === "no") w.push("u.email_verified = 0"); else if (ver === "waiting") w.push("u.verification_required = 1 AND u.email_verified = 0");
    const t = (q.get("q") || "").trim(); if (t) { w.push("(u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')"); a.push(likeEsc(t), likeEsc(t), likeEsc(t)); }
    const limit = Math.min(Math.max(Number(q.get("limit")) || 500, 1), 1000), page = Math.max(Number(q.get("page")) || 1, 1);
    const base = `FROM users u LEFT JOIN restaurants r ON r.id = u.restaurant_id WHERE ${w.join(" AND ")}`;
    const n = (x) => one(`SELECT COUNT(*) AS n FROM users ${x}`).n;
    json(res, 200, { total: one(`SELECT COUNT(*) AS n ${base}`, ...a).n, page, counts: { all: n(""), verified: n("WHERE email_verified = 1"), notVerified: n("WHERE email_verified = 0"), waiting: n("WHERE verification_required = 1 AND email_verified = 0") },
      users: all(`SELECT u.id, u.full_name, u.email, u.contact_number, u.role, u.status, u.restaurant_id, u.created_at, u.email_verified, u.email_verified_at, u.verification_required, r.name AS restaurant_name ${base} ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`, ...a, limit, (page - 1) * limit)
        .map(u => ({ id: u.id, fullName: u.full_name, email: u.email, contactNumber: u.contact_number, role: u.role, status: u.status, restaurantId: u.restaurant_id, restaurantName: u.restaurant_name, createdAt: iso(u.created_at),
          emailVerified: !!u.email_verified, emailVerifiedAt: iso(u.email_verified_at), verificationRequired: !!u.verification_required })) });
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

  add("POST", "/api/admin/restaurants", ADMIN, async ({ req, res, user }) => {
    const v = validateRestaurant(await readJson(req), null);
    let base = v.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "restaurant", id = base, n = 2;
    while (one("SELECT 1 AS x FROM restaurants WHERE id = ?", id)) id = `${base}-${n++}`;
    run(`INSERT INTO restaurants (id, ${RCOLS.join(", ")}, source) VALUES (?, ${RCOLS.map(() => "?").join(", ")}, ?)`, id, ...RCOLS.map(k => v[k]), "Added by administrator");
    audit(user, "restaurant.created", "restaurant", id, { name: v.name, municipality: v.municipality, lat: v.lat, lng: v.lng });
    json(res, 201, { id });
  });
  add("PUT", "/api/admin/restaurants/:id", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!cur) fail(404, "Restaurant not found.");
    const v = validateRestaurant(await readJson(req), cur);
    run(`UPDATE restaurants SET ${RCOLS.map(k => k + " = ?").join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...RCOLS.map(k => v[k]), cur.id);
    const changed = RCOLS.filter(k => String(cur[k] ?? "") !== String(v[k] ?? ""));
    audit(user, "restaurant.updated", "restaurant", cur.id, { fields: changed, ...(changed.includes("lat") || changed.includes("lng") ? { pin: { from: [cur.lat, cur.lng], to: [v.lat, v.lng] } } : {}) }); // a pin set here goes live without the staff location-request process
    json(res, 200, { ok: true });
  });
  add("DELETE", "/api/admin/restaurants/:id", ADMIN, async ({ req, res, user, params }) => {
    const cur = one("SELECT * FROM restaurants WHERE id = ?", params.id);
    if (!cur) fail(404, "Restaurant not found.");
    const b = await readJson(req);
    if (b.confirmName !== cur.name) fail(400, "Type the restaurant's exact name to confirm deletion.", { confirmName: "Name does not match." });
    const removed = {
      reservations: one("SELECT COUNT(*) AS n FROM reservations WHERE restaurant_id = ?", cur.id).n,
      orders: one("SELECT COUNT(*) AS n FROM orders WHERE restaurant_id = ?", cur.id).n,
      reviews: one("SELECT COUNT(*) AS n FROM reviews WHERE restaurant_id = ?", cur.id).n
    };
    const docFiles = [...all("SELECT file_name FROM restaurant_verification_documents WHERE restaurant_id = ?", cur.id).map(d => d.file_name),
      ...all("SELECT proof_file FROM payment_submissions WHERE restaurant_id = ?", cur.id).map(d => d.proof_file),
      ...all("SELECT qr_file FROM restaurant_payment_accounts WHERE restaurant_id = ?", cur.id).map(d => d.qr_file)];
    const imageFiles = [cur.logo_file, cur.cover_file, ...all("SELECT image_file FROM menu_items WHERE restaurant_id = ?", cur.id).map(m => m.image_file)];
    db.exec("BEGIN");
    try {
      run("UPDATE users SET restaurant_id = NULL WHERE restaurant_id = ?", cur.id); // staff stay, but become unassigned
      run("DELETE FROM restaurants WHERE id = ?", cur.id);                          // related bookings/orders/reviews/messages cascade
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    docFiles.forEach(f => uploads.deletePrivateFile(f)); imageFiles.forEach(f => uploads.deletePublicImage(f)); // no orphaned files
    audit(user, "restaurant.deleted", "restaurant", cur.id, { name: cur.name, removed });
    json(res, 200, { ok: true, removed });
  });

  add("POST", "/api/admin/staff", ADMIN, async ({ req, res, user }) => {
    const b = await readJson(req);
    const fullName = text(b.fullName, 80, "Full name", { required: true, min: 2 });
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) fail(400, "Enter a valid email address.", { email: "Enter a valid email address." });
    const rid = String(b.restaurantId ?? "");
    if (!one("SELECT 1 AS x FROM restaurants WHERE id = ?", rid)) fail(400, "Choose the restaurant this staff member belongs to.", { restaurantId: "Choose a restaurant." });
    if (one("SELECT 1 AS x FROM users WHERE email = ?", email)) fail(409, "An account with this email already exists.", { email: "Already registered." });
    const password = tempPassword();
    const newId = Number(run("INSERT INTO users (full_name, email, password_hash, role, restaurant_id) VALUES (?,?,?,?,?)", fullName, email, await hashPassword(password), "RESTAURANT_STAFF", rid).lastInsertRowid);
    audit(user, "user.staff_created", "user", newId, { email, restaurantId: rid }); // the temporary password is never logged
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
    audit(user, "user.updated", "user", target.id, { email: target.email, ...(b.status !== undefined ? { status: { from: target.status, to: b.status } } : {}), ...(b.restaurantId !== undefined ? { restaurantId: { from: target.restaurant_id, to: b.restaurantId } } : {}) });
    json(res, 200, { ok: true });
  });
  add("POST", "/api/admin/users/:id/reset-password", ADMIN, async ({ res, user, params }) => {
    const target = one("SELECT * FROM users WHERE id = ?", params.id);
    if (!target) fail(404, "Account not found.");
    const password = tempPassword();
    run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(password), target.id);
    run("DELETE FROM sessions WHERE user_id = ?", target.id);
    audit(user, "user.password_reset", "user", target.id, { email: target.email }); // the new password is never logged
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
    audit(user, "backup.downloaded", "database", "", { bytes: buf.length }); // contains personal data: every download is recorded
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
    const cap = await ctx.captcha.verify(b.captchaToken, ctx.clientIp(req)); // verified with the provider on the server, after the field checks
    if (!cap.ok) { const m = ctx.captcha.message(cap.reason); fail(cap.reason === "unavailable" ? 503 : 400, m, { captcha: m }); }
    if (one("SELECT 1 AS x FROM users WHERE email = ?", email)) fail(409, "An account with this email already exists.", applyDup());

    const hash = await hashPassword(password);
    let uid;
    db.exec("BEGIN IMMEDIATE");
    try {
      uid = Number(run("INSERT INTO users (full_name, email, password_hash, role, status, contact_number) VALUES (?,?,?,?,?,?)", fullName, email, hash, "RESTAURANT_STAFF", "PENDING", contactNumber).lastInsertRowid);
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
    let needsVerification = false, emailSent = false;
    if (ctx.verification.enabled()) {
      run("UPDATE users SET verification_required = 1 WHERE id = ?", uid); needsVerification = true;
      try { await ctx.verification.issue({ id: uid, email, full_name: fullName }); emailSent = true; } catch { /* they can ask for a new code */ }
    }
    json(res, 201, { status: "pending", needsVerification, emailSent, email, message: "Application received. An administrator will review it. You cannot log in as staff until it is approved." });
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
    audit(user, "application.approved", "staff_application", params.id, { restaurantId, note: String(body.note || "").slice(0, 200) });
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
    audit(user, "application.rejected", "staff_application", params.id, { note: String((typeof body === "object" && body && body.note) || "").slice(0, 200) });
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
    audit(user, "application.reopened", "staff_application", params.id, {});
    json(res, 200, { ok: true });
  });

  /* ---------- dispatcher ---------- */
  dispatchFn.publicFile = uploads.publicFile;
  dispatchFn.routeTable = () => routes.map(r => ({ method: r.method, pattern: r.pattern, roles: r.roles })); // used by the permission sweep test
  return dispatchFn;
  async function dispatchFn(req, res, user, pathname, method) {
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
