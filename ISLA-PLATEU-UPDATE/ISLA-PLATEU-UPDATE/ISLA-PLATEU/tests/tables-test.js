/* Phase 4: table management, availability and double-booking protection. Self-contained.   Run:  node tests/tables-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3934, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-tbl-"));
const ADMIN_PW = "Tables-Test-2026";
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
    const mkRest = (name, extra = {}) => call(admin.j, "POST", "/api/admin/restaurants", { name, municipality: "Larena", category: "Restaurant", address: "Larena", acceptsReservations: true, ...extra });
    await mkRest("Alpha Grill"); await mkRest("Beta Cafe"); await mkRest("Gamma Plain");
    const mkStaff = async (n, rid) => { const s = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff " + n, email: `${n}@example.com`, restaurantId: rid }); return login("RESTAURANT_STAFF", `${n}@example.com`, s.data.temporaryPassword); };
    const A = await mkStaff("alpha", "alpha-grill"), B = await mkStaff("beta", "beta-cafe"), G = await mkStaff("gamma", "gamma-plain");
    const mkCust = async (n) => { await call(jar(), "POST", "/api/register", { fullName: n + " Customer", email: `${n}@example.com`, password: "Island2026", confirmPassword: "Island2026" }); return (await login("CUSTOMER", `${n}@example.com`, "Island2026")).j; };
    const C1 = await mkCust("cara"), C2 = await mkCust("dan"), C3 = await mkCust("eve"), anon = jar();
    const avail = async (rid, date, time) => (await call(anon, "GET", `/api/restaurants/${rid}/tables?date=${date}&time=${time}`)).data;
    const reserve = (j, rid, date, time, party, tableId, extra = {}) => call(j, "POST", "/api/reservations", { restaurantId: rid, date, time, partySize: party, ...(tableId ? { tableId } : {}), ...extra });
    const setStatus = (j, id, status, extra = {}) => call(j, "PATCH", `/api/staff/reservations/${id}`, { status, ...extra });
    const D3 = ph(3)[0], D4 = ph(4)[0];

    /* restaurant with NO tables keeps the old behaviour */
    const e0 = await avail("alpha-grill", D3, "19:00");
    ok(e0.tables.length === 0 && e0.summary === null, "no tables configured -> empty list, no summary");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill").tables === null, "restaurant list: tables is null when none configured");
    const legacy = await reserve(C1, "gamma-plain", D3, "19:00", 2, 999);
    ok(legacy.status === 201, "restaurant without tables still takes a guest-count reservation (old behaviour)");
    ok((await setStatus(G.j, legacy.data.id, "CONFIRMED")).status === 200, "…and staff can still confirm it");

    /* permissions + validation */
    ok((await call(anon, "POST", "/api/staff/tables", { label: "X", capacity: 2 })).status === 401, "guest cannot add tables");
    ok((await call(C1, "POST", "/api/staff/tables", { label: "X", capacity: 2 })).status === 403, "customer cannot add tables");
    ok((await call(A.j, "POST", "/api/staff/tables/bulk", { count: 0, capacity: 4 })).status === 400, "bulk: 0 tables rejected");
    ok((await call(A.j, "POST", "/api/staff/tables/bulk", { count: 51, capacity: 4 })).status === 400, "bulk: 51 tables rejected");
    ok((await call(A.j, "POST", "/api/staff/tables/bulk", { count: 2, capacity: 0 })).status === 400, "bulk: 0 seats rejected");
    ok((await call(A.j, "POST", "/api/staff/tables", { label: "<b>x</b>", capacity: 2 })).status === 400, "markup in table name rejected");
    ok((await call(A.j, "POST", "/api/staff/tables", { label: "", capacity: 2 })).status === 400, "table name required");
    ok((await call(A.j, "POST", "/api/staff/tables", { label: "Big", capacity: 51 })).status === 400, "capacity above 50 rejected");

    /* configure Alpha: Table 1-3 (4 seats), Window 1 (2 seats), Terrace (8, walk-in only) */
    const bulk = await call(A.j, "POST", "/api/staff/tables/bulk", { count: 3, capacity: 4 });
    ok(bulk.status === 201 && bulk.data.created.join() === "Table 1,Table 2,Table 3", "bulk-add three numbered tables");
    ok((await call(A.j, "POST", "/api/staff/tables/bulk", { count: 1, capacity: 4 })).data.created[0] === "Table 4", "numbering continues without clashes");
    const t4 = (await call(A.j, "GET", "/api/staff/tables")).data.tables.find(t => t.label === "Table 4");
    ok((await call(A.j, "DELETE", `/api/staff/tables/${t4.id}`, {})).status === 200, "unused table can be deleted");
    const win = await call(A.j, "POST", "/api/staff/tables", { label: "Window 1", capacity: 2 });
    ok(win.status === 201, "single table added with its own name and seats");
    ok((await call(A.j, "POST", "/api/staff/tables", { label: "window 1", capacity: 2 })).status === 409, "duplicate table name (any case) rejected");
    const ter = await call(A.j, "POST", "/api/staff/tables", { label: "Terrace", capacity: 8, reservable: false });
    ok(ter.status === 201, "walk-in only table added");
    const list = (await call(A.j, "GET", "/api/staff/tables")).data;
    const T = Object.fromEntries(list.tables.map(t => [t.label, t.id]));
    ok(list.summary.total === 5 && list.summary.available === 4 && list.summary.walkInOnly === 1 && list.summary.seats === 22 && list.summary.reserved === 0, "summary: 5 tables, 4 reservable & free, 1 walk-in, 22 seats");
    ok((await call(B.j, "PATCH", `/api/staff/tables/${T["Table 1"]}`, { label: "Hijacked" })).status === 404 && (await call(B.j, "DELETE", `/api/staff/tables/${T["Table 1"]}`, {})).status === 404, "another restaurant's staff cannot edit or delete these tables");
    ok((await call(B.j, "GET", "/api/staff/tables")).data.tables.length === 0, "another restaurant sees none of these tables");

    /* public view */
    const pub = (await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill");
    ok(pub.tables && pub.tables.total === 5 && pub.tables.available === 4 && pub.tables.largest === 8, "map list carries total / available / reserved table counts");
    const det = (await call(anon, "GET", "/api/restaurants/alpha-grill")).data;
    ok(det.tableList.length === 5 && det.tableList.find(t => t.label === "Window 1").capacity === 2 && !JSON.stringify(det).includes("customer"), "details list each table's seats and status (no customer data)");
    ok((await call(anon, "GET", "/api/restaurants/alpha-grill/tables?date=2026-13-45&time=19:00")).status === 400, "bad date rejected");
    ok((await call(anon, "GET", "/api/restaurants/nope/tables")).status === 404, "unknown restaurant = 404");

    /* reservations pick tables; pending requests don't block, confirmed ones do */
    const r1 = await reserve(C1, "alpha-grill", D3, "19:00", 2, T["Window 1"]);
    ok(r1.status === 201, "customer requests a specific table");
    ok((await avail("alpha-grill", D3, "19:00")).summary.reserved === 0, "a PENDING request does not mark the table reserved");
    const c1 = await setStatus(A.j, r1.data.id, "CONFIRMED");
    ok(c1.status === 200 && c1.data.table === "Window 1", "staff confirms -> table assigned");
    const at = async (hhmm, day = D3) => (await avail("alpha-grill", day, hhmm)).tables.find(t => t.label === "Window 1").status;
    ok(await at("19:00") === "reserved" && await at("19:30") === "reserved" && await at("20:29") === "reserved", "confirmed table is reserved during the whole 90-minute window");
    ok(await at("20:30") === "available", "free again exactly when the window ends (20:30)");
    ok(await at("17:30") === "available" && await at("17:31") === "reserved", "a reservation that ends exactly at 19:00 does not clash, one minute later does");
    const sm = (await avail("alpha-grill", D3, "19:00")).summary;
    ok(sm.reserved === 1 && sm.available === 3 && sm.total === 5, "summary at 19:00: 1 reserved, 3 available of 5");
    ok((await call(C1, "GET", "/api/my/reservations")).data.find(v => v.id === r1.data.id).tableLabel === "Window 1", "customer sees the table on their reservation");

    /* blocked cases */
    ok((await reserve(C2, "alpha-grill", D3, "19:30", 2, T["Window 1"])).status === 409, "cannot request a table that is reserved in the overlapping window");
    ok((await reserve(C2, "alpha-grill", D3, "20:30", 2, T["Window 1"])).status === 201, "can request the same table right after the window");
    ok((await reserve(C2, "alpha-grill", D3, "21:00", 3, T["Window 1"])).status === 409, "party larger than the table's seats rejected");
    ok((await reserve(C2, "alpha-grill", D3, "21:00", 2, T["Terrace"])).status === 409, "walk-in-only table cannot be reserved");
    ok((await reserve(C2, "alpha-grill", D3, "21:00", 9, null)).status === 409, "no table fits 9 guests -> rejected");
    const bTable = (await call(B.j, "POST", "/api/staff/tables", { label: "B1", capacity: 4 })).data.id;
    ok((await reserve(C2, "alpha-grill", D3, "21:00", 2, bTable)).status === 400, "another restaurant's table id rejected");

    /* double booking at confirmation, even when requests were made in parallel */
    const p1 = await reserve(C1, "alpha-grill", D4, "18:00", 4, T["Table 1"]), p2 = await reserve(C2, "alpha-grill", D4, "18:30", 4, T["Table 1"]);
    ok(p1.status === 201 && p2.status === 201, "two overlapping requests for one table can both be pending");
    const race = await Promise.all([setStatus(A.j, p1.data.id, "CONFIRMED"), setStatus(A.j, p2.data.id, "CONFIRMED")]);
    ok(race.filter(x => x.status === 200).length === 1 && race.filter(x => x.status === 409).length === 1, "confirming both at once: exactly one wins, the other gets 409");
    const lost = race[0].status === 409 ? p1.data.id : p2.data.id;
    ok((await setStatus(A.j, lost, "CONFIRMED", { tableId: T["Table 1"] })).status === 409, "explicitly assigning the taken table is refused");
    const ok2 = await setStatus(A.j, lost, "CONFIRMED", { tableId: T["Table 2"] });
    ok(ok2.status === 200 && ok2.data.table === "Table 2", "staff can move the second booking to a free table and confirm");
    ok((await setStatus(A.j, lost, "CONFIRMED")).status === 409, "cannot confirm twice");

    /* auto-assign picks the smallest table that fits */
    const auto = await reserve(C2, "alpha-grill", D4, "18:00", 2, null);
    const autoC = await setStatus(A.j, auto.data.id, "CONFIRMED");
    ok(autoC.status === 200 && autoC.data.table === "Window 1", "no table chosen -> smallest free table that fits (Window 1 for 2 guests)");
    const stl = (await call(A.j, "GET", "/api/staff/reservations")).data;
    const pend = await reserve(C3, "alpha-grill", D4, "18:00", 3, null);
    const pv = (await call(A.j, "GET", "/api/staff/reservations")).data.find(v => v.id === pend.data.id);
    ok(pv.status === "PENDING" && pv.freeTables.every(t => t.capacity >= 3) && !pv.freeTables.some(t => ["Window 1", "Table 1", "Table 2"].includes(t.label)) && pv.freeTables.some(t => t.label === "Table 3"), "pending list offers only free tables that fit");
    ok((await setStatus(A.j, pend.data.id, "CONFIRMED")).data.table === "Table 3", "auto-assign takes the remaining table");
    ok((await avail("alpha-grill", D4, "18:00")).summary.available === 0, "all reservable tables are now reserved");
    ok((await reserve(C2, "alpha-grill", D4, "18:15", 2, null)).status === 409, "when nothing is free, new requests are refused with a clear message");
    const noRoom = await reserve(C2, "alpha-grill", D4, "18:15", 2, null);
    ok(/No table is free/.test(noRoom.data.error), "message explains that no table is free");

    /* freeing a table */
    ok((await call(C2, "POST", `/api/reservations/${auto.data.id}/cancel`, {})).status === 200, "customer cancels a confirmed reservation");
    ok((await avail("alpha-grill", D4, "18:00")).summary.available === 1, "cancelling frees the table");
    ok((await setStatus(A.j, pend.data.id, "NO_SHOW")).status === 200, "staff marks a no-show");
    ok((await avail("alpha-grill", D4, "18:00")).summary.available === 2, "a no-show frees the table too");

    /* staff edits */
    const delBusy = await call(A.j, "DELETE", `/api/staff/tables/${T["Window 1"]}`, {});
    ok(delBusy.status === 409, "cannot delete a table with upcoming confirmed reservations");
    ok((await call(A.j, "PATCH", `/api/staff/tables/${T["Table 1"]}`, { capacity: 2 })).status === 409, "cannot shrink a table below an upcoming confirmed party (4 guests)");
    const dis = await call(A.j, "PATCH", `/api/staff/tables/${T["Table 3"]}`, { active: false });
    ok(dis.status === 200, "staff temporarily disables a table");
    ok((await avail("alpha-grill", D4, "22:00")).tables.find(t => t.label === "Table 3").status === "disabled", "disabled tables show as disabled and are not counted as available");
    ok((await reserve(C2, "alpha-grill", D4, "22:00", 4, T["Table 3"])).status === 409, "customers cannot reserve a disabled table");
    ok((await call(A.j, "PATCH", `/api/staff/tables/${T["Table 3"]}`, { active: true, label: "Table 3A", capacity: 6 })).status === 200 && (await avail("alpha-grill", D4, "22:00")).tables.find(t => t.label === "Table 3A").capacity === 6, "re-enable, rename and resize a table");
    ok((await call(A.j, "PATCH", `/api/staff/tables/${T["Table 2"]}`, { label: "Table 3A" })).status === 409, "renaming onto an existing name rejected");
    ok((await call(A.j, "PATCH", `/api/staff/tables/${T["Terrace"]}`, { reservable: true })).status === 200 && (await avail("alpha-grill", D4, "22:00")).summary.available === 5, "making a walk-in table reservable adds it to availability");
    ok((await call(A.j, "DELETE", `/api/staff/tables/${T["Terrace"]}`, {})).status === 200, "free table deleted");

    /* reservation length */
    ok((await call(A.j, "PATCH", "/api/staff/restaurant", { reservationMinutes: 20 })).status === 400, "reservation length below 30 minutes rejected");
    ok((await call(A.j, "PATCH", "/api/staff/restaurant", { reservationMinutes: 241 })).status === 400, "reservation length above 240 minutes rejected");
    ok((await call(A.j, "PATCH", "/api/staff/restaurant", { reservationMinutes: 60 })).status === 200, "staff sets the reservation length to 60 minutes");
    ok(await at("20:00") === "available" && await at("19:59") === "reserved", "the window now ends 60 minutes after the start");

    /* windows that cross midnight */
    await call(A.j, "PATCH", "/api/staff/restaurant", { reservationMinutes: 90 });
    const late = await reserve(C1, "alpha-grill", D3, "23:30", 2, T["Window 1"]);
    await setStatus(A.j, late.data.id, "CONFIRMED");
    ok((await avail("alpha-grill", D4, "00:30")).tables.find(t => t.label === "Window 1").status === "reserved" && (await avail("alpha-grill", D4, "01:00")).tables.find(t => t.label === "Window 1").status === "available", "a 23:30 booking still blocks 00:30 the next day, and ends at 01:00");

    /* admin deletion cascades */
    ok((await call(admin.j, "DELETE", "/api/admin/restaurants/beta-cafe", { confirmName: "Beta Cafe" })).status === 200, "deleting a restaurant with tables works");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
