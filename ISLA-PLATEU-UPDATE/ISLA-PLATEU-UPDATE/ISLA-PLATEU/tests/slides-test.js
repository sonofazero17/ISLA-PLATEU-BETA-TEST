/* Phase 9: slideshow photos (credits, permission, public/admin routes). Self-contained.   Run:  node tests/slides-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3939, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-sld-"));
const ADMIN_PW = "Slides-Test-2026";
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

const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, n)]);

(async () => {
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    await call(admin.j, "POST", "/api/admin/restaurants", { name: "Alpha Grill", municipality: "Larena", category: "Restaurant", address: "Larena" });
    const sa = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff A", email: "alpha@example.com", restaurantId: "alpha-grill" });
    const A = await login("RESTAURANT_STAFF", "alpha@example.com", sa.data.temporaryPassword);
    await call(jar(), "POST", "/api/register", { fullName: "Cara Customer", email: "cara@example.com", password: "Island2026", confirmPassword: "Island2026" });
    const C = (await login("CUSTOMER", "cara@example.com", "Island2026")).j, anon = jar();
    const good = { set: "map", alt: "Grilled tuna on a banana leaf", credit: "Photo by Maria Santos", license: "Permission from Alpha Grill, 2026-11-10", caption: "Grilled tuna", confirm: "1" };
    const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const up = (j, o, buf = png(1)) => call(j, "POST", `/api/admin/slides?${qs({ ...good, ...o })}`, buf, { "Content-Type": "image/png" });
    const pub = async (set) => (await call(anon, "GET", `/api/slides?set=${set}`)).data;
    const adm = async () => (await call(admin.j, "GET", "/api/admin/slides")).data;

    /* public data: only credited, licensed photos */
    const l0 = await pub("landing");
    const landingIds = ["pagudfood", "the-cafe-infinite", "dagsa-resto", "la-candura", "luka-loko"];
    ok(l0.slides.length === 5 && landingIds.every(id => l0.slides.filter(s => s.restaurantId === id).length === 1) &&
      l0.slides.every(s => s.isPlaceholder && s.url.startsWith("/assets/images/restaurant-slides/") && /placeholder/i.test(s.license)),
    "landing starts with one clearly labeled local placeholder for each existing restaurant");
    const placeholderImage = await fetch(BASE + l0.slides[0].url);
    ok(placeholderImage.status === 200 && placeholderImage.headers.get("content-type").includes("image/svg+xml"), "local landing placeholder art is served without an external image dependency");
    ok((await pub("map")).slides.length === 0, "the map slideshow is empty until an administrator adds real photos (nothing invented)");
    ok((await call(anon, "GET", "/api/slides?set=nope")).status === 400 && (await call(anon, "GET", "/api/slides")).status === 400, "unknown slideshow rejected");

    /* permissions */
    for (const [m, p, b] of [["GET", "/api/admin/slides"], ["PATCH", "/api/admin/slides/1", { active: false }], ["POST", "/api/admin/slides/1/move", { direction: "up" }], ["DELETE", "/api/admin/slides/1", {}]]) ok((await call(anon, m, p, b)).status === 401 && (await call(C, m, p, b)).status === 403 && (await call(A.j, m, p, b)).status === 403, `${m} ${p}: guests 401, customers and staff 403`);
    ok((await up(anon, {})).status === 401 && (await up(C, {})).status === 403 && (await up(A.j, {})).status === 403, "only administrators can upload slideshow photos");

    /* validation: credit, licence and permission are mandatory */
    for (const [bad, why] of [[{ alt: "" }, "no description"], [{ alt: "ab" }, "description too short"], [{ credit: "" }, "no credit"], [{ license: "" }, "no licence or permission"], [{ confirm: undefined }, "no permission confirmation"], [{ confirm: "0" }, "permission box not ticked"], [{ set: "home" }, "unknown set"], [{ source: "javascript:alert(1)" }, "script link as source"], [{ source: "not a link" }, "invalid source"], [{ restaurantId: "nope" }, "unknown restaurant"], [{ alt: "<b>x</b>" }, "markup in description"], [{ credit: "<script>" }, "markup in credit"]]) ok((await up(admin.j, bad)).status === 400, `upload refused: ${why}`);
    ok((await adm()).map.length === 0, "none of the refused uploads were stored");
    ok((await call(admin.j, "POST", `/api/admin/slides?${qs(good)}`, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { "Content-Type": "image/png" })).status === 415, "SVG refused");
    ok((await call(admin.j, "POST", `/api/admin/slides?${qs(good)}`, Buffer.from("GIF89a" + "x".repeat(60)), { "Content-Type": "image/gif" })).status === 415, "GIF refused");
    const big = await call(admin.j, "POST", `/api/admin/slides?${qs(good)}`, Buffer.concat([png(1), Buffer.alloc(5 * 1024 * 1024)]), { "Content-Type": "image/png" });
    ok(big.status === 413, "photo over 4 MB refused");
    const seededPublic = fs.readdirSync(path.join(dir, "uploads", "public"));
    const { DatabaseSync } = require("node:sqlite");
    const seedDb = new DatabaseSync(path.join(dir, "t.db"));
    const seedRefs = new Set(seedDb.prepare("SELECT logo_file AS f FROM restaurants WHERE logo_file != '' UNION SELECT cover_file FROM restaurants WHERE cover_file != '' UNION SELECT image_file FROM menu_items WHERE image_file != ''").all().map(x => x.f));
    seedDb.close();
    ok(seededPublic.every(f => seedRefs.has(f)), "refused photos left no new files behind (preloaded PagudFood assets are retained)");

    /* upload, publish, order, hide, delete */
    const s1 = await up(admin.j, { caption: "Grilled tuna" }, png(1)), s2 = await up(admin.j, { alt: "Kinilaw served in a coconut shell", credit: "Own photo, ISLA-PLATEU team", license: "Owned by the project team", caption: "", restaurantId: "alpha-grill" }, png(2)), s3 = await up(admin.j, { set: "landing", title: "PagudFood feature", restaurantId: "pagudfood", alt: "A restaurant exterior with a sign", credit: "Photo by Juan Cruz, CC BY 4.0", license: "CC BY 4.0", source: "https://example.com/photo/1" }, png(3));
    ok(s1.status === 201 && s2.status === 201 && s3.status === 201, "three photos uploaded with credit, licence and confirmation");
    const m1 = await pub("map");
    ok(m1.slides.length === 2 && m1.slides[0].credit === "Photo by Maria Santos" && m1.slides[0].license === "Permission from Alpha Grill, 2026-11-10" && m1.slides[1].restaurantName === "Alpha Grill" && /^\/uploads\/public\/[a-f0-9]{32}\.png$/.test(m1.slides[0].url), "the public slideshow carries each photo's credit, licence and linked restaurant");
    const img = await fetch(BASE + m1.slides[0].url);
    ok(img.status === 200 && img.headers.get("content-type") === "image/png", "the photo is served publicly as an image");
    ok(!JSON.stringify(m1).includes("permission_confirmed") && !JSON.stringify(m1).includes("admin@"), "the public data holds no admin-only details");
    const l1 = await pub("landing");
    ok(l1.slides.length === 6 && l1.slides[5].id === s3.data.id && l1.slides[5].sourceUrl === "https://example.com/photo/1" &&
      l1.slides[0].restaurantId === "pagudfood" && l1.slides[0].title,
    "uploaded landing photos follow the five seeded restaurant placeholders and expose slide details");
    const replaceId = l1.slides[0].id;
    ok((await call(admin.j, "POST", `/api/admin/slides/${replaceId}/image?${qs({ alt: "Authorized PagudFood restaurant photo", credit: "Photo by project team", license: "Written permission from PagudFood", confirm: "0" })}`, png(4), { "Content-Type": "image/png" })).status === 400,
      "replacing a placeholder photo requires explicit permission confirmation");
    const replacement = await call(admin.j, "POST", `/api/admin/slides/${replaceId}/image?${qs({ alt: "Authorized PagudFood restaurant photo", credit: "Photo by project team", license: "Written permission from PagudFood", confirm: "1" })}`, png(4), { "Content-Type": "image/png" });
    ok(replacement.status === 200 && !(await pub("landing")).slides[0].isPlaceholder && (await pub("landing")).slides[0].url === replacement.data.url,
      "an authorized upload replaces the placeholder photo without changing its restaurant slide");
    ok((await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { active: false })).status === 200 && (await pub("map")).slides.length === 1, "hiding a photo removes it from the public slideshow");
    ok((await adm()).map.find(s => s.id === s1.data.id).active === false, "…but the admin still sees it");
    await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { active: true });
    ok((await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { credit: "" })).status === 400 && (await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { license: "" })).status === 400, "credit and licence cannot be blanked afterwards");
    ok((await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { caption: "Fresh grilled tuna", sourceUrl: "ftp://x" })).status === 400 && (await call(admin.j, "PATCH", `/api/admin/slides/${s1.data.id}`, { caption: "Fresh grilled tuna" })).status === 200 && (await pub("map")).slides[0].caption === "Fresh grilled tuna", "captions can be edited, bad links cannot");
    ok((await call(admin.j, "PATCH", "/api/admin/slides/99999", {})).status === 404, "unknown photo = 404");
    ok((await call(admin.j, "POST", `/api/admin/slides/${s1.data.id}/move`, { direction: "down" })).status === 200 && (await pub("map")).slides[0].alt === "Kinilaw served in a coconut shell", "a photo can be moved down");
    ok((await call(admin.j, "POST", `/api/admin/slides/${s1.data.id}/move`, { direction: "up" })).status === 200 && (await pub("map")).slides[0].alt === "Grilled tuna on a banana leaf", "…and back up");
    ok((await call(admin.j, "POST", `/api/admin/slides/${s1.data.id}/move`, { direction: "sideways" })).status === 400, "invalid direction refused");
    ok((await call(admin.j, "POST", `/api/admin/slides/${s1.data.id}/move`, { direction: "up" })).status === 200, "moving the first photo up is harmless");

    /* a restaurant being deleted does not remove the photo, only the link */
    ok((await call(admin.j, "DELETE", "/api/admin/restaurants/alpha-grill", { confirmName: "Alpha Grill" })).status === 200 && (await pub("map")).slides.length === 2 && (await pub("map")).slides[1].restaurantName === null, "deleting a linked restaurant keeps the photo and just unlinks it");

    const before = fs.readdirSync(path.join(dir, "uploads", "public")).length;
    ok((await call(admin.j, "DELETE", `/api/admin/slides/${s2.data.id}`, {})).status === 200 && fs.readdirSync(path.join(dir, "uploads", "public")).length === before - 1 && (await pub("map")).slides.length === 1, "deleting a photo removes its row and its file");

    /* cap */
    let last; for (let i = 0; i < 20; i++) last = await up(admin.j, { alt: "Sample photo " + i, set: "map" }, png(10 + i));
    ok(last.status === 409, "a slideshow holds at most 20 photos");

    /* audit */
    const logs = JSON.stringify((await call(admin.j, "GET", "/api/admin/audit-logs?limit=300")).data);
    ok(["slide.created", "slide.updated", "slide.deleted"].every(a => logs.includes(a)) && /permissionConfirmed/.test(logs) && /Permission from Alpha Grill/.test(logs), "uploads, edits and deletions are audited, including the licence and the permission confirmation");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  const stopped = new Promise(resolve => proc.once("exit", resolve));
  proc.kill("SIGKILL");
  await stopped;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
