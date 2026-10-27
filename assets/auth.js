/* Login (customer / staff / admin), customer registration and staff application.
   Every form keeps its OWN state: inputs, errors, banner and loading state are scoped to that form, and switching
   login type only shows/hides forms (nothing is copied or cleared). All real checks happen on the server. */
(function () {
  "use strict";
  const page = document.body.dataset.page;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const icon = (n) => `<i data-lucide="${n}" class="icon"></i>`;

  function scope(form) {
    const banner = form.querySelector(".form-banner"), btn = form.querySelector('[type="submit"]'), label = btn.querySelector(".submit-label");
    const errEl = (name) => form.querySelector(`[data-error-for="${name}"]`);
    const input = (name) => form.querySelector(`[name="${name}"]`);
    const api = {
      form,
      value: (name) => { const el = input(name); return el ? el.value : ""; },
      banner(kind, text, action) {
        const names = { error: "circle-alert", success: "circle-check", info: "clock" };
        banner.className = `form-banner alert alert-${kind}`;
        banner.innerHTML = `${icon(names[kind])}<span></span>`;
        const span = banner.lastElementChild; span.textContent = text;
        if (action) { const b = document.createElement("button"); b.type = "button"; b.className = "link-btn"; b.textContent = action.label; b.addEventListener("click", action.onClick); span.appendChild(document.createTextNode(" ")); span.appendChild(b); }
        ISLA.refreshIcons();
      },
      hideBanner() { banner.className = "form-banner alert hidden"; banner.textContent = ""; },
      setError(name, msg) {
        const el = input(name), er = errEl(name);
        if (er) { if (msg) { er.innerHTML = `${icon("circle-alert")}<span></span>`; er.lastElementChild.textContent = msg; ISLA.refreshIcons(); } else er.textContent = ""; }
        if (el && el.type !== "radio") { if (msg) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid"); }
      },
      clearErrors() { api.hideBanner(); form.querySelectorAll("[data-error-for]").forEach(e => api.setError(e.dataset.errorFor, "")); },
      setLoading(on) {
        btn.disabled = on; btn.classList.toggle("loading", on); btn.setAttribute("aria-busy", on ? "true" : "false");
        label.textContent = on ? btn.dataset.loading : btn.dataset.label;
      },
      focusFirstInvalid() { const el = form.querySelector('[aria-invalid="true"]'); if (el) el.focus(); },
      showServerErrors(fields) { Object.entries(fields || {}).forEach(([f, m]) => api.setError(f, m)); }
    };
    form.querySelectorAll("input, select, textarea").forEach(i => i.addEventListener("input", () => { if (i.hasAttribute("aria-invalid")) api.setError(i.name, ""); }));
    form.querySelectorAll(".toggle-pw").forEach(b => b.addEventListener("click", () => {
      const inp = document.getElementById(b.dataset.target), show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.setAttribute("aria-pressed", String(show)); b.setAttribute("aria-label", show ? "Hide password" : "Show password"); b.title = show ? "Hide password" : "Show password";
      b.innerHTML = icon(show ? "eye-off" : "eye"); ISLA.refreshIcons();
    }));
    return api;
  }
  const phoneProblem = (v) => {
    const s = String(v || "").trim();
    if (!s) return "Enter a contact number.";
    if (!/^[0-9+()\-\s.]+$/.test(s) || (s.includes("+") && !s.startsWith("+"))) return "Use digits only (spaces, dashes, + and brackets are fine).";
    const digits = s.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return "Enter a valid phone number (7 to 15 digits).";
    const c = s.replace(/[\s\-().]/g, "");
    if (/^(09|639|\+?639)/.test(c) && !/^(09\d{9}|\+?639\d{9})$/.test(c)) return "Mobile numbers look like 09XX XXX XXXX or +63 9XX XXX XXXX.";
    return "";
  };
  const passwordProblem = (p) => !p ? "Create a password." : p.length < 8 ? "Use at least 8 characters." : (!/[A-Za-z]/.test(p) || !/\d/.test(p)) ? "Include at least one letter and one number." : "";

  /* ================= LOGIN ================= */
  if (page === "login") {
    const LABEL = { CUSTOMER: "Customer", RESTAURANT_STAFF: "Staff", ADMINISTRATOR: "Admin" };
    const SLUG = { customer: "CUSTOMER", staff: "RESTAURANT_STAFF", admin: "ADMINISTRATOR" };
    const LEAD = {
      CUSTOMER: "Log in to find and compare restaurants across Siquijor.",
      RESTAURANT_STAFF: "Restaurant staff: log in with your approved staff account.",
      ADMINISTRATOR: "Administrators: log in with your authorized administrator account."
    };
    const scopes = {};
    document.querySelectorAll(".login-form[data-portal]").forEach(f => { scopes[f.dataset.portal] = scope(f); });
    const radios = [...document.querySelectorAll('input[name="roleChoice"]')];
    const params = new URLSearchParams(location.search);

    function selectPortal(portal, focus) {
      Object.entries(scopes).forEach(([p, s]) => { s.form.hidden = p !== portal; });    // values stay in the hidden forms
      radios.forEach(r => { r.checked = r.value === portal; });
      document.getElementById("roleLead").textContent = LEAD[portal];
      try { sessionStorage.setItem("isla.portal", portal); } catch { /* storage unavailable */ }
      if (focus) { const first = scopes[portal].form.querySelector("input"); if (first) first.focus(); }
    }
    radios.forEach(r => r.addEventListener("change", () => selectPortal(r.value, false)));
    let initial = SLUG[(params.get("role") || "").toLowerCase()];
    if (!initial) { try { initial = sessionStorage.getItem("isla.portal"); } catch { /* ignore */ } }
    selectPortal(LABEL[initial] ? initial : "CUSTOMER", false);

    if (params.get("registered") === "1") scopes.CUSTOMER.banner("success", "Account created! Log in with your new email and password.");
    const expired = params.get("expired") === "1";
    if (expired) Object.values(scopes).forEach(s => s.banner("info", "Your session has ended. Please log in again."));

    Object.entries(scopes).forEach(([portal, s]) => s.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      s.clearErrors();
      const email = s.value("email").trim(), password = s.value("password");
      let bad = false;
      if (!email) { s.setError("email", "Enter your email address."); bad = true; }
      else if (!EMAIL_RE.test(email)) { s.setError("email", "Enter a valid email address."); bad = true; }
      if (!password) { s.setError("password", "Enter your password."); bad = true; }
      if (bad) { s.focusFirstInvalid(); return; }

      s.setLoading(true);
      const res = await ISLA.api("/api/login", { body: { portal, email, password, remember: s.form.querySelector('[name="remember"]').checked } });
      if (res.ok) {
        s.banner("success", "Welcome back! Redirecting…");
        const next = params.get("next");
        setTimeout(() => window.location.assign(next === "/map" ? "/map" : res.data.redirect), 600); // only the public map is accepted as a return page
        return;
      }
      s.setLoading(false);
      const code = res.data.code;
      if (res.data.fields) s.showServerErrors(res.data.fields);
      if (code === "WRONG_PORTAL") s.banner("error", res.data.error, { label: `Go to ${LABEL[res.data.correctPortal]} login`, onClick: () => selectPortal(res.data.correctPortal, true) });
      else if (code === "APPLICATION_PENDING") s.banner("info", res.data.error);
      else s.banner("error", res.data.error || "Could not log in. Please try again.");
      if (res.status === 401) { s.form.querySelector('[name="password"]').value = ""; s.form.querySelector('[name="password"]').focus(); } // only this form's password is cleared
      else s.focusFirstInvalid();
    }));
  }

  /* ================= CUSTOMER REGISTRATION ================= */
  if (page === "register") {
    const s = scope(document.getElementById("form-register"));
    s.form.addEventListener("submit", async (e) => {
      e.preventDefault(); s.clearErrors();
      const v = { fullName: s.value("fullName").replace(/\s+/g, " ").trim(), email: s.value("email").trim(), password: s.value("password"), confirmPassword: s.value("confirmPassword") };
      const errs = {};
      if (v.fullName.length < 2) errs.fullName = "Enter your full name.";
      if (!v.email) errs.email = "Enter your email address."; else if (!EMAIL_RE.test(v.email)) errs.email = "Enter a valid email address.";
      const pp = passwordProblem(v.password); if (pp) errs.password = pp;
      if (!v.confirmPassword) errs.confirmPassword = "Confirm your password."; else if (v.confirmPassword !== v.password) errs.confirmPassword = "Passwords do not match.";
      if (Object.keys(errs).length) { s.showServerErrors(errs); s.banner("error", "Please fix the highlighted fields."); s.focusFirstInvalid(); return; }
      s.setLoading(true);
      const res = await ISLA.api("/api/register", { body: v }); // no role is sent: the server always creates CUSTOMER accounts
      if (res.ok) { s.banner("success", "Account created! Taking you to the login page…"); setTimeout(() => window.location.assign("/login?registered=1"), 1000); return; }
      s.setLoading(false); s.showServerErrors(res.data.fields);
      s.banner("error", res.data.error || "Could not create the account. Please try again."); s.focusFirstInvalid();
    });
  }

  /* ================= STAFF APPLICATION ================= */
  if (page === "register-staff") {
    const s = scope(document.getElementById("form-staffapp"));
    const existingBlock = document.getElementById("existingBlock"), newBlock = document.getElementById("newBlock");
    const modeRadios = [...s.form.querySelectorAll('input[name="restaurantMode"]')];
    const mode = () => (modeRadios.find(r => r.checked) || {}).value;
    function applyMode() { existingBlock.hidden = mode() !== "existing"; newBlock.hidden = mode() !== "new"; }
    modeRadios.forEach(r => r.addEventListener("change", applyMode)); applyMode();
    (async () => {  // list of restaurants already in ISLA-PLATEU (public data)
      const sel = s.form.querySelector('[name="restaurantId"]'), res = await ISLA.api("/api/restaurants");
      sel.innerHTML = '<option value="">Choose your restaurant…</option>';
      if (!res.ok || !Array.isArray(res.data)) { sel.innerHTML = '<option value="">Could not load the list. Register a new restaurant instead.</option>'; return; }
      res.data.forEach(r => { const o = document.createElement("option"); o.value = r.id; o.textContent = r.municipality ? `${r.name} · ${r.municipality}` : r.name; sel.appendChild(o); });
    })();

    s.form.addEventListener("submit", async (e) => {
      e.preventDefault(); s.clearErrors();
      const g = (n) => s.value(n).replace(/\s+/g, " ").trim(), errs = {};
      const body = { fullName: g("fullName"), email: g("email"), contactNumber: g("contactNumber"), password: s.value("password"), confirmPassword: s.value("confirmPassword"),
        restaurantMode: mode(), position: s.value("position"), permitNumber: g("permitNumber"), note: g("note") };
      if (body.fullName.length < 2) errs.fullName = "Enter your full name.";
      if (!body.email) errs.email = "Enter your email address."; else if (!EMAIL_RE.test(body.email)) errs.email = "Enter a valid email address.";
      const cp = phoneProblem(body.contactNumber); if (cp) errs.contactNumber = cp;
      const pp = passwordProblem(body.password); if (pp) errs.password = pp;
      if (!body.confirmPassword) errs.confirmPassword = "Confirm your password."; else if (body.confirmPassword !== body.password) errs.confirmPassword = "Passwords do not match.";
      if (body.restaurantMode === "existing") {
        body.restaurantId = s.value("restaurantId"); if (!body.restaurantId) errs.restaurantId = "Choose a restaurant from the list.";
      } else {
        Object.assign(body, { restaurantName: g("restaurantName"), restaurantContact: g("restaurantContact"), restaurantAddress: g("restaurantAddress"), municipality: s.value("municipality"), barangay: g("barangay"), category: s.value("category"), description: g("description") });
        if (body.restaurantName.length < 2) errs.restaurantName = "Enter the official restaurant name.";
        const rp = phoneProblem(body.restaurantContact); if (rp) errs.restaurantContact = rp.replace("a contact number", "the restaurant's contact number");
        if (body.restaurantAddress.length < 5) errs.restaurantAddress = "Enter the restaurant's street or landmark address.";
        if (!body.municipality) errs.municipality = "Choose the municipality in Siquijor.";
        if (body.barangay.length < 2) errs.barangay = "Enter the barangay.";
        if (!body.category) errs.category = "Choose a category.";
        if (body.description.length < 10) errs.description = "Describe the restaurant in at least 10 characters.";
      }
      if (!body.position) errs.position = "Choose your position at the restaurant.";
      if (body.permitNumber.length < 3) errs.permitNumber = "Enter your business permit or registration number.";
      if (Object.keys(errs).length) { s.showServerErrors(errs); s.banner("error", "Please fix the highlighted fields."); s.focusFirstInvalid(); return; }
      s.setLoading(true);
      const res = await ISLA.api("/api/staff-applications", { body });
      if (res.ok) {
        document.getElementById("applyBody").classList.add("hidden"); document.getElementById("doneBody").classList.remove("hidden");
        ISLA.refreshIcons(); window.scrollTo({ top: 0 }); document.querySelector("#doneBody h1").focus?.(); return;
      }
      s.setLoading(false); s.showServerErrors(res.data.fields);
      s.banner("error", res.data.error || "Could not submit the application. Please try again."); s.focusFirstInvalid();
    });
  }
})();
