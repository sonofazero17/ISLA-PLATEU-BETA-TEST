/* Login-portal, registration and staff-approval tests. Self-contained: starts its own server on a temporary
   database, restarts it to prove persistence, and stops it again.   Run:  node tests/applications-test.js */
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3911, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-app-"));
let pass = 0, fail = 0, proc = null, adminPw = null;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function start(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, "t.db"), APPLY_LIMIT_PER_HOUR: "100", ...extraEnv } });
    let out = "";
    proc.stdout.on("data", d => { out += d; const m = /Password: (\S+)/.exec(out); if (m && !adminPw) adminPw = m[1]; if (/running at/.test(out)) resolve(); });
    proc.on("error", reject); setTimeout(() => reject(new Error("server did not start")), 8000);
  });
}
const stop = async () => { proc.kill("SIGKILL"); await sleep(300); };
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; }, raw: () => c }; };
async function call(j, method, p, body) {
  const res = await fetch(BASE + p, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie"); j.set(setCookie);
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, setCookie, location: res.headers.get("location") };
}
const login = (portal, email, password, j = jar()) => call(j, "POST", "/api/login", { portal, email, password }).then(r => ({ ...r, j }));
const PW = "Island2026";
const appBody = (o = {}) => ({ fullName: "Maria Santos", email: "maria@example.com", contactNumber: "0917 555 1234", password: PW, confirmPassword: PW,
  restaurantMode: "existing", restaurantId: "la-candura", position: "Manager", permitNumber: "BP-2026-0042", note: "", ...o });
const newRest = (o = {}) => appBody({ restaurantMode: "new", restaurantId: undefined, restaurantName: "Sunset Grill", restaurantContact: "(035) 480 1234", restaurantAddress: "Beach road near the pier",
  municipality: "Larena", barangay: "Poblacion", category: "Restaurant", description: "Grilled seafood by the sea.", ...o });

(async () => {
  await start();
  const anon = jar();
  /* ---------- customer registration ---------- */
  const reg = await call(anon, "POST", "/api/register", { fullName: "Ana Reyes", email: "ana@example.com", password: PW, confirmPassword: PW, role: "RESTAURANT_STAFF", restaurantId: "la-candura", status: "ACTIVE" });
  ok(reg.status === 201, "customer registration succeeds");
  const admin = await login("ADMINISTRATOR", "admin@islaplateu.local", adminPw);
  ok(admin.status === 200 && admin.data.redirect === "/admin", "administrator login through the Admin form");
  let users = (await call(admin.j, "GET", "/api/admin/users")).data.users;
  const ana = users.find(u => u.email === "ana@example.com");
  ok(ana.role === "CUSTOMER" && ana.status === "ACTIVE" && !ana.restaurantId, "customer registration ignores role / restaurant / status sent by the browser (creates a plain customer)");
  ok(!(await call(anon, "POST", "/api/register", { fullName: "Bo", email: "bo@example.com", password: PW, confirmPassword: PW, restaurantMode: "new" })).data.fields, "customer registration does not accept staff application fields");

  /* ---------- the three login forms are separate flows ---------- */
  const custOk = await login("CUSTOMER", "ana@example.com", PW);
  ok(custOk.status === 200 && custOk.data.user.role === "CUSTOMER" && custOk.data.redirect === "/map", "customer logs in through the Customer form");
  for (const portal of ["RESTAURANT_STAFF", "ADMINISTRATOR"]) {
    const r = await login(portal, "ana@example.com", PW);
    ok(r.status === 403 && r.data.code === "WRONG_PORTAL" && !r.setCookie, `customer credentials are NOT accepted by the ${portal} form (403, no session cookie)`);
  }
  for (const portal of ["CUSTOMER", "RESTAURANT_STAFF"]) {
    const r = await login(portal, "admin@islaplateu.local", adminPw);
    ok(r.status === 403 && r.data.code === "WRONG_PORTAL" && !r.setCookie, `administrator credentials are NOT accepted by the ${portal} form`);
  }
  ok((await login("CUSTOMER", "ana@example.com", "WrongPass1")).status === 401 && (await login("ADMINISTRATOR", "ana@example.com", "WrongPass1")).status === 401, "wrong password gives the same 401 on every form (no role information leaks)");
  ok((await call(jar(), "POST", "/api/login", { email: "ana@example.com", password: PW })).status === 400, "login without a form type is refused");
  ok((await call(jar(), "POST", "/api/login", { portal: "SUPERUSER", email: "ana@example.com", password: PW })).status === 400, "unknown form type is refused");
  const probe = jar(); await login("RESTAURANT_STAFF", "ana@example.com", PW, probe);
  ok((await call(probe, "GET", "/api/admin/stats")).status === 401 && (await call(probe, "GET", "/staff")).location === "/login", "after a refused cross-form login there is no access to protected pages or APIs");
  // session rotation: logging in again destroys the session the browser already held
  const held = jar(); await login("CUSTOMER", "ana@example.com", PW, held); const oldCookie = held.raw();
  await login("ADMINISTRATOR", "admin@islaplateu.local", adminPw, held);
  const stale = jar(); stale.set(`isla_sid=${oldCookie.split("=")[1]}`);
  ok((await call(stale, "GET", "/api/me")).status === 401, "a new login replaces the previous session (old session token stops working)");

  /* ---------- staff application: validation ---------- */
  const empty = await call(jar(), "POST", "/api/staff-applications", {});
  ok(empty.status === 400 && ["fullName", "email", "contactNumber", "password", "position", "permitNumber", "restaurantMode"].every(k => empty.data.fields[k]), "empty application: every required field reports a message");
  const cases = [
    ["invalid email", appBody({ email: "nope" }), "email"], ["letters in phone", appBody({ contactNumber: "call me" }), "contactNumber"],
    ["too-short phone", appBody({ contactNumber: "12345" }), "contactNumber"], ["bad mobile format", appBody({ contactNumber: "0917 123" }), "contactNumber"],
    ["weak password", appBody({ password: "abcdefgh", confirmPassword: "abcdefgh" }), "password"], ["mismatched passwords", appBody({ confirmPassword: "Other2026" }), "confirmPassword"],
    ["unknown position", appBody({ position: "CEO" }), "position"], ["missing permit", appBody({ permitNumber: "" }), "permitNumber"],
    ["existing restaurant not chosen", appBody({ restaurantId: "" }), "restaurantId"], ["nonexistent restaurant", appBody({ restaurantId: "ghost" }), "restaurantId"],
    ["new: municipality outside Siquijor", newRest({ municipality: "Cebu City" }), "municipality"], ["new: short description", newRest({ description: "Hi" }), "description"],
    ["new: bad restaurant phone", newRest({ restaurantContact: "abc" }), "restaurantContact"], ["new: missing barangay", newRest({ barangay: "" }), "barangay"],
    ["markup in name", appBody({ fullName: "<b>x</b>" }), "fullName"]
  ];
  for (const [name, body, field] of cases) { const r = await call(jar(), "POST", "/api/staff-applications", body); ok(r.status === 400 && r.data.fields && r.data.fields[field], `validation: ${name}`); }
  ok((await call(jar(), "POST", "/api/staff-applications", appBody({ email: "ana@example.com" }))).status === 409, "email already used by a customer cannot apply (duplicate)");

  /* ---------- staff application: submit ---------- */
  const a1 = await call(jar(), "POST", "/api/staff-applications", appBody());
  ok(a1.status === 201 && a1.data.status === "pending" && /pending|review/i.test(a1.data.message), "staff application is saved as pending with a clear message");
  ok((await call(jar(), "POST", "/api/staff-applications", appBody())).status === 409, "the same applicant cannot apply twice (duplicate email)");
  const a2 = await call(jar(), "POST", "/api/staff-applications", newRest({ fullName: "Carlo Reyes", email: "carlo@example.com" }));
  ok(a2.status === 201, "application to register a NEW restaurant is accepted as pending");
  const dup = await call(jar(), "POST", "/api/staff-applications", newRest({ fullName: "Dee", email: "dee@example.com", restaurantName: "  sunset   GRILL " }));
  ok(dup.status === 400 && dup.data.fields.restaurantName, "second pending application for the same new restaurant name is refused");
  const clash = await call(jar(), "POST", "/api/staff-applications", newRest({ fullName: "Eli", email: "eli@example.com", restaurantName: "la candura" }));
  ok(clash.status === 400 && /already in ISLA-PLATEU/.test(clash.data.fields.restaurantName), "new restaurant with the name of an existing one is refused (choose it from the list)");
  const inj = await call(jar(), "POST", "/api/staff-applications", newRest({ fullName: "Ivy Tan", email: "ivy@example.com", restaurantName: "Bob'); DROP TABLE users;--" }));
  ok(inj.status === 201 && (await call(admin.j, "GET", "/api/admin/users")).status === 200, "SQL-injection text is stored as plain text; the database is unharmed (parameterized queries)");
  ok((await call(jar(), "POST", "/api/staff-applications", appBody({ email: "x' OR '1'='1" }))).status === 400, "injection-style email is rejected by validation");

  /* ---------- pending applicants have no access ---------- */
  const pend = await login("RESTAURANT_STAFF", "maria@example.com", PW);
  ok(pend.status === 403 && pend.data.code === "APPLICATION_PENDING" && /waiting for administrator review/.test(pend.data.error) && !pend.setCookie, "pending applicant sees the pending message and gets no session");
  ok((await login("CUSTOMER", "maria@example.com", PW)).data.code === "WRONG_PORTAL", "pending applicant cannot log in through the Customer form either");
  ok((await call(jar(), "GET", "/api/staff/restaurant")).status === 401 && (await call(jar(), "GET", "/staff")).location === "/login", "no staff functionality without a session");

  /* ---------- admin view + authorization ---------- */
  const list = await call(admin.j, "GET", "/api/admin/applications?status=pending");
  const apps = list.data.applications, mariaApp = apps.find(a => a.applicantEmail === "maria@example.com"), carloApp = apps.find(a => a.applicantEmail === "carlo@example.com"), ivyApp = apps.find(a => a.applicantEmail === "ivy@example.com");
  ok(list.status === 200 && list.data.counts.pending === 3 && apps.length === 3, "admin sees the 3 pending applications");
  ok(mariaApp.contactNumber === "0917 555 1234" && mariaApp.position === "Manager" && mariaApp.permitNumber === "BP-2026-0042" && mariaApp.restaurantId === "la-candura" && mariaApp.isNewRestaurant === false, "application shows applicant name, contact number, position, permit and the requested restaurant");
  ok(carloApp.isNewRestaurant && carloApp.restaurantName === "Sunset Grill" && carloApp.municipality === "Larena" && carloApp.barangay === "Poblacion" && carloApp.status === "pending", "new-restaurant application shows restaurant name, location and status");
  ok(!JSON.stringify(list.data).includes("scrypt"), "application list never exposes password hashes");
  const custSess = custOk.j;
  for (const [who, j, expected] of [["anonymous", jar(), 401], ["customer", custSess, 403]]) {
    ok((await call(j, "GET", "/api/admin/applications")).status === expected, `${who} cannot list applications (${expected})`);
    ok((await call(j, "POST", `/api/admin/applications/${mariaApp.id}/approve`, { confirm: true })).status === expected, `${who} cannot approve (${expected})`);
    ok((await call(j, "POST", `/api/admin/applications/${mariaApp.id}/reject`, { confirm: true, note: "no reason" })).status === expected, `${who} cannot reject (${expected})`);
  }
  ok((await call(custSess, "PATCH", `/api/admin/users/${users.find(u => u.email === "ana@example.com").id}`, { status: "DISABLED" })).status === 403, "customer cannot change account statuses");
  ok((await call(admin.j, "POST", `/api/admin/applications/${mariaApp.id}/approve`, {})).status === 400, "approval without confirmation is refused");
  const mid = (await call(admin.j, "GET", "/api/admin/users")).data.users.find(u => u.email === "maria@example.com");
  ok((await call(admin.j, "PATCH", `/api/admin/users/${mid.id}`, { status: "ACTIVE" })).status === 409, "admin cannot bypass the review by simply enabling an applicant account");

  /* ---------- approval ---------- */
  const [ap1, ap2] = await Promise.all([1, 2].map(() => call(admin.j, "POST", `/api/admin/applications/${mariaApp.id}/approve`, { confirm: true })));
  ok([ap1.status, ap2.status].sort().join() === "200,409", "two simultaneous approvals: exactly one succeeds, the other is refused (no double processing)");
  ok((await call(admin.j, "POST", `/api/admin/applications/${mariaApp.id}/approve`, { confirm: true })).status === 409, "repeating an approval is refused safely");
  ok((await call(admin.j, "POST", `/api/admin/applications/${mariaApp.id}/reject`, { confirm: true, note: "changed my mind" })).status === 409, "an approved application cannot be rejected afterwards");
  const maria = await login("RESTAURANT_STAFF", "maria@example.com", PW);
  ok(maria.status === 200 && maria.data.redirect === "/staff", "approved applicant logs in through the Staff form and lands on /staff");
  ok((await call(maria.j, "GET", "/api/staff/restaurant")).data.restaurant.id === "la-candura", "approved staff is attached to the requested restaurant");
  ok((await call(maria.j, "GET", "/admin")).status === 403 && (await call(maria.j, "GET", "/api/admin/applications")).status === 403, "approved staff still cannot reach admin pages or application APIs");
  ok((await call(maria.j, "POST", `/api/admin/applications/${carloApp.id}/approve`, { confirm: true })).status === 403, "staff cannot approve another application");
  const carlo = await call(admin.j, "POST", `/api/admin/applications/${carloApp.id}/approve`, { confirm: true });
  ok(carlo.status === 200 && carlo.data.restaurantId === "sunset-grill", "approving a new-restaurant application creates the restaurant");
  const pub = (await call(jar(), "GET", "/api/restaurants")).data.find(r => r.id === "sunset-grill");
  ok(pub && pub.municipality === "Larena" && /Brgy\. Poblacion/.test(pub.address) && pub.lat === null && pub.locationStatus === "address-only", "the new restaurant is listed with its address and NO invented map pin");
  const carloLogin = await login("RESTAURANT_STAFF", "carlo@example.com", PW);
  ok(carloLogin.status === 200 && (await call(carloLogin.j, "GET", "/api/staff/restaurant")).data.restaurant.id === "sunset-grill", "approved applicant is attached to the newly created restaurant");
  users = (await call(admin.j, "GET", "/api/admin/users")).data.users;
  ok(users.find(u => u.email === "carlo@example.com").restaurantName === "Sunset Grill" && users.find(u => u.email === "maria@example.com").restaurantName === "LA Candura", "admin account list shows which staff belongs to which restaurant");

  /* ---------- rejection ---------- */
  ok((await call(admin.j, "POST", `/api/admin/applications/${ivyApp.id}/reject`, { confirm: true })).status === 400, "rejection requires a reason");
  ok((await call(admin.j, "POST", `/api/admin/applications/${ivyApp.id}/reject`, { note: "Permit could not be verified" })).status === 400, "rejection requires confirmation");
  ok((await call(admin.j, "POST", `/api/admin/applications/${ivyApp.id}/reject`, { confirm: true, note: "Permit could not be verified" })).status === 200, "administrator rejects an application");
  ok((await call(admin.j, "POST", `/api/admin/applications/${ivyApp.id}/reject`, { confirm: true, note: "again again" })).status === 409, "repeating a rejection is refused safely");
  ok((await call(admin.j, "POST", `/api/admin/applications/${ivyApp.id}/approve`, { confirm: true })).status === 409, "a rejected application cannot be approved without reconsidering it first");
  const ivy = await login("RESTAURANT_STAFF", "ivy@example.com", PW);
  ok(ivy.status === 403 && ivy.data.code === "APPLICATION_REJECTED" && /Permit could not be verified/.test(ivy.data.error) && !ivy.setCookie, "rejected applicant sees the rejection (with the reason) and gets no session");
  const rejList = (await call(admin.j, "GET", "/api/admin/applications?status=rejected")).data;
  ok(rejList.applications.length === 1 && rejList.applications[0].reviewNote === "Permit could not be verified" && rejList.applications[0].reviewedBy === "System Administrator", "rejected record is kept for review with reviewer and reason");

  /* ---------- statuses survive a restart ---------- */
  await stop(); await start();
  const admin2 = await login("ADMINISTRATOR", "admin@islaplateu.local", adminPw);
  const all2 = (await call(admin2.j, "GET", "/api/admin/applications")).data;
  ok(all2.counts.approved === 2 && all2.counts.rejected === 1 && all2.counts.pending === 0, "application statuses are unchanged after restarting the server");
  ok((await login("RESTAURANT_STAFF", "maria@example.com", PW)).status === 200 && (await login("RESTAURANT_STAFF", "ivy@example.com", PW)).data.code === "APPLICATION_REJECTED", "approved staff can still log in and the rejected applicant is still refused after the restart");

  /* ---------- reconsider, then approve ---------- */
  const ivyApp2 = all2.applications.find(a => a.applicantEmail === "ivy@example.com");
  ok((await call(admin2.j, "POST", `/api/admin/applications/${ivyApp2.id}/reopen`, { confirm: true })).status === 200, "a rejected application can be reconsidered (back to pending)");
  ok((await login("RESTAURANT_STAFF", "ivy@example.com", PW)).data.code === "APPLICATION_PENDING", "reconsidered applicant sees the pending message again");
  ok((await call(admin2.j, "POST", `/api/admin/applications/${ivyApp2.id}/approve`, { confirm: true })).status === 200 && (await login("RESTAURANT_STAFF", "ivy@example.com", PW)).status === 200, "reconsidered application can then be approved");
  ok((await call(admin2.j, "POST", `/api/admin/applications/${mariaApp.id}/reopen`, { confirm: true })).status === 409, "an approved application cannot be reopened");

  /* ---------- password change signs out other devices ---------- */
  const dev1 = await login("CUSTOMER", "ana@example.com", PW), dev2 = await login("CUSTOMER", "ana@example.com", PW);
  ok((await call(dev1.j, "POST", "/api/me/password", { currentPassword: PW, newPassword: "NewIsland2027" })).status === 200, "customer changes their password");
  ok((await call(dev2.j, "GET", "/api/me")).status === 401 && (await call(dev1.j, "GET", "/api/me")).status === 200, "other signed-in devices are signed out after a password change; this one stays signed in");

  /* ---------- application rate limit ---------- */
  await stop(); await start({ APPLY_LIMIT_PER_HOUR: "2" });
  const r1 = await call(jar(), "POST", "/api/staff-applications", appBody({ email: "r1@example.com" })), r2 = await call(jar(), "POST", "/api/staff-applications", appBody({ email: "r2@example.com" })), r3 = await call(jar(), "POST", "/api/staff-applications", appBody({ email: "r3@example.com" }));
  ok(r1.status === 201 && r2.status === 201 && r3.status === 429, "application submissions are rate-limited per connection (3rd in an hour refused with the limit set to 2)");

  await stop();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); try { await stop(); } catch {} process.exit(1); });
