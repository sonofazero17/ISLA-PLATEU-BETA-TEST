/* CAPTCHA verification. The browser widget only produces a token; the token is ALWAYS verified here, with the secret key,
   by asking the provider. Providers: turnstile (default), hcaptcha, recaptcha. Enabled only when both keys are set. */
"use strict";

const PROVIDERS = {
  turnstile: { script: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", verify: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    csp: { script: ["https://challenges.cloudflare.com"], frame: ["https://challenges.cloudflare.com"], connect: ["https://challenges.cloudflare.com"], style: [] } },
  hcaptcha: { script: "https://js.hcaptcha.com/1/api.js?render=explicit", verify: "https://api.hcaptcha.com/siteverify",
    csp: { script: ["https://hcaptcha.com", "https://*.hcaptcha.com"], frame: ["https://hcaptcha.com", "https://*.hcaptcha.com"], connect: ["https://hcaptcha.com", "https://*.hcaptcha.com"], style: ["https://hcaptcha.com", "https://*.hcaptcha.com"] } },
  recaptcha: { script: "https://www.google.com/recaptcha/api.js?render=explicit", verify: "https://www.google.com/recaptcha/api/siteverify",
    csp: { script: ["https://www.google.com", "https://www.gstatic.com"], frame: ["https://www.google.com"], connect: ["https://www.google.com"], style: [] } }
};
const isLoopback = (h) => ["localhost", "127.0.0.1", "::1"].includes(String(h).toLowerCase());

function createCaptcha(env = process.env) {
  const name = String(env.CAPTCHA_PROVIDER || "turnstile").toLowerCase();
  const def = PROVIDERS[name];
  const siteKey = String(env.CAPTCHA_SITE_KEY || ""), secret = String(env.CAPTCHA_SECRET_KEY || "");
  if (!def && (siteKey || secret)) console.warn(`[captcha] Unknown CAPTCHA_PROVIDER "${name}". Use turnstile, hcaptcha or recaptcha.`);
  const enabled = !!def && !!siteKey && !!secret;
  if (!enabled && (siteKey || secret)) console.warn("[captcha] Both CAPTCHA_SITE_KEY and CAPTCHA_SECRET_KEY are needed, so the CAPTCHA is off.");
  let verifyUrl = def ? def.verify : "";
  if (env.CAPTCHA_VERIFY_URL) { // testing/proxy override: https anywhere, plain http only to this machine
    try { const u = new URL(env.CAPTCHA_VERIFY_URL); if (u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname))) verifyUrl = u.href; } catch { /* keep default */ }
  }

  /* Public settings for the browser (a site key is meant to be public). */
  const publicConfig = () => ({ enabled, provider: enabled ? name : null, siteKey: enabled ? siteKey : null, scriptUrl: enabled ? def.script : null });
  /* Extra content-security-policy sources the widget needs. */
  const csp = () => (enabled ? def.csp : { script: [], frame: [], connect: [], style: [] });

  /* Returns { ok:true } or { ok:false, reason: "missing" | "expired" | "failed" | "unavailable" }. Never trusts the client. */
  async function verify(token, ip) {
    if (!enabled) return { ok: true, skipped: true };
    token = typeof token === "string" ? token.trim() : "";
    if (!token || token.length > 4096) return { ok: false, reason: "missing" };
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (ip && ip !== "unknown") body.set("remoteip", ip);
      const res = await fetch(verifyUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, reason: "unavailable" };
      const data = await res.json();
      if (data && data.success === true) return { ok: true };
      const codes = [].concat((data && (data["error-codes"] || data.error_codes)) || []).map(String);
      return { ok: false, reason: codes.some(c => /timeout|duplicate|expired/i.test(c)) ? "expired" : "failed" };
    } catch { return { ok: false, reason: "unavailable" }; } // fail closed: if we cannot check, we do not let the request through
  }
  const message = (reason) => ({
    missing: "Please complete the security check (“I’m not a robot”) and try again.",
    expired: "The security check expired. Please complete it again.",
    failed: "The security check failed. Please try again.",
    unavailable: "We could not verify the security check right now. Please try again in a moment."
  })[reason] || "Please complete the security check and try again.";
  return { enabled, provider: enabled ? name : null, publicConfig, csp, verify, message };
}

module.exports = { createCaptcha };
