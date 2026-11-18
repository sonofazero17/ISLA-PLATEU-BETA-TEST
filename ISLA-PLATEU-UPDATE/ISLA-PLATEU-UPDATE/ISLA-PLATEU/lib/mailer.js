/* Outgoing email. Nodemailer is the configured SMTP transport (including Gmail); the small SMTP fallback
   keeps offline test runs usable when dependencies have not yet been installed.
   Secrets come only from the environment and are never logged or returned. */
"use strict";
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch { /* npm install will provide Nodemailer; minimal SMTP fallback keeps dependency-free test runs usable. */ }

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
const clean = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim(); // header injection guard
const isLoopback = (h) => ["localhost", "127.0.0.1", "::1"].includes(String(h).toLowerCase());
const parseFrom = (from) => {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from);
  return m ? { name: clean(m[1] || ""), email: clean(m[2]) } : { name: "", email: clean(from) };
};
function apiBase(value, fallback) { // test/proxy override: https anywhere, plain http only to this machine
  if (!value) return fallback;
  try { const u = new URL(value); if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) return u.origin; } catch { /* fall through */ }
  return fallback;
}
const wrap76 = (b64) => b64.replace(/(.{76})/g, "$1\r\n");
const b64 = (s) => wrap76(Buffer.from(s, "utf8").toString("base64"));

function buildMessage({ from, to, subject, text, html }) {
  const f = parseFrom(from), domain = (f.email.split("@")[1] || "localhost"), boundary = "b_" + crypto.randomBytes(12).toString("hex");
  const fromHeader = f.name ? `"${f.name.replace(/"/g, "")}" <${f.email}>` : f.email;
  const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  return [
    `From: ${fromHeader}`, `To: ${to}`, `Subject: ${clean(subj)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${domain}>`, "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(text), "",
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(html), "", `--${boundary}--`, ""
  ].join("\r\n");
}

/* Minimal SMTP client: implicit TLS (465), STARTTLS (587) or plain (loopback only, e.g. a local test mail catcher). */
function smtpSend(cfg, msg) {
  return new Promise((resolve, reject) => {
    let socket, buf = "", waiting = null, done = false;
    const timer = setTimeout(() => fail(new Error("The mail server did not answer in time.")), 20000);
    const fail = (err) => { if (done) return; done = true; clearTimeout(timer); try { socket && socket.destroy(); } catch { /* closed */ } reject(err); };
    const ok = () => { if (done) return; done = true; clearTimeout(timer); try { socket.end(); } catch { /* closed */ } resolve(); };
    const attach = (s) => {
      socket = s; buf = "";
      s.setEncoding("utf8");
      s.on("data", (d) => { buf += d; pump(); });
      s.on("error", (e) => fail(new Error("Could not talk to the mail server: " + e.code)));
      s.on("close", () => { if (waiting) fail(new Error("The mail server closed the connection.")); });
    };
    function pump() { // a reply is complete when a line "NNN text" (no dash) arrives
      if (!waiting) return;
      const lines = buf.split("\r\n"); if (lines[lines.length - 1] === "") lines.pop(); else if (!/\r\n$/.test(buf)) return;
      const last = lines[lines.length - 1];
      if (lines.length && /^\d{3} /.test(last) || (lines.length && /^\d{3}$/.test(last))) { const w = waiting; waiting = null; buf = ""; w({ code: Number(last.slice(0, 3)), lines }); }
    }
    const reply = () => new Promise((res) => { waiting = res; pump(); });
    const send = (line) => { socket.write(line + "\r\n"); return reply(); };
    const expect = async (p, codes, what) => { const r = await p; if (!codes.includes(r.code)) throw new Error(`The mail server refused ${what} (${r.code}).`); return r; };
    (async () => {
      const secure = cfg.secure;
      await new Promise((res, rej) => {
        const onConn = () => res();
        const s = secure === "tls" ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, onConn) : net.connect({ host: cfg.host, port: cfg.port }, onConn);
        attach(s); s.once("error", rej);
      });
      await expect(reply(), [220], "the connection");
      const ehlo = async () => expect(send(`EHLO ${cfg.localName || "isla-plateu"}`), [250], "the greeting");
      let caps = await ehlo();
      if (secure === "starttls") {
        await expect(send("STARTTLS"), [220], "STARTTLS");
        const plain = socket; plain.removeAllListeners("data"); plain.removeAllListeners("close");
        await new Promise((res, rej) => { const s = tls.connect({ socket: plain, servername: cfg.host }, res); attach(s); s.once("error", rej); });
        caps = await ehlo();
      }
      if (cfg.user) {
        const text = caps.lines.join(" ").toUpperCase();
        if (/AUTH[ =].*PLAIN/.test(text) || !/AUTH[ =].*LOGIN/.test(text)) await expect(send("AUTH PLAIN " + Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString("base64")), [235], "the login");
        else { await expect(send("AUTH LOGIN"), [334], "the login"); await expect(send(Buffer.from(cfg.user).toString("base64")), [334], "the login"); await expect(send(Buffer.from(cfg.pass).toString("base64")), [235], "the login"); }
      }
      await expect(send(`MAIL FROM:<${msg.fromEmail}>`), [250], "the sender");
      await expect(send(`RCPT TO:<${msg.to}>`), [250, 251], "the recipient");
      await expect(send("DATA"), [354], "the message");
      const body = msg.raw.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      socket.write(body + "\r\n.\r\n");
      await expect(reply(), [250], "the message");
      try { socket.write("QUIT\r\n"); } catch { /* ignore */ }
      ok();
    })().catch(fail);
  });
}

async function httpJson(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) { let m = ""; try { m = (await res.json()).message || ""; } catch { /* not json */ } throw new Error(`The email service refused the message (${res.status}). ${String(m).slice(0, 120)}`.trim()); }
}

function createMailer(env = process.env, { isProd = false } = {}) {
  let provider = String(env.MAIL_PROVIDER || "").toLowerCase();
  if (!provider) provider = env.SMTP_HOST ? "smtp" : env.RESEND_API_KEY ? "resend" : env.BREVO_API_KEY ? "brevo" : "none";
  if (provider === "log" && isProd) { console.warn("[mail] MAIL_PROVIDER=log is ignored in production (it would print verification codes to the logs)."); provider = "none"; }
  const smtpHost = provider === "gmail" ? "smtp.gmail.com" : String(env.SMTP_HOST || "");
  const secureRaw = String(env.SMTP_SECURE || (provider === "gmail" ? "tls" : (Number(env.SMTP_PORT) === 465 ? "tls" : "starttls"))).toLowerCase();
  const secure = ["tls", "true", "ssl"].includes(secureRaw) ? "tls" : secureRaw === "none" ? "none" : "starttls";
  const port = Number(env.SMTP_PORT) || (provider === "gmail" ? 465 : secure === "tls" ? 465 : 587);
  const from = clean(env.MAIL_FROM || (provider === "gmail" ? (env.SMTP_USER || env.EMAIL_USER) : "") || "");
  const user = String(env.SMTP_USER || env.EMAIL_USER || ""), pass = String(env.SMTP_PASS || env.EMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); // Gmail shows app passwords in groups of 4
  const problems = [];
  if (provider === "smtp" || provider === "gmail") {
    if (!smtpHost) problems.push("SMTP_HOST");
    if (provider === "gmail" && (!user || !pass)) problems.push("SMTP_USER and SMTP_PASS (a Gmail app password)");
    if (secure === "none" && !isLoopback(smtpHost)) problems.push("SMTP_SECURE=none is only allowed for a mail server on this machine");
  }
  if (provider === "resend" && !env.RESEND_API_KEY) problems.push("RESEND_API_KEY");
  if (provider === "brevo" && !env.BREVO_API_KEY) problems.push("BREVO_API_KEY");
  if (["smtp", "gmail", "resend", "brevo"].includes(provider) && !ADDRESS.test(parseFrom(from).email)) problems.push("MAIL_FROM (a valid sender address)");
  if (!["smtp", "gmail", "resend", "brevo", "log", "none"].includes(provider)) problems.push("a valid MAIL_PROVIDER (gmail, smtp, resend, brevo)");
  const configured = provider !== "none" && !problems.length;
  if (provider !== "none" && problems.length) console.warn(`[mail] Email is not configured: missing ${problems.join(", ")}.`);

  async function send({ to, subject, text, html }) {
    to = clean(to); subject = clean(subject);
    if (!ADDRESS.test(to)) throw new Error("Invalid recipient address.");
    if (!configured) throw new Error("Email delivery is not configured.");
    const f = parseFrom(from);
    if (provider === "log") { console.log(`[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n${text}\n`); return; }
    if (provider === "resend") return httpJson(`${apiBase(env.RESEND_API_URL, "https://api.resend.com")}/emails`, { Authorization: `Bearer ${env.RESEND_API_KEY}` }, { from, to: [to], subject, text, html });
    if (provider === "brevo") return httpJson(`${apiBase(env.BREVO_API_URL, "https://api.brevo.com")}/v3/smtp/email`, { "api-key": env.BREVO_API_KEY }, { sender: { email: f.email, ...(f.name ? { name: f.name } : {}) }, to: [{ email: to }], subject, textContent: text, htmlContent: html });
    if (nodemailer) {
      const transport = nodemailer.createTransport({
        host: smtpHost, port, secure: secure === "tls",
        requireTLS: secure === "starttls",
        auth: user ? { user, pass } : undefined,
        connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 20000
      });
      return transport.sendMail({ from, to, subject, text, html });
    }
    return smtpSend({ host: smtpHost, port, secure, user, pass, localName: (f.email.split("@")[1] || "isla-plateu") },
      { fromEmail: f.email, to, raw: buildMessage({ from, to, subject, text, html }) });
  }
  /* Safe to show to an administrator: never includes passwords or keys. */
  const describe = () => ({ provider, configured, from: configured ? parseFrom(from).email : "", problems });
  return { provider, configured, send, describe };
}

module.exports = { createMailer, buildMessage, parseFrom };
