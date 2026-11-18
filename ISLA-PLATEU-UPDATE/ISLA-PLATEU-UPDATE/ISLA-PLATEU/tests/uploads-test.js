/* Phase 2: restaurant logo/cover and food image uploads. Self-contained: starts its own server on a temporary database
   and a temporary uploads folder.   Run:  node tests/uploads-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3932, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-upl-"));
const ADMIN_PW = "Upload-Test-2026";
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

(async () => {
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    ok(admin.r.status === 200, "admin login");
    ok((await call(admin.j, "POST", "/api/admin/restaurants", { name: "Alpha Grill", municipality: "Larena", category: "Restaurant", address: "Larena" })).status === 201, "restaurant A created");
    ok((await call(admin.j, "POST", "/api/admin/restaurants", { name: "Beta Cafe", municipality: "Lazi", category: "Cafe", address: "Lazi" })).status === 201, "restaurant B created");
    const sa = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff Alpha", email: "alpha@example.com", restaurantId: "alpha-grill" });
    const sb = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff Beta", email: "beta@example.com", restaurantId: "beta-cafe" });
    const A = await login("RESTAURANT_STAFF", "alpha@example.com", sa.data.temporaryPassword);
    const B = await login("RESTAURANT_STAFF", "beta@example.com", sb.data.temporaryPassword);
    await call(jar(), "POST", "/api/register", { fullName: "Cara Customer", email: "cara@example.com", password: "Island2026", confirmPassword: "Island2026" });
    const cj = (await login("CUSTOMER", "cara@example.com", "Island2026")).j;
    const anon = jar();

    /* logo / cover */
    const up = await call(A.j, "POST", "/api/staff/restaurant/logo", img.png, { "Content-Type": "image/png" });
    ok(up.status === 200 && /^\/uploads\/public\/[a-f0-9]{32}\.png$/.test(up.data.url), "staff uploads a PNG logo");
    const served = await fetch(BASE + up.data.url);
    const bytes = Buffer.from(await served.arrayBuffer());
    ok(served.status === 200 && served.headers.get("content-type") === "image/png" && bytes.equals(img.png), "logo is served publicly with the right type and unchanged bytes");
    ok(served.headers.get("x-content-type-options") === "nosniff", "uploaded images are served with nosniff");
    const cov = await call(A.j, "POST", "/api/staff/restaurant/cover", img.webp, { "Content-Type": "image/webp" });
    ok(cov.status === 200 && cov.data.url.endsWith(".webp"), "staff uploads a WEBP cover image");
    const pub = (await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill");
    ok(pub.logo === up.data.url && pub.cover === cov.data.url, "public restaurant list carries the uploaded logo and cover");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "beta-cafe").logo === null, "other restaurant is unaffected (no logo)");

    const up2 = await call(A.j, "POST", "/api/staff/restaurant/logo", img.jpg, { "Content-Type": "image/jpeg" });
    ok(up2.status === 200 && up2.data.url.endsWith(".jpg"), "staff replaces the logo with a JPG");
    ok((await fetch(BASE + up.data.url)).status === 404, "the replaced logo file is deleted from storage");

    /* validation */
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    ok((await call(A.j, "POST", "/api/staff/restaurant/logo", svg, { "Content-Type": "image/png" })).status === 415, "SVG disguised as PNG is rejected");
    ok((await call(A.j, "POST", "/api/staff/restaurant/logo", Buffer.from("GIF89a" + "x".repeat(50)), { "Content-Type": "image/gif" })).status === 415, "GIF is rejected");
    ok((await call(A.j, "POST", "/api/staff/restaurant/logo", Buffer.from("<?php echo 1; ?>"), { "Content-Type": "image/jpeg" })).status === 415, "script file renamed as image is rejected");
    ok((await call(A.j, "POST", "/api/staff/restaurant/logo", Buffer.alloc(0), { "Content-Type": "image/png" })).status === 400, "empty upload is rejected");
    const big = await call(A.j, "POST", "/api/staff/restaurant/cover", Buffer.concat([img.jpg, Buffer.alloc(6 * 1024 * 1024)]), { "Content-Type": "image/jpeg" });
    ok(big.status === 413, "image over 5 MB is rejected (413)");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill").cover === cov.data.url, "failed uploads did not change the saved cover");

    /* permissions */
    ok((await call(anon, "POST", "/api/staff/restaurant/logo", img.png, { "Content-Type": "image/png" })).status === 401, "guest cannot upload a logo");
    ok((await call(cj, "POST", "/api/staff/restaurant/logo", img.png, { "Content-Type": "image/png" })).status === 403, "customer cannot upload a logo");
    ok((await call(cj, "DELETE", "/api/staff/restaurant/logo", {})).status === 403, "customer cannot remove a logo");
    ok((await call(A.j, "POST", "/api/staff/restaurant/logo", img.png, { "Content-Type": "image/png", Origin: "https://evil.example" })).status === 403, "cross-site upload is blocked");

    /* food items */
    const mk = await call(A.j, "POST", "/api/staff/menu", { name: "Grilled Tuna", price: 250, description: "Fresh catch", category: "Seafood" });
    ok(mk.status === 201, "staff adds a food item with a category");
    const id = mk.data.id;
    const fi = await call(A.j, "POST", `/api/staff/menu/${id}/image`, img.jpg, { "Content-Type": "image/jpeg" });
    ok(fi.status === 200 && fi.data.url.endsWith(".jpg"), "staff uploads a food image");
    ok((await call(B.j, "POST", `/api/staff/menu/${id}/image`, img.jpg, { "Content-Type": "image/jpeg" })).status === 404, "another restaurant's staff cannot set this food image");
    ok((await call(B.j, "DELETE", `/api/staff/menu/${id}/image`, {})).status === 404, "another restaurant's staff cannot remove this food image");
    ok((await call(B.j, "PATCH", `/api/staff/menu/${id}`, { name: "Hijack" })).status === 404, "another restaurant's staff cannot edit this food item");
    const detail = (await call(anon, "GET", "/api/restaurants/alpha-grill")).data;
    const item = detail.menu.find(m => m.id === id);
    ok(item && item.image === fi.data.url && item.category === "Seafood" && item.available === true && item.price === 250, "customer menu shows image, category, price and availability");
    ok(detail.restaurant.acceptsOrders === false, "ordering stays off until the restaurant enables it");
    await call(A.j, "PATCH", `/api/staff/menu/${id}`, { available: false });
    const d2 = (await call(anon, "GET", "/api/restaurants/alpha-grill")).data.menu.find(m => m.id === id);
    ok(d2 && d2.available === false, "unavailable items stay visible but are marked unavailable");
    await call(A.j, "PATCH", "/api/staff/restaurant", { acceptsOrders: true });
    const day = new Date(Date.now() + 8 * 3600e3 + 2 * 864e5).toISOString().slice(0, 10);
    const ord = await call(cj, "POST", "/api/orders", { restaurantId: "alpha-grill", pickupDate: day, pickupTime: "12:00", items: [{ menuItemId: id, qty: 1 }] });
    ok(ord.status === 409 || ord.status === 400, "an unavailable item cannot be ordered");
    await call(A.j, "PATCH", `/api/staff/menu/${id}`, { available: true, category: "Main dish" });
    ok((await call(cj, "POST", "/api/orders", { restaurantId: "alpha-grill", pickupDate: day, pickupTime: "12:00", items: [{ menuItemId: id, qty: 1 }] })).status === 201, "an available item can be ordered");
    const lst = await call(A.j, "GET", "/api/staff/menu");
    ok(lst.data[0].image === fi.data.url && lst.data[0].category === "Main dish", "staff menu list shows image and updated category");
    ok((await call(A.j, "DELETE", `/api/staff/menu/${id}/image`, {})).status === 200 && (await fetch(BASE + fi.data.url)).status === 404, "removing a food image deletes the file");

    /* deletion cleans up files; admin oversight */
    const fi2 = await call(A.j, "POST", `/api/staff/menu/${id}/image`, img.png, { "Content-Type": "image/png" });
    ok((await call(B.j, "DELETE", `/api/admin/menu/${id}/image`, {})).status === 403, "staff cannot use the admin image-removal route");
    ok((await call(admin.j, "DELETE", `/api/admin/menu/${id}/image`, {})).status === 200 && (await fetch(BASE + fi2.data.url)).status === 404, "admin can remove an inappropriate food image");
    ok((await call(admin.j, "DELETE", "/api/admin/restaurants/alpha-grill/cover", {})).status === 200 && (await fetch(BASE + cov.data.url)).status === 404, "admin can remove a restaurant cover image");
    ok((await call(A.j, "DELETE", "/api/staff/restaurant/logo", {})).status === 200 && (await fetch(BASE + up2.data.url)).status === 404, "staff can remove the logo");

    /* static route safety */
    for (const bad of ["/uploads/public/../t.db", "/uploads/public/%2e%2e%2ft.db", "/uploads/public/..%5ct.db", "/uploads/public/nothere.png", "/uploads/public/", "/uploads/private/x.png", "/uploads/t.db"]) {
      const r = await fetch(BASE + bad, { redirect: "manual" });
      ok(r.status === 404 || r.status === 400, `no path tricks: ${bad} -> ${r.status}`);
    }
    const listing = fs.readdirSync(path.join(dir, "uploads", "public"));
    const { DatabaseSync } = require("node:sqlite");
    const seedDb = new DatabaseSync(path.join(dir, "t.db"));
    const referenced = new Set(seedDb.prepare("SELECT logo_file AS f FROM restaurants WHERE logo_file != '' UNION SELECT cover_file FROM restaurants WHERE cover_file != '' UNION SELECT image_file FROM menu_items WHERE image_file != ''").all().map(x => x.f));
    seedDb.close();
    ok(listing.every(name => referenced.has(name)), "no orphaned image files remain after replace/remove (preloaded PagudFood assets are retained)");
    ok(fs.existsSync(path.join(dir, "uploads", "private")), "private upload folder exists (not served)");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
