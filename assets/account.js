/* Customer account: reservations, advance orders and messages. The server only returns the signed-in customer's own records. */
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id), esc = App.esc, icon = App.icon;
  const user = await App.requireUser(["CUSTOMER"]); if (!user) return;
  $("welcomeName").textContent = user.fullName.split(" ")[0];
  App.initBell($("bellMount"));

  async function loadReservations() {
    const r = await App.api("/api/my/reservations"), box = $("resList");
    if (!r.ok) { box.innerHTML = `<div class="empty-note">Could not load reservations.</div>`; return; }
    box.innerHTML = r.data.length ? r.data.map(v => `<article class="item-card"><div class="item-head"><div><h3>${esc(v.restaurantName)}</h3>
      <div class="item-meta">${esc(App.fmtSlot(v.date, v.time))} · party of ${v.partySize}</div></div>${App.badge(v.status)}</div>
      ${v.notes ? `<p class="item-body">Your note: ${esc(v.notes)}</p>` : ""}${v.staffNote ? `<p class="item-body"><strong>Restaurant:</strong> ${esc(v.staffNote)}</p>` : ""}
      ${["PENDING", "CONFIRMED"].includes(v.status) ? `<div class="item-actions"><button class="btn btn-quiet small" data-cancel-res="${v.id}">Cancel reservation</button></div>` : ""}</article>`).join("")
      : `<div class="empty-note">No reservations yet. Open a restaurant on the <a href="/map">map</a> and choose <strong>Reserve a table</strong>.</div>`;
  }
  async function loadOrders() {
    const r = await App.api("/api/my/orders"), box = $("ordList");
    if (!r.ok) { box.innerHTML = `<div class="empty-note">Could not load orders.</div>`; return; }
    box.innerHTML = r.data.length ? r.data.map(o => `<article class="item-card"><div class="item-head"><div><h3>Order #${o.id} · ${esc(o.restaurantName)}</h3>
      <div class="item-meta">Pickup ${esc(App.fmtSlot(o.pickupDate, o.pickupTime))}</div></div>${App.badge(o.status)}</div>
      <ul class="line-items">${o.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}</span><span>${esc(App.money(i.price * i.qty))}</span></li>`).join("")}<li><strong>Total</strong><strong>${esc(App.money(o.total))}</strong></li></ul>
      ${o.notes ? `<p class="item-body">Your note: ${esc(o.notes)}</p>` : ""}
      ${o.status === "PENDING" ? `<div class="item-actions"><button class="btn btn-quiet small" data-cancel-ord="${o.id}">Cancel order</button></div>` : ""}</article>`).join("")
      : `<div class="empty-note">No advance orders yet. Restaurants that take advance orders show an <strong>Order ahead</strong> button on the <a href="/map">map</a>.</div>`;
  }
  let threads = [], currentThread = null;
  async function loadMessages() {
    const r = await App.api("/api/my/inquiries"); if (!r.ok) { $("msgRoot").innerHTML = `<div class="empty-note">Could not load messages.</div>`; return; }
    threads = r.data; if (!threads.some(t => t.id === currentThread)) currentThread = threads[0] ? threads[0].id : null; renderMessages();
  }
  function renderMessages() {
    const root = $("msgRoot");
    if (!threads.length) { root.innerHTML = `<div class="empty-note">No messages yet. Use <strong>Message restaurant</strong> on a restaurant's details.</div>`; return; }
    const t = threads.find(x => x.id === currentThread);
    root.innerHTML = `<div class="convo"><div class="convo-list">${threads.map(x => `<button class="convo-item" data-thread="${x.id}" aria-current="${x.id === currentThread}"><strong>${esc(x.subject)}</strong><span>${esc(x.restaurantName)} · ${esc(App.fmtDateTime(x.updatedAt))}</span></button>`).join("")}</div>
      <div class="convo-pane"><div class="bubbles">${t.messages.map(m => `<div class="bubble ${m.from === "CUSTOMER" ? "mine" : ""}">${esc(m.body)}<small>${esc(m.from === "CUSTOMER" ? "You" : t.restaurantName + " staff")} · ${esc(App.fmtDateTime(m.at))}</small></div>`).join("")}</div>
      <form class="reply-form" data-reply="${t.id}"><textarea maxlength="1000" placeholder="Write a reply…" aria-label="Reply"></textarea><button class="btn btn-primary" type="submit">${icon("arrow-right")} Send</button></form></div></div>`;
    App.refresh();
  }
  document.addEventListener("click", async (e) => {
    const cr = e.target.closest("[data-cancel-res]"), co = e.target.closest("[data-cancel-ord]"), th = e.target.closest("[data-thread]");
    if (cr && await App.confirm("Cancel this reservation?", { okLabel: "Cancel reservation", danger: true })) {
      const r = await App.api(`/api/reservations/${cr.dataset.cancelRes}/cancel`, { method: "POST", body: {} });
      App.toast(r.ok ? "Reservation cancelled." : r.data.error, r.ok ? "success" : "error"); loadReservations();
    }
    if (co && await App.confirm("Cancel this advance order?", { okLabel: "Cancel order", danger: true })) {
      const r = await App.api(`/api/orders/${co.dataset.cancelOrd}/cancel`, { method: "POST", body: {} });
      App.toast(r.ok ? "Order cancelled." : r.data.error, r.ok ? "success" : "error"); loadOrders();
    }
    if (th) { currentThread = Number(th.dataset.thread); renderMessages(); }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-reply]"); if (!f) return; e.preventDefault();
    const ta = f.querySelector("textarea"); if (!ta.value.trim()) return;
    const r = await App.api(`/api/inquiries/${f.dataset.reply}/messages`, { body: { body: ta.value } });
    if (r.ok) loadMessages(); else App.toast(r.data.error || "Could not send.", "error");
  });

  App.tabs($("tabsRoot"), (tab) => { ({ reservations: loadReservations, orders: loadOrders, messages: loadMessages })[tab](); });
})();
