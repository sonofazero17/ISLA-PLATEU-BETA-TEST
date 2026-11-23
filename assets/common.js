/* ISLA-PLATEU shared helpers (icons, API calls, logout) */
(function () {
  "use strict";
  const ISLA = {
    ROLE_LABEL: { CUSTOMER: "Customer", RESTAURANT_STAFF: "Restaurant Staff", ADMINISTRATOR: "Administrator" },
    refreshIcons() {
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons({ attrs: { "aria-hidden": "true", focusable: "false" } });
      }
    },
    async api(url, options = {}) {
      const init = { credentials: "same-origin", headers: {}, ...options };
      if (options.body !== undefined) {
        init.method = options.method || "POST";
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(options.body);
      }
      try {
        const res = await fetch(url, init);
        let data = null;
        try { data = await res.json(); } catch { /* non-JSON response */ }
        return { ok: res.ok, status: res.status, data: data || {} };
      } catch {
        return { ok: false, status: 0, data: { error: "Could not reach the server. Check that it is running and try again." } };
      }
    },
    /* Sends a file as the raw request body (the server checks the real file type and size). */
    async upload(url, file, method = "POST") {
      try {
        const res = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
        return { ok: res.ok, status: res.status, data: data || {} };
      } catch { return { ok: false, status: 0, data: { error: "Could not reach the server. Check your connection and try again." } }; }
    },
    async logout() {
      await ISLA.api("/api/logout", { method: "POST", body: {} });
      window.location.assign("/login");
    },
    wireLogout() {
      document.querySelectorAll("[data-logout]").forEach(btn => btn.addEventListener("click", async () => {
        btn.disabled = true;
        await ISLA.logout();
      }));
    }
  };

  /* ---- CAPTCHA widget (the token is only a claim: the server verifies it with the provider) ---- */
  let cfgPromise = null, scriptPromise = null;
  ISLA.config = () => (cfgPromise = cfgPromise || fetch("/api/config", { credentials: "same-origin" }).then(r => r.json()).catch(() => ({})));
  const GLOBALS = { turnstile: "turnstile", hcaptcha: "hcaptcha", recaptcha: "grecaptcha" };
  function loadCaptchaScript(cfg) {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const g = GLOBALS[cfg.provider], ready = () => window[g] && typeof window[g].render === "function";
      const s = document.createElement("script"); s.src = cfg.scriptUrl; s.async = true; s.defer = true;
      s.onerror = () => reject(new Error("The security check could not be loaded."));
      s.onload = () => { const t0 = Date.now(); (function wait() { if (window[g] && window[g].ready && !ready()) return window[g].ready(() => resolve()); if (ready()) return resolve(); if (Date.now() - t0 > 10000) return reject(new Error("The security check did not start.")); setTimeout(wait, 100); })(); };
      document.head.appendChild(s);
    });
    scriptPromise.catch(() => { scriptPromise = null; });
    return scriptPromise;
  }
  ISLA.captcha = {
    /* Shows the widget inside `el`. Returns { enabled, getToken(), reset(), remove() }. When no CAPTCHA is configured it does nothing. */
    async mount(el) {
      const cfg = (await ISLA.config()).captcha;
      const none = { enabled: false, getToken: () => "", reset() {}, remove() {} };
      if (!cfg || !cfg.enabled) return none;
      const box = document.createElement("div"); box.className = "captcha-box"; el.appendChild(box);
      try { await loadCaptchaScript(cfg); } catch (e) { box.innerHTML = `<div class="alert alert-error"><span>${e.message} Check your connection and reload the page.</span></div>`; return { enabled: true, getToken: () => "", reset() {}, remove() { box.remove(); } }; }
      let token = "", id; const api = window[GLOBALS[cfg.provider]];
      id = api.render(box, { sitekey: cfg.siteKey, callback: (t) => { token = t; }, "expired-callback": () => { token = ""; }, "error-callback": () => { token = ""; } });
      return { enabled: true, getToken: () => token, reset() { token = ""; try { api.reset(id); } catch { /* widget gone */ } }, remove() { box.remove(); } };
    }
  };

  /* ---- Email verification panel: enter the 6-digit code, or ask for a new one (rate limited, CAPTCHA protected) ---- */
  ISLA.verifyEmail = {
    async mount(container, { email, emailSent = null, intro = "", onDone }) { // emailSent: true = just sent, false = sending failed, null = nothing was just sent
      const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
      const deliveryText = emailSent === false
        ? `We could not send a verification code to <strong>${esc(email)}</strong> right now. Try sending a new code below.`
        : `We sent a 6-digit code to <strong>${esc(email)}</strong>. It expires in 10 minutes. Check your spam folder if you do not see it.`;
      container.innerHTML = `<div class="verify-panel" role="group" aria-label="Verify your email address"><h2 class="verify-title">Check your email</h2>
        <p class="verify-text">${intro ? esc(intro) + " " : ""}${deliveryText}</p>
        <div class="alert hidden verify-msg" role="alert"></div>
        <label class="form-field"><span>Verification code</span><input class="verify-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" placeholder="123456" aria-label="6-digit verification code"></label>
        <button class="btn btn-primary verify-btn" type="button">Verify email</button>
        <div class="verify-captcha"></div>
        <p class="verify-resend"><button class="link-btn verify-resend-btn" type="button">Send a new code</button> <span class="muted verify-timer"></span></p></div>`;
      const q = (c) => container.querySelector(c), msg = q(".verify-msg"), codeIn = q(".verify-code"), vbtn = q(".verify-btn"), rbtn = q(".verify-resend-btn"), timer = q(".verify-timer");
      const show = (kind, text) => { msg.className = `alert alert-${kind} verify-msg`; msg.textContent = text; };
      const cap = await ISLA.captcha.mount(q(".verify-captcha"));
      let tick = null;
      const cooldown = (secs) => { clearInterval(tick); let left = secs; rbtn.disabled = left > 0; const draw = () => { timer.textContent = left > 0 ? `You can ask for another code in ${left}s.` : ""; }; draw(); if (left <= 0) return; tick = setInterval(() => { left--; draw(); if (left <= 0) { clearInterval(tick); rbtn.disabled = false; } }, 1000); };
      codeIn.addEventListener("input", () => { codeIn.value = codeIn.value.replace(/\D/g, "").slice(0, 6); });
      codeIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); vbtn.click(); } });
      vbtn.addEventListener("click", async () => {
        const code = codeIn.value.trim(); if (!/^\d{6}$/.test(code)) { show("error", "Enter the 6-digit code from your email."); codeIn.focus(); return; }
        vbtn.disabled = true; const r = await ISLA.api("/api/verify-email", { body: { email, code } }); vbtn.disabled = false;
        if (r.ok) { clearInterval(tick); show("success", r.data.message || "Your email address is verified."); vbtn.disabled = true; rbtn.disabled = true; codeIn.disabled = true; if (onDone) setTimeout(() => onDone(r.data), 1200); return; }
        show("error", r.data.error || "Could not verify the code."); if (r.data.exhausted) codeIn.value = ""; codeIn.focus();
      });
      rbtn.addEventListener("click", async () => {
        if (cap.enabled && !cap.getToken()) { show("error", "Please complete the security check first, then ask for a new code."); return; }
        rbtn.disabled = true; const r = await ISLA.api("/api/resend-verification", { body: { email, captchaToken: cap.getToken() } }); cap.reset();
        if (r.ok) { show("success", "If this account is waiting for verification, a new code is on its way. Check your inbox."); cooldown(r.data.retryAfter || 60); }
        else { show("error", r.data.error || "Could not send a new code."); cooldown(r.data.retryAfter && r.data.retryAfter <= 120 ? r.data.retryAfter : 0); }
      });
      if (emailSent === true) cooldown(60); else if (emailSent === false) { show("error", "We could not send the email automatically. Use “Send a new code” below."); cooldown(0); } else { show("info", "Enter the code we emailed you earlier, or send a new one."); cooldown(0); }
      setTimeout(() => codeIn.focus(), 50);
    }
  };
  window.ISLA = ISLA;
  document.addEventListener("DOMContentLoaded", () => { ISLA.refreshIcons(); ISLA.wireLogout(); });
})();
