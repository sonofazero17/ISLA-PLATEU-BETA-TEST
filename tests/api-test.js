/* Integration test against a running server.  Usage: BASE=http://localhost:3111 ADMIN_PW=... STAFF_PW=... node tests/api-test.js */
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
function jar() { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; }
async function call(j, method, path, body, extra = {}) {
  const res = await fetch(BASE + path, { method, redirect: "manual",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined });
  j.set(res.headers.get("set-cookie"));
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, headers: res.headers, res };
}
(async () => {
  const anon = jar();
  ok((await call(anon, "GET", "/map")).status === 200, "public map is open to visitors");
  ok((await call(anon, "GET", "/account")).headers.get("location") === "/login", "anonymous /account redirects to login");
  ok((await call(anon, "GET", "/admin")).headers.get("location") === "/login", "anonymous /admin redirects to login");
  ok((await call(anon, "GET", "/api/restaurants")).status === 200, "restaurant list is public");
  ok((await call(anon, "GET", "/api/admin/users")).status === 401, "anonymous admin API = 401");
  for (const f of ["/server.js", "/create-user.js", "/data/islaplateu.db", "/data/restaurants.json", "/package.json", "/assets/../server.js", "/assets/%2e%2e/server.js"])
    ok([404, 400, 302].includes((await call(anon, "GET", f)).status) && !(await call(anon, "GET", f)).res.ok, "not served: " + f);

  // registration validation
  const bad = await call(anon, "POST", "/api/register", { fullName: "", email: "nope", password: "short", confirmPassword: "x" });
  ok(bad.status === 400 && bad.data.fields.fullName && bad.data.fields.email && bad.data.fields.password && bad.data.fields.confirmPassword, "invalid registration rejected with field messages");
  ok((await call(anon, "POST", "/api/register", { fullName: "A B", email: "a@b.co", password: "abcdefgh", confirmPassword: "abcdefgh" })).status === 400, "password without a number rejected");
  const email = `cust${Date.now()}@example.com`;
  const reg = await call(anon, "POST", "/api/register", { fullName: "Test Customer", email, password: "Island2026", confirmPassword: "Island2026", role: "ADMINISTRATOR" });
  ok(reg.status === 201, "customer registration succeeds");
  ok((await call(anon, "POST", "/api/register", { fullName: "Dup", email: email.toUpperCase(), password: "Island2026", confirmPassword: "Island2026" })).status === 409, "duplicate email (case-insensitive) rejected");
  ok((await call(anon, "POST", "/api/register", { fullName: "X", email: "x@y.zz" }, { "Content-Type": "text/plain" })).status === 415, "non-JSON content type rejected");
  ok((await call(anon, "POST", "/api/register", { fullName: "Evil", email: "evil@x.com", password: "Island2026", confirmPassword: "Island2026" }, { Origin: "http://evil.example" })).status === 403, "cross-origin POST blocked");

  // login
  const c = jar();
  ok((await call(c, "POST", "/api/login", { portal: "CUSTOMER", email, password: "wrongpass1" })).status === 401, "wrong password = 401");
  ok((await call(c, "POST", "/api/login", { portal: "CUSTOMER", email: "nobody@example.com", password: "Island2026" })).status === 401, "unknown email = 401 (same message)");
  ok((await call(c, "POST", "/api/login", { portal: "CUSTOMER", email: "", password: "" })).status === 400, "empty login fields = 400");
  const login = await call(c, "POST", "/api/login", { portal: "CUSTOMER", email, password: "Island2026" });
  ok(login.status === 200 && login.data.user.role === "CUSTOMER" && login.data.redirect === "/map", "customer login -> CUSTOMER, redirect /map (admin role in sign-up body ignored)");
  const sc = login.headers.get("set-cookie");
  ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), "session cookie is HttpOnly + SameSite");
  ok(!JSON.stringify(login.data).includes("password"), "login response contains no password data");
  ok((await call(c, "GET", "/map")).status === 200, "customer can open /map");
  ok((await call(c, "GET", "/api/restaurants")).data.length >= 5, "customer can load restaurants (>=5 entries)");
  ok((await call(c, "GET", "/admin")).status === 403, "customer blocked from /admin page (403)");
  ok((await call(c, "GET", "/account")).status === 200, "customer can open /account");
  ok((await call(c, "GET", "/staff")).status === 403, "customer blocked from /staff page (403)");
  ok((await call(c, "GET", "/api/admin/users")).status === 403, "customer blocked from admin API (403)");
  ok((await call(c, "GET", "/login")).headers.get("location") === "/map", "logged-in customer visiting /login is sent to /map");

  // admin
  if (process.env.ADMIN_PW) {
    const a = jar();
    const r = await call(a, "POST", "/api/login", { portal: "ADMINISTRATOR", email: "admin@islaplateu.local", password: process.env.ADMIN_PW });
    ok(r.status === 200 && r.data.redirect === "/admin", "admin login -> /admin");
    ok((await call(a, "GET", "/admin")).status === 200, "admin can open /admin");
    const users = await call(a, "GET", "/api/admin/users");
    ok(users.status === 200 && users.data.users.some(u => u.email === email && u.role === "CUSTOMER"), "admin API lists accounts; public sign-up stayed CUSTOMER");
    ok(!JSON.stringify(users.data).includes("scrypt"), "admin API never returns password hashes");
    ok((await call(a, "GET", "/staff")).status === 403, "admin blocked from /staff page");
  }
  // staff
  if (process.env.STAFF_PW) {
    const s = jar();
    const r = await call(s, "POST", "/api/login", { portal: "RESTAURANT_STAFF", email: "staff@islaplateu.local", password: process.env.STAFF_PW });
    ok(r.status === 200 && r.data.redirect === "/staff", "staff login -> /staff");
    ok((await call(s, "GET", "/staff")).status === 200, "staff can open /staff");
    ok((await call(s, "GET", "/admin")).status === 403, "staff blocked from /admin");
    ok((await call(s, "GET", "/api/admin/users")).status === 403, "staff blocked from admin API");
    ok((await call(s, "GET", "/map")).status === 200, "staff can open locator map");
  }
  // logout
  const out = await call(c, "POST", "/api/logout", {});
  ok(out.status === 200, "logout responds OK");
  const saved = (login.headers.get("set-cookie").match(/isla_sid=[^;]+/) || [""])[0];
  const stale = jar(); stale.set(saved);
  ok((await call(stale, "GET", "/api/me")).status === 401, "old session token is invalid after logout");
  ok((await call(c, "GET", "/account")).status === 302, "after logout /account redirects to login");

  // brute-force lockout
  const victim = `lock${Date.now()}@example.com`;
  await call(anon, "POST", "/api/register", { fullName: "Lock Test", email: victim, password: "Island2026", confirmPassword: "Island2026" });
  let last; for (let i = 0; i < 6; i++) last = await call(jar(), "POST", "/api/login", { portal: "CUSTOMER", email: victim, password: "badbadbad1" });
  ok(last.status === 429, "6th failed attempt is rate-limited (429)");
  ok((await call(jar(), "POST", "/api/login", { portal: "CUSTOMER", email: victim, password: "Island2026" })).status === 429, "correct password also locked during lockout window");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
