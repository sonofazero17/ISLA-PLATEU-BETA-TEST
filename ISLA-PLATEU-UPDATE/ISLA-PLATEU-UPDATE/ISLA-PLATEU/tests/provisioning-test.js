/* Administrator provisioning, production behaviour, backups and map headers.
   Self-contained: starts its own servers on temporary databases.   Run:  node tests/provisioning-test.js */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
const PORT = 3931, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-prov-"));
let pass = 0, fail = 0, cur = null;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT)/.test(k)));
function start(env = {}, dbFile = "t.db") {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, dbFile), ...env } });
    const s = { proc, out: "", code: null };
    proc.stdout.on("data", d => { s.out += d; if (/running at/.test(s.out)) resolve(s); });
    proc.stderr.on("data", d => { s.out += d; });
    proc.on("exit", c => { s.code = c; });
    cur = s; setTimeout(() => reject(new Error("server did not start: " + s.out)), 9000);
  });
}
const stop = async (s = cur) => { s.proc.kill("SIGKILL"); await sleep(300); };
const jar = () => { let c = ""; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ""); if (m) c = m[1] ? "isla_sid=" + m[1] : ""; } }; };
async function call(j, method, p, body, headers = {}) {
  const res = await fetch(BASE + p, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = res.headers.get("set-cookie"); j.set(sc);
  let data = null; const ct = res.headers.get("content-type") || ""; if (ct.includes("json")) { try { data = await res.json(); } catch {} }
  return { status: res.status, data, setCookie: sc, headers: res.headers, res };
}
const login = (portal, email, password, headers = {}, j = jar()) => call(j, "POST", "/api/login", { portal, email, password }, headers).then(r => ({ ...r, j }));
const ADMIN = "admin@islaplateu.local";

(async () => {
  /* ---------- 1. production with NO password configured ---------- */
  let s = await start({ NODE_ENV: "production" }, "a.db");
  ok(/No administrator exists and ADMIN_PASSWORD is not set/.test(s.out) && !/Password:/i.test(s.out), "production without ADMIN_PASSWORD: no admin is invented and no password is printed");
  ok((await login("ADMINISTRATOR", ADMIN, "anything123")).status === 401, "…and nobody can log in as administrator");
  const h = await call(jar(), "GET", "/healthz");
  ok(h.status === 200 && h.data.ok === true, "health check endpoint answers 200");
  ok(h.headers.get("strict-transport-security") && h.headers.get("referrer-policy") === "strict-origin-when-cross-origin", "production sends HSTS and a Referrer-Policy that keeps the site origin for tile requests");
  const reg = await call(jar(), "POST", "/api/register", { fullName: "Squatter", email: ADMIN, password: "Island2026", confirmPassword: "Island2026" });
  ok(reg.status === 400 && /reserved/.test(reg.data.fields.email), "the administrator address cannot be registered by the public (no squatting before the admin exists)");
  ok((await call(jar(), "POST", "/api/register", { fullName: "Other", email: "someone@islaplateu.local", password: "Island2026", confirmPassword: "Island2026" })).status === 400, "the whole @islaplateu.local domain is reserved for public sign-up");
  const sa = await call(jar(), "POST", "/api/staff-applications", { fullName: "Sam", email: ADMIN, contactNumber: "0917 555 1234", password: "Island2026", confirmPassword: "Island2026", restaurantMode: "existing", restaurantId: "la-candura", position: "Manager", permitNumber: "BP-1" });
  ok(sa.status === 400 && sa.data.fields.email, "a staff application cannot use the reserved address either");
  await stop(s);

  /* ---------- 2. production WITH ADMIN_PASSWORD: created once, never changed ---------- */
  const PW1 = "Render-Admin-2026", PW2 = "Different-Pass-2027";
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1 }, "b.db");
  ok(/Administrator account created for admin@islaplateu\.local/.test(s.out) && !s.out.includes(PW1), "admin is created from ADMIN_PASSWORD and the password is never printed");
  const a1 = await login("ADMINISTRATOR", ADMIN, PW1);
  ok(a1.status === 200 && a1.data.redirect === "/admin", "administrator logs in with the configured password");
  const other = await login("ADMINISTRATOR", ADMIN, PW1);
  ok(other.status === 200 && (await call(a1.j, "GET", "/api/me")).status === 200 && (await call(other.j, "GET", "/api/me")).status === 200, "a second device/browser logs in with the same credentials (separate sessions)");
  const reg2 = await call(jar(), "POST", "/api/register", { fullName: "Ana Reyes", email: "ana@example.com", password: "Island2026", confirmPassword: "Island2026" });
  ok(reg2.status === 201, "customer registration works");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW2 }, "b.db");     // restart with a DIFFERENT env value
  ok(!/created/.test(s.out), "restart does not create another administrator");
  ok((await login("ADMINISTRATOR", ADMIN, PW1)).status === 200 && (await login("ADMINISTRATOR", ADMIN, PW2)).status === 401, "restart / redeploy with a different ADMIN_PASSWORD does NOT change the existing administrator password");
  const aa = await login("ADMINISTRATOR", ADMIN, PW1);
  const users = (await call(aa.j, "GET", "/api/admin/users")).data.users;
  ok(users.filter(u => u.role === "ADMINISTRATOR").length === 1 && users.find(u => u.email === "ana@example.com"), "still exactly one administrator, and the customer account survived the restart");
  ok((await login("CUSTOMER", "ana@example.com", "Island2026")).status === 200, "customer login still works after the restart (data persisted)");
  await stop(s);
  s = await start({ NODE_ENV: "production" }, "b.db");                            // restart with NO env at all
  ok((await login("ADMINISTRATOR", ADMIN, PW1)).status === 200, "restart with no ADMIN_PASSWORD at all: the administrator still logs in");
  await stop(s);

  /* ---------- 3. emergency recovery switch ---------- */
  const R1 = "Recovery-Pass-2028", CH = "Changed-Pass-2029", R2 = "Recovery-Pass-2030";
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD_RESET: R1 }, "b.db");
  const oldSession = jar(); await login("ADMINISTRATOR", ADMIN, R1, {}, oldSession);
  ok(/was reset from ADMIN_PASSWORD_RESET/.test(s.out) && !s.out.includes(R1), "ADMIN_PASSWORD_RESET resets the password once and never prints it");
  ok((await login("ADMINISTRATOR", ADMIN, PW1)).status === 401 && oldSession.get() !== "", "after recovery the previous password no longer works and the new one does");
  ok((await call(aa.j, "GET", "/api/me")).status === 401, "recovery also signs out the old administrator sessions");
  ok((await call(oldSession, "POST", "/api/me/password", { currentPassword: R1, newPassword: CH })).status === 200, "administrator changes the password normally afterwards");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD_RESET: R1 }, "b.db");  // variable left in place
  ok(/already applied/.test(s.out) && (await login("ADMINISTRATOR", ADMIN, CH)).status === 200 && (await login("ADMINISTRATOR", ADMIN, R1)).status === 401, "leaving ADMIN_PASSWORD_RESET set does not reset the password again on every restart");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD_RESET: R2 }, "b.db");  // a new value = a new, deliberate recovery
  ok((await login("ADMINISTRATOR", ADMIN, R2)).status === 200, "a different ADMIN_PASSWORD_RESET value triggers a new deliberate recovery");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: "short" }, "c.db");
  ok(/must be 8 to 128 characters/.test(s.out) && (await login("ADMINISTRATOR", ADMIN, "short")).status === 401, "a too-short ADMIN_PASSWORD is refused with a clear message (value never printed)");
  await stop(s);

  /* ---------- 4. local development keeps the one-time convenience ---------- */
  s = await start({}, "d.db");
  const m = /Password: (\S+)/.exec(s.out);
  ok(m && /Local development/.test(s.out), "local development prints a one-time password for a brand-new database");
  ok((await login("ADMINISTRATOR", ADMIN, m[1])).status === 200, "that password works");
  await stop(s);
  s = await start({}, "d.db");
  ok(!/Password:/.test(s.out) && (await login("ADMINISTRATOR", ADMIN, m[1])).status === 200, "restart does not generate a new password: the same one still works");
  await stop(s);

  /* ---------- 5. behind a proxy (Render): real visitor IPs ---------- */
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1, TRUST_PROXY_HOPS: "1" }, "e.db");
  for (let i = 0; i < 42; i++) await login("CUSTOMER", `bot${i}@example.com`, "wrongpass1", { "X-Forwarded-For": "9.9.9.9" });
  ok((await login("ADMINISTRATOR", ADMIN, PW1, { "X-Forwarded-For": "9.9.9.9" })).status === 429, "an abusive visitor is locked out…");
  ok((await login("ADMINISTRATOR", ADMIN, PW1, { "X-Forwarded-For": "8.8.8.8" })).status === 200, "…but the administrator on a different connection is NOT locked out (limits are per real visitor, not per proxy)");
  ok((await login("ADMINISTRATOR", ADMIN, PW1, { "X-Forwarded-For": "1.2.3.4, 9.9.9.9" })).status === 429, "a client cannot dodge the limit by adding fake X-Forwarded-For entries");
  const sec = await call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: ADMIN, password: PW1 }, { "X-Forwarded-Proto": "https", "X-Forwarded-For": "7.7.7.7" });
  ok(/;\s*Secure/.test(sec.setCookie) && /HttpOnly/.test(sec.setCookie) && /SameSite=Lax/.test(sec.setCookie), "behind an HTTPS proxy the session cookie is Secure + HttpOnly + SameSite");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1 }, "f.db");     // TRUST_PROXY_HOPS = 0
  for (let i = 0; i < 42; i++) await login("CUSTOMER", `bot${i}@example.com`, "wrongpass1");
  ok((await login("ADMINISTRATOR", ADMIN, PW1, { "X-Forwarded-For": "8.8.8.8" })).status === 429, "without proxy trust, X-Forwarded-For is ignored (it cannot be used to bypass lock-outs)");
  const ins = await call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: "nobody@example.com", password: "x" }, { "X-Forwarded-Proto": "https" });
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1 }, "g.db");
  const noTrust = await call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: ADMIN, password: PW1 }, { "X-Forwarded-Proto": "https" });
  ok(noTrust.status === 200 && !/Secure/.test(noTrust.setCookie), "forwarded-proto is not trusted unless a proxy is configured");
  await stop(s);
  s = await start({ RENDER: "true", ADMIN_PASSWORD: PW1 }, "h.db");
  const rn = await call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: ADMIN, password: PW1 }, { "X-Forwarded-Proto": "https", "X-Forwarded-For": "5.5.5.5" });
  ok(rn.status === 200 && /Secure/.test(rn.setCookie), "RENDER=true automatically trusts Render's single proxy hop (Secure cookie)");
  await stop(s);

  /* ---------- 6. storage warning ---------- */
  const inApp = path.join(ROOT, "data", `storage-test-${process.pid}.db`);
  s = await start({ RENDER: "true", ADMIN_PASSWORD: PW1, DB_PATH: inApp });
  const ad = await login("ADMINISTRATOR", ADMIN, PW1);
  const st = (await call(ad.j, "GET", "/api/admin/stats")).data.storage;
  ok(/WARNING: The database is stored inside the application folder/.test(s.out) && st.persistent === false && /persistent disk/.test(st.warning), "on Render with the database inside the app folder, the log and the admin stats warn that data will be erased");
  await stop(s); for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(inApp + e); } catch {} }
  s = await start({ RENDER: "true", ADMIN_PASSWORD: PW1 }, "disk.db");           // stands in for /var/data/...
  const ad2 = await login("ADMINISTRATOR", ADMIN, PW1);
  ok(!/WARNING/.test(s.out) && (await call(ad2.j, "GET", "/api/admin/stats")).data.storage.persistent === true, "a database path outside the app folder (e.g. a Render disk) raises no warning");

  /* ---------- 7. backup download + scripts ---------- */
  const cust = await login("CUSTOMER", "ana@example.com", "Island2026");
  await call(jar(), "POST", "/api/register", { fullName: "Ana Reyes", email: "ana@example.com", password: "Island2026", confirmPassword: "Island2026" });
  const cust2 = await login("CUSTOMER", "ana@example.com", "Island2026");
  ok((await call(jar(), "GET", "/api/admin/backup")).status === 401 && (await call(cust2.j, "GET", "/api/admin/backup")).status === 403, "backup download: visitors get 401 and customers get 403");
  const bk = await fetch(BASE + "/api/admin/backup", { headers: { Cookie: ad2.j.get() } });
  const buf = Buffer.from(await bk.arrayBuffer());
  ok(bk.status === 200 && buf.subarray(0, 15).toString() === "SQLite format 3" && /attachment/.test(bk.headers.get("content-disposition")), "administrator downloads a real SQLite backup file");
  const bkFile = path.join(dir, "download.db"); fs.writeFileSync(bkFile, buf);
  const { DatabaseSync } = require("node:sqlite"); const bdb = new DatabaseSync(bkFile, { readOnly: true });
  ok(bdb.prepare("SELECT COUNT(*) n FROM users").get().n >= 2 && bdb.prepare("SELECT COUNT(*) n FROM sessions").get().n === 0 && bdb.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "the backup holds the accounts, passes the integrity check and contains no live sessions");
  bdb.close();
  await stop(s);
  const env = { ...CLEAN, DB_PATH: path.join(dir, "disk.db") };
  const b1 = spawnSync(process.execPath, ["scripts/backup.js", path.join(dir, "cli-backup.db")], { cwd: ROOT, env, encoding: "utf8" });
  ok(b1.status === 0 && /integrity: ok/.test(b1.stdout) && fs.existsSync(path.join(dir, "cli-backup.db")), "scripts/backup.js writes a verified backup");
  ok(spawnSync(process.execPath, ["scripts/backup.js", path.join(dir, "cli-backup.db")], { cwd: ROOT, env, encoding: "utf8" }).status === 1, "backup refuses to overwrite an existing file");
  fs.writeFileSync(path.join(dir, "bad.db"), "this is not a database");
  ok(spawnSync(process.execPath, ["scripts/restore.js", path.join(dir, "bad.db"), "--yes"], { cwd: ROOT, env, encoding: "utf8" }).status === 1, "restore refuses a file that is not a valid database");
  ok(spawnSync(process.execPath, ["scripts/restore.js", path.join(dir, "cli-backup.db")], { cwd: ROOT, env, encoding: "utf8" }).status === 1, "restore does nothing without the --yes confirmation");
  const target = path.join(dir, "restore-target.db"); fs.copyFileSync(path.join(dir, "disk.db"), target); fs.appendFileSync(target, "");
  const env2 = { ...CLEAN, DB_PATH: target };
  const r1 = spawnSync(process.execPath, ["scripts/restore.js", path.join(dir, "cli-backup.db"), "--yes"], { cwd: ROOT, env: env2, encoding: "utf8" });
  ok(r1.status === 0 && /Current database kept as/.test(r1.stdout) && fs.readdirSync(dir).some(f => f.startsWith("restore-target.db.before-restore-")), "restore keeps the current database aside before replacing it");
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD_RESET: "Unused-Value-1", ADMIN_PASSWORD: PW1 }, "restore-target.db");
  ok((await login("CUSTOMER", "ana@example.com", "Island2026")).status === 200, "a restored backup starts normally and its accounts can log in");
  await stop(s);

  /* ---------- 8. map tile configuration ---------- */
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1 }, "i.db");
  const cfg = await call(jar(), "GET", "/api/config"), csp = (await call(jar(), "GET", "/healthz")).headers.get("content-security-policy");
  ok(cfg.data.tile.url === "https://tile.openstreetmap.org/{z}/{x}/{y}.png" && /OpenStreetMap contributors/.test(cfg.data.tile.attribution), "default tiles use OpenStreetMap's current HTTPS endpoint with attribution");
  ok(/img-src[^;]*https:\/\/tile\.openstreetmap\.org/.test(csp) && /img-src[^;]*https:\/\/\*\.tile\.openstreetmap\.org/.test(csp), "the Content-Security-Policy allows both the OSM tile host and its subdomains");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1, TILE_URL_TEMPLATE: "https://{s}.tiles.example.com/{z}/{x}/{y}.png", TILE_ATTRIBUTION: "Example Maps" }, "j.db");
  const cfg2 = await call(jar(), "GET", "/api/config"), csp2 = (await call(jar(), "GET", "/healthz")).headers.get("content-security-policy");
  ok(cfg2.data.tile.provider === "custom" && /\*\.tiles\.example\.com/.test(csp2) && /Example Maps/.test(cfg2.data.tile.attribution) && /OpenStreetMap contributors/.test(cfg2.data.tile.attribution), "a custom tile provider can be configured by environment variable (CSP follows, OSM data credit kept)");
  await stop(s);
  s = await start({ NODE_ENV: "production", ADMIN_PASSWORD: PW1, TILE_URL_TEMPLATE: "http://insecure.example.com/{z}/{x}/{y}.png" }, "k.db");
  ok(/TILE_URL_TEMPLATE ignored/.test(s.out) && (await call(jar(), "GET", "/api/config")).data.tile.provider === "openstreetmap", "an insecure (http) tile template is refused");

  /* ---------- 9. graceful shutdown ---------- */
  s.proc.kill("SIGTERM"); await sleep(1200);
  ok(s.code === 0 && /SIGTERM received/.test(s.out), "SIGTERM (sent by Render on deploy) shuts the server down cleanly");

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); try { await stop(); } catch {} process.exit(1); });
