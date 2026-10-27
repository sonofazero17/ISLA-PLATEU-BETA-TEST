/* Restaurant staff dashboard. Every request is limited by the server to the staff member's assigned restaurant. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id), esc = App.esc, icon = App.icon;
  const user = await App.requireUser(["RESTAURANT_STAFF"]); if (!user) return;
  App.initBell($("bellMount"));

  const first = await App.api("/api/staff/restaurant");
  if (first.status === 409) { $("noRest").classList.remove("hidden"); App.refresh(); return; }
  if (!first.ok) { App.toast(first.data.error || "Could not load your restaurant.", "error"); return; }
  $("staffApp").classList.remove("hidden");
  let rest = first.data.restaurant;

  function setCount(id, n) { const el = $(id); el.hidden = !n; el.textContent = n; }
  function showOverview(d) {
    rest = d.restaurant;
    $("restName").textContent = rest.name;
    $("restLead").textContent = [rest.address, rest.municipality].filter(Boolean).join(", ") || "Manage reservations, advance orders and customer messages for your restaurant.";
    const c = d.counts;
    $("staffStats").innerHTML = [["clock", c.pendingReservations, "Reservation requests to answer"], ["circle-check", c.upcomingReservations, "Upcoming confirmed"], ["utensils", c.pendingOrders, "New advance orders"], ["bell", c.awaitingReply, "Messages awaiting reply"]]
      .map(([ic, n, label]) => `<div class="stat"><span class="badge">${icon(ic)}</span><div><strong>${n}</strong><span>${label}</span></div></div>`).join("");
    setCount("cRes", c.pendingReservations); setCount("cOrd", c.pendingOrders); setCount("cMsg", c.awaitingReply); App.refresh();
  }
  async function loadOverview() { const r = await App.api("/api/staff/restaurant"); if (r.ok) showOverview(r.data); }
  showOverview(first.data);

  /* ---- Reservations ---- */
  async function loadReservations() {
    const r = await App.api("/api/staff/reservations"), box = $("resList"); if (!r.ok) { box.innerHTML = `<div class="empty-note">${esc(r.data.error || "Could not load.")}</div>`; return; }
    const f = $("resFilter").value;
    const rows = r.data.filter(v => f === "all" || (f === "open" ? ["PENDING", "CONFIRMED"].includes(v.status) : v.status === f));
    box.innerHTML = rows.length ? rows.map(v => {
      const acts = v.status === "PENDING" ? [["CONFIRMED", "Confirm", "btn-primary"], ["DECLINED", "Decline", "btn-quiet"]] : v.status === "CONFIRMED" ? [["COMPLETED", "Mark completed", "btn-quiet"], ["NO_SHOW", "No-show", "btn-quiet"], ["CANCELLED", "Cancel", "btn-quiet"]] : [];
      return `<article class="item-card"><div class="item-head"><div><h3>${esc(App.fmtSlot(v.date, v.time))} · party of ${v.partySize}</h3>
        <div class="item-meta">${esc(v.customerName)} · ${esc(v.customerEmail)} · requested ${esc(App.fmtDateTime(v.createdAt))}</div></div>${App.badge(v.status)}</div>
        ${v.notes ? `<p class="item-body">Customer note: ${esc(v.notes)}</p>` : ""}${v.staffNote ? `<p class="item-body">Your note: ${esc(v.staffNote)}</p>` : ""}
        ${acts.length ? `<div class="item-actions">${acts.map(([s, l, c]) => `<button class="btn ${c} small" data-res="${v.id}" data-status="${s}">${l}</button>`).join("")}</div>` : ""}</article>`;
    }).join("") : `<div class="empty-note">No reservations here.</div>`;
  }
  /* ---- Orders ---- */
  const ORDER_ACTIONS = { PENDING: [["ACCEPTED", "Accept", "btn-primary"], ["REJECTED", "Reject", "btn-quiet"]], ACCEPTED: [["PREPARING", "Start preparing", "btn-primary"], ["REJECTED", "Reject", "btn-quiet"]], PREPARING: [["READY", "Mark ready", "btn-primary"]], READY: [["COMPLETED", "Mark picked up", "btn-primary"]] };
  async function loadOrders() {
    const r = await App.api("/api/staff/orders"), box = $("ordList"); if (!r.ok) { box.innerHTML = `<div class="empty-note">${esc(r.data.error || "Could not load.")}</div>`; return; }
    const f = $("ordFilter").value, rows = r.data.filter(o => f === "all" || ORDER_ACTIONS[o.status]);
    box.innerHTML = rows.length ? rows.map(o => `<article class="item-card"><div class="item-head"><div><h3>Order #${o.id} · pickup ${esc(App.fmtSlot(o.pickupDate, o.pickupTime))}</h3>
      <div class="item-meta">${esc(o.customerName)} · ${esc(o.customerEmail)}</div></div>${App.badge(o.status)}</div>
      <ul class="line-items">${o.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${esc(App.money(i.price * i.qty))}</span></li>`).join("")}<li><strong>Total</strong><strong>${esc(App.money(o.total))}</strong></li></ul>
      ${o.notes ? `<p class="item-body">Customer note: ${esc(o.notes)}</p>` : ""}
      ${ORDER_ACTIONS[o.status] ? `<div class="item-actions">${ORDER_ACTIONS[o.status].map(([s, l, c]) => `<button class="btn ${c} small" data-ord="${o.id}" data-status="${s}">${l}</button>`).join("")}</div>` : ""}</article>`).join("")
      : `<div class="empty-note">No orders here.</div>`;
  }
  /* ---- Messages ---- */
  let threads = [], current = null;
  async function loadMessages() {
    const r = await App.api("/api/staff/inquiries"); if (!r.ok) return;
    threads = r.data; if (!threads.some(t => t.id === current)) current = threads[0] ? threads[0].id : null; renderMessages();
  }
  function renderMessages() {
    const root = $("msgRoot");
    if (!threads.length) { root.innerHTML = `<div class="empty-note">No customer messages yet.<br><small>Customers message you from your restaurant's details on the map. Your listed phone and email are shown to customers as ordinary contact details; calls and email are not handled inside ISLA-PLATEU.</small></div>`; return; }
    const t = threads.find(x => x.id === current), waiting = (x) => x.messages[x.messages.length - 1].from === "CUSTOMER";
    root.innerHTML = `<div class="convo"><div class="convo-list">${threads.map(x => `<button class="convo-item" data-thread="${x.id}" aria-current="${x.id === current}"><strong>${waiting(x) ? "● " : ""}${esc(x.subject)}</strong><span>${esc(x.customerName)} · ${esc(App.fmtDateTime(x.updatedAt))}</span></button>`).join("")}</div>
      <div class="convo-pane"><div class="bubbles">${t.messages.map(m => `<div class="bubble ${m.from === "STAFF" ? "mine" : ""}">${esc(m.body)}<small>${esc(m.name)} · ${esc(App.fmtDateTime(m.at))}</small></div>`).join("")}</div>
      <form class="reply-form" data-reply="${t.id}"><textarea maxlength="1000" placeholder="Reply to ${esc(t.customerName)}…" aria-label="Reply"></textarea><button class="btn btn-primary" type="submit">${icon("arrow-right")} Send</button></form></div></div>`;
    App.refresh();
  }
  /* ---- Reviews (read-only) ---- */
  async function loadReviews() {
    const r = await App.api("/api/staff/reviews"), root = $("revRoot"); if (!r.ok) return;
    root.innerHTML = `<div class="stat" style="margin-bottom:14px"><span class="badge">${icon("circle-check")}</span><div><strong>${r.data.count ? esc(r.data.average) + " / 5" : "–"}</strong><span>${r.data.count} customer rating${r.data.count === 1 ? "" : "s"}</span></div></div>
      <p class="hint" style="margin-bottom:12px">Reviews are written by customers and cannot be edited or removed from this dashboard.</p>` +
      (r.data.reviews.length ? `<div class="stack">${r.data.reviews.map(v => `<div class="item-card"><div class="item-head"><strong>${esc(v.name)}</strong>${App.stars(v.rating)}</div>${v.comment ? `<p class="item-body">${esc(v.comment)}</p>` : ""}<div class="item-meta">${esc(App.fmtDateTime(v.at))}</div></div>`).join("")}</div>` : `<div class="empty-note">No ratings yet.</div>`);
  }
  /* ---- Restaurant details + menu ---- */
  async function loadRestaurant() {
    await loadOverview();
    const menu = await App.api("/api/staff/menu"), items = menu.ok ? menu.data : [], root = $("restRoot");
    root.innerHTML = `<div class="card"><h2>Operational details</h2>
      <p>Name, category, address and map location are managed by the administrator: <strong>${esc(rest.name)}</strong> · ${esc([rest.address, rest.municipality].filter(Boolean).join(", ") || "no address yet")}.</p>
      <div class="alert alert-error hidden" id="restAlert" role="alert"></div>
      <div class="form-grid">
        <label class="form-field"><span>Contact (phone / email shown to customers)</span><input id="fContact" maxlength="80" value="${esc(rest.contact)}"></label>
        <label class="form-field"><span>Operating hours</span><input id="fHours" maxlength="120" value="${esc(rest.hours)}" placeholder="e.g. 8:00 AM–9:00 PM daily"></label>
        <label class="form-field full"><span>Description</span><textarea id="fDesc" maxlength="1000">${esc(rest.description)}</textarea></label>
        <label class="form-field"><span>Max guests per reservation time (optional)</span><input id="fCap" type="number" min="1" max="500" value="${rest.reservationCapacity ?? ""}" placeholder="No limit"></label>
        <div class="form-field"><span>Customer options</span>
          <label class="check-line"><input type="checkbox" id="fAcceptRes" ${rest.acceptsReservations ? "checked" : ""}> Accept reservation requests</label>
          <label class="check-line"><input type="checkbox" id="fAcceptOrd" ${rest.ordersEnabled ? "checked" : ""}> Accept advance orders (needs menu items)</label></div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" id="saveRest">Save details</button></div></div>
      <div class="card"><h2>Menu for advance orders</h2><p>Customers can only order items listed here. Prices are in pesos.</p>
        <form id="menuForm" class="form-grid"><label class="form-field"><span>Item name</span><input id="mName" maxlength="80" required></label>
          <label class="form-field"><span>Price (₱)</span><input id="mPrice" type="number" min="1" step="0.01" required></label>
          <label class="form-field full"><span>Description (optional)</span><input id="mDesc" maxlength="200"></label>
          <div class="form-field full"><button class="btn btn-primary" type="submit">${icon("plus")} Add menu item</button></div></form>
        ${items.length ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Item</th><th>Price</th><th>Available</th><th></th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.name)}${i.description ? `<br><small class="muted">${esc(i.description)}</small>` : ""}</td><td>${esc(App.money(i.price))}</td>
          <td><label class="check-line"><input type="checkbox" data-avail="${i.id}" ${i.available ? "checked" : ""}> Available</label></td><td><div class="item-actions"><button class="btn btn-quiet small" data-edit-menu="${i.id}" data-name="${esc(i.name)}" data-price="${i.price}">Edit price</button><button class="btn btn-quiet small" data-del-menu="${i.id}" data-name="${esc(i.name)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-note" style="margin-top:14px">No menu items yet.</p>`}</div>`;
    App.refresh();
  }

  /* ---- Actions ---- */
  document.addEventListener("click", async (e) => {
    const rs = e.target.closest("[data-res]"), od = e.target.closest("[data-ord]"), th = e.target.closest("[data-thread]");
    if (rs) {
      const status = rs.dataset.status; let note = "";
      if (["DECLINED", "CANCELLED"].includes(status)) { note = await App.prompt(status === "DECLINED" ? "Decline reservation" : "Cancel reservation", "Reason for the customer (optional)", { okLabel: "Send" }); if (note === null) return; }
      const r = await App.api(`/api/staff/reservations/${rs.dataset.res}`, { method: "PATCH", body: { status, staffNote: note } });
      App.toast(r.ok ? "Reservation updated. The customer was notified." : r.data.error, r.ok ? "success" : "error"); loadReservations(); loadOverview();
    }
    if (od) {
      const r = await App.api(`/api/staff/orders/${od.dataset.ord}`, { method: "PATCH", body: { status: od.dataset.status } });
      App.toast(r.ok ? "Order updated. The customer was notified." : r.data.error, r.ok ? "success" : "error"); loadOrders(); loadOverview();
    }
    if (th) { current = Number(th.dataset.thread); renderMessages(); }
    if (e.target.closest("#saveRest")) {
      const cap = $("fCap").value.trim();
      const r = await App.api("/api/staff/restaurant", { method: "PATCH", body: { contact: $("fContact").value, hours: $("fHours").value, description: $("fDesc").value, reservationCapacity: cap === "" ? null : Number(cap), acceptsReservations: $("fAcceptRes").checked, acceptsOrders: $("fAcceptOrd").checked } });
      if (r.ok) { App.toast("Details saved.", "success"); loadRestaurant(); } else { const a = $("restAlert"); a.textContent = r.data.error; a.classList.remove("hidden"); }
    }
    const ed = e.target.closest("[data-edit-menu]"), dl = e.target.closest("[data-del-menu]");
    if (ed) { const v = await App.prompt(`New price for ${ed.dataset.name}`, "Price in pesos", { okLabel: "Update", required: true, maxLength: 12 }); if (v !== null) { const r = await App.api(`/api/staff/menu/${ed.dataset.editMenu}`, { method: "PATCH", body: { price: Number(v) } }); App.toast(r.ok ? "Price updated." : r.data.error, r.ok ? "success" : "error"); loadRestaurant(); } }
    if (dl && await App.confirm(`Delete "${dl.dataset.name}" from the menu?`, { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/staff/menu/${dl.dataset.delMenu}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Item deleted." : r.data.error, r.ok ? "success" : "error"); loadRestaurant(); }
  });
  document.addEventListener("change", async (e) => {
    const av = e.target.closest("[data-avail]");
    if (av) { const r = await App.api(`/api/staff/menu/${av.dataset.avail}`, { method: "PATCH", body: { available: av.checked } }); if (!r.ok) App.toast(r.data.error, "error"); }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-reply]");
    if (f) { e.preventDefault(); const ta = f.querySelector("textarea"); if (!ta.value.trim()) return; const r = await App.api(`/api/inquiries/${f.dataset.reply}/messages`, { body: { body: ta.value } }); if (r.ok) { loadMessages(); loadOverview(); } else App.toast(r.data.error, "error"); }
    if (e.target.id === "menuForm") { e.preventDefault(); const r = await App.api("/api/staff/menu", { body: { name: $("mName").value, price: Number($("mPrice").value), description: $("mDesc").value } }); App.toast(r.ok ? "Menu item added." : r.data.error, r.ok ? "success" : "error"); if (r.ok) loadRestaurant(); }
  });
  $("resFilter").addEventListener("change", loadReservations); $("ordFilter").addEventListener("change", loadOrders);

  const loaders = { reservations: loadReservations, orders: loadOrders, messages: loadMessages, reviews: loadReviews, restaurant: loadRestaurant };
  let currentTab = "reservations";
  App.tabs($("tabsRoot"), (tab) => { currentTab = tab; loaders[tab](); });
  setInterval(() => { // keep new requests visible without a manual refresh (skipped while typing)
    if (document.querySelector("dialog[open]") || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    loadOverview(); if (["reservations", "orders", "messages"].includes(currentTab)) loaders[currentTab]();
  }, 45000);
})();
