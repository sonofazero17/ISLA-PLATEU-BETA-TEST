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
  const canEditIdentity = ["pagudfood", "the-cafe-infinite"].includes(rest.id);

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
      const hold = payHold(v.status, v.payment);
      const acts = v.status === "PENDING" ? [...(hold ? [] : [["CONFIRMED", "Confirm", "btn-primary"]]), ["DECLINED", "Decline", "btn-quiet"]] : v.status === "CONFIRMED" ? [["COMPLETED", "Mark completed", "btn-quiet"], ["NO_SHOW", "No-show", "btn-quiet"], ["CANCELLED", "Cancel", "btn-quiet"]] : [];
      return `<article class="item-card"><div class="item-head"><div><h3>${esc(App.fmtSlot(v.date, v.time))} · party of ${v.partySize}</h3>
        <div class="item-meta">${esc(v.customerName)} · ${esc(v.customerEmail)} · requested ${esc(App.fmtDateTime(v.createdAt))}${v.tableLabel ? ` · <strong>${esc(v.tableLabel)}</strong>` : ""}</div></div>${App.badge(v.status)}</div>
        ${v.notes ? `<p class="item-body">Customer note: ${esc(v.notes)}</p>` : ""}${v.staffNote ? `<p class="item-body">Your note: ${esc(v.staffNote)}</p>` : ""}
        ${payNotice(v.payment, v.status)}
        ${v.status === "PENDING" && !hold && rest.tables ? (v.freeTables && v.freeTables.length
          ? `<label class="form-field" style="max-width:340px"><span>Table for this booking</span><select data-res-table="${v.id}"><option value="">Auto-assign the best fit</option>${v.freeTables.map(t => `<option value="${t.id}" ${t.id === v.tableId ? "selected" : ""}>${esc(t.label)} (seats ${t.capacity})${t.id === v.tableId ? " – requested by customer" : ""}</option>`).join("")}</select></label>`
          : `<div class="alert alert-info"><span>No free table fits ${v.partySize} guest${v.partySize === 1 ? "" : "s"} at that time. You can decline, or free a table first.</span></div>`) : ""}
        ${acts.length ? `<div class="item-actions">${acts.map(([s, l, c]) => `<button class="btn ${c} small" data-res="${v.id}" data-status="${s}">${l}</button>`).join("")}</div>` : ""}</article>`;
    }).join("") : `<div class="empty-note">No reservations here.</div>`;
  }
  /* ---- Orders ---- */
  const PAY_CLS = { UNDER_REVIEW: "warn", ACCEPTED: "ok", REJECTED: "warn", AWAITING_PROOF: "warn", REFUNDED: "", UNPAID: "warn", VOID: "" };
  /* Shown on reservation and order cards: a payable booking cannot be confirmed or accepted until its payment is accepted (the server enforces this too). */
  const payHold = (st, p) => st === "PENDING" && p && p.status !== "ACCEPTED";
  const payNotice = (p, st) => !p || p.status === "VOID" ? "" : `<div class="pay-line"><span class="pill ${PAY_CLS[p.status] || ""}">${esc(p.statusLabel)}</span> <span>${esc(App.money(p.amount))}</span>${payHold(st, p) ? ` <small class="muted">You can accept this only after its payment is accepted.</small> <button class="btn btn-quiet small" data-goto-payments>Open Payments</button>` : ""}</div>`;
  const CANCEL = ["CANCELLED", "Cancel order", "btn-quiet"];
  const orderActions = (o) => ({ PENDING: [...(payHold(o.status, o.payment) ? [] : [["ACCEPTED", "Accept", "btn-primary"]]), ["REJECTED", "Reject", "btn-quiet"]], ACCEPTED: [["PREPARING", "Start preparing", "btn-primary"], ["REJECTED", "Reject", "btn-quiet"], CANCEL],
    PREPARING: [["READY", "Mark ready", "btn-primary"], CANCEL], READY: [["COMPLETED", o.fulfillment === "DINE_IN" ? "Mark served" : "Mark picked up", "btn-primary"], CANCEL] })[o.status];
  const ORDER_ACTIONS = { PENDING: 1, ACCEPTED: 1, PREPARING: 1, READY: 1 }; // statuses that still need staff attention
  async function loadOrders() {
    const r = await App.api("/api/staff/orders"), box = $("ordList"); if (!r.ok) { box.innerHTML = `<div class="empty-note">${esc(r.data.error || "Could not load.")}</div>`; return; }
    const f = $("ordFilter").value, rows = r.data.filter(o => f === "all" || ORDER_ACTIONS[o.status]);
    box.innerHTML = rows.length ? rows.map(o => `<article class="item-card"><div class="item-head"><div><h3>Order #${o.id} · ${o.fulfillment === "DINE_IN" ? "dine-in, arriving" : "pickup"} ${esc(App.fmtSlot(o.pickupDate, o.pickupTime))}</h3>
      <div class="item-meta">${esc(o.customerName)} · ${esc(o.customerEmail)}</div></div>${App.badge(o.status)}</div>
      <ul class="line-items">${o.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${esc(App.money(i.price * i.qty))}</span></li>`).join("")}<li><strong>Total</strong><strong>${esc(App.money(o.total))}</strong></li></ul>
      ${o.notes ? `<p class="item-body">Customer note: ${esc(o.notes)}</p>` : ""}
      ${o.staffNote ? `<p class="item-body">Your note: ${esc(o.staffNote)}</p>` : ""}
      ${payNotice(o.payment, o.status)}
      ${orderActions(o) ? `<div class="item-actions">${orderActions(o).map(([s, l, c]) => `<button class="btn ${c} small" data-ord="${o.id}" data-status="${s}">${l}</button>`).join("")}</div>` : ""}</article>`).join("")
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
    const imgBox = (kind, url, title, hint) => `<div class="img-slot"><strong>${title}</strong>
        <div class="img-preview ${kind}">${url ? `<img src="${esc(url)}" alt="${title}">` : `<span class="muted">No image yet</span>`}</div>
        <small class="muted">${hint}</small>
        <div class="item-actions"><label class="btn btn-quiet small file-btn">${icon("upload")} ${url ? "Replace" : "Upload"}<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-img-upload="/api/staff/restaurant/${kind}"></label>${url ? `<button class="btn btn-quiet small" type="button" data-img-remove="/api/staff/restaurant/${kind}">Remove</button>` : ""}</div></div>`;
    root.innerHTML = `<div class="card"><h2>Restaurant logo and profile image</h2>
      <p>Shown to customers on the map and in your restaurant details. JPG, PNG or WEBP, up to 5 MB. Only upload images you own or have permission to use.</p>
      <div class="img-grid">${imgBox("logo", rest.logo, "Logo", "Square images work best.")}${imgBox("cover", rest.cover, "Profile / cover image", "Wide photos (landscape) work best.")}</div></div>
      <div class="card"><h2>Operational details</h2>
      ${canEditIdentity ? `<p>${esc(rest.name)} demo profile: you can edit the restaurant's public name, category, address and other information. Map pins and verification remain administrator-controlled.</p>` : `<p>Name, category, address and map location are managed by the administrator: <strong>${esc(rest.name)}</strong> · ${esc([rest.address, rest.municipality].filter(Boolean).join(", ") || "no address yet")}.</p>`}
      <div class="alert alert-error hidden" id="restAlert" role="alert"></div>
      <div class="form-grid">
        ${canEditIdentity ? `<label class="form-field"><span>Restaurant name</span><input id="fName" maxlength="100" value="${esc(rest.name)}"></label><label class="form-field"><span>Category</span><input id="fCategory" maxlength="60" value="${esc(rest.category)}"></label><label class="form-field full"><span>Address</span><input id="fAddress" maxlength="180" value="${esc(rest.address)}"></label><label class="form-field"><span>Municipality</span><input id="fMunicipality" maxlength="60" value="${esc(rest.municipality)}"></label>` : ""}
        <label class="form-field"><span>Contact info (phone, email, or official social page shown to customers)</span><input id="fContact" maxlength="80" value="${esc(rest.contact)}"></label>
        <label class="form-field"><span>Operating hours</span><input id="fHours" maxlength="120" value="${esc(rest.hours)}" placeholder="e.g. 8:00 AM–9:00 PM daily"></label>
        <label class="form-field full"><span>Description</span><textarea id="fDesc" maxlength="1000">${esc(rest.description)}</textarea></label>
        <label class="form-field"><span>Max guests per reservation time (optional)</span><input id="fCap" type="number" min="1" max="500" value="${rest.reservationCapacity ?? ""}" placeholder="No limit"></label>
        <div class="form-field"><span>Customer options</span>
          <label class="check-line"><input type="checkbox" id="fAcceptRes" ${rest.acceptsReservations ? "checked" : ""}> Accept reservation requests</label>
          <label class="check-line"><input type="checkbox" id="fAcceptOrd" ${rest.ordersEnabled ? "checked" : ""}> Accept advance orders (needs menu items)</label>
          <label class="check-line"><input type="checkbox" id="fDineIn" ${(rest.fulfillmentOptions || []).includes("DINE_IN") ? "checked" : ""}> Also offer dine-in pre-orders (food ready when the customer arrives)</label></div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" id="saveRest">Save details</button></div></div>
      <div class="card"><h2>Menu for advance orders</h2><p>Customers can only order items listed here. Prices are in pesos.</p>
        <form id="menuForm" class="form-grid"><label class="form-field"><span>Item name</span><input id="mName" maxlength="80" required></label>
          <label class="form-field"><span>Price (₱)</span><input id="mPrice" type="number" min="1" step="0.01" required></label>
          <label class="form-field"><span>Food category (optional)</span><input id="mCat" maxlength="40" list="catList" placeholder="e.g. Main dish, Dessert, Drinks"><datalist id="catList"><option>Appetizer</option><option>Main dish</option><option>Seafood</option><option>Dessert</option><option>Drinks</option><option>Local delicacy</option></datalist></label>
          <label class="form-field"><span>Food photo (optional)</span><input id="mImg" type="file" accept="image/jpeg,image/png,image/webp"></label>
          <label class="form-field full"><span>Description (optional)</span><input id="mDesc" maxlength="200"></label>
          <div class="form-field full"><button class="btn btn-primary" type="submit">${icon("plus")} Add menu item</button></div></form>
        ${items.length ? `<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Photo</th><th>Item</th><th>Price</th><th>Available</th><th></th></tr></thead><tbody>${items.map(i => `<tr><td class="food-cell">${i.image ? `<img class="food-thumb" src="${esc(i.image)}" alt="${esc(i.name)}" loading="lazy">` : `<span class="food-thumb empty" aria-hidden="true"></span>`}</td><td>${esc(i.name)}${i.category ? ` <span class="pill">${esc(i.category)}</span>` : ""}${i.description ? `<br><small class="muted">${esc(i.description)}</small>` : ""}</td><td>${esc(App.money(i.price))}</td>
          <td><label class="check-line"><input type="checkbox" data-avail="${i.id}" ${i.available ? "checked" : ""}> Available</label></td><td><div class="item-actions"><label class="btn btn-quiet small file-btn">${i.image ? "Replace photo" : "Add photo"}<input type="file" accept="image/jpeg,image/png,image/webp" hidden data-img-upload="/api/staff/menu/${i.id}/image"></label>${i.image ? `<button class="btn btn-quiet small" data-img-remove="/api/staff/menu/${i.id}/image">Remove photo</button>` : ""}<button class="btn btn-quiet small" data-edit-menu="${i.id}" data-name="${esc(i.name)}" data-price="${i.price}">Edit price</button><button class="btn btn-quiet small" data-del-menu="${i.id}" data-name="${esc(i.name)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>` : `<p class="empty-note" style="margin-top:14px">No menu items yet.</p>`}</div>`;
    App.refresh();
  }




  /* ---- Payments: GCash details and receipt review ---- */
  let payFilter = "review";
  let pendingQrFile = null, pendingQrObjectUrl = null;
  const clearPendingQr = () => {
    if (pendingQrObjectUrl) URL.revokeObjectURL(pendingQrObjectUrl);
    pendingQrObjectUrl = null; pendingQrFile = null;
    const wrap = $("gcQrPending"), preview = $("gcQrPreview"), input = $("gcQr");
    if (wrap) wrap.classList.add("hidden");
    if (preview) preview.removeAttribute("src");
    if (input) input.value = "";
  };
  const PAY_FILTERS = [["review", "Needs review"], ["all", "All"], ["ACCEPTED", "Accepted"], ["REJECTED", "Rejected"], ["REFUNDED", "Refunded"]];
  async function loadPayments() {
    clearPendingQr();
    const root = $("payRoot");
    const [ar, pr, cr] = await Promise.all([App.api("/api/staff/payment-account"), App.api(`/api/staff/payments?filter=${encodeURIComponent(payFilter)}`), App.api("/api/staff/restaurant-charges")]);
    if (!ar.ok || !pr.ok || !cr.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc((ar.ok ? pr : ar).data.error || "Could not load payments.")}</span></div>`; return; }
    const a = ar.data, { payments, counts } = pr.data, charges = cr.data, badge = $("cPay"); badge.textContent = counts.review + counts.refundDue; badge.hidden = !(counts.review + counts.refundDue);
    root.innerHTML = `<div class="card"><h2>${a.demoPayment ? `${esc(rest.name)} demo payment settings` : "Your GCash payment details"}</h2>
        <p>${a.demoPayment ? "DEMO MODE: all customer payments are simulated. Never enter a real GCash account or use a real payment QR for this demonstration restaurant. Administrators can update the displayed demo QR image from Admin > Restaurants > Overview > Payments. The demo account label and number can be edited here." : "Customers pay you directly by GCash. They see your account name, a partly hidden number and your QR code only when they have a payment to make to you. Nothing here is shown on the public map."}</p>
        <div class="alert alert-error hidden" id="gcAlert" role="alert"></div>
        <div class="form-grid"><label class="form-field"><span>GCash account holder name</span><input id="gcName" maxlength="80" value="${esc(a.holderName)}" placeholder="Name as shown in GCash"></label>
          <label class="form-field"><span>GCash registered mobile number</span><input id="gcMobile" maxlength="20" value="${esc(a.mobile)}" placeholder="0917 123 4567"></label>
          <div class="form-field"><span>Customer payments</span>
            <label class="check-line"><input type="checkbox" id="gcPrepay" ${a.orderPrepay ? "checked" : ""}> Customers pay for advance orders by GCash before I accept them</label></div>
          <label class="form-field"><span>Reservation fee (₱, 0 = no fee)</span><input id="gcFee" type="number" min="0" max="10000" step="1" value="${a.reservationFee}"></label></div>
        <div class="modal-actions"><button class="btn btn-primary" id="gcSave" type="button">Save payment details</button></div>
        <h3 class="detail-h">GCash QR code</h3>
        ${a.hasQr ? `<img class="pay-qr" src="${esc(a.qrUrl)}?t=${Date.now()}" alt="Your current GCash QR code"><p class="muted hidden" id="gcQrLoadError" role="alert">Your saved QR image could not be loaded. Try uploading it again.</p>` : `<p class="muted">${a.configured ? "No QR code yet. Upload it to turn on customer payments." : "Save your name and number first, then upload your QR code."}</p>`}
        <div class="item-actions">${a.demoPayment ? `<span class="pill">Admin-managed demo QR</span>` : `<label class="btn btn-quiet small file-btn ${a.configured ? "" : "disabled"}">${icon("upload")} Choose QR code<input type="file" hidden accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" id="gcQr" ${a.configured ? "" : "disabled"}></label>${a.hasQr ? `<button class="btn btn-quiet small" id="gcQrRemove" type="button">Remove QR code</button>` : ""}`}</div>
        ${a.demoPayment ? `<p class="hint">Restaurant staff cannot replace the demo QR. An administrator can update its displayed image from Admin > Restaurants > Overview > Payments. Customer payments remain simulated, and the demo image must not be used to collect real payments.</p>` : `<div class="stack hidden" id="gcQrPending" style="margin-top:12px"><strong>Preview selected QR code</strong><img class="pay-qr" id="gcQrPreview" alt="Preview of selected GCash QR code"><p class="hint">Check that this is your own GCash QR code before uploading.</p><div class="item-actions"><button class="btn btn-primary small" id="gcQrConfirm" type="button">Save / Upload QR code</button><button class="btn btn-quiet small" id="gcQrCancel" type="button">Cancel</button></div></div><p class="hint">Use the QR code from your GCash app. JPG, JPEG, PNG or WEBP, up to 5 MB.</p>`}</div>
      <div class="card"><h2>Extra charges added to customer payments</h2>
        <p>Add a service charge or a tax if you charge one. It is shown to customers as its own line and added to what they pay by GCash. It applies only while customer payments are turned on. Only add a tax if you are registered or authorised to charge it.</p>
        ${charges.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Amount</th><th>Calculated on</th><th>Applies to</th><th></th></tr></thead><tbody>${charges.map(c => `<tr><td>${esc(c.label)}</td><td>${c.kind === "TAX" ? "Government tax" : "Restaurant fee"}</td><td>${c.calc === "PERCENT" ? esc(c.value) + "%" : esc(App.money(c.value))}</td><td><small>${c.base === "FOOD_AND_FEES" ? "the charge plus fees" : "the food or reservation charge"}</small></td><td>${({ ORDER: "Orders", RESERVATION: "Reservations", BOTH: "Both" })[c.appliesTo]}</td>
          <td><div class="item-actions"><label class="check-line"><input type="checkbox" data-ch-toggle="${c.id}" data-kind="${c.kind}" ${c.active ? "checked" : ""}> On</label><button class="btn btn-quiet small" data-ch-del="${c.id}" data-name="${esc(c.label)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-note">No extra charges. Customers pay only your menu prices${a.reservationFee ? " and reservation fee" : ""} (plus any ISLA-PLATEU service fee).</div>`}
        <div class="alert alert-error hidden" id="chAlert" role="alert"></div>
        <div class="form-grid" style="margin-top:12px"><label class="form-field"><span>Type</span><select id="chKind"><option value="FEE">Restaurant fee (for example a service charge)</option><option value="TAX">Government tax</option></select></label>
          <label class="form-field"><span>Name shown to customers</span><input id="chLabel" maxlength="60" placeholder="e.g. Service charge"></label>
          <label class="form-field"><span>Calculation</span><select id="chCalc"><option value="PERCENT">Percentage</option><option value="FIXED">Fixed amount (₱)</option></select></label>
          <label class="form-field"><span>Value (percent 0.01-50, or pesos)</span><input id="chValue" type="number" min="0.01" step="0.01"></label>
          <label class="form-field"><span>Calculated on</span><select id="chBase"><option value="FOOD">The food or reservation charge</option><option value="FOOD_AND_FEES">The charge plus my fees (taxes only)</option></select></label>
          <label class="form-field"><span>Applies to</span><select id="chApplies"><option value="BOTH">Orders and reservations</option><option value="ORDER">Orders only</option><option value="RESERVATION">Reservations only</option></select></label></div>
        <label class="check-line hidden" id="chConfWrap"><input type="checkbox" id="chConf"> I am registered or authorised to charge this tax and the rate is correct</label>
        <div class="modal-actions"><button class="btn btn-primary" id="chAdd" type="button">Add charge</button></div></div>
      <div class="card"><h2>Customer payments ${counts.review ? `<span class="pill warn">${counts.review} to review</span>` : ""}${counts.refundDue ? ` <span class="pill warn">${counts.refundDue} refund${counts.refundDue === 1 ? "" : "s"} due</span>` : ""}</h2>
        <div class="alert alert-info"><span>${a.demoPayment ? `<strong>SIMULATED PAYMENT REVIEW.</strong> These are fictional submissions for a school presentation. Do not check or expect any real GCash transaction.` : `<strong>A screenshot is not proof of payment.</strong> Open your own GCash transaction history and check the amount, reference number and time before accepting. Accept only what you can see in your GCash account.`}</span></div>
        <div class="toolbar"><label class="muted">Show <select id="payFilter">${PAY_FILTERS.map(([v, l]) => `<option value="${v}" ${payFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
        <div class="stack">${payments.length ? payments.map(p => payCard(p)).join("") : `<div class="empty-note">${payFilter === "review" ? "No receipts are waiting for review." : "No payments here."}</div>`}</div></div>`;
    $("payFilter").addEventListener("change", (e) => { payFilter = e.target.value; loadPayments(); });
    App.refresh();
  }
  function payCard(p) {
    const sub = p.submissions.length ? p.submissions[p.submissions.length - 1] : null, pm = p.parent;
    return `<article class="item-card"><div class="item-head"><div><h3>${esc(pm ? pm.label : "Payment")} · ${esc(App.money(p.amount))}</h3>
        <div class="item-meta">${esc(p.customerName || "")} · ${esc(p.customerEmail || "")}${pm ? ` · ${esc(App.fmtSlot(...pm.when.split(" ")))}` : ""}${pm && !pm.active ? ` · <strong>${esc(pm.status)}</strong>` : ""}</div></div><span class="pill ${PAY_CLS[p.status] || ""}">${esc(p.statusLabel)}</span></div>
      <ul class="line-items">${p.breakdown.map(l => `<li><span>${esc(l.label)}</span><span>${esc(App.money(l.amount))}</span></li>`).join("")}</ul>
      ${sub ? `<div class="pay-sub"><a href="/api/payments/${p.id}/receipt?submission=${sub.id}" target="_blank" rel="noopener"><img class="receipt-thumb" src="/api/payments/${p.id}/receipt?submission=${sub.id}" alt="Receipt screenshot" loading="lazy"></a>
        <div><p>Reference: <strong>${esc(sub.reference)}</strong><br>Customer says they sent: <strong>${esc(App.money(sub.declared))}</strong> ${sub.mismatch ? `<span class="pill warn">differs from ${esc(App.money(p.amount))} due</span>` : ""}<br><small class="muted">Submitted ${esc(App.fmtDateTime(sub.at))} · ${p.submissions.length} receipt${p.submissions.length === 1 ? "" : "s"} so far</small></p>
        ${sub.decision ? `<p class="muted">Last decision: ${esc(sub.decision.toLowerCase())}${sub.note ? ` · ${esc(sub.note)}` : ""}</p>` : ""}</div></div>` : `<p class="muted">No receipt submitted yet.</p>`}
      ${p.refundNote ? `<p class="item-body">Refund note: ${esc(p.refundNote)}</p>` : ""}
      ${p.status === "UNDER_REVIEW" ? `<div class="stack"><label class="check-line"><input type="checkbox" data-pay-verify="${p.id}"> ${p.demoPayment ? "I confirm this is a simulated demo payment submission for the presentation" : "I checked this transaction (amount, reference and time) in our own GCash account"}</label>
        <div class="item-actions"><button class="btn btn-primary small" data-pay-accept="${p.id}" disabled>Accept payment</button><button class="btn btn-quiet small" data-pay-reject="${p.id}">Reject</button></div></div>` : ""}
      ${p.refundDue ? `<div class="alert alert-info"><span>This ${pm.kind === "ORDER" ? "order" : "reservation"} is ${esc(pm.status.toLowerCase())} but the payment was accepted. Refund the customer in GCash, then record it.</span></div><div class="item-actions"><button class="btn btn-primary small" data-pay-refund="${p.id}">Mark as refunded</button></div>` : ""}
      <details class="order-history"><summary>Verification log</summary><ul class="line-items">${p.events.map(e => `<li><span>${esc(e.action.replace(".", " ").replace("_", " "))} · ${esc(e.by)}${e.note ? ` · ${esc(e.note)}` : ""}</span><small class="muted">${esc(App.fmtDateTime(e.at))}</small></li>`).join("")}</ul></details></article>`;
  }
  /* ---- Tables (Phase 4) ---- */
  const TBL_LABEL = { available: ["Free now", "ok"], reserved: ["Reserved now", "warn"], disabled: ["Temporarily disabled", "warn"], "walk-in": ["Walk-in only", ""] };
  async function loadTables() {
    await loadOverview();
    const root = $("tblRoot"), r = await App.api("/api/staff/tables");
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load tables.")}</span></div>`; return; }
    const { tables, summary, reservationMinutes } = r.data;
    root.innerHTML = `<div class="card"><h2>Tables and reservations</h2>
        <p>Customers see how many tables are free and can pick one when they reserve. A table counts as reserved only when you have <strong>confirmed</strong> a reservation for it; the same table cannot be confirmed for overlapping times.</p>
        ${summary ? `<div class="stat-grid">${[["utensils", summary.total, "Tables"], ["circle-check", summary.available, "Free and reservable now"], ["clock", summary.reserved, "Reserved now"], ["users", summary.seats, "Total seats"]].map(([ic, n, l]) => `<div class="stat"><span class="badge">${icon(ic)}</span><div><strong>${n}</strong><span>${l}</span></div></div>`).join("")}</div>` : `<div class="alert alert-info"><span>You have not added any tables yet. Until you do, reservations use the guest limit in the Restaurant &amp; menu tab.</span></div>`}
        <div class="form-grid" style="margin-top:12px"><label class="form-field"><span>Time a reserved table is held (minutes)</span><input id="tbLen" type="number" min="30" max="240" step="5" value="${reservationMinutes}"></label>
          <div class="form-field"><span>&nbsp;</span><button class="btn btn-quiet" id="tbLenSave" type="button">Save length</button></div></div></div>
      <div class="card"><h2>Add tables</h2><div class="alert alert-error hidden" id="tbAlert" role="alert"></div>
        <form id="tbBulk" class="form-grid"><label class="form-field"><span>How many tables</span><input id="tbCount" type="number" min="1" max="50" value="5" required></label>
          <label class="form-field"><span>Seats per table</span><input id="tbSeats" type="number" min="1" max="50" value="4" required></label>
          <label class="form-field"><span>Name prefix</span><input id="tbPrefix" maxlength="20" value="Table"></label>
          <div class="form-field"><span>&nbsp;</span><button class="btn btn-primary" type="submit">${icon("plus")} Add numbered tables</button></div></form>
        <form id="tbOne" class="form-grid" style="margin-top:14px"><label class="form-field"><span>Or add one table with its own name</span><input id="tbName" maxlength="30" placeholder="e.g. Window 1, Terrace A" required></label>
          <label class="form-field"><span>Seats</span><input id="tbOneSeats" type="number" min="1" max="50" value="2" required></label>
          <label class="check-line"><input type="checkbox" id="tbOneRes" checked> Customers can reserve it</label>
          <div class="form-field"><button class="btn btn-quiet" type="submit">Add table</button></div></form></div>
      <div class="card"><h2>Your tables</h2>${tables.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Seats</th><th>Reservable</th><th>In service</th><th>Status</th><th></th></tr></thead><tbody>${tables.map(t => `<tr data-trow="${t.id}">
          <td><input class="tb-in" data-f="label" maxlength="30" value="${esc(t.label)}" aria-label="Table name"></td>
          <td><input class="tb-in tb-num" data-f="capacity" type="number" min="1" max="50" value="${t.capacity}" aria-label="Seats"></td>
          <td><label class="check-line"><input type="checkbox" data-f="reservable" ${t.reservable ? "checked" : ""}> Yes</label></td>
          <td><label class="check-line"><input type="checkbox" data-f="active" ${t.active ? "checked" : ""}> Enabled</label></td>
          <td><span class="pill ${TBL_LABEL[t.status][1]}">${TBL_LABEL[t.status][0]}</span>${t.upcoming ? `<br><small class="muted">${t.upcoming} upcoming</small>` : ""}</td>
          <td><div class="item-actions"><button class="btn btn-quiet small" data-tb-save="${t.id}">Save</button><button class="btn btn-quiet small" data-tb-del="${t.id}" data-name="${esc(t.label)}">Delete</button></div></td></tr>`).join("")}</tbody></table></div>
        <p class="hint">Disable a table to take it out of service temporarily. Existing confirmed reservations are not cancelled automatically, so check them. "Reservable" off means walk-in only.</p>` : `<div class="empty-note">No tables yet.</div>`}</div>`;
    App.refresh();
  }
  const tbAlert = (m) => { const a = $("tbAlert"); if (!a) { App.toast(m, "error"); return; } a.textContent = m; a.classList.remove("hidden"); a.scrollIntoView({ block: "center" }); };
  /* ---- Map location request (admin approval required before anything appears on the public map) ---- */
  let tileCfg = null, locMap = null, savedLocMap = null, startingNew = false, pin = null;
  App.api("/api/config").then(r => { if (r.ok) tileCfg = r.data.tile; });
  const LOC_STATUS = { DRAFT: ["Draft (not submitted)", ""], PENDING: ["Pending", "warn"], UNDER_REVIEW: ["Under review", "warn"], APPROVED: ["Approved", "ok"], REJECTED: ["Rejected", "warn"], NEEDS_EVIDENCE: ["Requires additional evidence", "warn"] };
  const MAX_DOC = 8 * 1024 * 1024;
  async function loadLocation() {
    const root = $("locRoot");
    if (locMap) { locMap.remove(); locMap = null; }
    if (savedLocMap) { savedLocMap.remove(); savedLocMap = null; }
    const r = await App.api("/api/staff/location-request");
    if (!r.ok) { root.innerHTML = `<div class="alert alert-error"><span>${esc(r.data.error || "Could not load.")}</span></div>`; return; }
    const { current, request: q, history, kinds, canStartNew } = r.data;
    const hasCurrentPin = current.lat !== null && current.lat !== undefined && current.lng !== null && current.lng !== undefined &&
      Number.isFinite(Number(current.lat)) && Number.isFinite(Number(current.lng));
    const editing = (q && q.canEdit) || startingNew || !q;
    const base = (q && q.canEdit) ? q : (startingNew || !q) ? { lat: null, lng: null, address: current.address || "", contactPhone: "", businessContact: "" } : q;
    pin = base.lat !== null && base.lat !== undefined ? { lat: base.lat, lng: base.lng } : null;
    const st = q ? LOC_STATUS[q.status] : null;
    const docs = (q && q.canEdit && !startingNew) ? q.documents : [];
    const reqKinds = ["MAYORS_PERMIT", "DTI_SEC", "STOREFRONT_PHOTO", "AUTHORIZATION"];
    root.innerHTML = `<div class="card"><h2>Your public map location</h2>
        <p>${hasCurrentPin ? `${icon("map-pin")} ${current.locationStatus === "verified" ? "VERIFIED" : "APPROXIMATE"} saved pin: <strong>${esc(current.lat)}, ${esc(current.lng)}</strong>${current.address ? ` (${esc(current.address)})` : ""}. Customers can find you on the map.` : "Your restaurant does not have an approved map location yet. It appears on the public map only after an administrator approves a request."}</p>
        ${hasCurrentPin ? `<div id="savedLocMap" class="saved-loc-map" aria-label="Saved restaurant map location"></div>` : ""}
        <p class="hint">You cannot publish or change the public pin yourself. Every location must be reviewed by an administrator.</p></div>
      ${q && !startingNew ? `<div class="card"><h2>Latest request #${q.id} <span class="pill ${st[1]}">${esc(st[0])}</span></h2>
        ${q.reviewNote ? `<div class="alert alert-info"><span><strong>Message from the administrator:</strong> ${esc(q.reviewNote)}</span></div>` : ""}
        ${q.status === "PENDING" || q.status === "UNDER_REVIEW" ? `<p>Your request is with the administrator. You will be notified of the decision. You cannot edit it while it is being reviewed.</p>` : ""}
        ${!q.canEdit ? `<p class="muted">${esc(q.address)} · ${esc(q.lat)}, ${esc(q.lng)} · ${esc(q.contactPhone)}</p>` : ""}
        ${!q.canEdit ? `<ul class="line-items">${q.documents.map(d => `<li><span>${esc(kinds[d.kind])}: <a href="/api/staff/location-documents/${d.id}/file" target="_blank" rel="noopener">${esc(d.name || "file")}</a></span></li>`).join("")}</ul>` : ""}
        ${canStartNew && !q.canEdit ? `<div class="modal-actions"><button class="btn btn-quiet" data-loc-new>Request a different location</button></div>` : ""}</div>` : ""}
      ${editing ? `<div class="card"><h2>${q && q.canEdit && !startingNew ? "Edit request details" : "Request a map location"}</h2>
        <div class="alert alert-error hidden" id="locAlert" role="alert"></div>
        <p>Click the map (or drag the marker) to pin the exact restaurant entrance.</p>
        <div id="locPicker" class="loc-picker"></div>
        <p class="muted" id="locCoords">${pin ? `Pinned: ${esc(pin.lat)}, ${esc(pin.lng)}` : "No pin placed yet."}</p>
        <div class="form-grid">
          <label class="form-field full"><span>Complete restaurant address</span><input id="lcAddr" maxlength="200" value="${esc(base.address)}" placeholder="Street / barangay / municipality, Siquijor"></label>
          <label class="form-field"><span>Contact number</span><input id="lcPhone" maxlength="30" value="${esc(base.contactPhone)}" placeholder="e.g. 0917 123 4567"></label>
          <label class="form-field"><span>Business contact details (email, Facebook page…)</span><input id="lcBiz" maxlength="200" value="${esc(base.businessContact)}"></label></div>
        <div class="modal-actions"><button class="btn btn-primary" data-loc-save="${q && q.canEdit && !startingNew ? q.id : ""}">${q && q.canEdit && !startingNew ? "Save details" : "Save as draft"}</button>${startingNew ? `<button class="btn btn-quiet" data-loc-cancel>Cancel</button>` : ""}</div></div>` : ""}
      ${q && q.canEdit && !startingNew ? `<div class="card"><h2>Supporting evidence (private)</h2>
        <p>Only you and ISLA-PLATEU administrators can see these files. JPG, PNG, WEBP or PDF, up to 8 MB each. A photo alone does not prove ownership, so please include the registration documents and proof that you may manage this restaurant.</p>
        <div class="stack">${Object.keys(kinds).map(k => `<div class="item-card"><div class="item-head"><strong>${esc(kinds[k])}${reqKinds.includes(k) ? "" : " (optional)"}</strong>${k === "MAYORS_PERMIT" || k === "DTI_SEC" ? `<span class="muted">one of the two is required</span>` : reqKinds.includes(k) ? `<span class="muted">required</span>` : ""}</div>
          <ul class="line-items">${docs.filter(d => d.kind === k).map(d => `<li><span><a href="/api/staff/location-documents/${d.id}/file" target="_blank" rel="noopener">${esc(d.name || "file")}</a> <small class="muted">${Math.round(d.size / 1024)} KB</small></span><button class="btn btn-quiet small" data-doc-del="${d.id}">Remove</button></li>`).join("")}</ul>
          <label class="btn btn-quiet small file-btn">${icon("upload")} Upload<input type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf" data-doc-kind="${k}" data-req="${q.id}"></label></div>`).join("")}</div>
        <div class="modal-actions"><button class="btn btn-primary" data-loc-submit="${q.id}">Submit for admin review</button></div></div>` : ""}
      ${history.length ? `<div class="card"><h2>Request history</h2><ul class="line-items">${history.map(h => `<li><span>#${h.id} · <strong>${esc(LOC_STATUS[h.status][0])}</strong>${h.reviewNote ? ` · ${esc(h.reviewNote)}` : ""}</span><small class="muted">${esc(App.fmtDateTime(h.reviewedAt || h.submittedAt))}</small></li>`).join("")}</ul></div>` : ""}`;
    App.refresh();
    if (hasCurrentPin && typeof L !== "undefined") {
      const el = $("savedLocMap");
      savedLocMap = L.map(el, { minZoom: 9, maxZoom: 18 }).setView([Number(current.lat), Number(current.lng)], 16);
      const tc = tileCfg || { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" };
      L.tileLayer(tc.url, { maxZoom: tc.maxZoom || 19, attribution: tc.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(savedLocMap);
      L.marker([Number(current.lat), Number(current.lng)]).bindPopup(`<strong>${esc(rest.name)}</strong><br>${esc(current.address || rest.address || "")}`).addTo(savedLocMap).openPopup();
      setTimeout(() => savedLocMap && savedLocMap.invalidateSize(), 150);
    }
    if (editing) initPicker();
  }
  function setPin(lat, lng) { pin = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }; $("locCoords").textContent = `Pinned: ${pin.lat}, ${pin.lng}`; }
  function initPicker() {
    const el = $("locPicker"); if (!el) return;
    if (typeof L === "undefined") { el.innerHTML = `<div class="empty-note">The map library could not be loaded. Please check your connection and reload.</div>`; return; }
    locMap = L.map(el, { minZoom: 9, maxZoom: 18 }).setView(pin ? [pin.lat, pin.lng] : [9.20, 123.52], pin ? 16 : 11);
    const tc = tileCfg || { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" };
    L.tileLayer(tc.url, { maxZoom: tc.maxZoom || 19, attribution: tc.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(locMap);
    let marker = null;
    const place = (ll) => { setPin(ll.lat, ll.lng); if (!marker) { marker = L.marker(ll, { draggable: true }).addTo(locMap); marker.on("dragend", () => setPin(marker.getLatLng().lat, marker.getLatLng().lng)); } else marker.setLatLng(ll); };
    if (pin) place({ lat: pin.lat, lng: pin.lng });
    locMap.on("click", (e) => place(e.latlng));
    setTimeout(() => locMap && locMap.invalidateSize(), 150);
  }
  async function locSave(id) {
    const body = { address: $("lcAddr").value, contactPhone: $("lcPhone").value, businessContact: $("lcBiz").value, ...(pin || {}) };
    const r = id ? await App.api(`/api/staff/location-requests/${id}`, { method: "PATCH", body }) : await App.api("/api/staff/location-requests", { body });
    if (!r.ok) { const a = $("locAlert"); a.textContent = r.data.error; a.classList.remove("hidden"); a.scrollIntoView({ block: "center" }); return; }
    startingNew = false; App.toast("Request details saved. Now add your supporting evidence.", "success"); loadLocation();
  }
  /* ---- Actions ---- */
  document.addEventListener("click", async (e) => {
    const rs = e.target.closest("[data-res]"), od = e.target.closest("[data-ord]"), th = e.target.closest("[data-thread]");
    if (rs) {
      const status = rs.dataset.status; let note = "";
      if (["DECLINED", "CANCELLED"].includes(status)) { note = await App.prompt(status === "DECLINED" ? "Decline reservation" : "Cancel reservation", "Reason for the customer (optional)", { okLabel: "Send" }); if (note === null) return; }
      const sel = document.querySelector(`select[data-res-table="${rs.dataset.res}"]`), tableId = status === "CONFIRMED" && sel && sel.value ? Number(sel.value) : undefined;
      const r = await App.api(`/api/staff/reservations/${rs.dataset.res}`, { method: "PATCH", body: { status, staffNote: note, tableId } });
      App.toast(r.ok ? `Reservation updated.${r.data.table ? " Table: " + r.data.table + "." : ""} The customer was notified.` : r.data.error, r.ok ? "success" : "error"); loadReservations(); loadOverview();
    }
    if (od) {
      const stt = od.dataset.status; let note = "";
      if (stt === "REJECTED" || stt === "CANCELLED") { note = await App.prompt(stt === "REJECTED" ? "Reject order" : "Cancel order", stt === "REJECTED" ? "Reason for the customer (optional)" : "Reason for the customer (required)", { okLabel: "Send", required: stt === "CANCELLED", maxLength: 300 }); if (note === null) return; }
      const r = await App.api(`/api/staff/orders/${od.dataset.ord}`, { method: "PATCH", body: { status: stt, note } });
      App.toast(r.ok ? "Order updated. The customer was notified." : r.data.error, r.ok ? "success" : "error"); loadOrders(); loadOverview();
    }
    if (th) { current = Number(th.dataset.thread); renderMessages(); }
    if (e.target.closest("#saveRest")) {
      const cap = $("fCap").value.trim();
      const r = await App.api("/api/staff/restaurant", { method: "PATCH", body: { ...(canEditIdentity ? { name: $("fName").value, category: $("fCategory").value, address: $("fAddress").value, municipality: $("fMunicipality").value } : {}), contact: $("fContact").value, hours: $("fHours").value, description: $("fDesc").value, reservationCapacity: cap === "" ? null : Number(cap), acceptsReservations: $("fAcceptRes").checked, acceptsOrders: $("fAcceptOrd").checked, orderDineIn: $("fDineIn").checked } });
      if (r.ok) { App.toast("Details saved.", "success"); loadRestaurant(); } else { const a = $("restAlert"); a.textContent = r.data.error; a.classList.remove("hidden"); }
    }
    if (e.target.closest("[data-goto-payments]")) { const t = document.querySelector("[data-tab=payments]"); if (t) t.click(); return; }
    const pa = e.target.closest("[data-pay-accept]"), prj = e.target.closest("[data-pay-reject]"), prf = e.target.closest("[data-pay-refund]");
    if (pa) { const chk = document.querySelector(`[data-pay-verify="${pa.dataset.payAccept}"]`); if (!chk || !chk.checked) return;
      const r = await App.api(`/api/staff/payments/${pa.dataset.payAccept}/decision`, { body: { decision: "ACCEPTED", verified: true } }); App.toast(r.ok ? "Payment accepted. The customer was notified." : r.data.error, r.ok ? "success" : "error"); loadPayments(); loadOverview(); return; }
    if (prj) { const note = await App.prompt("Reject payment", "Reason for the customer (required)", { okLabel: "Reject", required: true, maxLength: 300 }); if (note === null) return;
      const r = await App.api(`/api/staff/payments/${prj.dataset.payReject}/decision`, { body: { decision: "REJECTED", note } }); App.toast(r.ok ? "Payment rejected. The customer can upload a new receipt." : r.data.error, r.ok ? "success" : "error"); loadPayments(); return; }
    if (prf) { const note = await App.prompt("Mark as refunded", "Refund note, for example the GCash refund reference (required)", { okLabel: "Mark refunded", required: true, maxLength: 300 }); if (note === null) return;
      const r = await App.api(`/api/staff/payments/${prf.dataset.payRefund}/refund`, { body: { note } }); App.toast(r.ok ? "Marked as refunded. The customer was notified." : r.data.error, r.ok ? "success" : "error"); loadPayments(); return; }
    if (e.target.closest("#chAdd")) {
      const r = await App.api("/api/staff/restaurant-charges", { body: { kind: $("chKind").value, label: $("chLabel").value, calc: $("chCalc").value, value: Number($("chValue").value), base: $("chBase").value, appliesTo: $("chApplies").value, confirmed: $("chConf").checked } });
      if (r.ok) { App.toast("Charge added.", "success"); loadPayments(); } else { const a = $("chAlert"); a.textContent = r.data.error; a.classList.remove("hidden"); a.scrollIntoView({ block: "center" }); } return;
    }
    const chd = e.target.closest("[data-ch-del]");
    if (chd && await App.confirm(`Delete "${chd.dataset.name}"? Existing payments keep the amounts they were created with.`, { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/staff/restaurant-charges/${chd.dataset.chDel}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Deleted." : r.data.error, r.ok ? "success" : "error"); loadPayments(); return; }
    if (e.target.closest("#gcQrConfirm")) {
      if (!pendingQrFile) { App.toast("Choose a QR image first.", "error"); return; }
      const save = $("gcQrConfirm"); save.disabled = true; save.textContent = "Uploading…";
      const r = await ISLA.upload("/api/staff/payment-account/qr", pendingQrFile);
      if (r.ok) { clearPendingQr(); App.toast("GCash QR code uploaded successfully.", "success"); loadPayments(); }
      else { save.disabled = false; save.textContent = "Save / Upload QR code"; App.toast(r.data.error || "QR code upload failed. Please try again.", "error"); }
      return;
    }
    if (e.target.closest("#gcQrCancel")) { clearPendingQr(); loadPayments(); return; }
    if (e.target.closest("#gcQrRemove")) {
      if (!(await App.confirm("Remove your restaurant’s GCash QR code? Customers will no longer see it for new payments.", { okLabel: "Remove QR code", danger: true }))) return;
      const r = await App.api("/api/staff/payment-account/qr", { method: "DELETE", body: {} });
      App.toast(r.ok ? "GCash QR code removed successfully." : (r.data.error || "Could not remove the QR code."), r.ok ? "success" : "error");
      if (r.ok) loadPayments(); return;
    }
    if (e.target.closest("#gcSave")) {
      const r = await App.api("/api/staff/payment-account", { method: "PUT", body: { holderName: $("gcName").value, mobile: $("gcMobile").value, orderPrepay: $("gcPrepay").checked, reservationFee: $("gcFee").value } });
      if (r.ok) { App.toast("Payment details saved.", "success"); loadPayments(); } else { const a = $("gcAlert"); a.textContent = r.data.error; a.classList.remove("hidden"); a.scrollIntoView({ block: "center" }); } return;
    }
    const tbs = e.target.closest("[data-tb-save]"), tbd = e.target.closest("[data-tb-del]");
    if (tbs) {
      const row = tbs.closest("tr"), g = (f) => row.querySelector(`[data-f=${f}]`);
      const r = await App.api(`/api/staff/tables/${tbs.dataset.tbSave}`, { method: "PATCH", body: { label: g("label").value, capacity: Number(g("capacity").value), reservable: g("reservable").checked, active: g("active").checked } });
      App.toast(r.ok ? (r.data.upcomingConfirmed ? `Saved. This table has ${r.data.upcomingConfirmed} upcoming confirmed reservation(s). Please check them.` : "Table saved.") : r.data.error, r.ok ? "success" : "error"); loadTables(); return;
    }
    if (tbd && await App.confirm(`Delete "${tbd.dataset.name}"?`, { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/staff/tables/${tbd.dataset.tbDel}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Table deleted." : r.data.error, r.ok ? "success" : "error"); loadTables(); return; }
    if (e.target.closest("#tbLenSave")) { const r = await App.api("/api/staff/restaurant", { method: "PATCH", body: { reservationMinutes: Number($("tbLen").value) } }); App.toast(r.ok ? "Saved." : r.data.error, r.ok ? "success" : "error"); if (r.ok) loadTables(); return; }
    const ls = e.target.closest("[data-loc-save]"), lsub = e.target.closest("[data-loc-submit]"), lnew = e.target.closest("[data-loc-new]"), lcan = e.target.closest("[data-loc-cancel]"), ldel = e.target.closest("[data-doc-del]");
    if (ls) { locSave(ls.dataset.locSave); return; }
    if (lnew) { startingNew = true; loadLocation(); return; }
    if (lcan) { startingNew = false; loadLocation(); return; }
    if (ldel && await App.confirm("Remove this document?", { okLabel: "Remove", danger: true })) { const r = await App.api(`/api/staff/location-documents/${ldel.dataset.docDel}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Document removed." : r.data.error, r.ok ? "success" : "error"); loadLocation(); return; }
    if (lsub && await App.confirm("Submit this request for admin review? You will not be able to edit it while it is being reviewed.", { okLabel: "Submit" })) {
      const r = await App.api(`/api/staff/location-requests/${lsub.dataset.locSubmit}/submit`, { body: {} });
      App.toast(r.ok ? "Submitted. The administrator will review it." : r.data.error, r.ok ? "success" : "error"); loadLocation(); return;
    }
    const rm = e.target.closest("[data-img-remove]");
    if (rm && await App.confirm("Remove this image?", { okLabel: "Remove", danger: true })) { const r = await App.api(rm.dataset.imgRemove, { method: "DELETE", body: {} }); App.toast(r.ok ? "Image removed." : r.data.error, r.ok ? "success" : "error"); loadRestaurant(); }
    const ed = e.target.closest("[data-edit-menu]"), dl = e.target.closest("[data-del-menu]");
    if (ed) { const v = await App.prompt(`New price for ${ed.dataset.name}`, "Price in pesos", { okLabel: "Update", required: true, maxLength: 12 }); if (v !== null) { const r = await App.api(`/api/staff/menu/${ed.dataset.editMenu}`, { method: "PATCH", body: { price: Number(v) } }); App.toast(r.ok ? "Price updated." : r.data.error, r.ok ? "success" : "error"); loadRestaurant(); } }
    if (dl && await App.confirm(`Delete "${dl.dataset.name}" from the menu?`, { okLabel: "Delete", danger: true })) { const r = await App.api(`/api/staff/menu/${dl.dataset.delMenu}`, { method: "DELETE", body: {} }); App.toast(r.ok ? "Item deleted." : r.data.error, r.ok ? "success" : "error"); loadRestaurant(); }
  });
  document.addEventListener("change", async (e) => {
    const cht = e.target.closest("[data-ch-toggle]");
    if (cht) {
      let confirmed; if (cht.checked && cht.dataset.kind === "TAX") { if (!(await App.confirm("Switching this tax on means you confirm that you are registered or authorised to charge it and that the rate is correct.", { okLabel: "I confirm" }))) { cht.checked = false; return; } confirmed = true; }
      const r = await App.api(`/api/staff/restaurant-charges/${cht.dataset.chToggle}`, { method: "PATCH", body: { active: cht.checked, confirmed } }); App.toast(r.ok ? "Saved." : r.data.error, r.ok ? "success" : "error"); loadPayments(); return;
    }
    if (e.target.id === "chKind") { $("chConfWrap").classList.toggle("hidden", e.target.value !== "TAX"); return; }
    const pv = e.target.closest("[data-pay-verify]");
    if (pv) { const b = document.querySelector(`[data-pay-accept="${pv.dataset.payVerify}"]`); if (b) b.disabled = !pv.checked; return; }
    if (e.target.id === "gcQr") {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      clearPendingQr();
      const allowed = ["image/jpeg", "image/png", "image/webp"], ext = file.name.toLowerCase().split(".").pop();
      if (!allowed.includes(file.type) && !["jpg", "jpeg", "png", "webp"].includes(ext)) { App.toast("Unsupported image format. Choose a JPG, JPEG, PNG or WEBP image.", "error"); return; }
      if (file.size > 5 * 1024 * 1024) { App.toast("The QR image is larger than 5 MB.", "error"); return; }
      pendingQrFile = file; pendingQrObjectUrl = URL.createObjectURL(file);
      $("gcQrPreview").src = pendingQrObjectUrl; $("gcQrPending").classList.remove("hidden");
      $("gcQrConfirm").disabled = false; $("gcQrConfirm").textContent = "Save / Upload QR code";
      return;
    }
    const dk = e.target.closest("[data-doc-kind]");
    if (dk) {
      const file = dk.files[0]; if (!file) return;
      if (file.size > MAX_DOC) { App.toast("That file is larger than 8 MB.", "error"); dk.value = ""; return; }
      const r = await ISLA.upload(`/api/staff/location-requests/${dk.dataset.req}/documents?kind=${encodeURIComponent(dk.dataset.docKind)}&name=${encodeURIComponent(file.name)}`, file);
      App.toast(r.ok ? "Document uploaded." : r.data.error, r.ok ? "success" : "error"); dk.value = ""; loadLocation(); return;
    }
    const up = e.target.closest("[data-img-upload]");
    if (up) {
      const file = up.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { App.toast("The image is larger than 5 MB.", "error"); up.value = ""; return; }
      const r = await ISLA.upload(up.dataset.imgUpload, file);
      App.toast(r.ok ? "Image saved." : r.data.error, r.ok ? "success" : "error"); up.value = ""; if (r.ok) loadRestaurant(); return;
    }
    const av = e.target.closest("[data-avail]");
    if (av) { const r = await App.api(`/api/staff/menu/${av.dataset.avail}`, { method: "PATCH", body: { available: av.checked } }); if (!r.ok) App.toast(r.data.error, "error"); }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-reply]");
    if (f) { e.preventDefault(); const ta = f.querySelector("textarea"); if (!ta.value.trim()) return; const r = await App.api(`/api/inquiries/${f.dataset.reply}/messages`, { body: { body: ta.value } }); if (r.ok) { loadMessages(); loadOverview(); } else App.toast(r.data.error, "error"); }
    if (e.target.id === "tbBulk") { e.preventDefault(); const r = await App.api("/api/staff/tables/bulk", { body: { count: Number($("tbCount").value), capacity: Number($("tbSeats").value), prefix: $("tbPrefix").value } }); if (r.ok) { App.toast(`${r.data.created.length} table(s) added.`, "success"); loadTables(); } else tbAlert(r.data.error); return; }
    if (e.target.id === "tbOne") { e.preventDefault(); const r = await App.api("/api/staff/tables", { body: { label: $("tbName").value, capacity: Number($("tbOneSeats").value), reservable: $("tbOneRes").checked } }); if (r.ok) { App.toast("Table added.", "success"); loadTables(); } else tbAlert(r.data.error); return; }
    if (e.target.id === "menuForm") {
      e.preventDefault();
      const file = $("mImg").files[0];
      if (file && file.size > 5 * 1024 * 1024) { App.toast("The photo is larger than 5 MB.", "error"); return; }
      const r = await App.api("/api/staff/menu", { body: { name: $("mName").value, price: Number($("mPrice").value), description: $("mDesc").value, category: $("mCat").value } });
      if (!r.ok) { App.toast(r.data.error, "error"); return; }
      if (file) { const u = await ISLA.upload(`/api/staff/menu/${r.data.id}/image`, file); App.toast(u.ok ? "Menu item added with photo." : `Item added, but the photo was not saved: ${u.data.error}`, u.ok ? "success" : "error"); }
      else App.toast("Menu item added.", "success");
      loadRestaurant();
    }
  });
  $("resFilter").addEventListener("change", loadReservations); $("ordFilter").addEventListener("change", loadOrders);

  const loaders = { reservations: loadReservations, orders: loadOrders, messages: loadMessages, reviews: loadReviews, restaurant: loadRestaurant, payments: loadPayments, tables: loadTables, location: loadLocation };
  let currentTab = "reservations";
  App.api("/api/staff/payments").then(r => { if (r.ok) { const n = r.data.counts.review + r.data.counts.refundDue, b = $("cPay"); if (b) { b.textContent = n; b.hidden = !n; } } });
  App.tabs($("tabsRoot"), (tab) => { currentTab = tab; loaders[tab](); });
  setInterval(() => { // keep new requests visible without a manual refresh (skipped while typing)
    if (document.querySelector("dialog[open]") || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    loadOverview(); if (["reservations", "orders", "messages"].includes(currentTab)) loaders[currentTab]();
  }, 45000);
})();
