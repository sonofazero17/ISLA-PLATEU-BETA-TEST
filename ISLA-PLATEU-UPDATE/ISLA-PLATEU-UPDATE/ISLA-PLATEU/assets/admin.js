/* Administrator dashboard: real statistics, restaurant management (with map preview), staff accounts. All actions are enforced by the server. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id), esc = App.esc, icon = App.icon;
  const me = await App.requireUser(["ADMINISTRATOR"]); if (!me) return;
  $("welcomeName").textContent = me.fullName;
  let restaurants = [];
  const BOUNDS = { latMin: 9.08, latMax: 9.36, lngMin: 123.43, lngMax: 123.67 };

  let tileCfg = null;   // same tile settings as the public map (OpenStreetMap by default)
  App.api("/api/config").then(r => { if (r.ok) tileCfg = r.data.tile; });
  async function fetchRestaurants() { const r = await App.api("/api/restaurants"); restaurants = r.ok ? r.data : []; return restaurants; }

  /* ---------- Overview ---------- */
  async function securityCard(root) {
    const r = await App.api("/api/admin/security-status"); if (!r.ok) return;
    const { email, captcha, accounts } = r.data, line = (ok, title, text) => `<li><span class="pill ${ok ? "ok" : "warn"}">${ok ? "On" : "Off"}</span> <strong>${title}</strong> <span class="muted">${text}</span></li>`;
    root.insertAdjacentHTML("beforeend", `<div class="card"><h2>Account protection</h2><ul class="line-items">
      ${line(email.enabled, "Email verification", email.enabled ? `Codes are sent from ${esc(email.from || "the configured address")} (${esc(email.provider)}). New sign-ups must verify before they can log in.` : `Not set up${email.problems && email.problems.length ? ` (missing ${esc(email.problems.join(", "))})` : ""}. New accounts can log in without verifying. See the README: Email verification.`)}
      ${line(captcha.enabled, "CAPTCHA (I'm not a robot)", captcha.enabled ? `Checked on the server for sign-up, staff applications, new-code requests and repeated failed logins (${esc(captcha.provider)}).` : "Not set up. Sign-up is not protected from automated registrations. See the README: CAPTCHA.")}
      <li><span class="muted">Accounts:</span> <strong>${accounts.verified}</strong> verified · <strong>${accounts.unverified}</strong> not verified${accounts.waitingToVerify ? ` · ${accounts.waitingToVerify} waiting to verify before they can log in` : ""}</li></ul></div>`);
  }
  async function loadOverview() {
    const r = await App.api("/api/admin/stats"), root = $("overviewRoot");
    if (!r.ok) { root.innerHTML = `<div class="empty-note">Could not load statistics.</div>`; return; }
    const s = r.data, stat = (ic, n, label, sub) => `<div class="stat"><span class="badge">${icon(ic)}</span><div><strong>${n}</strong><span>${label}${sub ? `<br><small>${sub}</small>` : ""}</span></div></div>`;
    const breakdown = (obj) => Object.keys(obj).length ? Object.entries(obj).map(([k, n]) => `<li><span>${App.badge(k)}</span><strong>${n}</strong></li>`).join("") : `<li class="muted">None yet</li>`;
    root.innerHTML = (s.storage && s.storage.warning ? `<div class="alert alert-error" role="alert">${icon("circle-alert")}<span><strong>Data is not being kept safely.</strong> ${esc(s.storage.warning)}</span></div>` : "") + `<div class="stat-grid">
        ${stat("user-round", s.users.total, "Registered accounts", `${s.users.byRole.CUSTOMER} customers · ${s.users.byRole.RESTAURANT_STAFF} staff · ${s.users.byRole.ADMINISTRATOR} admins${s.users.disabled ? ` · ${s.users.disabled} disabled` : ""}`)}
        ${stat("circle-check", s.sessions.activeLast15Min, "Active in the last 15 minutes", "Signed-in users who made a request recently")}
        ${stat("log-in", s.sessions.signedIn, "Signed-in users", "Unexpired sessions (may include idle users)")}
        ${stat("user-plus", s.applications.pending, "Staff applications waiting", `${s.applications.approved} approved · ${s.applications.rejected} rejected`)}
        ${stat("utensils", s.restaurants.total, "Restaurants", `${s.restaurants.withMapPin} with a map pin`)}
        ${stat("clock", s.reservations.total, "Reservation requests")}
        ${stat("bell", s.orders.total, "Advance orders")}
        ${stat("circle-check", s.reviews.total, "Customer reviews")}
      </div>
      <div class="two-col"><div class="card"><h2>Reservations by status</h2><ul class="line-items">${breakdown(s.reservations.byStatus)}</ul></div>
      <div class="card"><h2>Advance orders by status</h2><ul class="line-items">${breakdown(s.orders.byStatus)}</ul></div></div>
      <div class="card"><h2>Database backup</h2><p>Download a copy of the database (accounts, restaurants, reservations, orders, payments). It does <strong>not</strong> include uploaded photos, verification documents, receipts or QR codes: those are in the uploads folder next to the database, so copy that folder as well (the backup script in the README does both). Keep every backup private: it contains personal data and password hashes, and it must never be committed to GitHub.</p>
        <div class="card-actions"><a class="btn btn-quiet" href="/api/admin/backup" download>${icon("arrow-right")} Download backup</a></div></div>
      <p class="hint">All figures are counted from the database when this page loads. Not tracked: ${s.notTracked.map(esc).join("; ")}.</p>`;
    await securityCard(root);
    await attentionCard(root);
    App.refresh();
  }


  /* ---------- Staff applications ---------- */
  let appFilter = "pending";
  function setAppCount(n) { const el = $("cApps"); el.hidden = !n; el.textContent = n; }
  let appSeq = 0;
  async function loadApplications() {
    const seq = ++appSeq;                                   // ignore slower, older responses so a stale list never overwrites the current view
    const [r] = await Promise.all([App.api(`/api/admin/applications?status=${appFilter}`), fetchRestaurants()]), root = $("appsRoot");
    if (seq !== appSeq) return;
    if (!r.ok) { root.innerHTML = `<div class="empty-note">${esc(r.data.error || "Could not load applications.")}</div>`; return; }
    const c = r.data.counts; setAppCount(c.pending);
    const restName = (id) => (restaurants.find(x => x.id === id) || {}).name;
    const row = (label, v) => v ? `<div class="detail-row"><div><small>${label}</small><div>${esc(v)}</div></div></div>` : "";
    root.innerHTML = `<div class="toolbar"><label class="muted">Show <select id="appFilter">${[["pending", `Pending (${c.pending})`], ["approved", `Approved (${c.approved})`], ["rejected", `Rejected (${c.rejected})`], ["all", "All"]].map(([v, t]) => `<option value="${v}" ${v === appFilter ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      <span class="muted">Applicants cannot log in as staff until an administrator approves them.</span></div>
      <div class="stack">${r.data.applications.length ? r.data.applications.map(a => `<article class="item-card" data-app-card="${a.id}">
        <div class="item-head"><div><h3>${esc(a.applicantName)}</h3><div class="item-meta">${esc(a.applicantEmail)} · ${esc(a.contactNumber)} · submitted ${esc(App.fmtDateTime(a.submittedAt))}</div></div>${App.badge(a.status.toUpperCase())}</div>
        <div class="detail-grid" style="margin-top:12px">
          ${row(a.isNewRestaurant ? "Requested restaurant (new)" : "Requested restaurant (already listed)", a.isNewRestaurant ? a.restaurantName : (restName(a.restaurantId) || a.restaurantName))}
          ${row("Location", [a.barangay && "Brgy. " + a.barangay, a.municipality].filter(Boolean).join(", "))}
          ${row("Address", a.address)}${row("Restaurant contact", a.restaurantContact)}${row("Category", a.isNewRestaurant ? a.category : "")}
          ${row("Applicant position", a.position)}${row("Business permit / registration no.", a.permitNumber)}
        </div>
        ${a.isNewRestaurant && a.description ? `<p class="item-body"><strong>Description:</strong> ${esc(a.description)}</p>` : ""}
        ${a.note ? `<p class="item-body"><strong>Applicant note:</strong> ${esc(a.note)}</p>` : ""}
        ${!a.isNewRestaurant && a.status === "pending" ? `<p class="hint">${a.restaurantStaffCount} staff member${a.restaurantStaffCount === 1 ? " is" : "s are"} already assigned to this restaurant. Check the applicant is entitled to join.</p>` : ""}
        ${a.status === "approved" ? `<p class="item-body"><strong>Approved</strong> by ${esc(a.reviewedBy || "an administrator")} on ${esc(App.fmtDateTime(a.reviewedAt))}. Staff account belongs to <strong>${esc(restName(a.restaurantId) || a.restaurantName)}</strong>.</p>` : ""}
        ${a.status === "rejected" ? `<p class="item-body"><strong>Rejected</strong> by ${esc(a.reviewedBy || "an administrator")} on ${esc(App.fmtDateTime(a.reviewedAt))}. Reason shown to applicant: ${esc(a.reviewNote)}</p>` : ""}
        <div class="item-actions">
          ${a.status === "pending" ? `<button class="btn btn-primary small" data-app-approve="${a.id}">${icon("circle-check")} Approve</button><button class="btn btn-quiet small" data-app-reject="${a.id}">${icon("x")} Reject</button>` : ""}
          ${a.status === "rejected" ? `<button class="btn btn-quiet small" data-app-reopen="${a.id}">Reconsider (back to pending)</button>` : ""}
        </div></article>`).join("") : `<div class="empty-note">No ${appFilter === "all" ? "" : esc(appFilter) + " "}applications.</div>`}</div>`;
    App.refresh();
  }
  document.addEventListener("change", (e) => { if (e.target.id === "appFilter") { appFilter = e.target.value; loadApplications(); } });
  document.addEventListener("click", async (e) => {
    const ap = e.target.closest("[data-app-approve]"), rj = e.target.closest("[data-app-reject]"), ro = e.target.closest("[data-app-reopen]");
    const done = (r, ok) => { App.toast(r.ok ? ok : r.data.error, r.ok ? "success" : "error"); loadApplications(); loadOverview(); };
    const card = (id) => (document.querySelector(`[data-app-card="${id}"]`) || { querySelector: () => null });
    if (ap) {
      const name = card(ap.dataset.appApprove).querySelector("h3")?.textContent || "this applicant";
      if (await App.confirm(`Approve ${name}? Their staff account will be activated and assigned to the requested restaurant (a new restaurant record is created if it is not listed yet).`, { okLabel: "Approve", title: "Approve application" }))
        done(await App.api(`/api/admin/applications/${ap.dataset.appApprove}/approve`, { body: { confirm: true } }), "Application approved. The staff account is now active.");
    }
    if (rj) {
      const note = await App.prompt("Reject application", "Reason (shown to the applicant when they try to log in)", { okLabel: "Reject application", required: true });
      if (note !== null && await App.confirm("Reject this application? The applicant will not be able to log in as staff. The record is kept for review.", { okLabel: "Reject", danger: true, title: "Confirm rejection" }))
        done(await App.api(`/api/admin/applications/${rj.dataset.appReject}/reject`, { body: { confirm: true, note } }), "Application rejected. The record was kept.");
    }
    if (ro && await App.confirm("Move this application back to pending so it can be reviewed again?", { okLabel: "Reconsider" }))
      done(await App.api(`/api/admin/applications/${ro.dataset.appReopen}/reopen`, { body: { confirm: true } }), "Application is pending again.");
  });

  /* ---------- Restaurants ---------- */
  async function loadRestaurants() {
    await fetchRestaurants();
    $("restRoot").innerHTML = `<div class="toolbar"><span class="muted">${restaurants.length} restaurants</span><button class="btn btn-primary" id="addRest">${icon("plus")} Add restaurant</button></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Municipality</th><th>Category</th><th>Map pin</th><th>Rating</th><th></th></tr></thead><tbody>${restaurants.map(r => `<tr>
        <td><strong>${esc(r.name)}</strong></td><td>${esc(r.municipality)}</td><td>${esc(r.category)}</td>
        <td>${r.lat !== null ? `<span class="pill ${r.locationStatus === "verified" ? "ok" : "warn"}">${r.locationStatus === "verified" ? "VERIFIED" : "APPROXIMATE"}</span>` : `<span class="pill warn">PENDING</span>`}</td>
        <td>${r.ratingCount ? `${App.stars(r.ratingAvg)} ${esc(r.ratingAvg)} (${r.ratingCount})` : `<span class="muted">–</span>`}</td>
        <td><div class="item-actions"><button class="btn btn-quiet small" data-rest-overview="${esc(r.id)}">Overview</button><button class="btn btn-quiet small" data-edit="${esc(r.id)}">Edit</button><button class="btn btn-quiet small" data-del="${esc(r.id)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>`;
    App.refresh();
  }
  function restaurantForm(r) {
    const v = r || {}, isNew = !r;
    const m = App.modal({ title: isNew ? "Add restaurant" : `Edit ${v.name}`, size: "wide", html: `<div class="alert alert-error hidden" id="rfAlert" role="alert"></div>
      <div class="form-grid">
        <label class="form-field"><span>Name <b>*</b></span><input id="rfName" maxlength="100" value="${esc(v.name || "")}"></label>
        <label class="form-field"><span>Municipality</span><input id="rfMun" maxlength="60" value="${esc(v.municipality || "")}" list="munList"></label>
        <label class="form-field"><span>Category <b>*</b></span><input id="rfCat" maxlength="40" value="${esc(v.category || "Restaurant")}" list="catList"></label>
        <label class="form-field"><span>Contact</span><input id="rfContact" maxlength="80" value="${esc(v.contact || "")}"></label>
        <label class="form-field full"><span>Address</span><input id="rfAddr" maxlength="200" value="${esc(v.address || "")}"></label>
        <label class="form-field"><span>Operating hours</span><input id="rfHours" maxlength="120" value="${esc(v.hours || "")}"></label>
        <label class="form-field"><span>Max guests per reservation time (optional)</span><input id="rfCap" type="number" min="1" max="500" value="${v.reservationCapacity ?? ""}"></label>
        <label class="form-field full"><span>Description</span><textarea id="rfDesc" maxlength="1000">${esc(v.description || "")}</textarea></label>
        <label class="form-field full"><span>Internal / data-accuracy note</span><textarea id="rfNotes" maxlength="500">${esc(v.notes || "")}</textarea></label>
        <div class="form-field full"><span>Options</span><div class="inline-fields">
          <label class="check-line"><input type="checkbox" id="rfRes" ${v.acceptsReservations !== false ? "checked" : ""}> Accept reservations</label>
          <label class="check-line"><input type="checkbox" id="rfOrd" ${v.ordersEnabled ? "checked" : ""}> Allow advance orders</label></div></div>
      </div>
      <datalist id="munList">${[...new Set(restaurants.map(x => x.municipality).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join("")}</datalist>
      <datalist id="catList">${[...new Set(restaurants.map(x => x.category).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join("")}</datalist>
      <div class="location-picker"><div><strong>Map location</strong><p id="pinInfo"></p></div><button class="btn btn-quiet small" type="button" id="clearPin">Clear pin</button></div>
      <div id="pickerMap" class="picker-map" aria-label="Map for choosing the restaurant location"></div>
      <div class="form-grid" style="margin-top:12px">
        <label class="form-field"><span>Latitude</span><input id="rfLat" inputmode="decimal" value="${v.lat ?? ""}" placeholder="e.g. 9.2"></label>
        <label class="form-field"><span>Longitude</span><input id="rfLng" inputmode="decimal" value="${v.lng ?? ""}" placeholder="e.g. 123.5"></label>
        <label class="check-line full"><input type="checkbox" id="rfVer" ${v.verified ? "checked" : ""}> I checked this pin against the real location (mark as verified)</label>
      </div>
      <p class="form-hint">Click the map to place the pin (or drag it). Coordinates must be inside Siquijor. Leave them empty if the exact location is not known yet; the restaurant will then show as "pin pending".</p>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>${isNew ? "Add restaurant" : "Save changes"}</button></div>` });
    const b = m.body, g = (id) => b.querySelector("#" + id);
    const inBounds = (la, ln) => la >= BOUNDS.latMin && la <= BOUNDS.latMax && ln >= BOUNDS.lngMin && ln <= BOUNDS.lngMax;
    let map = null, marker = null;
    const info = (t, warn) => { const p = g("pinInfo"); p.textContent = t; p.style.color = warn ? "var(--danger)" : ""; };
    function syncMarker(fly) {
      const la = parseFloat(g("rfLat").value), ln = parseFloat(g("rfLng").value);
      if (!Number.isFinite(la) || !Number.isFinite(ln)) { if (marker && map) { map.removeLayer(marker); marker = null; } info(g("rfLat").value || g("rfLng").value ? "Enter both latitude and longitude." : "No pin set (pin pending).", !!(g("rfLat").value || g("rfLng").value)); return; }
      if (!inBounds(la, ln)) { info("These coordinates are outside Siquijor.", true); return; }
      info(`Pin at ${la.toFixed(6)}, ${ln.toFixed(6)}`);
      if (!map) return;
      if (!marker) { marker = L.marker([la, ln], { draggable: true }).addTo(map); marker.on("dragend", () => { const p = marker.getLatLng(); g("rfLat").value = p.lat.toFixed(6); g("rfLng").value = p.lng.toFixed(6); syncMarker(false); }); }
      else marker.setLatLng([la, ln]);
      if (fly) map.setView([la, ln], 16);
    }
    if (typeof L !== "undefined") {
      setTimeout(() => {
        map = L.map(g("pickerMap"), { minZoom: 9, maxZoom: 18 }).setView([9.20, 123.52], 11);
        const tc = tileCfg || { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" };
        L.tileLayer(tc.url, { maxZoom: tc.maxZoom || 19, attribution: tc.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(map);
        map.on("click", (e) => { g("rfLat").value = e.latlng.lat.toFixed(6); g("rfLng").value = e.latlng.lng.toFixed(6); syncMarker(false); });
        map.invalidateSize(); syncMarker(true);
      }, 120);
    } else { g("pickerMap").innerHTML = `<div class="empty-note">The map library could not be loaded. You can still type coordinates.</div>`; }
    ["rfLat", "rfLng"].forEach(id => g(id).addEventListener("input", () => syncMarker(false)));
    g("clearPin").addEventListener("click", () => { g("rfLat").value = ""; g("rfLng").value = ""; g("rfVer").checked = false; syncMarker(false); });
    syncMarker(false);
    b.querySelector("[data-no]").addEventListener("click", () => m.close());
    b.querySelector("[data-yes]").addEventListener("click", async (e) => {
      const lat = g("rfLat").value.trim(), lng = g("rfLng").value.trim(), cap = g("rfCap").value.trim();
      const body = { name: g("rfName").value, municipality: g("rfMun").value, category: g("rfCat").value, contact: g("rfContact").value, address: g("rfAddr").value,
        hours: g("rfHours").value, description: g("rfDesc").value, notes: g("rfNotes").value, lat: lat === "" ? null : Number(lat), lng: lng === "" ? null : Number(lng),
        verified: g("rfVer").checked, acceptsReservations: g("rfRes").checked, acceptsOrders: g("rfOrd").checked, reservationCapacity: cap === "" ? null : Number(cap) };
      const btn = e.currentTarget; btn.disabled = true;
      const res = await App.api(isNew ? "/api/admin/restaurants" : `/api/admin/restaurants/${encodeURIComponent(v.id)}`, { method: isNew ? "POST" : "PUT", body });
      btn.disabled = false;
      if (res.ok) { m.close(); App.toast(isNew ? "Restaurant added. It is now on the public map." : "Restaurant updated.", "success"); loadRestaurants(); loadOverview(); }
      else { const a = g("rfAlert"); a.textContent = res.data.error || "Could not save."; a.classList.remove("hidden"); a.scrollIntoView({ block: "nearest" }); }
    });
  }
  function deleteDialog(r) {
    const m = App.modal({ title: `Delete ${r.name}?`, size: "narrow", html: `<div class="alert alert-error"><span>This permanently removes the restaurant from the map <strong>and</strong> deletes its reservations, advance orders, reviews, menu and messages. Staff assigned to it become unassigned. This cannot be undone.</span></div>
      <label class="form-field" style="margin-top:12px"><span>Type the restaurant name to confirm: <strong>${esc(r.name)}</strong></span><input id="delName" autocomplete="off"></label><p class="field-error" id="delErr"></p>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn danger" type="button" data-yes>Delete restaurant</button></div>` });
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async () => {
      const res = await App.api(`/api/admin/restaurants/${encodeURIComponent(r.id)}`, { method: "DELETE", body: { confirmName: m.body.querySelector("#delName").value } });
      if (res.ok) { m.close(); App.toast(`${r.name} deleted.`, "success"); loadRestaurants(); loadOverview(); } else m.body.querySelector("#delErr").textContent = res.data.error;
    });
  }
  document.addEventListener("click", async (e) => {
    if (e.target.closest("#addRest")) restaurantForm(null);
    const ed = e.target.closest("[data-edit]"), dl = e.target.closest("[data-del]");
    if (ed) { const res = await App.api(`/api/restaurants/${encodeURIComponent(ed.dataset.edit)}`); if (res.ok) restaurantForm(res.data.restaurant); }
    if (dl) deleteDialog(restaurants.find(r => r.id === dl.dataset.del));
  });

  /* ---------- Staff & accounts ---------- */
  let acct = { role: "all", status: "all", verified: "all", q: "" };
  async function loadAccounts() {
    await fetchRestaurants();
    const aq = new URLSearchParams(); for (const [k, v] of Object.entries(acct)) if (v && v !== "all") aq.set(k, v);
    const r = await App.api(`/api/admin/users?${aq}`), root = $("acctRoot"); if (!r.ok) { root.innerHTML = `<div class="empty-note">Could not load accounts.</div>`; return; }
    const tag = { ADMINISTRATOR: "admin", RESTAURANT_STAFF: "staff", CUSTOMER: "" };
    root.innerHTML = `<div class="card"><h2>Create a restaurant staff account</h2><p>Staff accounts can only be created here. The account gets a one-time temporary password.</p>
      <div class="alert alert-error hidden" id="stAlert" role="alert"></div>
      <form id="staffForm" class="form-grid"><label class="form-field"><span>Full name</span><input id="stName" maxlength="80" required></label>
        <label class="form-field"><span>Email</span><input id="stEmail" type="email" required></label>
        <label class="form-field"><span>Restaurant</span><select id="stRest" required><option value="">Choose a restaurant…</option>${restaurants.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>
        <div class="form-field" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">${icon("user-plus")} Create staff account</button></div></form></div>
      <div class="form-grid mon-filters"><label class="form-field"><span>Role</span><select data-acf="role">${[["all", "All roles"], ["CUSTOMER", "Customers"], ["RESTAURANT_STAFF", "Restaurant staff"], ["ADMINISTRATOR", "Administrators"]].map(([v, l]) => `<option value="${v}" ${acct.role === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="form-field"><span>Account status</span><select data-acf="status">${[["all", "Any status"], ["ACTIVE", "Active"], ["DISABLED", "Disabled"], ["PENDING", "Pending"], ["REJECTED", "Rejected"]].map(([v, l]) => `<option value="${v}" ${acct.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="form-field"><span>Email verification</span><select data-acf="verified">${[["all", "Any"], ["yes", "Verified"], ["no", "Not verified"], ["waiting", "Waiting to verify (cannot log in yet)"]].map(([v, l]) => `<option value="${v}" ${acct.verified === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="form-field"><span>Search (name, email, restaurant)</span><input data-acf="q" value="${esc(acct.q)}" maxlength="80" placeholder="Type, then press Enter"></label></div>
      <div class="toolbar"><span class="muted">${r.data.total} shown of ${r.data.counts.all} accounts · ${r.data.counts.verified} verified · ${r.data.counts.notVerified} not verified${r.data.counts.waiting ? ` · ${r.data.counts.waiting} waiting to verify` : ""}</span></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email / phone</th><th>Role</th><th>Restaurant</th><th>Status</th><th>Email</th><th></th></tr></thead><tbody>${r.data.users.map(u => `<tr>
        <td>${esc(u.fullName)}${u.email === me.email ? ' <small class="muted">(you)</small>' : ""}</td><td>${esc(u.email)}${u.contactNumber ? `<br><small class="muted">${esc(u.contactNumber)}</small>` : ""}</td>
        <td><span class="role-tag ${tag[u.role]}">${esc(ISLA.ROLE_LABEL[u.role])}</span></td><td>${esc(u.restaurantName || (u.role === "RESTAURANT_STAFF" ? "Unassigned" : "–"))}</td><td>${App.badge(u.status)}</td>
        <td>${u.emailVerified ? `<span class="pill ok" title="${esc(App.fmtDateTime(u.emailVerifiedAt))}">Verified</span>` : u.verificationRequired ? `<span class="pill warn">Waiting to verify</span>` : `<span class="pill">Not verified</span>`}</td>
        <td><div class="item-actions">${!u.emailVerified && ["ACTIVE", "PENDING"].includes(u.status) ? `<button class="btn btn-quiet small" data-send-code="${u.id}" data-name="${esc(u.fullName)}">Send code</button>` : ""}${u.role === "RESTAURANT_STAFF" ? `<button class="btn btn-quiet small" data-assign="${u.id}" data-name="${esc(u.fullName)}" data-rest="${esc(u.restaurantId || "")}">Assign</button>` : ""}
          ${["PENDING", "REJECTED"].includes(u.status) ? `<small class="muted">See Staff applications</small>` : ""}
          ${u.email !== me.email && !["PENDING", "REJECTED"].includes(u.status) ? `<button class="btn btn-quiet small" data-toggle="${u.id}" data-status="${u.status === "ACTIVE" ? "DISABLED" : "ACTIVE"}" data-name="${esc(u.fullName)}">${u.status === "ACTIVE" ? "Disable" : "Enable"}</button>` : ""}
          <button class="btn btn-quiet small" data-reset="${u.id}" data-name="${esc(u.fullName)}">Reset password</button></div></td></tr>`).join("")}</tbody></table></div>`;
    App.refresh();
  }
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "staffForm") return; e.preventDefault();
    const res = await App.api("/api/admin/staff", { body: { fullName: $("stName").value, email: $("stEmail").value, restaurantId: $("stRest").value } });
    if (res.ok) { App.showSecret("Staff account created", "Give these sign-in details to the staff member.", res.data.email, res.data.temporaryPassword); loadAccounts(); loadOverview(); }
    else { const a = $("stAlert"); a.textContent = res.data.error; a.classList.remove("hidden"); }
  });
  document.addEventListener("click", async (e) => {
    const as = e.target.closest("[data-assign]"), tg = e.target.closest("[data-toggle]"), rs = e.target.closest("[data-reset]");
    if (as) {
      const m = App.modal({ title: `Assign ${as.dataset.name}`, size: "narrow", html: `<label class="form-field"><span>Restaurant</span><select id="asRest"><option value="">Unassigned</option>${restaurants.map(x => `<option value="${esc(x.id)}" ${x.id === as.dataset.rest ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
        <div class="modal-actions"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes>Save</button></div>` });
      m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
      m.body.querySelector("[data-yes]").addEventListener("click", async () => { const v = m.body.querySelector("#asRest").value; const r = await App.api(`/api/admin/users/${as.dataset.assign}`, { method: "PATCH", body: { restaurantId: v === "" ? null : v } }); m.close(); App.toast(r.ok ? "Assignment updated." : r.data.error, r.ok ? "success" : "error"); loadAccounts(); });
    }
    if (tg && await App.confirm(`${tg.dataset.status === "DISABLED" ? "Disable" : "Enable"} ${tg.dataset.name}'s account?${tg.dataset.status === "DISABLED" ? " They will be signed out immediately." : ""}`, { okLabel: tg.dataset.status === "DISABLED" ? "Disable" : "Enable", danger: tg.dataset.status === "DISABLED" })) {
      const r = await App.api(`/api/admin/users/${tg.dataset.toggle}`, { method: "PATCH", body: { status: tg.dataset.status } }); App.toast(r.ok ? "Account updated." : r.data.error, r.ok ? "success" : "error"); loadAccounts(); loadOverview();
    }
    if (rs && await App.confirm(`Reset ${rs.dataset.name}'s password? They will be signed out and need the new temporary password.`, { okLabel: "Reset password" })) {
      const r = await App.api(`/api/admin/users/${rs.dataset.reset}/reset-password`, { method: "POST", body: {} });
      if (r.ok) App.showSecret("Password reset", "Share the new temporary password securely.", r.data.email, r.data.temporaryPassword); else App.toast(r.data.error, "error");
    }
  });

  App.api("/api/admin/applications?status=pending").then(r => { if (r.ok) setAppCount(r.data.counts.pending); });

  /* ---------- Location requests (review evidence, approve / reject / ask for more) ---------- */
  const LOC_STATUS = { PENDING: ["Pending", "warn"], UNDER_REVIEW: ["Under review", "warn"], APPROVED: ["Approved", "ok"], REJECTED: ["Rejected", "warn"], NEEDS_EVIDENCE: ["Needs evidence", "warn"] };
  let locFilter = "open";
  async function loadLocationRequests() {
    const root = $("locReqRoot");
    const r = await App.api(`/api/admin/location-requests?status=${encodeURIComponent(locFilter)}`);
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load requests.")}</span></div>`; return; }
    const rows = r.data;
    const open = locFilter === "open" ? rows.length : null;
    const badge = $("cLoc"); if (open !== null) { badge.textContent = open; badge.hidden = !open; }
    root.innerHTML = `<div class="toolbar"><label class="muted">Show <select id="locFilter">${[["open", "Needs action"], ["all", "All"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"]].map(([v, l]) => `<option value="${v}" ${locFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Submitted by</th><th>Status</th><th>Documents</th><th>Submitted</th><th></th></tr></thead><tbody>${rows.map(q => `<tr><td>${esc(q.restaurantName)}<br><small class="muted">${esc(q.address)}</small></td><td>${esc(q.submitter)}</td>
        <td><span class="pill ${LOC_STATUS[q.status][1]}">${esc(LOC_STATUS[q.status][0])}</span></td><td>${q.documentCount}</td><td>${esc(App.fmtDateTime(q.submittedAt))}</td><td><button class="btn btn-quiet small" data-loc-review="${q.id}">Review</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">No location requests here.</div>`}`;
    $("locFilter").addEventListener("change", (e) => { locFilter = e.target.value; loadLocationRequests(); });
    App.refresh();
  }
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  async function reviewLocation(id) {
    const r = await App.api(`/api/admin/location-requests/${id}`);
    if (!r.ok) { App.toast(r.data.error, "error"); return; }
    const { request: q, restaurant: rs, submitter, documents, kinds, history } = r.data, st = LOC_STATUS[q.status];
    const decidable = ["PENDING", "UNDER_REVIEW"].includes(q.status);
    const m = App.modal({ title: `Location request: ${rs.name}`, size: "wide", html: `
      <p><span class="pill ${st[1]}">${esc(st[0])}</span> Submitted ${esc(App.fmtDateTime(q.submittedAt))} by ${esc(submitter ? submitter.name + " (" + submitter.email + ")" : "unknown")}</p>
      ${q.reviewNote ? `<p class="hint">Last note: ${esc(q.reviewNote)}</p>` : ""}
      <div class="two-col">
        <div><h3 class="detail-h">Requested pin</h3><div id="lrMap" class="loc-picker"></div>
          <p><strong>${esc(q.lat)}, ${esc(q.lng)}</strong><br>${esc(q.address)}</p>
          <p class="muted">Contact: ${esc(q.contactPhone)}${q.businessContact ? " · " + esc(q.businessContact) : ""}</p>
          <p class="muted">Current public pin: ${rs.lat !== null ? esc(rs.lat + ", " + rs.lng) + " (" + esc(rs.locationStatus) + ")" : "none"}</p></div>
        <div><h3 class="detail-h">Restaurant profile</h3>
          ${rs.logo ? `<img src="${esc(rs.logo)}" alt="" class="food-thumb" style="width:64px;height:64px">` : ""}
          <p><strong>${esc(rs.name)}</strong> · ${esc(rs.category)}<br>${esc([rs.address, rs.municipality].filter(Boolean).join(", "))}</p>
          ${rs.cover ? `<img src="${esc(rs.cover)}" alt="" style="width:100%;border-radius:10px;max-height:140px;object-fit:cover">` : ""}
          <p class="muted">${esc(rs.description || "No description")}</p><p class="muted">Hours: ${esc(rs.hours || "not set")} · Contact: ${esc(rs.contact || "not set")}</p></div></div>
      <h3 class="detail-h">Evidence (private, visible only to administrators and the restaurant's staff)</h3>
      ${documents.length ? `<ul class="line-items">${documents.map(d => `<li><span>${esc(kinds[d.kind])}: <a href="/api/admin/location-documents/${d.id}/file" target="_blank" rel="noopener">${esc(d.name || "file")}</a> <small class="muted">${esc(d.mime)} · ${fmtSize(d.size)}</small></span></li>`).join("")}</ul>` : `<p class="empty-note">No documents.</p>`}
      <p class="hint">Photos alone do not prove ownership. Check the permit and registration details, that the signage matches the restaurant, and that the person is authorized to represent it. PDFs download instead of opening in the browser.</p>
      ${history.length ? `<h3 class="detail-h">History</h3><ul class="line-items">${history.map(h => `<li><span>${esc(h.action.replace("location_request.", "").replace("_", " "))} by ${esc(h.by)}</span><small class="muted">${esc(App.fmtDateTime(h.at))}</small></li>`).join("")}</ul>` : ""}
      ${decidable ? `<div class="modal-actions" style="flex-wrap:wrap">${q.status === "PENDING" ? `<button class="btn btn-quiet" data-dec="UNDER_REVIEW">Mark under review</button>` : ""}<button class="btn btn-quiet" data-dec="NEEDS_EVIDENCE">Request more evidence</button><button class="btn btn-quiet" data-dec="REJECTED">Reject</button><button class="btn btn-primary" data-dec="APPROVED">Approve location</button></div>` : ""}` });
    if (typeof L !== "undefined") setTimeout(() => {
      const map = L.map(m.body.querySelector("#lrMap"), { minZoom: 9, maxZoom: 18 }).setView([q.lat, q.lng], 16);
      const tc = tileCfg || { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" };
      L.tileLayer(tc.url, { maxZoom: tc.maxZoom || 19, attribution: tc.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(map);
      L.marker([q.lat, q.lng]).addTo(map); map.invalidateSize();
    }, 150);
    m.body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-dec]"); if (!b) return;
      const decision = b.dataset.dec; let note = "";
      if (decision === "APPROVED" && !(await App.confirm(`Approve this location? ${rs.name} will appear on the public map at ${q.lat}, ${q.lng}.`, { okLabel: "Approve" }))) return;
      if (decision === "REJECTED" || decision === "NEEDS_EVIDENCE") { note = await App.prompt(decision === "REJECTED" ? "Reject request" : "Request more evidence", "Message to the restaurant (required)", { okLabel: "Send", required: true, maxLength: 500 }); if (note === null) return; }
      const res = await App.api(`/api/admin/location-requests/${id}/decision`, { body: { decision, note } });
      App.toast(res.ok ? "Decision recorded. The restaurant was notified." : res.data.error, res.ok ? "success" : "error");
      if (res.ok) { m.close(); loadLocationRequests(); fetchRestaurants(); }
    });
  }
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-loc-review]"); if (b) reviewLocation(b.dataset.locReview); });


  /* ---------- Fees & taxes (nothing is charged until an administrator adds it) ---------- */
  const BASE_LABEL = { FOOD: "the restaurant's charge (food or reservation fee)", RESTAURANT_TOTAL: "the restaurant's whole total (charge, fees and taxes)", SERVICE_FEES: "the ISLA-PLATEU service fees", FOOD_AND_FEES: "the charge plus the restaurant's fees" };
  const KIND_LABEL = { SERVICE_FEE: "ISLA-PLATEU service fee", SYSTEM_TAX: "Government tax (system)", FEE: "Restaurant fee", TAX: "Government tax (restaurant)" };
  const APPLIES_LABEL = { ORDER: "Orders", RESERVATION: "Reservations", BOTH: "Orders and reservations" };
  const amountText = (l) => l.calc === "PERCENT" ? `${l.value}%` : App.money(l.value);
  let feeLines = [];
  const monthStart = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 8) + "01", todayPH = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  async function loadFees() {
    const root = $("feeRoot"), [r, led] = await Promise.all([App.api("/api/admin/fee-settings"), App.api(`/api/admin/fee-ledger?from=${monthStart()}&to=${todayPH()}`), fetchRestaurants()]);
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load fee settings.")}</span></div>`; return; }
    feeLines = r.data.lines;
    root.innerHTML = `<div class="alert alert-info"><span><strong>Nothing is charged until you add it here.</strong> ISLA-PLATEU does not supply tax rates or legal advice. Enter a fee or tax only after confirming the requirement and the rate with your legal and accounting advisers. Customers always see every line separately before they pay.</span></div>
      <div class="card"><div class="item-head"><h2>ISLA-PLATEU service fee and system taxes</h2><button class="btn btn-primary small" data-fee-edit="new">${icon("plus")} Add line</button></div>
        ${feeLines.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Amount</th><th>Calculated on</th><th>Applies to</th><th>Status</th><th></th></tr></thead><tbody>${feeLines.map(l => `<tr><td>${esc(l.label)}${l.basisNote ? `<br><small class="muted">Basis: ${esc(l.basisNote)}</small>` : ""}${l.verifiedAt ? `<br><small class="muted">Verified ${esc(App.fmtDateTime(l.verifiedAt))}</small>` : ""}</td><td>${esc(KIND_LABEL[l.kind])}</td><td>${esc(amountText(l))}</td><td><small>${esc(BASE_LABEL[l.base])}</small></td><td>${esc(APPLIES_LABEL[l.appliesTo])}</td>
          <td><span class="pill ${l.active ? "ok" : ""}">${l.active ? "Active" : "Off"}</span></td><td><div class="item-actions"><button class="btn btn-quiet small" data-fee-edit="${l.id}">Edit</button><button class="btn btn-quiet small" data-fee-del="${l.id}" data-name="${esc(l.label)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">No service fee or system tax is configured, so customers pay only what the restaurant charges.</div>`}</div>
      <div class="card"><h2>Check a calculation</h2><p>See exactly what a customer would be shown for a sample amount.</p>
        <div class="form-grid"><label class="form-field"><span>For</span><select id="pvKind"><option value="ORDER">An advance order</option><option value="RESERVATION">A reservation fee</option></select></label>
          <label class="form-field"><span>Sample restaurant charge (₱)</span><input id="pvAmount" type="number" min="1" step="0.01" value="500"></label>
          <label class="form-field"><span>Include a restaurant's own charges</span><select id="pvRest"><option value="">None (platform lines only)</option>${restaurants.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>
          <div class="form-field"><span>&nbsp;</span><button class="btn btn-quiet" id="pvGo" type="button">Calculate</button></div></div><div id="pvOut"></div></div>
      <div class="card"><h2>Fees and taxes collected through accepted payments</h2>
        <p class="hint">Customers pay the restaurant's own GCash. ISLA-PLATEU never receives this money, so the ISLA-PLATEU lines below are amounts to settle with each restaurant. Refunded payments are excluded.</p>
        <div class="form-grid"><label class="form-field"><span>From</span><input id="ldFrom" type="date" value="${monthStart()}"></label><label class="form-field"><span>To</span><input id="ldTo" type="date" value="${todayPH()}"></label></div>
        <div id="ldOut">${ledgerTable(led.ok ? led.data : null)}</div></div>
      <div class="card"><h2>Charges set by restaurants</h2>${r.data.restaurantCharges.length ? `<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Name</th><th>Type</th><th>Amount</th><th>Calculated on</th><th>Applies to</th><th>Status</th><th>Confirmed</th></tr></thead><tbody>${r.data.restaurantCharges.map(c => `<tr><td>${esc(c.restaurantName)}</td><td>${esc(c.label)}</td><td>${esc(KIND_LABEL[c.kind])}</td><td>${esc(amountText(c))}</td><td><small>${esc(BASE_LABEL[c.base])}</small></td><td>${esc(APPLIES_LABEL[c.appliesTo])}</td><td><span class="pill ${c.active ? "ok" : ""}">${c.active ? "Active" : "Off"}</span></td><td>${c.confirmedAt ? esc(App.fmtDateTime(c.confirmedAt)) : "–"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">No restaurant has added its own fees or taxes.</div>`}</div>`;
    App.refresh();
  }
  function ledgerTable(d) {
    if (!d) return `<div class="empty-note">Could not load.</div>`;
    if (!d.restaurants.length) return `<div class="empty-note">No accepted payments in this period.</div>`;
    return `<div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Payments</th><th>Collected</th><th>Restaurant share</th><th>ISLA-PLATEU fees</th><th>System taxes</th></tr></thead><tbody>${d.restaurants.map(e => `<tr><td>${esc(e.restaurantName)}</td><td>${e.payments}</td><td>${esc(App.money(e.collected))}</td><td>${esc(App.money(e.restaurantShare))}</td><td>${esc(App.money(e.platformFees))}</td><td>${esc(App.money(e.systemTaxes))}</td></tr>`).join("")}
      <tr><th>Total</th><th>${d.totals.payments}</th><th>${esc(App.money(d.totals.collected))}</th><th>${esc(App.money(d.totals.restaurantShare))}</th><th>${esc(App.money(d.totals.platformFees))}</th><th>${esc(App.money(d.totals.systemTaxes))}</th></tr></tbody></table></div>`;
  }
  function feeForm(l) {
    const isNew = !l, v = l || { kind: "SERVICE_FEE", label: "", calc: "PERCENT", value: "", base: "FOOD", appliesTo: "BOTH", active: true, basisNote: "" };
    const m = App.modal({ title: isNew ? "Add a fee or tax line" : "Edit fee or tax line", size: "narrow", html: `<div class="alert alert-error hidden form-alert" role="alert"></div>
      <div class="stack"><label class="form-field"><span>Type</span><select id="flKind"><option value="SERVICE_FEE">ISLA-PLATEU service fee</option><option value="SYSTEM_TAX">Government tax charged by the system</option></select></label>
        <label class="form-field"><span>Name shown to customers</span><input id="flLabel" maxlength="60" value="${esc(v.label)}"></label>
        <div class="inline-fields"><label class="form-field"><span>Calculation</span><select id="flCalc"><option value="PERCENT">Percentage</option><option value="FIXED">Fixed amount (₱)</option></select></label>
          <label class="form-field"><span id="flValL">Value</span><input id="flVal" type="number" min="0.01" step="0.01" value="${esc(v.value)}"></label></div>
        <label class="form-field"><span>Calculated on</span><select id="flBase"></select></label>
        <label class="form-field"><span>Applies to</span><select id="flApplies"><option value="BOTH">Orders and reservations</option><option value="ORDER">Orders only</option><option value="RESERVATION">Reservations only</option></select></label>
        <label class="check-line"><input type="checkbox" id="flActive" ${v.active ? "checked" : ""}> Active (charged to customers)</label>
        <label class="form-field"><span id="flNoteL">Basis note (optional for fees)</span><textarea id="flNote" maxlength="300" placeholder="e.g. which legal or accounting advice this is based on">${esc(v.basisNote)}</textarea></label>
        <label class="check-line hidden" id="flVerWrap"><input type="checkbox" id="flVer"> I verified this tax and its rate against the applicable legal and accounting requirements</label></div>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Save</button></div>` });
    const q = (id) => m.body.querySelector("#" + id);
    q("flKind").value = v.kind; q("flCalc").value = v.calc; q("flApplies").value = v.appliesTo;
    const sync = () => {
      const tax = q("flKind").value === "SYSTEM_TAX", keep = q("flBase").value;
      q("flBase").innerHTML = (tax ? ["FOOD", "RESTAURANT_TOTAL", "SERVICE_FEES"] : ["FOOD", "RESTAURANT_TOTAL"]).map(b => `<option value="${b}">${esc(BASE_LABEL[b])}</option>`).join("");
      q("flBase").value = [...q("flBase").options].some(o => o.value === (keep || v.base)) ? (keep || v.base) : "FOOD";
      q("flVerWrap").classList.toggle("hidden", !tax); q("flNoteL").textContent = tax ? "Legal or accounting basis (required for taxes)" : "Basis note (optional for fees)";
      q("flValL").textContent = q("flCalc").value === "PERCENT" ? "Percentage (0.01 to 50)" : "Amount in pesos";
    };
    q("flKind").addEventListener("change", sync); q("flCalc").addEventListener("change", sync); sync();
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async (e) => {
      const body = { kind: q("flKind").value, label: q("flLabel").value, calc: q("flCalc").value, value: Number(q("flVal").value), base: q("flBase").value, appliesTo: q("flApplies").value, active: q("flActive").checked, basisNote: q("flNote").value, verified: q("flVer").checked };
      const btn = e.currentTarget; btn.disabled = true; // keep a reference: currentTarget is cleared once the handler awaits
      const r = await App.api(isNew ? "/api/admin/fee-settings" : `/api/admin/fee-settings/${l.id}`, { method: isNew ? "POST" : "PATCH", body });
      btn.disabled = false;
      if (r.ok) { m.close(); App.toast("Saved.", "success"); loadFees(); } else { const a = m.body.querySelector(".form-alert"); a.textContent = r.data.error; a.classList.remove("hidden"); a.scrollIntoView({ block: "nearest" }); }
    });
  }
  document.addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-fee-edit]"), del = e.target.closest("[data-fee-del]");
    if (ed) { feeForm(ed.dataset.feeEdit === "new" ? null : feeLines.find(x => String(x.id) === ed.dataset.feeEdit)); return; }
    if (del && await App.confirm(`Delete "${del.dataset.name}"? Existing payments keep the amounts they were created with.`, { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/admin/fee-settings/${del.dataset.feeDel}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Deleted." : r.data.error, r.ok ? "success" : "error"); loadFees(); return; }
    if (e.target.closest("#pvGo")) {
      const r = await App.api(`/api/admin/fee-preview?kind=${$("pvKind").value}&amount=${encodeURIComponent($("pvAmount").value)}&restaurantId=${encodeURIComponent($("pvRest").value)}`);
      $("pvOut").innerHTML = r.ok ? App.breakdown(r.data.breakdown, r.data.total) : `<div class="alert alert-error"><span>${esc(r.data.error)}</span></div>`; return;
    }
  });
  document.addEventListener("change", async (e) => {
    if (e.target.id !== "ldFrom" && e.target.id !== "ldTo") return;
    const r = await App.api(`/api/admin/fee-ledger?from=${$("ldFrom").value}&to=${$("ldTo").value}`);
    $("ldOut").innerHTML = r.ok ? ledgerTable(r.data) : `<div class="alert alert-error"><span>${esc(r.data.error)}</span></div>`;
  });


  document.addEventListener("change", (e) => { const f = e.target.closest("[data-acf]"); if (f && f.tagName === "SELECT") { acct[f.dataset.acf] = f.value; loadAccounts(); } });
  document.addEventListener("keydown", (e) => { const f = e.target.closest && e.target.closest("[data-acf]"); if (f && f.tagName === "INPUT" && e.key === "Enter") { e.preventDefault(); acct.q = f.value; loadAccounts(); } });
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-send-code]"); if (!b) return;
    if (!(await App.confirm(`Email a new verification code to ${b.dataset.name}?`, { okLabel: "Send code" }))) return;
    const r = await App.api(`/api/admin/users/${b.dataset.sendCode}/resend-verification`, { body: {} });
    App.toast(r.ok ? r.data.message : r.data.error, r.ok ? "success" : "error");
  });
  /* ---------- Attention queue (what needs the administrator) ---------- */
  async function attentionCard(root) {
    const r = await App.api("/api/admin/attention"); if (!r.ok) return;
    const rows = r.data.items.filter(i => i.count > 0);
    root.insertAdjacentHTML("afterbegin", `<div class="card"><h2>Needs your attention ${r.data.total ? `<span class="pill warn">${r.data.total}</span>` : ""}</h2>${rows.length
      ? `<ul class="line-items">${rows.map(i => `<li><span><strong>${i.count}</strong> ${esc(i.label)}</span><button class="btn btn-quiet small" data-goto="${i.tab}" data-sub="${i.sub || ""}">Open</button></li>`).join("")}</ul>`
      : `<p class="muted">Nothing is waiting for you right now.</p>`}</div>`);
  }
  function gotoTab(tab, sub) { if (sub) monSub = sub; const t = document.querySelector(`[data-tab="${tab}"]`); if (t) t.click(); }

  /* ---------- Monitoring: reservations, orders, payments, tables, menus (read-only, plus narrow menu moderation) ---------- */
  let monSub = "reservations", mon = { page: 1, status: "all", restaurantId: "", q: "", from: "", to: "" };
  const MON_SUBS = [["reservations", "Reservations"], ["orders", "Advance orders"], ["payments", "Payments"], ["tables", "Tables"], ["menus", "Menus"]];
  const MON_STATUS = { reservations: ["PENDING", "CONFIRMED", "DECLINED", "COMPLETED", "NO_SHOW", "CANCELLED"], orders: ["PENDING", "ACCEPTED", "REJECTED", "PREPARING", "READY", "COMPLETED", "CANCELLED"], payments: ["AWAITING_PROOF", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REFUNDED", "VOID"] };
  const PAYCLS = { UNDER_REVIEW: "warn", ACCEPTED: "ok", REJECTED: "warn", AWAITING_PROOF: "warn", REFUNDED: "", VOID: "" };
  const label = (s) => String(s).replace(/_/g, " ").toLowerCase().replace(/^./, c => c.toUpperCase());
  const payPill = (p) => p ? `<span class="pill ${PAYCLS[p.status] || ""}">${esc(label(p.status))}</span> <small class="muted">${esc(App.money(p.amount))}</small>` : `<span class="muted">–</span>`;
  async function loadMonitor() {
    await fetchRestaurants();
    $("monRoot").innerHTML = `<div class="subtabs" role="group" aria-label="Monitoring views">${MON_SUBS.map(([k, l]) => `<button class="btn ${monSub === k ? "btn-primary" : "btn-quiet"} small" data-mon-sub="${k}" aria-pressed="${monSub === k}">${l}</button>`).join("")}</div><div id="monBody"></div>`;
    await loadMonBody();
  }
  async function loadMonBody() {
    const body = $("monBody"), listy = MON_STATUS[monSub];
    if (monSub === "tables") return renderTablesView(body);
    if (monSub === "menus") return renderMenusView(body);
    const q = new URLSearchParams({ page: mon.page, limit: 20 }); for (const k of ["status", "restaurantId", "q", "from", "to"]) if (mon[k] && !(k === "status" && mon[k] === "all")) q.set(k, mon[k]);
    if (monSub === "payments") { q.delete("from"); q.delete("to"); }
    const r = await App.api(`/api/admin/${monSub}?${q}`);
    if (!r.ok) { body.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load.")}</span></div>`; return; }
    const d = r.data, chips = `<div class="chips"><button class="pill ${mon.status === "all" ? "ok" : ""}" data-mon-status="all">All</button>${listy.map(st => `<button class="pill ${mon.status === st ? "ok" : ""}" data-mon-status="${st}">${esc(label(st))} ${d.counts[st] || 0}</button>`).join("")}</div>`;
    const bar = `<div class="form-grid mon-filters"><label class="form-field"><span>Restaurant</span><select data-mon-f="restaurantId"><option value="">All restaurants</option>${restaurants.map(x => `<option value="${esc(x.id)}" ${mon.restaurantId === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="form-field"><span>Search ${monSub === "payments" ? "(name, email, reference)" : "(name or email)"}</span><input data-mon-f="q" value="${esc(mon.q)}" placeholder="Type, then press Enter" maxlength="80"></label>
      ${monSub === "payments" ? "" : `<label class="form-field"><span>From</span><input type="date" data-mon-f="from" value="${esc(mon.from)}"></label><label class="form-field"><span>To</span><input type="date" data-mon-f="to" value="${esc(mon.to)}"></label>`}</div>`;
    const flag = (t) => `<br><span class="pill warn">${t}</span>`;
    let head, rowFn;
    if (monSub === "reservations") { head = ["Restaurant", "Customer", "When", "Party", "Table", "Status", "Payment"]; rowFn = (v) => `<td>${esc(v.restaurantName)}</td><td>${esc(v.customerName)}<br><small class="muted">${esc(v.customerEmail)}</small></td><td>${esc(App.fmtSlot(v.date, v.time))}</td><td>${v.partySize}</td><td>${esc(v.tableLabel || "–")}</td><td>${App.badge(v.status)}${v.stale ? flag("No answer for 24h+") : ""}</td><td>${payPill(v.payment)}</td>`; }
    else if (monSub === "orders") { head = ["Restaurant", "Customer", "For", "Items", "Total", "Status", "Payment"]; rowFn = (o) => `<td>${esc(o.restaurantName)}</td><td>${esc(o.customerName)}<br><small class="muted">${esc(o.customerEmail)}</small></td><td>${o.fulfillment === "DINE_IN" ? "Dine-in" : "Pickup"}<br><small class="muted">${esc(App.fmtSlot(o.date, o.time))}</small></td><td><small>${esc(o.items)}</small></td><td>${esc(App.money(o.total))}</td><td>${App.badge(o.status)}${o.stale ? flag("No answer for 24h+") : ""}</td><td>${payPill(o.payment)}</td>`; }
    else { head = ["Restaurant", "Customer", "For", "Amount", "Status", "Latest receipt", "Tries"]; rowFn = (p) => `<td>${esc(p.restaurantName)}</td><td>${esc(p.customerName)}<br><small class="muted">${esc(p.customerEmail)}</small></td><td>${esc(p.label)}${p.parentStatus ? `<br><small class="muted">${esc(label(p.parentStatus))}</small>` : ""}</td><td>${esc(App.money(p.amount))}</td><td><span class="pill ${PAYCLS[p.status] || ""}">${esc(p.statusLabel)}</span>${p.waitingTooLong ? flag("Not checked for 24h+") : ""}${p.refundDue ? flag("Refund due") : ""}</td>
        <td>${p.latest ? `${esc(p.latest.reference)}<br><small class="muted">says ${esc(App.money(p.latest.declared))} · <a href="/api/payments/${p.id}/receipt?submission=${p.latest.submissionId}" target="_blank" rel="noopener">view receipt</a></small>` : `<span class="muted">none yet</span>`}</td><td>${p.attempts}</td>`; }
    body.innerHTML = `${monSub === "payments" ? `<div class="alert alert-info"><span>Only the restaurant can accept, reject or refund a payment, because only they can check their own GCash records. You can monitor here and open receipts; every receipt you open is recorded in that payment's verification log.</span></div>` : ""}${chips}${bar}
      ${d.rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${d.rows.map(x => `<tr>${rowFn(x)}</tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">Nothing matches these filters.</div>`}
      <div class="pager"><button class="btn btn-quiet small" data-mon-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>Previous</button><span class="muted">Page ${d.page} of ${d.pages} · ${d.total} result${d.total === 1 ? "" : "s"}</span><button class="btn btn-quiet small" data-mon-page="${d.page + 1}" ${d.page >= d.pages ? "disabled" : ""}>Next</button></div>`;
    App.refresh();
  }
  async function renderTablesView(body) {
    const r = await App.api("/api/admin/tables-overview"); if (!r.ok) { body.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error)}</span></div>`; return; }
    const st = { available: "Free now", reserved: "Reserved now", disabled: "Disabled", "walk-in": "Walk-in only" };
    body.innerHTML = `<p class="hint">Live table availability for each restaurant, as customers see it right now. Restaurants manage their own tables.</p><div class="stack">${r.data.map(x => `<article class="item-card"><div class="item-head"><div><h3>${esc(x.name)}</h3><div class="item-meta">${esc(x.municipality || "")} · ${x.acceptsReservations ? "taking reservations" : "reservations off"} · tables held ${x.reservationMinutes} min</div></div>
        ${x.pendingRequests ? `<span class="pill warn">${x.pendingRequests} pending request${x.pendingRequests === 1 ? "" : "s"}</span>` : ""}</div>
      ${x.summary ? `<p><strong>${x.summary.available}</strong> free · <strong>${x.summary.reserved}</strong> reserved · ${x.summary.disabled} disabled · ${x.summary.walkInOnly} walk-in only · ${x.summary.total} tables, ${x.summary.seats} seats · ${x.upcomingConfirmed} upcoming confirmed</p>
        <ul class="table-chips">${x.tables.map(t => `<li class="table-chip ${esc(t.status)}"><strong>${esc(t.label)}</strong><span>${t.capacity} seat${t.capacity === 1 ? "" : "s"}</span><em>${st[t.status] || ""}</em></li>`).join("")}</ul>`
        : `<p class="muted">No tables set up${x.guestLimit ? `; reservations use a limit of ${x.guestLimit} guests per time` : ""}.</p>`}</article>`).join("")}</div>`;
  }
  async function renderMenusView(body) {
    const r = await App.api("/api/admin/menus"); if (!r.ok) { body.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error)}</span></div>`; return; }
    body.innerHTML = `<p class="hint">Overview of every restaurant's menu. Open a menu to hide or remove an inappropriate item or photo.</p><div class="table-wrap"><table><thead><tr><th>Restaurant</th><th>Items</th><th>Available</th><th>With photo</th><th>Categories</th><th>Orders</th><th></th></tr></thead><tbody>${r.data.map(x => `<tr><td>${esc(x.name)}</td><td>${x.items}</td><td>${x.available}</td><td>${x.withImages}</td><td>${x.categories}</td><td>${x.ordersEnabled ? "On" : "Off"}</td><td><button class="btn btn-quiet small" data-menu-open="${esc(x.id)}">View menu</button></td></tr>`).join("")}</tbody></table></div>`;
  }
  async function openMenu(id) {
    const r = await App.api(`/api/admin/restaurants/${encodeURIComponent(id)}/menu`); if (!r.ok) { App.toast(r.data.error, "error"); return; }
    const m = App.modal({ title: `Menu: ${r.data.restaurant.name}`, size: "wide", html: r.data.items.length ? `<div class="stack">${r.data.items.map(i => `<article class="item-card"><div class="pay-sub">${i.image ? `<img class="receipt-thumb" src="${esc(i.image)}" alt="${esc(i.name)}" loading="lazy">` : ""}<div style="flex:1;min-width:180px"><strong>${esc(i.name)}</strong> ${i.category ? `<span class="pill">${esc(i.category)}</span>` : ""} ${i.available ? "" : `<span class="pill warn">Hidden</span>`}<p class="muted" style="margin:4px 0">${esc(App.money(i.price))}${i.description ? " · " + esc(i.description) : ""}</p>
        <div class="item-actions"><button class="btn btn-quiet small" data-mi-toggle="${i.id}" data-avail="${i.available ? 1 : 0}">${i.available ? "Hide item" : "Show item"}</button>${i.image ? `<button class="btn btn-quiet small" data-mi-photo="${i.id}">Remove photo</button>` : ""}<button class="btn btn-quiet small" data-mi-del="${i.id}" data-name="${esc(i.name)}">Delete item</button></div></div></div></article>`).join("")}</div>` : `<div class="empty-note">This restaurant has no menu items.</div>` });
    m.body.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-mi-toggle]"), ph = e.target.closest("[data-mi-photo]"), dl = e.target.closest("[data-mi-del]"); let res;
      if (t) res = await App.api(`/api/admin/menu/${t.dataset.miToggle}`, { method: "PATCH", body: { available: t.dataset.avail !== "1" } });
      else if (ph && await App.confirm("Remove this photo?", { okLabel: "Remove", danger: true })) res = await App.api(`/api/admin/menu/${ph.dataset.miPhoto}/image`, { method: "DELETE", body: {} });
      else if (dl && await App.confirm(`Delete "${dl.dataset.name}" from the menu?`, { okLabel: "Delete", danger: true })) res = await App.api(`/api/admin/menu/${dl.dataset.miDel}`, { method: "DELETE", body: {} });
      else return;
      App.toast(res.ok ? "Done." : res.data.error, res.ok ? "success" : "error"); if (res.ok) { m.close(); openMenu(id); if (monSub === "menus") loadMonBody(); }
    });
  }
  async function restaurantOverview(id) {
    const r = await App.api(`/api/admin/restaurants/${encodeURIComponent(id)}/overview`); if (!r.ok) { App.toast(r.data.error, "error"); return; }
    const d = r.data, x = d.restaurant, n = (o, k) => (o && o[k]) || 0, pay = d.payments;
    const hasPin = x.lat !== null && x.lng !== null && Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng));
    const locationStatus = hasPin && x.locationStatus === "verified" ? "VERIFIED" : hasPin ? "APPROXIMATE" : "PENDING";
    let pendingQrFile = null, pendingQrObjectUrl = null;
    const qrImage = pay.hasQr
      ? `<img class="pay-qr" src="/api/admin/restaurants/${encodeURIComponent(id)}/payment-qr?t=${Date.now()}" alt="Current private GCash QR code">`
      : `<p class="muted">${pay.holderOnFile ? "No GCash QR code uploaded." : "Payment account details must be saved by restaurant staff before a QR code can be uploaded."}</p>`;
    const qrControls = pay.demoPayment
      ? `<span class="pill">Fixed non-scannable demo QR</span>`
      : `<label class="btn btn-quiet small file-btn ${pay.holderOnFile ? "" : "disabled"}">${icon("upload")} ${pay.hasQr ? "Choose replacement QR" : "Upload QR code"}<input type="file" hidden accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" id="adminQrFile" ${pay.holderOnFile ? "" : "disabled"}></label>`;
    const qrPreview = pay.demoPayment
      ? `<p class="hint">The demonstration QR cannot be replaced with a potentially scannable image.</p>`
      : pay.holderOnFile
        ? `<div class="stack hidden" id="adminQrPending" style="margin-top:12px"><strong>Preview replacement QR code</strong><img class="pay-qr" id="adminQrPreview" alt="Preview of selected replacement QR code"><div class="item-actions"><button class="btn btn-primary small" type="button" data-admin-qr-save>Save / Upload QR code</button><button class="btn btn-quiet small" type="button" data-admin-qr-cancel>Cancel</button></div></div><p class="hint">JPG, JPEG, PNG or WEBP, up to 5 MB.</p>`
        : "";
    const m = App.modal({ title: x.name, size: "wide", html: `
      ${x.cover ? `<img src="${esc(x.cover)}" alt="" style="width:100%;max-height:150px;object-fit:cover;border-radius:12px;margin-bottom:10px">` : ""}
      <p>${x.logo ? `<img src="${esc(x.logo)}" alt="" class="food-thumb" style="display:inline-block;vertical-align:middle;margin-right:8px">` : ""}<strong>${esc(x.category)}</strong> · ${esc([x.address, x.municipality].filter(Boolean).join(", ") || "No address")} · ${esc(x.contact || "no contact")}<br><span class="muted">Hours: ${esc(x.hours || "not set")} · ${x.description ? esc(x.description) : "no description"}</span></p>
      <div class="two-col"><div><h3 class="detail-h">Location and evidence</h3><p>Map pin: <span class="pill ${locationStatus === "VERIFIED" ? "ok" : "warn"}">${locationStatus}</span>${hasPin ? ` ${esc(x.lat)}, ${esc(x.lng)}` : ""}</p>
          <p>${d.location ? `Latest request #${d.location.requestId}: <span class="pill ${d.location.status === "APPROVED" ? "ok" : "warn"}">${esc(label(d.location.status))}</span>, ${d.location.documents} document${d.location.documents === 1 ? "" : "s"} (${esc(d.location.documentKinds.map(label).join(", ") || "none")})` : `<span class="muted">No location request submitted.</span>`}</p>
          <h3 class="detail-h">Staff</h3>${d.staff.length ? `<ul class="line-items">${d.staff.map(u => `<li><span>${esc(u.name)} <small class="muted">${esc(u.email)}</small></span><span><span class="pill ${u.status === "ACTIVE" ? "ok" : "warn"}">${esc(label(u.status))}</span> <span class="pill ${u.emailVerified ? "ok" : ""}">${u.emailVerified ? "Email verified" : "Not verified"}</span></span></li>`).join("")}</ul>` : `<p class="muted">No staff account assigned.</p>`}</div>
        <div><h3 class="detail-h">Tables and menu</h3><p>${d.tables ? `${d.tables.total} tables (${d.tables.available} free now, ${d.tables.reserved} reserved), ${d.tables.seats} seats` : "No tables set up"} · ${x.acceptsReservations ? "reservations on" : "reservations off"}</p>
          <p>Menu: ${d.menu.items} item${d.menu.items === 1 ? "" : "s"}, ${d.menu.available} available, ${d.menu.withImages} with photo · advance orders ${x.acceptsOrders ? "on" : "off"}</p>
          <h3 class="detail-h">Payments</h3><p>GCash ${pay.gcashConfigured ? `<span class="pill ok">set up</span>` : `<span class="pill">not set up</span>`}${pay.orderPrepay ? " · orders paid by GCash" : ""}${pay.reservationFee ? ` · reservation fee ${esc(App.money(pay.reservationFee))}` : ""}${pay.extraCharges ? ` · ${pay.extraCharges} extra charge${pay.extraCharges === 1 ? "" : "s"}` : ""}<br><small class="muted">Under review ${n(pay, "UNDER_REVIEW")} · accepted ${n(pay, "ACCEPTED")} · rejected ${n(pay, "REJECTED")} · refunded ${n(pay, "REFUNDED")}.</small></p>
          ${qrImage}<div class="item-actions">${qrControls}</div>${qrPreview}
          <h3 class="detail-h">Activity</h3><p>Reservations: ${n(d.activity.reservations, "PENDING")} pending, ${n(d.activity.reservations, "CONFIRMED")} confirmed, ${n(d.activity.reservations, "COMPLETED")} completed<br>Orders: ${n(d.activity.orders, "PENDING")} pending, ${n(d.activity.orders, "ACCEPTED") + n(d.activity.orders, "PREPARING") + n(d.activity.orders, "READY")} in progress, ${n(d.activity.orders, "COMPLETED")} completed<br>Ratings: ${d.activity.reviews.count ? `${esc(d.activity.reviews.average)} from ${d.activity.reviews.count}` : "none yet"}</p></div></div>
      <div class="modal-actions" style="flex-wrap:wrap"><button class="btn btn-quiet" data-ro="menu">View menu</button><button class="btn btn-quiet" data-ro="edit">Edit details</button>${x.logo ? `<button class="btn btn-quiet" data-ro="logo">Remove logo</button>` : ""}${x.cover ? `<button class="btn btn-quiet" data-ro="cover">Remove cover image</button>` : ""}${d.location && ["PENDING", "UNDER_REVIEW"].includes(d.location.status) ? `<button class="btn btn-primary" data-ro="loc">Review location request</button>` : ""}</div>` });
    const qrInput = m.body.querySelector("#adminQrFile");
    const clearPendingQr = () => {
      if (pendingQrObjectUrl) URL.revokeObjectURL(pendingQrObjectUrl);
      pendingQrFile = null; pendingQrObjectUrl = null;
      if (qrInput) qrInput.value = "";
      const pending = m.body.querySelector("#adminQrPending");
      if (pending) pending.classList.add("hidden");
    };
    if (qrInput) qrInput.addEventListener("change", () => {
      const file = qrInput.files && qrInput.files[0]; if (!file) return;
      const allowed = ["image/jpeg", "image/png", "image/webp"], ext = file.name.toLowerCase().split(".").pop();
      if ((!allowed.includes(file.type) && !["jpg", "jpeg", "png", "webp"].includes(ext)) || file.size > 5 * 1024 * 1024) {
        App.toast(file.size > 5 * 1024 * 1024 ? "The QR image is larger than 5 MB." : "Choose a JPG, JPEG, PNG or WEBP image.", "error");
        clearPendingQr(); return;
      }
      clearPendingQr();
      pendingQrFile = file; pendingQrObjectUrl = URL.createObjectURL(file);
      m.body.querySelector("#adminQrPreview").src = pendingQrObjectUrl;
      m.body.querySelector("#adminQrPending").classList.remove("hidden");
    });
    m.body.addEventListener("click", async (e) => {
      if (e.target.closest("[data-admin-qr-cancel]")) { clearPendingQr(); return; }
      if (e.target.closest("[data-admin-qr-save]")) {
        if (!pendingQrFile) { App.toast("Choose a QR image first.", "error"); return; }
        const save = e.target.closest("[data-admin-qr-save]"); save.disabled = true; save.textContent = "Uploading...";
        const res = await ISLA.upload(`/api/admin/restaurants/${encodeURIComponent(id)}/payment-qr`, pendingQrFile);
        if (res.ok) { clearPendingQr(); App.toast("Restaurant payment QR code updated.", "success"); m.close(); restaurantOverview(id); }
        else { save.disabled = false; save.textContent = "Save / Upload QR code"; App.toast(res.data.error || "QR code upload failed.", "error"); }
        return;
      }
      const b = e.target.closest("[data-ro]"); if (!b) return; const a = b.dataset.ro;
      if (a === "menu") { m.close(); openMenu(id); }
      else if (a === "edit") { m.close(); const res = await App.api(`/api/restaurants/${encodeURIComponent(id)}`); if (res.ok) restaurantForm(res.data.restaurant); }
      else if (a === "loc") { m.close(); reviewLocation(d.location.requestId); }
      else if ((a === "logo" || a === "cover") && await App.confirm(`Remove this restaurant's ${a === "logo" ? "logo" : "cover image"}?`, { okLabel: "Remove", danger: true })) { const res = await App.api(`/api/admin/restaurants/${encodeURIComponent(id)}/${a}`, { method: "DELETE", body: {} }); App.toast(res.ok ? "Removed." : res.data.error, res.ok ? "success" : "error"); if (res.ok) { m.close(); restaurantOverview(id); } }
    });
  }
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]"), sub = e.target.closest("[data-mon-sub]"), chip = e.target.closest("[data-mon-status]"), pg = e.target.closest("[data-mon-page]"), mo = e.target.closest("[data-menu-open]"), ro = e.target.closest("[data-rest-overview]");
    if (g) { gotoTab(g.dataset.goto, g.dataset.sub); return; }
    if (sub) { monSub = sub.dataset.monSub; mon = { page: 1, status: "all", restaurantId: "", q: "", from: "", to: "" }; loadMonitor(); return; }
    if (chip) { mon.status = chip.dataset.monStatus; mon.page = 1; loadMonBody(); return; }
    if (pg && !pg.disabled) { mon.page = Number(pg.dataset.monPage); loadMonBody(); return; }
    if (mo) { openMenu(mo.dataset.menuOpen); return; }
    if (ro) { restaurantOverview(ro.dataset.restOverview); return; }
  });
  document.addEventListener("change", (e) => { const f = e.target.closest("[data-mon-f]"); if (f && f.tagName !== "INPUT" || (f && f.type === "date")) { mon[f.dataset.monF] = f.value; mon.page = 1; loadMonBody(); } });
  document.addEventListener("keydown", (e) => { const f = e.target.closest && e.target.closest("[data-mon-f]"); if (f && f.tagName === "INPUT" && f.type !== "date" && e.key === "Enter") { e.preventDefault(); mon[f.dataset.monF] = f.value; mon.page = 1; loadMonBody(); } });
  /* ---------- Slideshow photos (only real, credited, licensed photos) ---------- */
  let slideData = null;
  const restOptions = (sel) => `<option value="">None</option>${restaurants.map(x => `<option value="${esc(x.id)}" ${sel === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}`;
  async function loadSlides() {
    const root = $("slideRoot"), [r] = await Promise.all([App.api("/api/admin/slides"), fetchRestaurants()]);
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load the slideshow.")}</span></div>`; return; }
    slideData = r.data;
    const list = (title, hint, items, emptyText) => `<div class="card"><h2>${title}</h2><p class="hint">${hint}</p>${items.length ? `<div class="stack">${items.map((s, i) => `<article class="item-card"><div class="pay-sub"><img class="receipt-thumb" src="${esc(s.url)}" alt="${esc(s.alt)}" loading="lazy" style="width:120px;height:80px">
        <div style="flex:1;min-width:200px"><strong>${esc(s.alt)}</strong>${s.builtIn ? ` <span class="pill">Built in</span>` : ""}${s.active ? "" : ` <span class="pill warn">Hidden</span>`}
          <p class="muted" style="margin:4px 0">${s.caption ? esc(s.caption) + " · " : ""}Credit: ${esc(s.credit)} · ${esc(s.license)}${s.restaurantName ? ` · Restaurant: ${esc(s.restaurantName)}` : ""}${s.sourceUrl ? ` · <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : ""}</p>
          ${s.builtIn ? `<small class="muted">This credited Wikimedia Commons photo is always the first landing photo.</small>` : `<div class="item-actions"><button class="btn btn-quiet small" data-slide-move="up" data-id="${s.id}" ${i === 0 || (items[0] && items[0].builtIn && i === 1) ? "disabled" : ""} aria-label="Move up">↑</button><button class="btn btn-quiet small" data-slide-move="down" data-id="${s.id}" ${i === items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
            <button class="btn btn-quiet small" data-slide-toggle="${s.id}" data-active="${s.active ? 1 : 0}">${s.active ? "Hide" : "Show"}</button><button class="btn btn-quiet small" data-slide-edit="${s.id}">Edit</button><button class="btn btn-quiet small" data-slide-del="${s.id}">Delete</button></div>`}</div></div></article>`).join("")}</div>` : `<div class="empty-note">${emptyText}</div>`}</div>`;
    root.innerHTML = `<div class="alert alert-info"><span><strong>Use only genuine photos you are allowed to use.</strong> Upload photos you took yourself, photos with a licence that permits this use (for example Creative Commons, with the credit it requires), or photos a restaurant gave you written permission to use. Every photo needs a credit and a licence or permission note, which are shown on the page next to the photo. Do not use logos or restaurant photos without permission.</span></div>
      <div class="card"><h2>Add a photo</h2><div class="alert alert-error hidden" id="slAlert" role="alert"></div>
        <div class="form-grid"><label class="form-field"><span>Where it appears</span><select id="slSet"><option value="landing">Landing page (restaurants, local dishes, dining places)</option><option value="map">Map page (food and dishes)</option></select></label>
          <label class="form-field"><span>Photo (JPG, PNG or WEBP, up to ${Math.round(slideData.maxBytes / 1048576)} MB, wide landscape works best)</span><input id="slFile" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <label class="form-field full"><span>Describe the photo (for screen readers)</span><input id="slAlt" maxlength="160" placeholder="e.g. The restaurant entrance and sign at daylight"></label>
          <label class="form-field"><span>Caption shown on the page (optional)</span><input id="slCaption" maxlength="100" placeholder="e.g. Grilled tuna"></label>
          <label class="form-field"><span>Restaurant shown (optional)</span><select id="slRest">${restOptions("")}</select></label>
          <label class="form-field"><span>Credit (who took or owns the photo)</span><input id="slCredit" maxlength="160" placeholder="e.g. Photo by Maria Santos"></label>
          <label class="form-field"><span>Licence or permission</span><input id="slLicense" maxlength="200" placeholder="e.g. CC BY 4.0, or: Permission from Resto X, 10 Nov 2026"></label>
          <label class="form-field full"><span>Link to the source or permission (optional)</span><input id="slSource" maxlength="300" placeholder="https://…"></label></div>
        <label class="check-line"><input type="checkbox" id="slConfirm"> I confirm that I own this photo or have permission or a licence to use it on this website, and I have entered its credit correctly.</label>
        <div class="modal-actions"><button class="btn btn-primary" id="slAdd" type="button">${icon("upload")} Upload photo</button></div></div>
      ${list("Landing page slideshow", "Shown behind the welcome text, with a dark overlay so the text stays readable. With only the built-in photo, the page keeps its original single background.", slideData.landing, "No photos yet.")}
      ${list("Map page slideshow", "Shown in the banner above the map. The map and the restaurant markers stay on a plain background. Until you add photos, the map page shows its normal heading.", slideData.map, "No food photos yet. Add genuine photos of Siquijor dishes you are allowed to use.")}`;
    App.refresh();
  }
  document.addEventListener("click", async (e) => {
    const add = e.target.closest("#slAdd"), mv = e.target.closest("[data-slide-move]"), tg = e.target.closest("[data-slide-toggle]"), ed = e.target.closest("[data-slide-edit]"), dl = e.target.closest("[data-slide-del]");
    if (add) {
      const err = (m) => { const a = $("slAlert"); a.textContent = m; a.classList.remove("hidden"); a.scrollIntoView({ block: "center" }); };
      const file = $("slFile").files[0];
      if (!file) return err("Choose a photo to upload.");
      if (file.size > slideData.maxBytes) return err(`That photo is larger than ${Math.round(slideData.maxBytes / 1048576)} MB. Please compress or resize it first.`);
      if (!$("slConfirm").checked) return err("Tick the box to confirm you have the right to use this photo.");
      const q = new URLSearchParams({ set: $("slSet").value, alt: $("slAlt").value, caption: $("slCaption").value, credit: $("slCredit").value, license: $("slLicense").value, source: $("slSource").value, restaurantId: $("slRest").value, confirm: "1" });
      add.disabled = true; const r = await ISLA.upload(`/api/admin/slides?${q}`, file); add.disabled = false;
      if (r.ok) { App.toast("Photo added to the slideshow.", "success"); loadSlides(); } else err(r.data.error || "Could not upload the photo.");
      return;
    }
    if (mv) { const r = await App.api(`/api/admin/slides/${mv.dataset.id}/move`, { body: { direction: mv.dataset.slideMove } }); if (r.ok) loadSlides(); else App.toast(r.data.error, "error"); return; }
    if (tg) { const r = await App.api(`/api/admin/slides/${tg.dataset.slideToggle}`, { method: "PATCH", body: { active: tg.dataset.active !== "1" } }); App.toast(r.ok ? "Saved." : r.data.error, r.ok ? "success" : "error"); loadSlides(); return; }
    if (dl && await App.confirm("Delete this photo from the slideshow? The file is removed.", { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/admin/slides/${dl.dataset.slideDel}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Deleted." : r.data.error, r.ok ? "success" : "error"); loadSlides(); return; }
    if (ed) {
      const s = [...slideData.landing, ...slideData.map].find(x => String(x.id) === ed.dataset.slideEdit); if (!s) return;
      const m = App.modal({ title: "Edit photo details", size: "narrow", html: `<div class="alert alert-error hidden form-alert" role="alert"></div><div class="stack">
        <label class="form-field"><span>Description (for screen readers)</span><input id="seAlt" maxlength="160" value="${esc(s.alt)}"></label><label class="form-field"><span>Caption</span><input id="seCap" maxlength="100" value="${esc(s.caption)}"></label>
        <label class="form-field"><span>Credit</span><input id="seCredit" maxlength="160" value="${esc(s.credit)}"></label><label class="form-field"><span>Licence or permission</span><input id="seLic" maxlength="200" value="${esc(s.license)}"></label>
        <label class="form-field"><span>Source link</span><input id="seSrc" maxlength="300" value="${esc(s.sourceUrl)}"></label><label class="form-field"><span>Restaurant shown</span><select id="seRest">${restOptions(s.restaurantId)}</select></label></div>
        <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Save</button></div>` });
      const q = (id) => m.body.querySelector("#" + id);
      m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
      m.body.querySelector("[data-yes]").addEventListener("click", async () => {
        const r = await App.api(`/api/admin/slides/${s.id}`, { method: "PATCH", body: { alt: q("seAlt").value, caption: q("seCap").value, credit: q("seCredit").value, license: q("seLic").value, sourceUrl: q("seSrc").value, restaurantId: q("seRest").value } });
        if (r.ok) { m.close(); App.toast("Saved.", "success"); loadSlides(); } else { const a = m.body.querySelector(".form-alert"); a.textContent = r.data.error; a.classList.remove("hidden"); }
      });
    }
  });
  /* ---------- Audit log ---------- */
  let aud = { action: "", actor: "", from: "", to: "", q: "" }, audActions = [], audRows = [], audNext = null;
  const auditQs = (extra = {}) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries({ ...aud, ...extra })) if (v) q.set(k, v); return q.toString(); };
  const auditFmt = (d) => { try { const o = JSON.parse(d); return Object.entries(o).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · "); } catch { return d; } };
  async function loadAudit(more = false) {
    const root = $("auditRoot"), r = await App.api(`/api/admin/audit-search?${auditQs({ limit: 50, before: more && audNext ? audNext : "" })}`);
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load the audit log.")}</span></div>`; return; }
    if (!more) { audRows = []; if (r.data.actions) audActions = r.data.actions; }
    audRows = audRows.concat(r.data.entries); audNext = r.data.nextBefore;
    root.innerHTML = `<p class="hint">Records of administrator, approval and payment-setting actions. Entries cannot be edited or deleted from the dashboard. Passwords and payment numbers are never recorded.</p>
      <div class="form-grid mon-filters"><label class="form-field"><span>Action</span><select data-aud="action"><option value="">All actions</option>${[...new Set(audActions.map(a => a.split(".")[0]))].map(g => `<option value="${esc(g)}" ${aud.action === g ? "selected" : ""}>${esc(label(g))}</option>`).join("")}</select></label>
        <label class="form-field"><span>Who</span><input data-aud="actor" value="${esc(aud.actor)}" maxlength="80" placeholder="Name"></label>
        <label class="form-field"><span>From</span><input type="date" data-aud="from" value="${esc(aud.from)}"></label><label class="form-field"><span>To</span><input type="date" data-aud="to" value="${esc(aud.to)}"></label>
        <label class="form-field"><span>Search details</span><input data-aud="q" value="${esc(aud.q)}" maxlength="80" placeholder="Type, then press Enter"></label></div>
      <div class="toolbar"><span class="muted">${audRows.length} entr${audRows.length === 1 ? "y" : "ies"} shown</span><a class="btn btn-quiet small" href="/api/admin/audit-export?${auditQs()}" download>${icon("download")} Export CSV</a></div>
      ${audRows.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody>${audRows.map(a => `<tr><td>${esc(App.fmtDateTime(a.at))}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.targetType)} ${esc(a.targetId)}</td><td><small class="muted">${esc(auditFmt(a.detail))}</small></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">No entries match.</div>`}
      ${audNext ? `<div class="pager"><span></span><button class="btn btn-quiet" data-aud-more>Load older entries</button><span></span></div>` : ""}`;
    App.refresh();
  }
  document.addEventListener("change", (e) => { const f = e.target.closest("[data-aud]"); if (f && (f.tagName === "SELECT" || f.type === "date")) { aud[f.dataset.aud] = f.value; loadAudit(); } });
  document.addEventListener("keydown", (e) => { const f = e.target.closest && e.target.closest("[data-aud]"); if (f && f.tagName === "INPUT" && f.type !== "date" && e.key === "Enter") { e.preventDefault(); aud[f.dataset.aud] = f.value; loadAudit(); } });
  document.addEventListener("click", (e) => { if (e.target.closest("[data-aud-more]")) loadAudit(true); });
  App.api("/api/admin/location-requests?status=open").then(r => { if (r.ok) { const b = $("cLoc"); b.textContent = r.data.length; b.hidden = !r.data.length; } });
  App.tabs($("tabsRoot"), (tab) => ({ overview: loadOverview, applications: loadApplications, locations: loadLocationRequests, restaurants: loadRestaurants, monitor: loadMonitor, fees: loadFees, slides: loadSlides, accounts: loadAccounts, audit: loadAudit })[tab]());
})();
