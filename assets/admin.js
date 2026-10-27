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
      <div class="card"><h2>Database backup</h2><p>Download a copy of the whole database (accounts, restaurants, reservations, orders). Keep it private: it contains personal data and password hashes, and it must never be committed to GitHub.</p>
        <div class="card-actions"><a class="btn btn-quiet" href="/api/admin/backup" download>${icon("arrow-right")} Download backup</a></div></div>
      <p class="hint">All figures are counted from the database when this page loads. Not tracked: ${s.notTracked.map(esc).join("; ")}.</p>`;
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
        <td>${r.lat !== null ? `<span class="pill ${r.locationStatus === "verified" ? "ok" : "warn"}">${r.locationStatus === "verified" ? "Verified" : "Approximate"}</span>` : `<span class="pill">No pin</span>`}</td>
        <td>${r.ratingCount ? `${App.stars(r.ratingAvg)} ${esc(r.ratingAvg)} (${r.ratingCount})` : `<span class="muted">–</span>`}</td>
        <td><div class="item-actions"><button class="btn btn-quiet small" data-edit="${esc(r.id)}">Edit</button><button class="btn btn-quiet small" data-del="${esc(r.id)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>`;
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
  async function loadAccounts() {
    await fetchRestaurants();
    const r = await App.api("/api/admin/users"), root = $("acctRoot"); if (!r.ok) { root.innerHTML = `<div class="empty-note">Could not load accounts.</div>`; return; }
    const tag = { ADMINISTRATOR: "admin", RESTAURANT_STAFF: "staff", CUSTOMER: "" };
    root.innerHTML = `<div class="card"><h2>Create a restaurant staff account</h2><p>Staff accounts can only be created here. The account gets a one-time temporary password.</p>
      <div class="alert alert-error hidden" id="stAlert" role="alert"></div>
      <form id="staffForm" class="form-grid"><label class="form-field"><span>Full name</span><input id="stName" maxlength="80" required></label>
        <label class="form-field"><span>Email</span><input id="stEmail" type="email" required></label>
        <label class="form-field"><span>Restaurant</span><select id="stRest" required><option value="">Choose a restaurant…</option>${restaurants.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>
        <div class="form-field" style="justify-content:flex-end"><button class="btn btn-primary" type="submit">${icon("user-plus")} Create staff account</button></div></form></div>
      <div class="toolbar"><span class="muted">${r.data.users.length} accounts</span></div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email / phone</th><th>Role</th><th>Restaurant</th><th>Status</th><th></th></tr></thead><tbody>${r.data.users.map(u => `<tr>
        <td>${esc(u.fullName)}${u.email === me.email ? ' <small class="muted">(you)</small>' : ""}</td><td>${esc(u.email)}${u.contactNumber ? `<br><small class="muted">${esc(u.contactNumber)}</small>` : ""}</td>
        <td><span class="role-tag ${tag[u.role]}">${esc(ISLA.ROLE_LABEL[u.role])}</span></td><td>${esc(u.restaurantName || (u.role === "RESTAURANT_STAFF" ? "Unassigned" : "–"))}</td><td>${App.badge(u.status)}</td>
        <td><div class="item-actions">${u.role === "RESTAURANT_STAFF" ? `<button class="btn btn-quiet small" data-assign="${u.id}" data-name="${esc(u.fullName)}" data-rest="${esc(u.restaurantId || "")}">Assign</button>` : ""}
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
  App.tabs($("tabsRoot"), (tab) => ({ overview: loadOverview, applications: loadApplications, restaurants: loadRestaurants, accounts: loadAccounts })[tab]());
})();
