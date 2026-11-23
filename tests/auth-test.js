/* Phase 8: email verification (real SMTP client against a local fake mail server) and server-side CAPTCHA (fake provider).
   Self-contained.   Run:  node tests/auth-test.js */
const { spawn } = require("node:child_process");
const net = require("node:net"), http = require("node:http");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const { createMailer } = require(path.join(ROOT, "lib", "mailer.js")), { createCaptcha } = require(path.join(ROOT, "lib", "captcha.js"));
const PORT = 3938, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isla-auth-")), DBFILE = path.join(dir, "t.db");
const ADMIN_PW = "Auth-Test-2026";
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR|MAIL_|SMTP_|RESEND_|BREVO_|CAPTCHA_|EMAIL_)/.test(k)));
const jar = () => { let c = ""; return { get: () => c, set(h) { for (const name of ["isla_sid", "isla_recovery"]) { const m = new RegExp(name + "=([^;]*)").exec(h || ""); if (m) { const parts = c.split("; ").filter(x => x && !x.startsWith(name + "=")); if (m[1]) parts.push(name + "=" + m[1]); c = parts.join("; "); } } } }; };
async function call(j, method, p, body, extra = {}) {
  const res = await fetch(BASE + p, { method, redirect: "manual", body: body === undefined ? undefined : JSON.stringify(body), headers: { "X-Forwarded-For": "10.9.9.9", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra } });
  j.set(res.headers.get("set-cookie"));
  let data = null; if ((res.headers.get("content-type") || "").includes("json")) { try { data = await res.json(); } catch {} }
  return { status: res.status, data, res };
}

/* ---- fake SMTP server ---- */
const smtp = { user: "mailer@isla.test", pass: "app-password-1234", rejectRcpt: false, messages: [], authFailures: 0 };
function startSmtp() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.write("220 fake ESMTP ready\r\n");
      let buf = "", dataMode = false, lines = [], msg = {};
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (dataMode) { if (line === ".") { dataMode = false; msg.raw = lines.join("\r\n"); smtp.messages.push(msg); msg = {}; lines = []; sock.write("250 queued\r\n"); } else lines.push(line.startsWith("..") ? line.slice(1) : line); continue; }
          if (/^EHLO/i.test(line)) sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (/^AUTH PLAIN /i.test(line)) { const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0"); if (u === smtp.user && p === smtp.pass) { msg.authed = true; sock.write("235 ok\r\n"); } else { smtp.authFailures++; sock.write("535 bad credentials\r\n"); } }
          else if (/^MAIL FROM:/i.test(line)) { msg.from = /<([^>]*)>/.exec(line)[1]; sock.write("250 ok\r\n"); }
          else if (/^RCPT TO:/i.test(line)) { if (smtp.rejectRcpt) sock.write("550 mailbox unavailable\r\n"); else { msg.to = /<([^>]*)>/.exec(line)[1]; sock.write("250 ok\r\n"); } }
          else if (/^DATA/i.test(line)) { dataMode = true; sock.write("354 go\r\n"); }
          else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
          else sock.write("250 ok\r\n");
        }
      });
      sock.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const textOf = (m) => { const part = /Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n\r\n--/.exec(m.raw); return part ? Buffer.from(part[1].replace(/\r\n/g, ""), "base64").toString("utf8") : ""; };
const codeOf = (m) => (/code is: (\d{6})/.exec(textOf(m)) || [])[1];
const lastMail = (to) => [...smtp.messages].reverse().find(m => m.to === to);

/* ---- fake CAPTCHA provider ---- */
const cap = { used: new Set(), seen: [], down: false };
function startCaptcha() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        if (cap.down) { res.writeHead(500); return res.end("down"); }
        const f = new URLSearchParams(body), token = f.get("response") || "";
        cap.seen.push({ secret: f.get("secret"), token, ip: f.get("remoteip") });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (f.get("secret") !== "test-secret") return res.end(JSON.stringify({ success: false, "error-codes": ["invalid-input-secret"] }));
        if (token.startsWith("ok") && !cap.used.has(token)) { cap.used.add(token); return res.end(JSON.stringify({ success: true })); }
        if (token.startsWith("ok")) return res.end(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
        if (token === "expired") return res.end(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
        res.end(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
let ipN = 0; const fresh = () => ({ "X-Forwarded-For": `10.1.${(++ipN) >> 8}.${ipN & 255}` }); // every simulated visitor gets its own address
let tokenN = 0; const tok = () => "ok-" + (++tokenN) + "-" + Math.random().toString(36).slice(2);

(async () => {
  const smtpSrv = await startSmtp(), capSrv = await startCaptcha(), smtpPort = smtpSrv.address().port, capPort = capSrv.address().port;
  const proc = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: DBFILE, ADMIN_PASSWORD: ADMIN_PW, TRUST_PROXY_HOPS: "1",
    MAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "none", SMTP_USER: smtp.user, SMTP_PASS: smtp.pass, MAIL_FROM: "ISLA-PLATEU <no-reply@isla.test>",
    CAPTCHA_PROVIDER: "turnstile", CAPTCHA_SITE_KEY: "test-site-key", CAPTCHA_SECRET_KEY: "test-secret", CAPTCHA_VERIFY_URL: `http://127.0.0.1:${capPort}/siteverify` } });
  let out = ""; proc.stdout.on("data", d => out += d); proc.stderr.on("data", d => out += d);
  for (let i = 0; i < 60 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  const db = () => new DatabaseSync(DBFILE);
  try {
    const anon = jar();
    const reg = (email, extra = {}, token = tok()) => call(jar(), "POST", "/api/register", { fullName: "Test " + email.split("@")[0], email, password: "Island2026", confirmPassword: "Island2026", captchaToken: token, ...extra }, fresh());
    const login = (email, password = "Island2026", extra = {}, portal = "CUSTOMER") => call(jar(), "POST", "/api/login", { portal, email, password, ...extra });
    const verify = (email, code) => call(jar(), "POST", "/api/verify-email", { email, code }, fresh());
    const resend = (email, token = tok(), j = jar()) => call(j, "POST", "/api/resend-verification", { email, captchaToken: token }, fresh());
    const backdate = (email, ms) => { const d = db(); d.prepare("UPDATE email_verification_codes SET created_at = created_at - ? WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(ms, email); d.close(); };
    const backdateRecovery = (email, ms) => { const d = db(); d.prepare("UPDATE password_recovery_codes SET created_at = created_at - ? WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(ms, email); d.close(); };

    /* ---- public configuration and headers ---- */
    const resetPage = await call(anon, "GET", "/reset-password");
    const resetHtml = await resetPage.res.text();
    ok(resetPage.status === 200 && /Find Your Account/.test(resetHtml) && /Check Your Email/.test(resetHtml) && /Create a New Password/.test(resetHtml), "password-recovery page is publicly reachable and contains the staged recovery flow");
    const loginPage = await call(anon, "GET", "/login");
    const loginHtml = await loginPage.res.text();
    ok(loginPage.status === 200 && (loginHtml.match(/Forgot password\?/g) || []).length === 3, "customer, staff and administrator login forms each show Forgot password");
    const cfg = await call(anon, "GET", "/api/config");
    ok(cfg.data.captcha.enabled === true && cfg.data.captcha.provider === "turnstile" && cfg.data.captcha.siteKey === "test-site-key" && /challenges.cloudflare.com/.test(cfg.data.captcha.scriptUrl) && cfg.data.emailVerification.enabled === true, "config tells the browser which CAPTCHA to show and that email verification is on");
    ok(!JSON.stringify(cfg.data).includes("test-secret") && !JSON.stringify(cfg.data).includes(smtp.pass), "no secret key or mail password is ever sent to the browser");
    const csp = (await fetch(BASE + "/login")).headers.get("content-security-policy");
    ok(/script-src[^;]*challenges\.cloudflare\.com/.test(csp) && /frame-src[^;]*challenges\.cloudflare\.com/.test(csp) && /connect-src[^;]*challenges\.cloudflare\.com/.test(csp), "the security policy allows only the CAPTCHA provider's domains");

    /* ---- registration needs a server-verified CAPTCHA ---- */
    ok((await reg("nobody@example.com", {}, "")).status === 400, "registration without a CAPTCHA token is refused");
    const noTok = await call(jar(), "POST", "/api/register", { fullName: "No Token", email: "notoken@example.com", password: "Island2026", confirmPassword: "Island2026" }, fresh());
    ok(noTok.status === 400 && noTok.data.code === "CAPTCHA_FAILED" && noTok.data.fields.captcha, "…with a clear message the page can show");
    ok((await reg("bad@example.com", {}, "forged-by-the-browser")).status === 400, "a token the provider rejects is refused (the browser's word is not trusted)");
    ok(/expired/i.test((await reg("exp@example.com", {}, "expired")).data.error), "an expired token says so");
    cap.down = true; const down = await reg("down@example.com"); cap.down = false;
    ok(down.status === 503 && /could not verify/i.test(down.data.error), "if the provider cannot be reached the request is refused (fails closed)");
    ok(smtp.messages.length === 0 && (() => { const d = db(); const n = d.prepare("SELECT COUNT(*) AS n FROM users WHERE email IN ('nobody@example.com','notoken@example.com','bad@example.com','exp@example.com','down@example.com')").get().n; d.close(); return n === 0; })(), "none of those attempts created an account or sent an email");
    const spent = cap.used.size;
    ok((await call(jar(), "POST", "/api/register", { fullName: "Typo", email: "not-an-email", password: "Island2026", confirmPassword: "Island2026", captchaToken: tok() }, fresh())).status === 400 && cap.used.size === spent, "a typo in the form does not spend the one-time token");
    ok(cap.seen.every(s => s.secret === "test-secret"), "the server always checks tokens with the secret key");

    /* ---- register, receive a code, verify ---- */
    const t1 = tok(), r1 = await reg("cara@example.com", {}, t1);
    ok(r1.status === 201 && r1.data.needsVerification === true && r1.data.emailSent === true && r1.data.email === "cara@example.com", "registration succeeds and asks for email verification");
    ok((await reg("cara2@example.com", {}, t1)).status === 400, "a CAPTCHA token cannot be replayed");
    const m1 = lastMail("cara@example.com");
    ok(m1 && m1.authed === true && m1.from === "no-reply@isla.test" && /^\d{6}$/.test(codeOf(m1)) && /ISLA-PLATEU verification code/.test(m1.raw) && /Hi Test cara/.test(textOf(m1)), "a 6-digit code arrives by email, sent through the mail server with authentication");
    const code1 = codeOf(m1);
    ok(/multipart\/alternative/.test(m1.raw) && /text\/html/.test(m1.raw), "the email has plain-text and HTML versions");
    const lg0 = await login("cara@example.com");
    ok(lg0.status === 403 && lg0.data.code === "EMAIL_NOT_VERIFIED" && lg0.data.email === "cara@example.com", "login is refused until the email is verified");
    ok((await login("cara@example.com", "WrongPass9")).status === 401, "…and a wrong password still just says incorrect (no verification hint)");
    const d0 = db(), rows0 = d0.prepare("SELECT * FROM email_verification_codes").all(); d0.close();
    ok(rows0.length === 1 && rows0[0].code_hash.length === 64 && !JSON.stringify(rows0).includes(code1), "the code is stored only as a hash");
    ok((await verify("cara@example.com", "12ab")).status === 400 && (await verify("cara@example.com", "")).status === 400, "a malformed code is rejected");
    const wrong = code1 === "000000" ? "111111" : "000000";
    const w1 = await verify("cara@example.com", wrong);
    ok(w1.status === 400 && w1.data.attemptsLeft === 4 && /4 attempts left/.test(w1.data.error), "a wrong code says how many attempts are left");
    ok((await verify("cara@example.com", code1)).status === 200, "the right code verifies the account");
    ok((await verify("cara@example.com", code1)).status === 400, "a code works only once");
    const lg1 = await login("cara@example.com");
    ok(lg1.status === 200 && lg1.data.user.email === "cara@example.com", "after verification the person can log in");
    const me = await (async () => { const j = jar(); await call(j, "POST", "/api/login", { portal: "CUSTOMER", email: "cara@example.com", password: "Island2026" }); return call(j, "GET", "/api/me"); })();
    ok(me.data.user.emailVerified === true, "/api/me reports the verified state");

    /* ---- attempt limit ---- */
    await reg("dan@example.com"); const dcode = codeOf(lastMail("dan@example.com"));
    for (let i = 0; i < 4; i++) await verify("dan@example.com", dcode === "123456" ? "654321" : "123456");
    const w5 = await verify("dan@example.com", dcode === "123456" ? "654321" : "123456");
    ok(w5.status === 400 && w5.data.exhausted === true && /Too many wrong attempts/.test(w5.data.error), "five wrong guesses use up the code");
    const afterLock = await verify("dan@example.com", dcode);
    ok(afterLock.status === 400 && /not valid or has expired/.test(afterLock.data.error), "…and then even the correct code no longer works");

    /* ---- resend: CAPTCHA, cooldown, hourly cap, no enumeration ---- */
    const sentBefore = smtp.messages.length;
    ok((await resend("dan@example.com", "")).status === 400 && smtp.messages.length === sentBefore, "resend needs a CAPTCHA too");
    const cool = await resend("dan@example.com");
    ok(cool.status === 429 && cool.data.retryAfter > 0 && cool.data.retryAfter <= 60 && smtp.messages.length === sentBefore, "resend is limited to one code per minute");
    backdate("dan@example.com", 61000);
    const rs = await resend("dan@example.com");
    ok(rs.status === 200 && smtp.messages.length === sentBefore + 1, "after the cooldown a new code is sent");
    const dcode2 = codeOf(lastMail("dan@example.com"));
    ok((await verify("dan@example.com", dcode)).status === 400 || dcode === dcode2, "the older code stops working when a new one is issued");
    ok((await verify("dan@example.com", dcode2)).status === 200, "the new code verifies the account");
    const n0 = smtp.messages.length;
    const unk = await resend("ghost@example.com"), ver = await resend("cara@example.com");
    ok(unk.status === 200 && ver.status === 200 && unk.data.message === ver.data.message && smtp.messages.length === n0, "unknown and already-verified addresses get the same answer and no email (no account enumeration)");
    await reg("eve@example.com");
    { const d = db(), uid = d.prepare("SELECT id FROM users WHERE email = 'eve@example.com'").get().id; d.prepare("DELETE FROM email_verification_codes WHERE user_id = ?").run(uid);
      for (let i = 0; i < 5; i++) d.prepare("INSERT INTO email_verification_codes (user_id, code_hash, expires_at, created_at, consumed_at) VALUES (?,?,?,?,?)").run(uid, "00", Date.now() + 1e6, Date.now() - 600000 - i, Date.now()); d.close(); }
    const cap5 = await resend("eve@example.com");
    ok(cap5.status === 429 && /Too many codes/.test(cap5.data.error), "no more than five codes per hour for one account");

    /* ---- expiry ---- */
    await reg("fay@example.com"); const fcode = codeOf(lastMail("fay@example.com"));
    { const d = db(); d.prepare("UPDATE email_verification_codes SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = 'fay@example.com')").run(Date.now() - 1000); d.close(); }
    const exp = await verify("fay@example.com", fcode);
    ok(exp.status === 400 && /expired/.test(exp.data.error), "a code expires after its time limit");
    backdate("fay@example.com", 61000);
    ok((await resend("fay@example.com")).status === 200 && (await verify("fay@example.com", codeOf(lastMail("fay@example.com")))).status === 200, "a fresh code after expiry works");

    /* ---- mail server problems ---- */
    smtp.rejectRcpt = true; const failReg = await reg("gus@example.com"); smtp.rejectRcpt = false;
    ok(failReg.status === 503 && /account was not created/i.test(failReg.data.error), "if the verification email cannot be sent, the account is not created");
    ok((() => { const d = db(); const n = d.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'gus@example.com'").get().n; d.close(); return n === 0; })(), "a failed verification send leaves no registration behind");
    ok(/Verification email could not be sent/.test(out) && !out.includes(smtp.pass), "the failure is logged without the mail password");
    const badAuth = await (async () => { const mm = createMailer({ MAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "none", SMTP_USER: smtp.user, SMTP_PASS: "wrong", MAIL_FROM: "a@isla.test" }); try { await mm.send({ to: "x@example.com", subject: "s", text: "t", html: "<p>t</p>" }); return null; } catch (e) { return e.message; } })();
    ok(badAuth && /login/.test(badAuth) && !badAuth.includes("wrong"), "wrong mail credentials give a clear error that does not echo the password");

    /* ---- verify endpoint throttle ---- */
    let last; for (let i = 0; i < 22; i++) last = await verify("throttle@example.com", "123456");
    ok(last.status === 429, "guessing codes for one address is throttled");

    /* ---- six-digit Gmail account recovery ---- */
    await reg("recovery@gmail.com");
    const recoverySignupCode = codeOf(lastMail("recovery@gmail.com"));
    ok((await verify("recovery@gmail.com", recoverySignupCode)).status === 200, "recovery test account has a verified Gmail address");
    const recoveryAnon = jar();
    const unauthorizedReset = await call(recoveryAnon, "POST", "/api/password-recovery/complete", { password: "NewIsland2027", confirmPassword: "NewIsland2027" }, fresh());
    ok(unauthorizedReset.status === 401, "password cannot be changed without successful email verification");
    const recoveryMailStart = smtp.messages.length;
    const recoveryRequest = await call(jar(), "POST", "/api/password-recovery/request", { email: "recovery@gmail.com" }, fresh());
    ok(recoveryRequest.status === 200 && /If an account matches/.test(recoveryRequest.data.message) && smtp.messages.length === recoveryMailStart + 1, "recovery request sends a six-digit code and returns a generic response");
    const recoveryCode = codeOf(lastMail("recovery@gmail.com"));
    ok(/^\d{6}$/.test(recoveryCode || "") && !JSON.stringify(recoveryRequest.data).includes(recoveryCode), "six-digit code is emailed but never returned by the API");
    { const d = db(); const saved = d.prepare("SELECT code_hash, code_salt, expires_at, attempts FROM password_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1").get("recovery@gmail.com");
      ok(saved && saved.code_hash !== recoveryCode && saved.code_hash.length === 64 && saved.expires_at > Date.now() && saved.attempts === 0, "only a salted HMAC hash of the ten-minute code is stored"); d.close(); }
    const wrongRecovery = await call(jar(), "POST", "/api/password-recovery/verify", { email: "recovery@gmail.com", code: "000000" === recoveryCode ? "111111" : "000000" }, fresh());
    ok(wrongRecovery.status === 400 && /invalid or has expired/i.test(wrongRecovery.data.error), "incorrect recovery code is rejected");
    const recoveryBrowser = jar();
    const verifiedRecovery = await call(recoveryBrowser, "POST", "/api/password-recovery/verify", { email: "recovery@gmail.com", code: recoveryCode }, fresh());
    ok(verifiedRecovery.status === 200 && recoveryBrowser.get().includes("isla_recovery=") && !JSON.stringify(verifiedRecovery.data).includes(recoveryCode), "correct code is single-use and grants an HttpOnly recovery cookie, not a browser token");
    const oldSession = jar();
    await call(oldSession, "POST", "/api/login", { portal: "CUSTOMER", email: "recovery@gmail.com", password: "Island2026" });
    const recoveryResetDone = await call(recoveryBrowser, "POST", "/api/password-recovery/complete", { password: "NewIsland2027", confirmPassword: "NewIsland2027" }, fresh());
    ok(recoveryResetDone.status === 200 && /successfully reset/i.test(recoveryResetDone.data.message), "verified account can save a matching strong new password");
    ok((await call(oldSession, "GET", "/api/me")).status === 401, "password reset invalidates existing login sessions");
    ok((await login("recovery@gmail.com", "Island2026")).status === 401 && (await login("recovery@gmail.com", "NewIsland2027")).status === 200, "new password works and old password no longer works");
    ok((await call(recoveryBrowser, "POST", "/api/password-recovery/complete", { password: "AnotherIsland2028", confirmPassword: "AnotherIsland2028" }, fresh())).status === 401, "recovery authorization cannot be reused after password reset");
    /* Recovery resend cooldown, latest-code-only, expiry and five-attempt limit. */
    const cooldownRecovery = await call(jar(), "POST", "/api/password-recovery/request", { email: "recovery@gmail.com" }, fresh());
    ok(cooldownRecovery.status === 200, "a new recovery request is accepted after a completed reset");
    const oldRecoveryCode = codeOf(lastMail("recovery@gmail.com"));
    const tooSoon = await call(jar(), "POST", "/api/password-recovery/resend", { email: "recovery@gmail.com" }, fresh());
    ok(tooSoon.status === 429 && tooSoon.data.retryAfter > 0 && tooSoon.data.retryAfter <= 60, "resend is blocked during the 60-second cooldown");
    backdateRecovery("recovery@gmail.com", 61000);
    const resent = await call(jar(), "POST", "/api/password-recovery/resend", { email: "recovery@gmail.com" }, fresh());
    const newestRecoveryCode = codeOf(lastMail("recovery@gmail.com"));
    ok(resent.status === 200 && /^\d{6}$/.test(newestRecoveryCode || "") && oldRecoveryCode !== newestRecoveryCode, "a new code can be sent after the cooldown");
    ok((await call(jar(), "POST", "/api/password-recovery/verify", { email: "recovery@gmail.com", code: oldRecoveryCode }, fresh())).status === 400, "issuing a new code invalidates the previous code");
    const latestGrant = jar();
    ok((await call(latestGrant, "POST", "/api/password-recovery/verify", { email: "recovery@gmail.com", code: newestRecoveryCode }, fresh())).status === 200, "only the latest code can verify");
    ok((await call(latestGrant, "POST", "/api/password-recovery/complete", { password: "NewIsland2028", confirmPassword: "NewIsland2028" }, fresh())).status === 200, "password can be reset using the latest verified code");

    await reg("expired-recovery@gmail.com");
    await verify("expired-recovery@gmail.com", codeOf(lastMail("expired-recovery@gmail.com")));
    await call(jar(), "POST", "/api/password-recovery/request", { email: "expired-recovery@gmail.com" }, fresh());
    const expiredRecoveryCode = codeOf(lastMail("expired-recovery@gmail.com"));
    { const d = db(); d.prepare("UPDATE password_recovery_codes SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(Date.now() - 1, "expired-recovery@gmail.com"); d.close(); }
    ok((await call(jar(), "POST", "/api/password-recovery/verify", { email: "expired-recovery@gmail.com", code: expiredRecoveryCode }, fresh())).status === 400, "expired recovery codes are rejected");

    await reg("attempt-limit@gmail.com");
    await verify("attempt-limit@gmail.com", codeOf(lastMail("attempt-limit@gmail.com")));
    await call(jar(), "POST", "/api/password-recovery/request", { email: "attempt-limit@gmail.com" }, fresh());
    const limitedCode = codeOf(lastMail("attempt-limit@gmail.com"));
    for (let i = 0; i < 5; i++) await call(jar(), "POST", "/api/password-recovery/verify", { email: "attempt-limit@gmail.com", code: limitedCode === "999999" ? "000000" : "999999" }, fresh());
    ok((await call(jar(), "POST", "/api/password-recovery/verify", { email: "attempt-limit@gmail.com", code: limitedCode }, fresh())).status === 400, "five incorrect code attempts invalidate the recovery code");

    const unknownRecoveryCount = smtp.messages.length;
    const unknownRecovery = await call(jar(), "POST", "/api/password-recovery/request", { email: "missing@gmail.com" }, fresh());
    ok(unknownRecovery.status === 200 && unknownRecovery.data.message === recoveryRequest.data.message && smtp.messages.length === unknownRecoveryCount, "unknown Gmail address receives the same generic response without account enumeration");

    /* ---- login CAPTCHA after repeated failures ---- */
    const adm = (extra, pw = ADMIN_PW) => call(jar(), "POST", "/api/login", { portal: "ADMINISTRATOR", email: "admin@islaplateu.local", password: pw, ...extra });
    ok((await adm({})).status === 200, "normal login needs no CAPTCHA");
    for (let i = 0; i < 3; i++) ok((await adm({}, "wrong-" + i)).status === 401, `wrong password #${i + 1} -> 401`);
    const need = await adm({});
    ok(need.status === 400 && need.data.code === "CAPTCHA_REQUIRED" && need.data.captcha === true, "after three failures the CAPTCHA is required before more guesses");
    ok((await adm({ captchaToken: "forged" })).status === 400, "a forged token does not unlock more guesses");
    ok((await adm({ captchaToken: tok() }, "wrong-again")).status === 401, "a valid token allows a try (and a wrong password still fails)");
    const good = await adm({ captchaToken: tok() });
    ok(good.status === 200, "a valid token with the right password logs in");
    ok((await adm({})).status === 200, "after success the failure count resets, no CAPTCHA needed");

    /* ---- staff application ---- */
    const app = (email, token) => call(jar(), "POST", "/api/staff-applications", { fullName: "Pia Owner", email, contactNumber: "09171234567", password: "Island2026", confirmPassword: "Island2026", restaurantMode: "new", restaurantName: "Verified Grill " + email.split("@")[0], restaurantContact: "09181234567", restaurantAddress: "Poblacion, Larena", municipality: "Larena", barangay: "Poblacion", category: "Restaurant", description: "A small grill serving local dishes.", position: "Owner", permitNumber: "BP-2026-001", note: "", captchaToken: token }, fresh());
    ok((await app("pia@example.com", "")).status === 400 && (await app("pia@example.com", "forged")).status === 400, "a staff application needs a verified CAPTCHA");
    const ap = await app("pia@example.com", tok());
    ok(ap.status === 201 && ap.data.needsVerification === true && ap.data.emailSent === true, "a valid application is received and a code is emailed");
    const pcode = codeOf(lastMail("pia@example.com"));
    const pend = await login("pia@example.com", "Island2026", {}, "RESTAURANT_STAFF");
    ok(pend.status === 403 && pend.data.code === "APPLICATION_PENDING", "a pending applicant still sees the application-pending message");
    const vv = await verify("pia@example.com", pcode);
    ok(vv.status === 200 && /waiting for administrator review/.test(vv.data.message), "the applicant verifies their email while the application waits");
    const adminJar = jar(); await call(adminJar, "POST", "/api/login", { portal: "ADMINISTRATOR", email: "admin@islaplateu.local", password: ADMIN_PW });
    const pendingApp = async (email) => (await call(adminJar, "GET", "/api/admin/applications?status=pending")).data.applications.find(a => a.applicantEmail === email).id;
    const appId = await pendingApp("pia@example.com");
    ok((await call(adminJar, "POST", `/api/admin/applications/${appId}/approve`, { confirm: true })).status === 200, "admin approves the application");
    ok((await login("pia@example.com", "Island2026", {}, "RESTAURANT_STAFF")).status === 200, "the verified, approved applicant can log in");
    const ap2 = await app("quin@example.com", tok());
    await call(adminJar, "POST", `/api/admin/applications/${await pendingApp("quin@example.com")}/approve`, { confirm: true });
    const un = await login("quin@example.com", "Island2026", {}, "RESTAURANT_STAFF");
    ok(un.status === 403 && un.data.code === "EMAIL_NOT_VERIFIED", "an approved applicant who never verified their email cannot log in yet");

    /* ---- accounts created before this update are not locked out, and can verify voluntarily ---- */
    await reg("legacy@example.com");
    { const d = db(); d.prepare("UPDATE users SET verification_required = 0, email_verified = 0 WHERE email = 'legacy@example.com'").run(); d.close(); }
    const lj = jar(); ok((await call(lj, "POST", "/api/login", { portal: "CUSTOMER", email: "legacy@example.com", password: "Island2026" })).status === 200, "an older, unverified account can still log in");
    ok((await call(lj, "GET", "/api/me")).data.user.emailVerified === false, "…and the page can see it is unverified");
    backdate("legacy@example.com", 61000);
    const nL = smtp.messages.length;
    ok((await resend("legacy@example.com", tok(), lj)).status === 200 && smtp.messages.length === nL + 1, "a signed-in older account can ask for a code");
    ok((await verify("legacy@example.com", codeOf(lastMail("legacy@example.com")))).status === 200, "…and verify");
    const nL2 = smtp.messages.length; await resend("legacy@example.com");
    ok(smtp.messages.length === nL2, "but an anonymous visitor cannot trigger emails to an older account");

    /* ---- legacy password-reset link endpoints are replaced by the six-digit Gmail flow ---- */
    ok((await call(jar(), "POST", "/api/forgot-password", { email: "resetme@example.com" }, fresh())).status === 404, "legacy reset-link endpoint is no longer exposed");
    ok((await call(jar(), "POST", "/api/reset-password", { token: "a".repeat(43), password: "NewIsland2027", confirmPassword: "NewIsland2027" }, fresh())).status === 404, "legacy reset-token endpoint is no longer exposed");

    /* ---- administrator status (names and counts only, never secrets) ---- */
    const st = await call(adminJar, "GET", "/api/admin/security-status");
    ok(st.status === 200 && st.data.email.enabled === true && st.data.email.provider === "smtp" && st.data.email.from === "no-reply@isla.test" && st.data.captcha.enabled === true && st.data.captcha.provider === "turnstile" && st.data.accounts.verified > 0, "the admin can see whether email verification and CAPTCHA are on, with account counts");
    ok(!JSON.stringify(st.data).includes(smtp.pass) && !JSON.stringify(st.data).includes("test-secret"), "…and the status never contains a password or secret key");
    ok((await call(jar(), "GET", "/api/admin/security-status")).status === 401 && (await call(lj, "GET", "/api/admin/security-status")).status === 403, "only administrators can read it");

    /* ---- modules on their own ---- */
    const mk = (env, prod = false) => { const w = console.warn; console.warn = () => {}; try { return createMailer(env, { isProd: prod }); } finally { console.warn = w; } };
    ok(mk({ MAIL_PROVIDER: "gmail", SMTP_USER: "me@gmail.com" }).configured === false && mk({ MAIL_PROVIDER: "gmail", SMTP_USER: "me@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop" }).configured === true, "Gmail needs an address and an app password");
    ok(mk({ MAIL_PROVIDER: "gmail", EMAIL_USER: "me@gmail.com", EMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" }).configured === true, "the documented EMAIL_USER and EMAIL_APP_PASSWORD settings configure Gmail SMTP");
    ok(mk({ MAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.com", SMTP_SECURE: "none", MAIL_FROM: "a@b.co" }).configured === false, "unencrypted SMTP is refused for remote servers");
    ok(mk({ MAIL_PROVIDER: "log" }, true).configured === false && mk({ MAIL_PROVIDER: "log" }, false).configured === true, "the development 'log' provider is disabled in production");
    ok(mk({ MAIL_PROVIDER: "resend" }).configured === false && mk({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "ISLA <a@b.co>" }).configured === true && mk({}).provider === "none", "provider checks: Resend needs a key and a sender, nothing set = off");
    const inj = mk({ MAIL_PROVIDER: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "none", MAIL_FROM: "a@isla.test" });
    ok(await inj.send({ to: "a@b.co\r\nBcc: evil@x.io", subject: "s", text: "t", html: "h" }).then(() => false, (e) => /Invalid recipient/.test(e.message)), "a recipient containing line breaks (header injection) is refused");
    const sub = await inj.send({ to: "ok@example.com", subject: "Line1\r\nBcc: evil@x.io", text: "t", html: "h" }).then(() => lastMail("ok@example.com"));
    ok(sub && !/^Bcc:/m.test(sub.raw), "line breaks in a subject cannot add headers");
    const api = [];
    const apiSrv = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { api.push({ url: req.url, auth: req.headers.authorization, key: req.headers["api-key"], body: JSON.parse(b) }); res.writeHead(req.headers.authorization === "Bearer bad" ? 401 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message: "nope" })); }); });
    await new Promise(r => apiSrv.listen(0, "127.0.0.1", r)); const ap_ = apiSrv.address().port;
    const rs_ = mk({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "key-123", MAIL_FROM: "ISLA <no-reply@isla.test>", RESEND_API_URL: `http://127.0.0.1:${ap_}` });
    await rs_.send({ to: "z@example.com", subject: "S", text: "T", html: "H" });
    ok(api[0].url === "/emails" && api[0].auth === "Bearer key-123" && api[0].body.to[0] === "z@example.com" && api[0].body.from === "ISLA <no-reply@isla.test>", "Resend: correct endpoint, key in a header, payload shape");
    const br_ = mk({ MAIL_PROVIDER: "brevo", BREVO_API_KEY: "bkey", MAIL_FROM: "ISLA <no-reply@isla.test>", BREVO_API_URL: `http://127.0.0.1:${ap_}` });
    await br_.send({ to: "z@example.com", subject: "S", text: "T", html: "H" });
    ok(api[1].url === "/v3/smtp/email" && api[1].key === "bkey" && api[1].body.sender.email === "no-reply@isla.test" && api[1].body.to[0].email === "z@example.com", "Brevo: correct endpoint, key in a header, payload shape");
    const bad_ = mk({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "bad", MAIL_FROM: "a@b.co", RESEND_API_URL: `http://127.0.0.1:${ap_}` });
    ok(await bad_.send({ to: "z@example.com", subject: "S", text: "T", html: "H" }).then(() => false, (e) => /401/.test(e.message) && !e.message.includes("bad")), "an email service error is reported without the API key");
    ok(JSON.stringify(inj.describe()).includes("isla.test") && !JSON.stringify(rs_.describe()).includes("key-123") && !JSON.stringify(mk({ MAIL_PROVIDER: "gmail", SMTP_USER: "me@gmail.com", SMTP_PASS: "supersecretpw" }).describe()).includes("supersecretpw"), "the status description never includes secrets");
    apiSrv.close();
    const c = (env) => { const w = console.warn; console.warn = () => {}; try { return createCaptcha(env); } finally { console.warn = w; } };
    ok(c({}).enabled === false && c({ CAPTCHA_SITE_KEY: "a" }).enabled === false && c({ CAPTCHA_SECRET_KEY: "b" }).enabled === false && c({ CAPTCHA_PROVIDER: "nope", CAPTCHA_SITE_KEY: "a", CAPTCHA_SECRET_KEY: "b" }).enabled === false && c({ CAPTCHA_SITE_KEY: "a", CAPTCHA_SECRET_KEY: "b" }).enabled === true, "CAPTCHA is on only when a known provider has both keys");
    ok(c({ CAPTCHA_PROVIDER: "hcaptcha", CAPTCHA_SITE_KEY: "a", CAPTCHA_SECRET_KEY: "b" }).csp().script.some(x => /hcaptcha/.test(x)) && c({ CAPTCHA_PROVIDER: "recaptcha", CAPTCHA_SITE_KEY: "a", CAPTCHA_SECRET_KEY: "b" }).publicConfig().provider === "recaptcha" && c({}).csp().script.length === 0, "other providers supply their own policy entries; with no CAPTCHA nothing extra is allowed");
    const cc = c({ CAPTCHA_SITE_KEY: "a", CAPTCHA_SECRET_KEY: "test-secret", CAPTCHA_VERIFY_URL: `http://127.0.0.1:${capPort}/siteverify` });
    ok((await cc.verify("", "1.2.3.4")).reason === "missing" && (await cc.verify("x".repeat(5000))).reason === "missing" && (await cc.verify("bad")).reason === "failed" && (await cc.verify("expired")).reason === "expired", "verification outcomes: missing, oversized, failed, expired");
    ok((await cc.verify(tok(), "9.9.9.9")).ok === true && cap.seen.at(-1).ip === "9.9.9.9", "the visitor's address is passed to the provider");
    ok((await c({}).verify("anything")).skipped === true, "with no CAPTCHA configured verification is skipped");
  } catch (e) { fail++; console.log("FAIL unexpected error: " + e.stack); }
  await new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
  await Promise.all([
    new Promise((resolve) => smtpSrv.close(resolve)),
    new Promise((resolve) => capSrv.close(resolve))
  ]);
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (e) {
      if (e.code !== "EPERM" || i === 19) throw e;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
