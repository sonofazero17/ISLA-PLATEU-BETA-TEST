/* Phase 3: location requests, private verification documents, admin approval and audit log. Self-contained.   Run:  node tests/location-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3933, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-loc-"));
const ADMIN_PW = "Location-Test-2026";
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

const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 65)]);
const upload = (j, id, kind, buf, name = "file") => call(j, "POST", `/api/staff/location-requests/${id}/documents?kind=${kind}&name=${name}`, buf, { "Content-Type": "application/octet-stream" });
const GOOD = { lat: 9.2, lng: 123.52, address: "Poblacion, Larena, Siquijor", contactPhone: "0917 123 4567", businessContact: "owner@example.com" };

(async () => {
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  try {
    const login = async (portal, email, password) => { const j = jar(); const r = await call(j, "POST", "/api/login", { portal, email, password }); return { j, r }; };
    const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", ADMIN_PW);
    ok(admin.r.status === 200, "admin login");
    await call(admin.j, "POST", "/api/admin/restaurants", { name: "Alpha Grill", municipality: "Larena", category: "Restaurant", address: "Larena" });
    await call(admin.j, "POST", "/api/admin/restaurants", { name: "Beta Cafe", municipality: "Lazi", category: "Cafe", address: "Lazi" });
    const sa = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff Alpha", email: "alpha@example.com", restaurantId: "alpha-grill" });
    const sb = await call(admin.j, "POST", "/api/admin/staff", { fullName: "Staff Beta", email: "beta@example.com", restaurantId: "beta-cafe" });
    const A = await login("RESTAURANT_STAFF", "alpha@example.com", sa.data.temporaryPassword);
    const B = await login("RESTAURANT_STAFF", "beta@example.com", sb.data.temporaryPassword);
    await call(jar(), "POST", "/api/register", { fullName: "Cara Customer", email: "cara@example.com", password: "Island2026", confirmPassword: "Island2026" });
    const C = (await login("CUSTOMER", "cara@example.com", "Island2026")).j, anon = jar();
    const pubA = async () => (await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "alpha-grill");

    /* validation */
    ok((await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, lat: 14.5, lng: 121 })).status === 400, "pin outside Siquijor rejected");
    ok((await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, lat: undefined, lng: undefined })).status === 400, "request without a pin rejected");
    ok((await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, contactPhone: "abc" })).status === 400, "invalid contact number rejected");
    ok((await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, address: "" })).status === 400, "address is required");
    ok((await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, address: "<script>x</script>" })).status === 400, "markup in address rejected");
    ok((await call(anon, "POST", "/api/staff/location-requests", GOOD)).status === 401, "guest cannot request a location");
    ok((await call(C, "POST", "/api/staff/location-requests", GOOD)).status === 403, "customer cannot request a location");

    const mk = await call(A.j, "POST", "/api/staff/location-requests", GOOD);
    ok(mk.status === 201 && mk.data.status === "DRAFT", "staff creates a draft location request");
    const id = mk.data.id;
    ok((await call(A.j, "POST", "/api/staff/location-requests", GOOD)).status === 409, "only one open request at a time");
    const sub0 = await call(A.j, "POST", `/api/staff/location-requests/${id}/submit`, {});
    ok(sub0.status === 400 && /permit/i.test(sub0.data.error), "cannot submit without evidence");

    /* documents */
    ok((await upload(A.j, id, "BOGUS", img.jpg)).status === 400, "unknown document kind rejected");
    ok((await upload(A.j, id, "STOREFRONT_PHOTO", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).status === 415, "SVG evidence rejected");
    ok((await upload(A.j, id, "STOREFRONT_PHOTO", Buffer.from("MZ" + "x".repeat(200)))).status === 415, "executable evidence rejected");
    const big = await upload(A.j, id, "OTHER", Buffer.concat([pdf, Buffer.alloc(9 * 1024 * 1024)]));
    ok(big.status === 413, "document over 8 MB rejected");
    ok((await upload(B.j, id, "OTHER", img.jpg)).status === 404, "other restaurant's staff cannot add documents to this request");
    ok((await upload(C, id, "OTHER", img.jpg)).status === 403, "customer cannot add documents");
    const d1 = await upload(A.j, id, "STOREFRONT_PHOTO", img.jpg, "front.jpg");
    ok(d1.status === 201, "storefront photo uploaded");
    ok((await call(A.j, "POST", `/api/staff/location-requests/${id}/submit`, {})).status === 400, "still incomplete without registration and authorization");
    const d2 = await upload(A.j, id, "MAYORS_PERMIT", pdf, "permit.pdf");
    const d3 = await upload(A.j, id, "AUTHORIZATION", img.png, "letter.png");
    ok(d2.status === 201 && d3.status === 201, "permit (PDF) and authorization letter uploaded");

    /* documents are private */
    const own = await fetch(BASE + `/api/staff/location-documents/${d1.data.id}/file`, { headers: { Cookie: A.j.get() } });
    ok(own.status === 200 && own.headers.get("content-type") === "image/jpeg" && /no-store/.test(own.headers.get("cache-control")), "owner staff can view their document (private, no-store)");
    ok((await fetch(BASE + `/api/staff/location-documents/${d1.data.id}/file`, { headers: { Cookie: B.j.get() } })).status === 404, "other restaurant's staff cannot read it");
    ok((await fetch(BASE + `/api/staff/location-documents/${d1.data.id}/file`, { headers: { Cookie: C.get() } })).status === 403, "customer cannot read it");
    ok((await fetch(BASE + `/api/staff/location-documents/${d1.data.id}/file`)).status === 401, "guest cannot read it");
    ok((await fetch(BASE + `/api/admin/location-documents/${d1.data.id}/file`, { headers: { Cookie: A.j.get() } })).status === 403, "staff cannot use the admin document route");
    const priv = fs.readdirSync(path.join(dir, "uploads", "private"));
    ok(priv.length === 8, "three submitted private documents plus the PagudFood, Cafe Infinite, Luca Loko, Dagsa and LA Candura demo payment placeholders are stored");
    for (const f of priv) ok((await fetch(BASE + `/uploads/private/${f}`)).status === 404 && (await fetch(BASE + `/uploads/public/${f}`)).status === 404, `private file ${f.slice(0, 6)}… is not reachable by URL`);
    const pubFiles = fs.readdirSync(path.join(dir, "uploads", "public"));
    const { DatabaseSync } = require("node:sqlite");
    const seedDb = new DatabaseSync(path.join(dir, "t.db"));
    const publicRefs = new Set(seedDb.prepare("SELECT logo_file AS f FROM restaurants WHERE logo_file != '' UNION SELECT cover_file FROM restaurants WHERE cover_file != '' UNION SELECT image_file FROM menu_items WHERE image_file != ''").all().map(x => x.f));
    seedDb.close();
    ok(pubFiles.length > 0 && pubFiles.every(f => publicRefs.has(f)), "only referenced preloaded restaurant public images are present; no private documents leaked");

    /* staff cannot publish coordinates directly */
    await call(A.j, "PATCH", "/api/staff/restaurant", { lat: 9.2, lng: 123.5, address: "Hacked", description: "ok" });
    const before = await pubA();
    ok(before.lat === null && before.lng === null, "staff PATCH cannot set public coordinates");
    ok((await call(A.j, "PUT", "/api/admin/restaurants/alpha-grill", { lat: 9.2, lng: 123.5 })).status === 403, "staff cannot use the admin restaurant route");

    /* submit */
    const sub = await call(A.j, "POST", `/api/staff/location-requests/${id}/submit`, {});
    ok(sub.status === 200 && sub.data.status === "PENDING", "complete request submitted -> Pending");
    ok((await pubA()).lat === null, "pending request does NOT put the restaurant on the public map");
    ok((await call(A.j, "PATCH", `/api/staff/location-requests/${id}`, { address: "Changed after submit" })).status === 409, "cannot edit a submitted request");
    ok((await upload(A.j, id, "OTHER", img.jpg)).status === 409, "cannot add documents to a submitted request");
    ok((await call(A.j, "DELETE", `/api/staff/location-documents/${d1.data.id}`, {})).status === 409, "cannot remove documents from a submitted request");
    ok((await call(A.j, "POST", `/api/staff/location-requests/${id}/submit`, {})).status === 409, "cannot submit twice");
    ok((await call(B.j, "POST", `/api/staff/location-requests/${id}/submit`, {})).status === 404, "other restaurant's staff cannot touch the request");

    /* admin review */
    ok((await call(C, "GET", "/api/admin/location-requests")).status === 403 && (await call(A.j, "GET", "/api/admin/location-requests")).status === 403 && (await call(anon, "GET", "/api/admin/location-requests")).status === 401, "only admins can list location requests");
    const list = await call(admin.j, "GET", "/api/admin/location-requests");
    ok(list.status === 200 && list.data.some(q => q.id === id && q.status === "PENDING" && q.documentCount === 3 && q.restaurantName === "Alpha Grill"), "admin sees the pending request with document count");
    const det = await call(admin.j, "GET", `/api/admin/location-requests/${id}`);
    ok(det.status === 200 && det.data.documents.length === 3 && det.data.request.lat === 9.2 && det.data.restaurant.name === "Alpha Grill" && det.data.submitter.email === "alpha@example.com", "admin sees pin, address, profile, submitter and documents");
    const adoc = await fetch(BASE + `/api/admin/location-documents/${d2.data.id}/file`, { headers: { Cookie: admin.j.get() } });
    ok(adoc.status === 200 && adoc.headers.get("content-type") === "application/pdf" && /attachment/.test(adoc.headers.get("content-disposition")), "admin can open a document (PDFs download, never render inline)");
    ok((await call(A.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "APPROVED" })).status === 403, "staff cannot approve their own request");
    ok((await call(C, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "APPROVED" })).status === 403, "customer cannot approve");
    ok((await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "NEEDS_EVIDENCE" })).status === 400, "asking for evidence needs a message");
    ok((await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "REJECTED", note: "" })).status === 400, "rejecting needs a reason");
    ok((await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "BANANA" })).status === 409, "invalid decision rejected");
    ok((await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "UNDER_REVIEW" })).status === 200, "admin marks it Under Review");
    const ne = await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "NEEDS_EVIDENCE", note: "Please add an interior photo." });
    ok(ne.status === 200, "admin requests additional evidence");
    const st = await call(A.j, "GET", "/api/staff/location-request");
    ok(st.data.request.status === "NEEDS_EVIDENCE" && st.data.request.reviewNote === "Please add an interior photo." && st.data.request.canEdit === true, "staff sees the status, the admin's message and can edit");
    const notes = JSON.stringify((await call(A.j, "GET", "/api/notifications")).data);
    ok(/needs more evidence/.test(notes) && /interior photo/i.test(notes), "staff was notified of the evidence request");
    ok((await upload(A.j, id, "INTERIOR_PHOTO", img.webp, "inside.webp")).status === 201, "staff adds the extra evidence");
    ok((await call(A.j, "PATCH", `/api/staff/location-requests/${id}`, { lat: 9.205, lng: 123.521, address: "Poblacion, Larena (corrected)" })).status === 200, "staff corrects the pin and address");
    ok((await call(A.j, "POST", `/api/staff/location-requests/${id}/submit`, {})).data.status === "PENDING", "resubmitted -> Pending again");
    ok((await pubA()).lat === null, "still not public after resubmission");
    const ap = await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "APPROVED", note: "Verified" });
    ok(ap.status === 200 && ap.data.status === "APPROVED", "admin approves the request");
    const after = await pubA();
    ok(after.lat === 9.205 && after.lng === 123.521 && after.locationStatus === "verified" && after.address === "Poblacion, Larena (corrected)", "approved pin and address are now public and marked verified");
    ok((await call(admin.j, "POST", `/api/admin/location-requests/${id}/decision`, { decision: "REJECTED", note: "late" })).status === 409, "an approved request cannot be flipped");
    ok(/approved/.test(JSON.stringify((await call(A.j, "GET", "/api/notifications")).data)), "staff notified of approval");
    const d4 = await call(admin.j, "GET", `/api/admin/location-requests/${id}`);
    ok(d4.data.history.some(h => h.action === "location_request.approved") && d4.data.history.some(h => h.action === "location_request.needs_evidence"), "request history records who decided what");
    const logs = await call(admin.j, "GET", "/api/admin/audit-logs");
    ok(logs.status === 200 && logs.data.some(l => l.action === "location_request.approved" && l.actor.length > 0) && logs.data.some(l => l.action === "location_request.submitted") && logs.data.some(l => l.action === "location_document.viewed"), "audit log records submission, document views and the approval");
    ok(logs.data.find(l => l.action === "location_request.approved").detail.includes("9.205"), "audit entry keeps the approved coordinates");
    ok((await call(A.j, "GET", "/api/admin/audit-logs")).status === 403 && (await call(C, "GET", "/api/admin/audit-logs")).status === 403, "staff and customers cannot read the audit log");

    /* relocation after approval needs a fresh approval */
    const again = await call(A.j, "GET", "/api/staff/location-request");
    ok(again.data.canStartNew === true, "after approval staff may request a new location");
    const mk2 = await call(A.j, "POST", "/api/staff/location-requests", { ...GOOD, lat: 9.15, lng: 123.55 });
    ok(mk2.status === 201 && (await pubA()).lat === 9.205, "a relocation request does not move the live pin until approved");

    /* rejection flow */
    const mkB = await call(B.j, "POST", "/api/staff/location-requests", GOOD);
    for (const [k, b] of [["DTI_SEC", img.png], ["STOREFRONT_PHOTO", img.jpg], ["AUTHORIZATION", pdf]]) await upload(B.j, mkB.data.id, k, b);
    await call(B.j, "POST", `/api/staff/location-requests/${mkB.data.id}/submit`, {});
    const rj = await call(admin.j, "POST", `/api/admin/location-requests/${mkB.data.id}/decision`, { decision: "REJECTED", note: "Pin is not at the restaurant." });
    ok(rj.status === 200, "admin rejects with a reason");
    ok((await call(B.j, "GET", "/api/staff/location-request")).data.request.reviewNote === "Pin is not at the restaurant.", "staff sees the rejection reason");
    ok((await call(B.j, "PATCH", `/api/staff/location-requests/${mkB.data.id}`, { lat: 9.18, lng: 123.6 })).status === 200 && (await call(B.j, "POST", `/api/staff/location-requests/${mkB.data.id}/submit`, {})).status === 200, "rejected applicant submits corrected details");
    ok((await call(admin.j, "GET", "/api/admin/location-requests?status=open")).data.some(q => q.id === mkB.data.id && q.status === "PENDING"), "corrected request is back in the admin queue");
    ok((await pubA()), "public list still works");
    ok((await call(anon, "GET", "/api/restaurants")).data.find(r => r.id === "beta-cafe").lat === null, "rejected/pending restaurant has no public pin");

    /* deleting a restaurant removes its private files */
    const del = await call(admin.j, "DELETE", "/api/admin/restaurants/beta-cafe", { confirmName: "Beta Cafe" });
    ok(del.status === 200 && fs.readdirSync(path.join(dir, "uploads", "private")).length === priv.length + 1, "deleting a restaurant removes its private documents");
    ok((await call(admin.j, "GET", "/api/admin/audit-logs")).data.some(l => l.action === "restaurant.deleted"), "restaurant deletion is audited");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  proc.kill("SIGKILL");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
