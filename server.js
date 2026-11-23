/* ISLA-PLATEU server
   Node.js backend; Nodemailer is used for configured SMTP email delivery.
   - Real server-side authentication: scrypt password hashing, SQLite storage, HttpOnly session cookies
   - Role-based authorization for pages AND API endpoints (CUSTOMER, RESTAURANT_STAFF, ADMINISTRATOR)
   Requires Node.js 22.13 or newer (uses the built-in node:sqlite module). */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`ISLA-PLATEU needs Node.js 22.13 or newer (found ${process.versions.node}). Download the LTS version from https://nodejs.org`);
  process.exit(1);
}
process.removeAllListeners("warning");
process.on("warning", (w) => { // hide only the harmless "SQLite is experimental" notice; every other warning is still shown
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.warn(w.stack || String(w));
});
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "islaplateu.db");
const HOST = process.env.HOST || "0.0.0.0";                    // listen on all interfaces (required on Render)
const IS_RENDER = process.env.RENDER === "true";                // Render sets RENDER=true on its services
const IS_PROD = process.env.NODE_ENV === "production" || IS_RENDER;
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";     // force the Secure cookie flag (it is also set automatically behind an HTTPS proxy)
// How many reverse proxies sit in front of the app (Render's load balancer = 1). Needed to see the REAL visitor IP.
const TRUST_PROXY_HOPS = process.env.TRUST_PROXY_HOPS !== undefined ? Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS, 10) || 0) : (IS_RENDER ? 1 : 0);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@islaplateu.local").trim().toLowerCase(); // canonical administrator email
const RESERVED_DOMAIN = "@islaplateu.local";                    // public sign-up may not use this domain (it would let someone squat the admin address)
const isReservedEmail = (email) => email === ADMIN_EMAIL || email.endsWith(RESERVED_DOMAIN);
const COOKIE_NAME = "isla_sid";
const SESSION_HOURS = 12;          // normal session
const REMEMBER_DAYS = 30;          // "Remember me"
const ROLES = ["CUSTOMER", "RESTAURANT_STAFF", "ADMINISTRATOR"];
const HOME = { CUSTOMER: "/map", RESTAURANT_STAFF: "/staff", ADMINISTRATOR: "/admin" };

/* ---------- Database ---------- */
const { openDatabase } = require("./lib/db.js");
const db = openDatabase(DB_PATH, ROOT);
const RECOVERY_SECRET = process.env.EMAIL_CODE_SECRET || (() => {
  const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get("password_recovery_secret");
  if (existing && existing.value) return existing.value;
  const generated = crypto.randomBytes(48).toString("hex");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("password_recovery_secret", generated);
  return db.prepare("SELECT value FROM settings WHERE key = ?").get("password_recovery_secret").value;
})();
const { createMailer } = require("./lib/mailer.js"), { createCaptcha } = require("./lib/captcha.js"), { createVerification } = require("./lib/verification.js");
const mailer = createMailer(process.env, { isProd: IS_PROD }), captcha = createCaptcha(process.env);
const verification = createVerification({ db, mailer, crypto });
/* ---------- Storage check (is the database going to survive a redeploy?) ---------- */
const DB_INSIDE_APP = path.resolve(DB_PATH).startsWith(path.resolve(ROOT) + path.sep);
const STORAGE = { path: DB_PATH, persistent: !(IS_RENDER && DB_INSIDE_APP),
  warning: IS_RENDER && DB_INSIDE_APP ? "The database is stored inside the application folder, which Render erases on every deploy and restart. Attach a Render persistent disk and set DB_PATH to a file on it (for example /var/data/islaplateu.db), otherwise accounts and data will be lost." : "" };
const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  insertUser: db.prepare("INSERT INTO users (full_name, email, password_hash, role, restaurant_id) VALUES (?, ?, ?, ?, ?)"),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMINISTRATOR'"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, last_seen) VALUES (?, ?, ?, ?)"),
  sessionUser: db.prepare(`SELECT u.id, u.full_name, u.email, u.role, u.restaurant_id, u.status, u.email_verified, u.verification_required, s.expires_at, s.last_seen
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
  touchSession: db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?")
};

/* ---------- Passwords (scrypt, per-user random salt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scrypt = (pw, salt, o) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = stored.split("$");
    if (alg !== "scrypt") return false;
    const expected = Buffer.from(keyB64, "base64");
    const actual = await scrypt(pw, Buffer.from(saltB64, "base64"), { N: +N, r: +r, p: +p, keylen: expected.length });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
let DUMMY_HASH = null; // compared against when the email is unknown, so timing does not reveal which emails exist
hashPassword(crypto.randomBytes(12).toString("hex")).then(h => { DUMMY_HASH = h; });

/* ---------- Validation ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateRegistration(b) {
  const errors = {};
  const fullName = String(b.fullName ?? "").replace(/\s+/g, " ").trim();
  const email = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  const confirm = String(b.confirmPassword ?? "");
  if (fullName.length < 2) errors.fullName = "Enter your full name.";
  else if (fullName.length > 80) errors.fullName = "Name must be 80 characters or fewer.";
  else if (/[<>]/.test(fullName)) errors.fullName = "Name contains characters that are not allowed.";
  if (!email) errors.email = "Enter your email address.";
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!password) errors.password = "Create a password.";
  else if (password.length < 8) errors.password = "Use at least 8 characters.";
  else if (password.length > 128) errors.password = "Password must be 128 characters or fewer.";
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.password = "Include at least one letter and one number.";
  if (!confirm) errors.confirmPassword = "Confirm your password.";
  else if (confirm !== password) errors.confirmPassword = "Passwords do not match.";
  return { errors, fullName, email, password };
}

/* ---------- Sessions ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttl = remember ? REMEMBER_DAYS * 864e5 : SESSION_HOURS * 36e5;
  q.insertSession.run(sha256(token), userId, Date.now() + ttl, Date.now());
  return { token, maxAge: remember ? Math.floor(ttl / 1000) : null };
}
function isHttps(req) {
  if (req.socket.encrypted) return true;
  if (!TRUST_PROXY_HOPS) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",").map(x => x.trim()).filter(Boolean);
  return proto.length > 0 && proto[Math.max(0, proto.length - TRUST_PROXY_HOPS)] === "https";
}
function cookieHeader(value, maxAge, req) {
  let c = `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== null && maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (COOKIE_SECURE || (req && isHttps(req))) c += "; Secure";
  return c;
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
/* ---------- CAPTCHA + email verification helpers ---------- */
const hitMaps = new Map(); // name -> Map(key -> [timestamps])
function hitLimit(name, key, max, windowMs) { // true = allowed (and recorded); false = over the limit
  const m = hitMaps.get(name) || new Map(); hitMaps.set(name, m);
  const now = Date.now(), hits = (m.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { m.set(key, hits); return false; }
  hits.push(now); m.set(key, hits); return true;
}
setInterval(() => { for (const m of hitMaps.values()) for (const [k, v] of m) if (!v.length || Date.now() - v[v.length - 1] > 36e5) m.delete(k); }, 10 * 60 * 1000).unref();
/* Sends the failure itself and returns false when the CAPTCHA does not check out. The token is verified with the provider on the server. */
async function captchaOk(req, res, b) {
  const r = await captcha.verify(b && b.captchaToken, clientIp(req));
  if (r.ok) return true;
  const msg = captcha.message(r.reason);
  json(res, r.reason === "unavailable" ? 503 : 400, { code: "CAPTCHA_FAILED", error: msg, fields: { captcha: msg } });
  return false;
}
function currentUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const hash = sha256(token);
  const row = q.sessionUser.get(hash);
  if (!row) return null;
  if (row.expires_at < Date.now() || row.status !== "ACTIVE") { q.deleteSession.run(hash); return null; }
  if (!row.last_seen || Date.now() - row.last_seen > 60000) q.touchSession.run(Date.now(), hash); // used for the "active now" statistic
  return { id: row.id, fullName: row.full_name, email: row.email, role: row.role, restaurantId: row.restaurant_id, emailVerified: !!row.email_verified };
}
setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

/* ---------- Rate limiting (in-memory) ---------- */
const failures = new Map(); // key -> { count, until }
const LOGIN_MAX = 5, LOCK_MS = 15 * 60 * 1000;
function lockedFor(key) {
  const f = failures.get(key);
  if (f && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 60000);
  if (f && f.until && f.until <= Date.now()) failures.delete(key);
  return 0;
}
function recordFailure(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= LOGIN_MAX) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(key, f);
}
const ipFailures = new Map(); // ip -> { count, until }: stops one address from trying many different accounts
const IP_MAX = 40;
function ipLocked(ip) { const f = ipFailures.get(ip); if (f && f.until > Date.now()) return true; if (f && f.until) ipFailures.delete(ip); return false; }
function recordIpFailure(ip) {
  const f = ipFailures.get(ip) || { count: 0, until: 0 };
  f.count += 1; if (f.count >= IP_MAX) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  ipFailures.set(ip, f);
}
const regHits = new Map(); // ip -> [timestamps]
function registrationAllowed(ip) {
  const now = Date.now();
  const hits = (regHits.get(ip) || []).filter(t => now - t < 36e5);
  if (hits.length >= 10) { regHits.set(ip, hits); return false; }
  hits.push(now); regHits.set(ip, hits); return true;
}

/* ---------- HTTP helpers ---------- */
/* Map tiles: OpenStreetMap's public tile servers by default. Their usage policy requires a valid HTTP Referer on every tile
   request, so the Referrer-Policy below must NOT strip it (the old "same-origin" policy did). A different provider can be
   configured with TILE_URL_TEMPLATE / TILE_ATTRIBUTION without changing code. */
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
function loadTileConfig() {
  const cfg = { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: OSM_ATTRIBUTION, maxZoom: 19, provider: "openstreetmap", imgSources: ["https://tile.openstreetmap.org", "https://*.tile.openstreetmap.org"] };
  const t = (process.env.TILE_URL_TEMPLATE || "").trim();
  if (!t) return cfg;
  if (!/^https:\/\/[^\s'"<>;]+$/.test(t) || !/\{z\}/.test(t) || !/\{x\}/.test(t) || !/\{y\}/.test(t)) { console.error("[map] TILE_URL_TEMPLATE ignored: it must be an https:// URL containing {z}, {x} and {y}."); return cfg; }
  try {
    const u = new URL(t.replace(/\{s\}/g, "a").replace(/\{[zxy]\}/g, "0").replace(/\{r\}/g, ""));
    const host = t.includes("{s}") ? "https://*." + u.host.split(".").slice(1).join(".") : u.origin;
    const extra = (process.env.TILE_ATTRIBUTION || "").replace(/[<>&"']/g, "").trim();
    return { url: t, attribution: OSM_ATTRIBUTION + (extra ? " · " + extra : ""), maxZoom: Math.min(22, Math.max(1, parseInt(process.env.TILE_MAX_ZOOM, 10) || 19)), provider: "custom", imgSources: [host] };
  } catch { console.error("[map] TILE_URL_TEMPLATE ignored: it is not a valid URL."); return cfg; }
}
const TILES = loadTileConfig();
const CAPTCHA_CSP = captcha.csp(); // the CAPTCHA provider's own domains are allowed only when a CAPTCHA is configured
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",   // sends only the site origin to other sites (e.g. tile servers), never full paths
  ...(IS_PROD ? { "Strict-Transport-Security": "max-age=15552000" } : {}), // ignored by browsers over plain http
  "Content-Security-Policy": [
    "default-src 'self'",
    `script-src 'self' https://unpkg.com ${CAPTCHA_CSP.script.join(" ")}`.trim(),
    `style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com ${CAPTCHA_CSP.style.join(" ")}`.trim(),
    `frame-src 'self' https://www.google.com https://maps.google.com ${CAPTCHA_CSP.frame.join(" ")}`.trim(),
    "font-src https://fonts.gstatic.com",
    `img-src 'self' data: ${TILES.imgSources.join(" ")} https://unpkg.com https://upload.wikimedia.org`,
    `connect-src 'self' ${CAPTCHA_CSP.connect.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ")
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", ...headers });
const redirect = (res, to) => send(res, 302, "", { Location: to });
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("Unsupported content type"), { status: 415 }));
    const tooBig = () => Object.assign(new Error("Request too large"), { status: 413 });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > 10 * 1024) { req.resume(); setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref(); return reject(tooBig()); } // answer first, then drop the connection
    let size = 0, over = false; const chunks = [];
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > 10 * 1024) { over = true; chunks.length = 0; reject(tooBig()); req.resume(); setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref(); return; } // let the 413 reply go out, then cut the connection
      chunks.push(c);
    });
    req.on("end", () => {
      try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); resolve(v && typeof v === "object" ? v : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function sameOrigin(req) { // CSRF defence in depth (cookies are also SameSite=Lax)
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
/* The visitor's address. Behind Render's load balancer req.socket.remoteAddress is the BALANCER for everyone, so rate limits and
   lock-outs would be shared by all visitors. We take the address the trusted proxy appended (counting from the right, so a
   client cannot fake it by sending its own X-Forwarded-For header). */
function clientIp(req) {
  const direct = req.socket.remoteAddress || "unknown";
  if (!TRUST_PROXY_HOPS) return direct;
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
  const i = chain.length - TRUST_PROXY_HOPS;
  return i >= 0 ? chain[i] : direct;
}
const features = require("./features.js")({ db, json, readJson, hashPassword, verifyPassword, crypto, ROLES, send, isReservedEmail, verification, captcha, mailer, dbPath: DB_PATH, storage: STORAGE, sessionHash: (req) => { const t = readCookie(req, COOKIE_NAME); return t ? sha256(t) : ""; }, clientIp });

/* ---------- Static files (explicit whitelist: server code and the database are never served) ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
function serveFile(res, file, headers = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", ...headers });
  });
}
const PAGE_FILES = { "/": "landing.html", "/map": "index.html", "/login": "login.html", "/register": "register.html", "/register-staff": "register-staff.html", "/reset-password": "reset-password.html", "/account": "account.html", "/staff": "staff.html", "/admin": "admin.html" };
const PUBLIC_PAGES = new Set(["/", "/map"]);
const forbiddenPage = (user) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access denied | ISLA-PLATEU</title><link rel="stylesheet" href="/assets/auth.css">
<body class="denied"><main><img src="/assets/logo.svg" alt="" width="56" height="56"><h1>Access denied</h1>
<p>Your account does not have permission to open this page.</p><a class="btn btn-primary" href="${HOME[user.role]}">Go to my page</a></main></body>`;

/* ---------- Router ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;
  const user = currentUser(req);

  if (p === "/healthz" && (method === "GET" || method === "HEAD")) return json(res, 200, { ok: true }); // for Render's health check; reveals nothing
  /* Pages */
  if (method === "GET" || method === "HEAD") {
    if (PUBLIC_PAGES.has(p)) return serveFile(res, path.join(ROOT, PAGE_FILES[p])); // introduction page and public map: no login needed
    if (p === "/reset-password") return serveFile(res, path.join(ROOT, PAGE_FILES[p]));
    if (p === "/login" || p === "/register" || p === "/register-staff") return user ? redirect(res, HOME[user.role]) : serveFile(res, path.join(ROOT, PAGE_FILES[p]));
    if (PAGE_FILES[p]) {
      if (!user) return redirect(res, "/login");
      const allowed = { "/account": ["CUSTOMER"], "/staff": ["RESTAURANT_STAFF"], "/admin": ["ADMINISTRATOR"] }[p];
      if (!allowed.includes(user.role)) return send(res, 403, forbiddenPage(user), { "Content-Type": "text/html; charset=utf-8" });
      return serveFile(res, path.join(ROOT, PAGE_FILES[p]));
    }
    if (p === "/index.html") return redirect(res, "/map");
    if (p === "/style.css" || p === "/script.js") return serveFile(res, path.join(ROOT, p.slice(1)), { "Cache-Control": "no-cache" });
    if (p.startsWith("/assets/")) {
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(path.join(ROOT, "assets") + path.sep)) return send(res, 400, "Bad request");
      return serveFile(res, file, { "Cache-Control": "no-cache" });
    }
  }

  /* Uploaded PUBLIC images (logos, covers, food photos). Names are random and validated against an exact pattern; private files are never served here. */
  if ((method === "GET" || method === "HEAD") && p.startsWith("/uploads/public/")) {
    const f = features.publicFile(p.slice("/uploads/public/".length));
    if (!f) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    return serveFile(res, f.file, { "Content-Type": f.type, "Cache-Control": "public, max-age=31536000, immutable" });
  }

  /* API */
  if (p.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD" && !sameOrigin(req)) return json(res, 403, { error: "Cross-site request blocked." });

    if (p === "/api/config" && method === "GET") return json(res, 200, { tile: { url: TILES.url, attribution: TILES.attribution, maxZoom: TILES.maxZoom, provider: TILES.provider }, captcha: captcha.publicConfig(), emailVerification: { enabled: verification.enabled() } });
    if (p === "/api/me" && method === "GET") return user ? json(res, 200, { user }) : json(res, 401, { error: "Not signed in." });

    if ((p === "/api/password-recovery/request" || p === "/api/password-recovery/resend") && method === "POST") {
      const b = await readJson(req), ip = clientIp(req), email = String(b.email ?? "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) return json(res, 400, { error: "Enter a valid Gmail address." });
      if (!hitLimit("password-recovery-ip", ip, 12, 60 * 60 * 1000) || !hitLimit("password-recovery-email", sha256(email), 5, 60 * 60 * 1000)) {
        return json(res, 429, { error: "For your security, please wait before trying again." });
      }
      const generic = { ok: true, message: "If an account matches that email address, a verification code will be sent shortly." };
      if (!mailer.configured) return json(res, 503, { error: "Account recovery email is temporarily unavailable. Please contact the administrator." });
      const row = q.userByEmail.get(email);
      if (!row || row.status !== "ACTIVE") return json(res, 200, generic);
      const now = Date.now();
      const recent = db.prepare("SELECT created_at FROM password_recovery_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(row.id);
      if (recent && now - recent.created_at < 60 * 1000) {
        const retryAfter = Math.max(1, Math.ceil((60 * 1000 - (now - recent.created_at)) / 1000));
        return p.endsWith("/resend") ? json(res, 429, { error: "Please wait before requesting another code.", retryAfter }) : json(res, 200, generic);
      }
      const sent = db.prepare("SELECT COUNT(*) AS n FROM password_recovery_codes WHERE user_id = ? AND created_at > ?").get(row.id, now - 60 * 60 * 1000).n;
      if (sent >= 5) return json(res, 200, generic);
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const salt = crypto.randomBytes(16).toString("hex");
      const codeHash = crypto.createHmac("sha256", RECOVERY_SECRET).update(`${row.id}:${salt}:${code}`).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE password_recovery_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(now, row.id);
        db.prepare("UPDATE password_recovery_grants SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, row.id);
        db.prepare("INSERT INTO password_recovery_codes (user_id, code_hash, code_salt, expires_at, attempts, created_at) VALUES (?,?,?,?,0,?)").run(row.id, codeHash, salt, now + 10 * 60 * 1000, now);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      const safeName = String(row.full_name || "there").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
      const html = `<div style="margin:0;background:#f3f7f6;padding:32px 12px;font-family:Arial,sans-serif;color:#173b45"><div style="max-width:520px;margin:auto;background:#fff;border:1px solid #dce8e5;border-radius:16px;overflow:hidden"><div style="background:#123b4a;padding:24px;text-align:center;color:#fff"><div style="font-size:22px;font-weight:700;letter-spacing:1px">ISLA-PLATEU</div><div style="font-size:11px;letter-spacing:2px;margin-top:5px">SIQUIJOR RESTAURANT LOCATOR</div></div><div style="padding:28px"><h2 style="margin:0 0 12px">Verify your account</h2><p>Hello ${safeName},</p><p>Use this verification code to continue recovering your ISLA-PLATEU account:</p><div style="margin:24px 0;padding:18px;background:#edf7f4;border-radius:12px;text-align:center;font-size:34px;font-weight:700;letter-spacing:9px;color:#087d7b">${code}</div><p>This code expires in <strong>10 minutes</strong> and can only be used once.</p><p style="font-size:13px;color:#526b70">If you did not request this code, you can ignore this email. Your password will not change. Never share this code with anyone.</p></div></div></div>`;
      try {
        await mailer.send({ to: row.email, subject: "Your ISLA-PLATEU account recovery code", text: `Hello ${row.full_name || "there"},\n\nYour ISLA-PLATEU account recovery verification code is: ${code}\n\nIt expires in 10 minutes and can only be used once. If you did not request this code, ignore this email. Never share this code with anyone.`, html });
      } catch (e) {
        db.prepare("UPDATE password_recovery_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(Date.now(), row.id);
        console.warn("[mail] Account recovery code could not be sent:", e.message);
      }
      return json(res, 200, generic);
    }

    if (p === "/api/password-recovery/verify" && method === "POST") {
      const b = await readJson(req), ip = clientIp(req), email = String(b.email ?? "").trim().toLowerCase(), code = String(b.code ?? "").trim();
      if (!hitLimit("password-recovery-verify-ip", ip, 30, 15 * 60 * 1000) || !hitLimit("password-recovery-verify-email", sha256(email), 10, 15 * 60 * 1000)) return json(res, 429, { error: "Too many attempts. Please wait and try again." });
      if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return json(res, 400, { error: "The verification code is invalid or has expired." });
      const row = db.prepare(`SELECT c.id AS code_id, c.user_id, c.code_hash, c.code_salt, c.expires_at, c.attempts, c.consumed_at, u.status
        FROM password_recovery_codes c JOIN users u ON u.id = c.user_id WHERE u.email = ? ORDER BY c.id DESC LIMIT 1`).get(email);
      if (!row || row.status !== "ACTIVE" || row.consumed_at || row.expires_at < Date.now() || row.attempts >= 5) return json(res, 400, { error: "The verification code is invalid or has expired." });
      const candidate = crypto.createHmac("sha256", RECOVERY_SECRET).update(`${row.user_id}:${row.code_salt}:${code}`).digest();
      const expected = Buffer.from(row.code_hash, "hex");
      const matches = expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
      if (!matches) {
        const attemptedAt = Date.now();
        db.prepare("UPDATE password_recovery_codes SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= 5 THEN ? ELSE consumed_at END WHERE id = ? AND consumed_at IS NULL").run(attemptedAt, row.code_id);
        return json(res, 400, { error: "The verification code is invalid or has expired." });
      }
      const grant = crypto.randomBytes(32).toString("base64url"), now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT id FROM password_recovery_codes WHERE id = ? AND consumed_at IS NULL AND expires_at >= ? AND attempts < 5").get(row.code_id, now);
        if (!current) { db.exec("ROLLBACK"); return json(res, 400, { error: "The verification code is invalid or has expired." }); }
        db.prepare("UPDATE password_recovery_codes SET consumed_at = ? WHERE id = ?").run(now, row.code_id);
        db.prepare("UPDATE password_recovery_grants SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, row.user_id);
        db.prepare("INSERT INTO password_recovery_grants (user_id, grant_hash, expires_at, created_at) VALUES (?,?,?,?)").run(row.user_id, sha256(grant), now + 10 * 60 * 1000, now);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      const secure = COOKIE_SECURE || isHttps(req) ? "; Secure" : "";
      const recoveryCookie = `isla_recovery=${grant}; Path=/api/password-recovery; Max-Age=600; HttpOnly; SameSite=Strict${secure}`;
      return json(res, 200, { ok: true, message: "Your email has been verified. Create a new password." }, { "Set-Cookie": recoveryCookie });
    }

    if (p === "/api/password-recovery/complete" && method === "POST") {
      const b = await readJson(req), ip = clientIp(req), grant = readCookie(req, "isla_recovery") || "", password = String(b.password ?? ""), confirm = String(b.confirmPassword ?? "");
      if (!hitLimit("password-recovery-complete", ip, 10, 15 * 60 * 1000)) return json(res, 429, { error: "Too many attempts. Please wait and try again." });
      const fields = {};
      if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fields.password = "Use 8 to 128 characters, including at least one letter and one number.";
      if (!confirm || confirm !== password) fields.confirmPassword = "Your passwords must match.";
      if (Object.keys(fields).length) return json(res, 400, { error: "Please correct the password fields.", fields });
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(grant)) return json(res, 401, { error: "Your verification has expired. Please start account recovery again." });
      const grantRow = db.prepare("SELECT id, user_id, expires_at, used_at FROM password_recovery_grants WHERE grant_hash = ?").get(sha256(grant));
      if (!grantRow || grantRow.used_at || grantRow.expires_at < Date.now()) return json(res, 401, { error: "Your verification has expired. Please start account recovery again." });
      const passwordHash = await hashPassword(password), now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db.prepare("SELECT id, user_id FROM password_recovery_grants WHERE id = ? AND used_at IS NULL AND expires_at >= ?").get(grantRow.id, now);
        if (!current) { db.exec("ROLLBACK"); return json(res, 401, { error: "Your verification has expired. Please start account recovery again." }); }
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, current.user_id);
        db.prepare("UPDATE password_recovery_grants SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, current.user_id);
        db.prepare("UPDATE password_recovery_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(now, current.user_id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(current.user_id);
        db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, current.user_id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      const clearCookie = `isla_recovery=; Path=/api/password-recovery; Max-Age=0; HttpOnly; SameSite=Strict${COOKIE_SECURE || isHttps(req) ? "; Secure" : ""}`;
      return json(res, 200, { ok: true, message: "Your password has been successfully reset. You can now log in with your new password." }, { "Set-Cookie": clearCookie });
    }

    if (p === "/api/verify-email" && method === "POST") {
      const b = await readJson(req), ip = clientIp(req), email = String(b.email ?? "").trim().toLowerCase();
      if (!hitLimit("verify-ip", ip, 40, 15 * 60 * 1000) || !hitLimit("verify-email", email, 20, 15 * 60 * 1000)) return json(res, 429, { error: "Too many attempts. Please wait a few minutes and try again." });
      try {
        const u = verification.verify(email, b.code);
        return json(res, 200, { ok: true, message: u.status === "PENDING" ? "Your email address is verified. Your staff application is waiting for administrator review." : "Your email address is verified. You can now log in." });
      } catch (e) { if (e.status) return json(res, e.status, { error: e.message, attemptsLeft: e.attemptsLeft, exhausted: !!e.exhausted }); throw e; }
    }
    if (p === "/api/resend-verification" && method === "POST") {
      const b = await readJson(req), ip = clientIp(req), email = String(b.email ?? "").trim().toLowerCase();
      if (!verification.enabled()) return json(res, 503, { error: "Email verification is not available right now." });
      if (!hitLimit("resend-ip", ip, 20, 36e5)) return json(res, 429, { error: "Too many code requests from this connection. Please try again later." });
      if (!(await captchaOk(req, res, b))) return;
      const generic = { ok: true, retryAfter: 60, message: "If this account is waiting for verification, a new code is on its way." }; // never reveals whether an account exists
      const row = q.userByEmail.get(email), own = user && user.email === email; // a signed-in older account may verify voluntarily
      if (!row || row.email_verified || !(row.verification_required || own)) return json(res, 200, generic);
      try { const r = await verification.issue(row); return json(res, 200, { ...generic, retryAfter: r.retryAfter }); }
      catch (e) { if (e.status) return json(res, e.status, { error: e.message, retryAfter: e.retryAfter }); throw e; }
    }

    if (await features(req, res, user, p, method)) return;

    if (p === "/api/register" && method === "POST") {
      const b = await readJson(req);
      if (!registrationAllowed(clientIp(req))) return json(res, 429, { error: "Too many sign-ups from this connection. Please try again later." });
      const { errors, fullName, email, password } = validateRegistration(b);
      if (Object.keys(errors).length) return json(res, 400, { error: "Please fix the highlighted fields.", fields: errors });
      if (!(await captchaOk(req, res, b))) return; // after field checks, so a typo does not spend the one-time token
      if (isReservedEmail(email)) return json(res, 400, { error: "Please use a different email address.", fields: { email: "This email address is reserved. Please use a different one." } });
      if (q.userByEmail.get(email)) return json(res, 409, { error: "An account with this email already exists.", fields: { email: "This email is already registered. Try logging in instead." } });
      const hash = await hashPassword(password);
      let userId;
      try { userId = Number(q.insertUser.run(fullName, email, hash, "CUSTOMER", null).lastInsertRowid); } // role is ALWAYS CUSTOMER for public sign-up; any "role" in the request is ignored
      catch { return json(res, 409, { error: "An account with this email already exists.", fields: { email: "This email is already registered. Try logging in instead." } }); }
      let needsVerification = false, emailSent = false;
      if (verification.enabled()) { // the account cannot log in until the person proves they control this email address
        db.prepare("UPDATE users SET verification_required = 1 WHERE id = ?").run(userId); needsVerification = true;
        try { await verification.issue({ id: userId, email, full_name: fullName }); emailSent = true; }
        catch {
          db.prepare("DELETE FROM users WHERE id = ?").run(userId);
          return json(res, 503, { error: "We could not send the verification email. Your account was not created. Please try again later." });
        }
      }
      return json(res, 201, { ok: true, needsVerification, emailSent, email, message: needsVerification ? "Account created. Enter the code we emailed you to verify your address." : "Account created. You can now log in." });
    }

    if (p === "/api/login" && method === "POST") {
      const b = await readJson(req);
      const portal = String(b.portal ?? "");                       // which login form the person used (customer / staff / admin)
      const email = String(b.email ?? "").trim().toLowerCase();
      const password = String(b.password ?? "");
      if (!ROLES.includes(portal)) return json(res, 400, { error: "Choose Customer, Staff or Admin login." });
      const fields = {};
      if (!email) fields.email = "Enter your email address.";
      if (!password) fields.password = "Enter your password.";
      if (Object.keys(fields).length) return json(res, 400, { error: "Enter your email and password.", fields });
      if (password.length > 1024) return json(res, 401, { error: "Incorrect email or password." });
      const ip = clientIp(req), key = `${ip}|${email}`;
      const wait = lockedFor(key);
      if (wait || ipLocked(ip)) return json(res, 429, { error: `Too many failed attempts. Try again in about ${wait || 15} minute${(wait || 15) === 1 ? "" : "s"}.` });
      const fl = failures.get(key), ipf = ipFailures.get(ip); // after a few wrong passwords the person must pass the CAPTCHA before more guesses are tried
      if (captcha.enabled && ((fl && fl.count >= 3) || (ipf && ipf.count >= 15))) {
        if (!b.captchaToken) return json(res, 400, { code: "CAPTCHA_REQUIRED", captcha: true, error: "For your security, please complete the security check and try again." });
        if (!(await captchaOk(req, res, b))) return;
      }
      const row = q.userByEmail.get(email);
      const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH || "x");
      if (!row || !ok) { recordFailure(key); recordIpFailure(ip); return json(res, 401, { error: "Incorrect email or password." }); }
      failures.delete(key);
      // Credentials are correct from here on. The server, not the browser, decides whether this login form is the right one for the account.
      if (row.role !== portal) {
        const label = { CUSTOMER: "Customer", RESTAURANT_STAFF: "Staff", ADMINISTRATOR: "Admin" };
        return json(res, 403, { code: "WRONG_PORTAL", correctPortal: row.role, error: `These details belong to a ${label[row.role]} account. Please use the ${label[row.role]} login instead.` });
      }
      if (row.status === "PENDING") return json(res, 403, { code: "APPLICATION_PENDING", error: "Your staff application is still waiting for administrator review. You can log in once it is approved." });
      if (row.status === "REJECTED") {
        const app = db.prepare("SELECT review_note FROM staff_applications WHERE user_id = ?").get(row.id);
        return json(res, 403, { code: "APPLICATION_REJECTED", error: "Your staff application was not approved." + (app && app.review_note ? ` Reason: ${app.review_note}` : "") + " Please contact the administrator if you think this is a mistake." });
      }
      if (row.status !== "ACTIVE") return json(res, 403, { code: "ACCOUNT_DISABLED", error: "This account has been disabled. Please contact the administrator." });
      if (row.verification_required && !row.email_verified) return json(res, 403, { code: "EMAIL_NOT_VERIFIED", email: row.email, error: "Please verify your email address before logging in. Enter the code we sent you, or ask for a new one." });
      const oldToken = readCookie(req, COOKIE_NAME);               // session rotation: any session the browser already held is destroyed
      if (oldToken) q.deleteSession.run(sha256(oldToken));
      const { token, maxAge } = createSession(row.id, b.remember === true);
      return json(res, 200, {
        user: { fullName: row.full_name, email: row.email, role: row.role }, // the role comes from the database, never from the client
        redirect: HOME[row.role]
      }, { "Set-Cookie": cookieHeader(token, maxAge, req) });
    }

    if (p === "/api/logout" && method === "POST") {
      const token = readCookie(req, COOKIE_NAME);
      if (token) q.deleteSession.run(sha256(token));
      return json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0, req) });
    }

    return json(res, 404, { error: "Not found." });
  }

  send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error("Server error:", err.message);
    if (!res.headersSent) json(res, status, { error: status === 500 ? "Something went wrong. Please try again." : err.message });
  });
});

/* ---------- Administrator provisioning ----------
   * The admin is created ONLY when no administrator exists yet, with the password from ADMIN_PASSWORD.
   * An existing administrator's password is never touched on restart or redeploy.
   * No password is generated or printed in production. (Local development still prints a one-time password.)
   * ADMIN_PASSWORD_RESET is an explicit recovery switch: it is applied once per distinct value (remembered as a hash). */
const getSetting = (k) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) || {}).value;
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
const validAdminPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 128;
async function provisionAdmin() {
  const envPw = process.env.ADMIN_PASSWORD || "", resetPw = process.env.ADMIN_PASSWORD_RESET || "";
  const admins = q.countAdmins.get().n, canonical = q.userByEmail.get(ADMIN_EMAIL);
  if (admins === 0) {
    if (canonical) console.error(`[admin] ${ADMIN_EMAIL} already exists but is not an administrator account, so it was left unchanged. Choose another ADMIN_EMAIL.`);
    else if (envPw) {
      if (!validAdminPassword(envPw)) console.error("[admin] ADMIN_PASSWORD must be 8 to 128 characters. The administrator account was NOT created.");
      else { q.insertUser.run("System Administrator", ADMIN_EMAIL, await hashPassword(envPw), "ADMINISTRATOR", null); console.log(`[admin] Administrator account created for ${ADMIN_EMAIL} using ADMIN_PASSWORD.`); }
    } else if (IS_PROD) {
      console.warn(`[admin] No administrator exists and ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD in the environment and restart to create ${ADMIN_EMAIL}. No password is generated or printed in production.`);
    } else {
      const generated = crypto.randomBytes(9).toString("base64url"); // local development convenience only
      q.insertUser.run("System Administrator", ADMIN_EMAIL, await hashPassword(generated), "ADMINISTRATOR", null);
      console.log("\n  Local development: an administrator account was created.");
      console.log(`    Email:    ${ADMIN_EMAIL}`);
      console.log(`    Password: ${generated}   (shown once - save it now, or set ADMIN_PASSWORD before the first start)\n`);
    }
  } else if (admins > 1) console.warn(`[admin] ${admins} administrator accounts exist. Review them in the Admin dashboard.`);

  if (resetPw) {
    if (!validAdminPassword(resetPw)) { console.error("[admin] ADMIN_PASSWORD_RESET must be 8 to 128 characters and was ignored."); return; }
    const marker = getSetting("admin_reset_marker");
    if (marker && await verifyPassword(resetPw, marker)) { console.log("[admin] ADMIN_PASSWORD_RESET was already applied earlier; the current password is unchanged. You can remove the variable."); return; }
    const row = q.userByEmail.get(ADMIN_EMAIL), hash = await hashPassword(resetPw);
    if (row && row.role !== "ADMINISTRATOR") { console.error(`[admin] ${ADMIN_EMAIL} is not an administrator account; reset skipped.`); return; }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (row) { db.prepare("UPDATE users SET password_hash = ?, status = 'ACTIVE' WHERE id = ?").run(hash, row.id); db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id); }
      else q.insertUser.run("System Administrator", ADMIN_EMAIL, hash, "ADMINISTRATOR", null);
      setSetting("admin_reset_marker", hash);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
    console.log(`[admin] Administrator password for ${ADMIN_EMAIL} was reset from ADMIN_PASSWORD_RESET (value not shown). Remove the variable after you have logged in.`);
  }
}

function shutdown(signal) { // Render sends SIGTERM on every deploy: finish requests, flush the database, exit cleanly
  console.log(`[server] ${signal} received, shutting down.`);
  server.close(() => { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* already closed */ } process.exit(0); });
  if (server.closeIdleConnections) server.closeIdleConnections();   // do not wait for idle keep-alive browser connections
  setTimeout(() => process.exit(0), 8000).unref();
}

if (require.main === module) {
  provisionAdmin().then(() => server.listen(PORT, HOST, () => {
    console.log(`ISLA-PLATEU running at http://localhost:${PORT} (listening on ${HOST}:${PORT}${IS_PROD ? ", production mode" : ""})`);
    console.log(`[storage] database file: ${DB_PATH}`);
    if (STORAGE.warning) console.warn(`[storage] WARNING: ${STORAGE.warning}`);
    if (IS_PROD && !TRUST_PROXY_HOPS) console.warn("[server] TRUST_PROXY_HOPS is 0: if the site is behind a reverse proxy, every visitor will share one IP address for rate limits.");
  })).catch((err) => { console.error("[server] failed to start:", err.message); process.exit(1); });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
module.exports = { hashPassword };
