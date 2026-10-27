/* ISLA-PLATEU shared UI helpers: toast, modal, confirm, formatting, notification bell, change-password dialog. */
(function () {
  "use strict";
  const App = {};
  const icon = (n, c = "") => `<i data-lucide="${n}" class="icon ${c}"></i>`;
  App.icon = icon;
  App.esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  App.api = (...a) => ISLA.api(...a);
  const TZ = "Asia/Manila";
  App.fmtSlot = (date, time) => {
    const [y, m, d] = date.split("-").map(Number); const [hh, mm] = time.split(":").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
    return dt.toLocaleDateString("en-PH", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) + " · " +
      dt.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  };
  App.fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString("en-PH", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: TZ }) : "";
  App.money = (n) => "₱" + Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  App.statusLabel = (s) => String(s).replace("_", " ");
  App.badge = (s) => `<span class="badge-status ${App.esc(s)}">${App.esc(App.statusLabel(s))}</span>`;
  App.stars = (n) => { const r = Math.round(Number(n) || 0); return `<span class="stars" role="img" aria-label="${r} out of 5 stars">${"★".repeat(r)}<span class="off">${"★".repeat(5 - r)}</span></span>`; };
  App.todayPH = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  App.refresh = () => window.ISLA && ISLA.refreshIcons();

  let toastEl, toastTimer;
  App.toast = (msg, kind = "") => {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "toast"; toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite"); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.className = "toast show " + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4200);
  };

  /* Modal: returns { el, body, close }. content is trusted HTML built with App.esc. */
  App.modal = ({ title, html, size = "", onClose }) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal " + size;
    dlg.innerHTML = `<div class="modal-inner"><div class="modal-head"><h2>${App.esc(title)}</h2>
      <button type="button" class="close-button" aria-label="Close" title="Close">${icon("x")}</button></div><div class="modal-body">${html}</div></div>`;
    document.body.appendChild(dlg);
    const close = () => { if (dlg.open) dlg.close(); };
    dlg.querySelector(".close-button").addEventListener("click", close);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
    dlg.addEventListener("close", () => { dlg.remove(); if (onClose) onClose(); });
    dlg.showModal(); App.refresh();
    return { el: dlg, body: dlg.querySelector(".modal-body"), close };
  };
  App.confirm = (message, { okLabel = "Confirm", danger = false, title = "Please confirm" } = {}) => new Promise((resolve) => {
    let answered = false;
    const m = App.modal({ title, size: "narrow", html: `<p class="modal-copy">${App.esc(message)}</p>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn ${danger ? "danger" : "btn-primary"}" type="button" data-yes>${App.esc(okLabel)}</button></div>`,
      onClose: () => { if (!answered) resolve(false); } });
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", () => { answered = true; resolve(true); m.close(); });
  });
  /* Ask for a short optional note */
  App.prompt = (title, label, { okLabel = "Save", required = false, maxLength = 300 } = {}) => new Promise((resolve) => {
    let answered = false;
    const m = App.modal({ title, size: "narrow", html: `<label class="form-field"><span>${App.esc(label)}</span><textarea maxlength="${maxLength}"></textarea></label>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>${App.esc(okLabel)}</button></div>`,
      onClose: () => { if (!answered) resolve(null); } });
    const ta = m.body.querySelector("textarea");
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", () => { if (required && !ta.value.trim()) { ta.focus(); return; } answered = true; resolve(ta.value.trim()); m.close(); });
    ta.focus();
  });
  App.showSecret = (title, intro, email, password) => {
    const m = App.modal({ title, size: "narrow", html: `<p class="modal-copy">${App.esc(intro)}</p>
      <div class="alert alert-info"><span><strong>${App.esc(email)}</strong><br>Temporary password: <code id="secretPw">${App.esc(password)}</code></span></div>
      <p class="hint">This password is shown only once. Share it securely and ask the user to change it after logging in.</p>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-copy>Copy password</button><button class="btn btn-primary" type="button" data-done>Done</button></div>` });
    m.body.querySelector("[data-copy]").addEventListener("click", async () => { try { await navigator.clipboard.writeText(password); App.toast("Password copied.", "success"); } catch { App.toast("Select and copy the password manually."); } });
    m.body.querySelector("[data-done]").addEventListener("click", () => m.close());
  };

  /* Tabs: container has .tabs buttons[data-tab] and panels .tab-panel[data-panel] */
  App.tabs = (root, onChange) => {
    const buttons = [...root.querySelectorAll(".tab")], panels = [...root.querySelectorAll(".tab-panel")];
    const show = (name, push = true) => {
      buttons.forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
      panels.forEach(p => { p.hidden = p.dataset.panel !== name; });
      if (push) history.replaceState(null, "", "#" + name);
      if (onChange) onChange(name);
    };
    buttons.forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
    const initial = location.hash.slice(1);
    show(buttons.some(b => b.dataset.tab === initial) ? initial : buttons[0].dataset.tab, false);
    return show;
  };

  /* Notification bell */
  App.initBell = (mount) => {
    mount.innerHTML = `<button class="bell-btn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" title="Notifications">${icon("bell")}<span class="bell-badge" hidden>0</span></button><div class="bell-panel" hidden></div>`;
    const btn = mount.querySelector(".bell-btn"), badge = mount.querySelector(".bell-badge"), panel = mount.querySelector(".bell-panel");
    App.refresh();
    async function load() {
      const r = await App.api("/api/notifications"); if (!r.ok) return;
      badge.hidden = r.data.unread === 0; badge.textContent = r.data.unread > 99 ? "99+" : r.data.unread;
      panel.innerHTML = `<h4>Notifications</h4>` + (r.data.items.length
        ? `<ul>${r.data.items.map(n => `<li class="${n.read ? "" : "unread"}">${App.esc(n.message)}<small>${App.esc(App.fmtDateTime(n.at))}</small></li>`).join("")}</ul>`
        : `<p class="muted" style="padding:10px 12px;font-size:14px">Nothing new yet. Reservation, order and message updates appear here.</p>`);
    }
    btn.addEventListener("click", async () => {
      const open = panel.hidden; panel.hidden = !open; btn.setAttribute("aria-expanded", String(open));
      if (open) { await load(); if (!badge.hidden) { await App.api("/api/notifications/read", { method: "POST", body: {} }); badge.hidden = true; } }
    });
    document.addEventListener("click", (e) => { if (!mount.contains(e.target)) { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
    load(); setInterval(() => { if (panel.hidden) load(); }, 45000);
  };

  App.changePassword = () => {
    const m = App.modal({ title: "Change password", size: "narrow", html: `<div id="cpAlert" class="alert alert-error hidden" role="alert"></div>
      <div class="stack"><label class="form-field"><span>Current password</span><input type="password" id="cpCur" autocomplete="current-password"></label>
      <label class="form-field"><span>New password</span><input type="password" id="cpNew" autocomplete="new-password"><small class="hint">8+ characters with a letter and a number.</small></label></div>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Update password</button></div>` });
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async () => {
      const r = await App.api("/api/me/password", { body: { currentPassword: m.body.querySelector("#cpCur").value, newPassword: m.body.querySelector("#cpNew").value } });
      if (r.ok) { m.close(); App.toast("Password updated.", "success"); return; }
      const a = m.body.querySelector("#cpAlert"); a.textContent = r.data.error || "Could not update the password."; a.classList.remove("hidden");
    });
  };
  document.addEventListener("click", (e) => { if (e.target.closest("[data-change-password]")) App.changePassword(); });

  /* Load the current user and fill the common header fields */
  App.requireUser = async (roles) => {
    const me = await App.api("/api/me");
    if (!me.ok) { location.replace("/login?expired=1"); return null; }
    if (roles && !roles.includes(me.data.user.role)) { location.replace("/map"); return null; }
    const n = document.getElementById("userName"), r = document.getElementById("userRole");
    if (n) n.textContent = me.data.user.fullName; if (r) r.textContent = ISLA.ROLE_LABEL[me.data.user.role];
    return me.data.user;
  };
  window.App = App;
})();
