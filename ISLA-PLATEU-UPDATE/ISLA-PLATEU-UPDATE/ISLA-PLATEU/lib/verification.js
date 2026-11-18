/* Email verification codes. A code is 6 random digits, valid for 10 minutes, usable for 5 wrong guesses, and stored only as an HMAC
   (never in clear). Sending is rate limited per account: one code per minute and five per hour. */
"use strict";
const CODE_TTL_MS = 10 * 60 * 1000, MAX_ATTEMPTS = 5, COOLDOWN_MS = 60 * 1000, MAX_SENDS_PER_HOUR = 5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function createVerification({ db, mailer, crypto, env = process.env }) {
  const getSetting = (k) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) || {}).value;
  const setSetting = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  let pepper = env.EMAIL_CODE_SECRET || getSetting("email_code_pepper");
  if (!pepper) { pepper = crypto.randomBytes(32).toString("hex"); setSetting("email_code_pepper", pepper); }
  const hash = (userId, code) => crypto.createHmac("sha256", pepper).update(`${userId}:${code}`).digest("hex");
  const same = (a, b) => { const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex"); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const enabled = () => mailer.configured;

  /* Creates and emails a fresh code (older codes stop working). Throws {status, message, retryAfter?}. */
  async function issue(user) {
    const now = Date.now();
    const last = db.prepare("SELECT created_at FROM email_verification_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
    if (last && now - last.created_at < COOLDOWN_MS) { const s = Math.ceil((COOLDOWN_MS - (now - last.created_at)) / 1000); throw err(429, `Please wait ${s} second${s === 1 ? "" : "s"} before asking for another code.`, { retryAfter: s }); }
    const sent = db.prepare("SELECT COUNT(*) AS n FROM email_verification_codes WHERE user_id = ? AND created_at > ?").get(user.id, now - 36e5).n;
    if (sent >= MAX_SENDS_PER_HOUR) throw err(429, "Too many codes were requested for this account. Please try again in about an hour.", { retryAfter: 3600 });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    db.prepare("UPDATE email_verification_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(now, user.id); // only the newest code works
    const id = Number(db.prepare("INSERT INTO email_verification_codes (user_id, code_hash, expires_at, created_at) VALUES (?,?,?,?)").run(user.id, hash(user.id, code), now + CODE_TTL_MS, now).lastInsertRowid);
    const name = user.full_name || "there", mins = CODE_TTL_MS / 60000;
    try {
      await mailer.send({ to: user.email, subject: "Your ISLA-PLATEU verification code",
        text: `Hi ${name},\n\nYour ISLA-PLATEU verification code is: ${code}\n\nIt expires in ${mins} minutes. If you did not create an account, you can ignore this email.\n`,
        html: `<p>Hi ${esc(name)},</p><p>Your ISLA-PLATEU verification code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p><p>It expires in ${mins} minutes. If you did not create an account, you can ignore this email.</p>` });
    } catch (e) {
      db.prepare("DELETE FROM email_verification_codes WHERE id = ?").run(id); // a code nobody received must not count against the person
      console.warn("[mail] Verification email could not be sent:", e.message);
      throw err(502, "We could not send the email right now. Please try again in a moment.");
    }
    return { expiresInMinutes: mins, retryAfter: COOLDOWN_MS / 1000 };
  }

  /* Checks a code. Returns the user row on success, otherwise throws {status, message}. */
  function verify(email, code) {
    code = String(code ?? "").trim();
    if (!/^\d{6}$/.test(code)) throw err(400, "Enter the 6-digit code from your email.");
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email ?? "").trim().toLowerCase());
    const row = user && db.prepare("SELECT * FROM email_verification_codes WHERE user_id = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1").get(user.id);
    const invalid = "That code is not valid or has expired. Request a new one.";
    if (!user || !row) throw err(400, invalid);
    if (row.expires_at < Date.now()) { db.prepare("UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id); throw err(400, "This code has expired. Request a new one."); }
    if (!same(hash(user.id, code), row.code_hash)) {
      const attempts = row.attempts + 1;
      db.prepare("UPDATE email_verification_codes SET attempts = ?, consumed_at = CASE WHEN ? >= ? THEN ? ELSE NULL END WHERE id = ?").run(attempts, attempts, MAX_ATTEMPTS, Date.now(), row.id);
      if (attempts >= MAX_ATTEMPTS) throw err(400, "Too many wrong attempts. Request a new code.", { exhausted: true });
      const left = MAX_ATTEMPTS - attempts;
      throw err(400, `Incorrect code. You have ${left} attempt${left === 1 ? "" : "s"} left.`, { attemptsLeft: left });
    }
    db.prepare("UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?").run(Date.now(), row.id);
    db.prepare("UPDATE users SET email_verified = 1, email_verified_at = datetime('now') WHERE id = ?").run(user.id);
    return user;
  }
  return { enabled, issue, verify, constants: { CODE_TTL_MS, MAX_ATTEMPTS, COOLDOWN_MS, MAX_SENDS_PER_HOUR } };
}
module.exports = { createVerification };
