/* ISLA-PLATEU restaurant map (public).
   - Anyone can browse, search, filter and open restaurant details.
   - Live tracking / in-app routes need a login (routes are calculated by the server, which checks the session).
   - Reservations, advance orders, messages and ratings are for CUSTOMER accounts.
   Restaurant data comes from the database via /api/restaurants. Only saved coordinates are plotted. */
(() => {
  "use strict";
  const HAS_MAP = typeof L !== "undefined";
  const ISLAND_CENTER = [9.20, 123.52]; // initial island-level view, not a restaurant coordinate
  const ISLAND_BOUNDS = HAS_MAP ? L.latLngBounds([9.08, 123.43], [9.36, 123.67]) : null;
  const HOME = { CUSTOMER: "/account", RESTAURANT_STAFF: "/staff", ADMINISTRATOR: "/admin" };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => App.esc(v);
  const icon = (n, c) => App.icon(n, c);
  const elements = {
    search: $("searchInput"), municipality: $("municipalityFilter"), category: $("categoryFilter"),
    list: $("restaurantList"), empty: $("emptyState"), visibleCount: $("visibleCount"),
    resultSummary: $("resultSummary"), restaurantCount: $("restaurantCount"), mapStatus: $("mapStatus")
  };
  let session = null;           // { id, fullName, role } or null for visitors
  let restaurants = [];
  const markers = new Map();
  let activeId = null;
  let map = null, tracker = null, navDestId = null, tilesLoaded = false, tileErrors = 0;

  const toast = (m, k) => App.toast(m, k);
  const refreshIcons = () => App.refresh();
  const isMappable = (r) => r.lat !== null && r.lat !== "" && r.lng !== null && r.lng !== "" &&
    Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) &&
    Number(r.lat) >= -90 && Number(r.lat) <= 90 && Number(r.lng) >= -180 && Number(r.lng) <= 180 &&
    (r.verified === true || r.locationStatus === "approximate" || r.locationStatus === "verified");
  const hasVerifiedPin = (r) => isMappable(r) && r.locationStatus === "verified";
  const glyphFor = (r) => (r.category === "Cafe" ? "coffee" : "utensils");
  const isCustomer = () => session && session.role === "CUSTOMER";

  /* ---------- Map with loading / error states ---------- */
  function setMapStatus(kind, message, retry) {
    const box = elements.mapStatus;
    if (kind === "hidden") { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.classList.toggle("error", kind === "error");
    box.innerHTML = kind === "error"
      ? `${icon("circle-alert")}<span></span>${retry ? '<button type="button" class="btn btn-quiet small" id="retryMapBtn">Try again</button>' : ""}`
      : `${icon("loader-circle", "spin")}<span></span>`;
    box.querySelector("span").textContent = message;
    if (retry) $("retryMapBtn").addEventListener("click", retry);
    refreshIcons();
  }
  const DEFAULT_TILE = { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' };
  function initMap() {
    if (!HAS_MAP) { setMapStatus("error", "The map library could not be loaded. Check your internet connection and reload the page. The restaurant list still works."); return; }
    map = L.map("map", { zoomControl: true, minZoom: 9, maxZoom: 18, maxBounds: ISLAND_BOUNDS.pad(0.4), maxBoundsViscosity: 0.75 }).setView(ISLAND_CENTER, 11);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    // Keep Leaflet's idea of the container size in step with the real layout (window resize, rotation, sidebar height, late-loading fonts).
    let raf = 0; const resize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => map.invalidateSize({ pan: false })); };
    if ("ResizeObserver" in window) new ResizeObserver(resize).observe($("map")); else window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize); window.addEventListener("load", resize);
    map.on("popupopen", (e) => {
      const el = e.popup.getElement && e.popup.getElement();
      if (el) el.querySelectorAll("[data-popup-detail]").forEach(b => b.addEventListener("click", () => openDetails(b.dataset.popupDetail)));
      if (el) el.querySelectorAll("[data-popup-nav]").forEach(b => b.addEventListener("click", () => beginNavigation(b.dataset.popupNav)));
      refreshIcons();
    });
    tracker = IslaTracking.create({
      map, container: $("mapOverlays"), api: App.api, esc, icon, refreshIcons, toast, isMappable,
      isSignedIn: () => !!session, needLogin: loginPrompt,
      onNavDestination: (id) => { navDestId = id; highlightMarker(); },
      onTrackingChange: (on) => { $("trackBtnLabel").textContent = on ? "Stop tracking" : "Track my location"; },
      onChangeDestination: () => { toast("Choose another restaurant, then press Navigate."); if (window.innerWidth <= 760) $("backToListBtn").click(); else elements.search.focus(); }
    });
    addTiles();
    setTimeout(() => map.invalidateSize(), 250);
  }
  async function addTiles() {
    const res = await App.api("/api/config");
    const cfg = res.ok && res.data.tile ? res.data.tile : DEFAULT_TILE;
    let host = "the tile server"; try { host = new URL(cfg.url.replace(/\{[a-z]\}/g, "a")).host; } catch { /* keep the generic name */ }
    // referrerPolicy: OpenStreetMap's tile usage policy requires a valid Referer, so the site origin must be sent with tile requests.
    const tiles = L.tileLayer(cfg.url, { maxZoom: cfg.maxZoom || 19, attribution: cfg.attribution, referrerPolicy: "strict-origin-when-cross-origin" }).addTo(map);
    const fail = () => setMapStatus("error", `Map tiles could not be loaded from ${host}. This is usually the network, a privacy or ad blocker, or the tile provider refusing requests. Open the browser's developer tools (Network tab) to see the response.`,
      () => { tileErrors = 0; setMapStatus("loading", "Loading map…"); tiles.redraw(); watchdog(); });
    const watchdog = () => setTimeout(() => { if (!tilesLoaded) fail(); }, 12000);
    tiles.on("load", () => { tilesLoaded = true; setMapStatus("hidden"); });
    tiles.on("tileerror", (e) => { tileErrors += 1; if (tileErrors <= 3) console.warn("Map tile failed to load:", e && e.tile ? e.tile.src : "(unknown)"); if (!tilesLoaded && tileErrors >= 4) fail(); });
    watchdog();
  }

  /* ---------- Markers and directory ---------- */
  function iconFor(r) {
    const cls = r.id === "pagudfood" ? "custom-marker pagudfood-marker"
      : r.locationStatus === "approximate" ? "custom-marker approximate-marker" : "custom-marker";
    const logo = typeof r.logo === "string" && r.logo.startsWith("/uploads/public/")
      ? `<img class="marker-logo" src="${esc(r.logo)}" alt="" draggable="false">`
      : icon(glyphFor(r));
    return L.divIcon({ className: "", html: `<div class="${cls}" role="img" aria-label="${esc(r.name)}">${logo}</div>`, iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -22] });
  }
  function popupHtml(r) {
    const address = r.id === "pagudfood" ? r.address : [r.address, r.municipality].filter(Boolean).join(", ");
    const safeImg = (u) => typeof u === "string" && u.startsWith("/uploads/public/") ? u : "";
    return `${safeImg(r.cover) ? `<img class="popup-cover" src="${esc(r.cover)}" alt="" loading="lazy">` : ""}
      <div class="popup-title">${safeImg(r.logo) ? `<img class="popup-logo" src="${esc(r.logo)}" alt="" loading="lazy">` : ""}<span>${esc(r.name)}</span></div>
      ${r.tables ? `<div class="popup-tables"><strong>${r.tables.available}</strong> of ${r.tables.total} tables free now${r.tables.reserved ? ` · ${r.tables.reserved} reserved` : ""} · up to ${r.tables.largest} seats</div>` : ""}
      ${r.ratingCount ? `<div class="popup-meta">${App.stars(r.ratingAvg)} <span>${esc(r.ratingAvg)} (${r.ratingCount})</span></div>` : ""}
      <div class="popup-meta">${icon("map-pin")} ${esc(address || "Address pending confirmation")}</div>
      <div class="popup-meta">${icon(glyphFor(r))} ${esc(r.category || "Unconfirmed")}</div>
      ${r.hours ? `<div class="popup-meta">${icon("clock")} ${esc(r.hours)}</div>` : ""}
      ${r.locationStatus === "approximate" ? `<div class="popup-pending">Approximate pin - confirm exact entrance</div>` : ""}
      <div class="popup-actions"><button type="button" class="popup-link" data-popup-detail="${esc(r.id)}">${icon("info")} View details</button>
      <button type="button" class="popup-link" data-popup-nav="${esc(r.id)}">${icon("navigation")} Navigate</button></div>`;
  }
  function highlightMarker() {
    markers.forEach((marker, id) => {
      const el = marker.getElement && marker.getElement();
      const dot = el && el.querySelector(".custom-marker");
      if (dot) { dot.classList.toggle("selected", id === activeId); dot.classList.toggle("destination", id === navDestId); }
      if (marker.setZIndexOffset) marker.setZIndexOffset(id === activeId ? 1000 : 0);
    });
  }
  function rebuildMarkers() {
    if (!map) return;
    markers.forEach(m => map.removeLayer(m)); markers.clear();
    restaurants.filter(isMappable).forEach(r => {
      const marker = L.marker([Number(r.lat), Number(r.lng)], { icon: iconFor(r), title: r.name, keyboard: true })
        .bindPopup(popupHtml(r), { maxWidth: 280 })
        .on("click", () => { activeId = r.id; renderDirectory(); highlightMarker(); scrollCardIntoView(r.id); });
      marker.addTo(map); markers.set(r.id, marker);
    });
    refreshIcons(); highlightMarker();
  }
  function scrollCardIntoView(id) {
    const card = elements.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card && window.innerWidth > 760) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function visibleRestaurants() {
    const query = elements.search.value.trim().toLocaleLowerCase(), mun = elements.municipality.value, cat = elements.category.value;
    return restaurants.filter(r => {
      const q = !query || [r.name, r.address, r.municipality, r.category, r.description].some(v => String(v || "").toLocaleLowerCase().includes(query));
      return q && (!mun || r.municipality === mun) && (!cat || r.category === cat);
    });
  }
  function populateFilters() {
    const fill = (select, values) => {
      const current = select.value;
      select.querySelectorAll("option:not([value=''])").forEach(o => o.remove());
      [...new Set(values.filter(Boolean))].sort().forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; select.appendChild(o); });
      select.value = [...select.options].some(o => o.value === current) ? current : "";
    };
    fill(elements.municipality, restaurants.map(r => r.municipality)); fill(elements.category, restaurants.map(r => r.category));
  }
  function renderDirectory() {
    const visible = visibleRestaurants();
    elements.visibleCount.textContent = visible.length;
    elements.restaurantCount.textContent = restaurants.length;
    elements.resultSummary.textContent = `Showing ${visible.length} of ${restaurants.length} restaurants`;
    elements.list.classList.toggle("hidden", visible.length === 0);
    elements.empty.classList.toggle("hidden", visible.length !== 0);
    elements.list.innerHTML = visible.map(r => {
      const where = [r.municipality, r.category === "Unconfirmed" ? "" : r.category].filter(Boolean).join(" · ");
      const mapped = isMappable(r);
      const status = r.locationStatus === "approximate" ? "Approx. pin" : (mapped ? "On map" : "Pin pending");
      const photo = typeof r.logo === "string" && r.logo.startsWith("/uploads/public/") ? `<img src="${esc(r.logo)}" alt="" loading="lazy">` : typeof r.photo === "string" && r.photo.startsWith("/assets/") ? `<img src="${esc(r.photo)}" alt="" loading="lazy">` : icon(glyphFor(r));
      return `<article class="restaurant-card ${activeId === r.id ? "active" : ""}" role="button" tabindex="0" data-id="${esc(r.id)}" aria-pressed="${activeId === r.id}" aria-label="Show ${esc(r.name)} on the map">
        <div class="restaurant-avatar" aria-hidden="true">${photo}</div>
        <div class="restaurant-info">
          <h3>${esc(r.name)}</h3>
          ${r.ratingCount ? `<div class="restaurant-meta">${App.stars(r.ratingAvg)}<span>${esc(r.ratingAvg)} (${r.ratingCount})</span></div>` : ""}
          <div class="restaurant-meta">${icon("map-pin")}<span>${esc(where || r.address || "Details pending confirmation")}</span></div>
          ${r.address ? `<div class="restaurant-meta addr"><span>${esc(r.address)}</span></div>` : ""}
          ${r.hours ? `<div class="restaurant-meta">${icon("clock")}<span>${esc(r.hours)}</span></div>` : ""}
          <div class="card-links">
            <button type="button" class="center-btn" data-details="${esc(r.id)}">${icon("info")} Details</button>
            ${mapped ? `<button type="button" class="center-btn" data-nav="${esc(r.id)}">${icon("navigation")} Navigate</button>`
                     : `<span class="location-pending-link">${icon("map-pin")} Address only · no saved pin</span>`}
          </div>
        </div>
        <span class="pending-label ${r.locationStatus === "approximate" ? "approximate-label" : (mapped ? "mapped-label" : "")}">${status}</span>
      </article>`;
    }).join("");
    elements.list.querySelectorAll(".restaurant-card").forEach(card => {
      const activate = () => selectRestaurant(card.dataset.id);
      card.addEventListener("click", e => { if (e.target.closest("a,button")) return; activate(); });
      card.addEventListener("keydown", e => { if (e.target !== card) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    });
    refreshIcons(); highlightMarker();
  }
  function selectRestaurant(id) {
    const r = restaurants.find(x => x.id === id); if (!r) return;
    activeId = id; renderDirectory();
    if (!isMappable(r)) { toast(`${r.name}: exact pin not confirmed yet. Open its details for the listed address.`); return; }
    if (!map) { toast("The map is unavailable right now."); return; }
    const marker = markers.get(id);
    map.flyTo([Number(r.lat), Number(r.lng)], Math.max(map.getZoom(), 15), { duration: 0.7 });
    if (marker) setTimeout(() => { marker.openPopup(); highlightMarker(); }, 450);
    if (window.innerWidth <= 760) document.querySelector(".map-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Login prompt for protected features ---------- */
  function loginPrompt(feature) {
    const copy = {
      navigation: ["Log in to use live navigation", "Live location tracking and in-app routes are available to registered users. Browsing the map stays free."],
      tracking: ["Log in to use live navigation", "Live location tracking is available to registered users. Browsing the map stays free."],
      reserve: ["Log in to reserve a table", "Reservation requests are tied to a customer account so the restaurant can confirm them with you."],
      order: ["Log in to order ahead", "Advance orders are tied to a customer account so you can follow their status."],
      message: ["Log in to message the restaurant", "Messages are tied to a customer account so the restaurant can reply to you."],
      review: ["Log in to rate this restaurant", "Ratings come from signed-in customers, one per restaurant."]
    }[feature] || ["Log in to continue", "This feature needs an account."];
    const m = App.modal({ title: copy[0], size: "narrow", html: `<p class="modal-copy">${esc(copy[1])}</p>
      <div class="cta-stack"><a class="btn btn-primary" href="/login?next=/map">${icon("log-in")} Log In</a>
      <a class="btn btn-quiet" href="/register">${icon("user-plus")} Create Account</a>
      <button type="button" class="link-btn" data-close>Keep browsing</button></div>` });
    m.body.querySelector("[data-close]").addEventListener("click", () => m.close());
  }
  const needCustomer = (feature) => {
    if (!session) { loginPrompt(feature); return false; }
    if (!isCustomer()) { toast("This feature is for customer accounts.", "error"); return false; }
    return true;
  };

  /* ---------- Restaurant details ---------- */
  async function openDetails(id) {
    const base = restaurants.find(r => r.id === id); if (!base) return;
    if (isMappable(base)) selectRestaurant(id);
    const m = App.modal({ title: base.name, size: "wide", html: `<p class="muted">${icon("loader-circle", "spin")} Loading details…</p>` });
    const res = await App.api(`/api/restaurants/${encodeURIComponent(id)}`);
    if (!res.ok) { m.body.innerHTML = `<div class="alert alert-error">${icon("circle-alert")}<span>Could not load details. Please try again.</span></div>`; refreshIcons(); return; }
    const { restaurant: r, reviews, menu, myReview, tableList = [] } = res.data;
    const mapped = isMappable(r);
    const isPagudFood = r.id === "pagudfood";
    const isCafeInfinite = r.id === "the-cafe-infinite";
    const row = (ic, label, v) => v ? `<div class="detail-row">${icon(ic)}<div><small>${label}</small><div>${esc(v)}</div></div></div>` : "";
    const facebookContact = /^https:\/\/www\.facebook\.com\/p\/[A-Za-z0-9-]+\/?$/.test(r.contact || "") ? r.contact : "";
    const contactRow = facebookContact
      ? `<div class="detail-row">${icon("phone")}<div><small>Contact</small><div><a href="${esc(facebookContact)}" target="_blank" rel="noopener noreferrer">Message on Facebook</a></div></div></div>`
      : row("phone", "Contact", r.contact || "No contact information listed yet");
    const displayAddress = isPagudFood ? r.address : [r.address, r.municipality].filter(Boolean).join(", ");
    const custNote = session && !isCustomer() ? `<p class="hint">Reservations, orders, messages and ratings are available to customer accounts.</p>` : "";
    const okImg = (u) => typeof u === "string" && u.startsWith("/uploads/public/") ? u : "";
    const banner = (okImg(r.cover) || okImg(r.logo)) ? `<div class="detail-banner">${okImg(r.cover) ? `<img class="detail-cover" src="${esc(r.cover)}" alt="${esc(r.name)} profile photo">` : ""}${okImg(r.logo) ? `<img class="detail-logo" src="${esc(r.logo)}" alt="${esc(r.name)} logo">` : ""}</div>` : "";
    m.body.innerHTML = `${banner}
      <div class="detail-top"><span class="pill">${esc(r.category)}</span>
        ${r.ratingCount ? `<span class="rating-line">${App.stars(r.ratingAvg)} <strong>${esc(r.ratingAvg)}</strong> <span class="muted">(${r.ratingCount} review${r.ratingCount === 1 ? "" : "s"})</span></span>` : `<span class="muted">No ratings yet</span>`}
        <span class="pill ${r.locationStatus === "verified" ? "ok" : "warn"}">${mapped ? (r.locationStatus === "verified" ? "Verified pin" : "Approximate pin") : "Pin pending"}</span></div>
      ${r.description ? `<p class="detail-desc">${esc(r.description)}</p>` : ""}
      <div class="detail-grid">
        ${row("map-pin", "Address", displayAddress || "Address pending confirmation")}
        ${row("clock", "Operating hours", r.hours || "Hours not listed yet. Contact the restaurant.")}
        ${contactRow}
        ${r.notes ? row("circle-help", "Note", r.notes) : ""}
      </div>
      ${isPagudFood ? `<section class="restaurant-map-section" aria-label="PagudFood location on the ISLA PLATEU map">
        <div class="restaurant-map-heading"><div><h3 class="detail-h">PagudFood on the ISLA PLATEU map</h3>
        <p class="muted">${mapped ? `Saved pin: ${Number(r.lat)}, ${Number(r.lng)}.` : "No valid restaurant pin is saved yet."}</p></div>
        ${mapped ? `<button class="btn btn-primary small" type="button" data-act="show-map">${icon("map-pin")} Show on map</button>` : ""}</div>
        <p class="muted">${esc(displayAddress || "Address pending confirmation")}</p>
      </section>` : ""}
      ${r.tables ? `<h3 class="detail-h">Tables</h3><p class="muted">${r.tables.total} table${r.tables.total === 1 ? "" : "s"} · ${r.tables.seats} seats in total · <strong>${r.tables.available} free</strong> and ${r.tables.reserved} reserved right now · ${r.acceptsReservations ? "Reservations are open" : "Not taking reservations at the moment"}</p>
        <ul class="table-chips">${tableList.map(t => `<li class="table-chip ${esc(t.status)}"><strong>${esc(t.label)}</strong><span>${t.capacity} seat${t.capacity === 1 ? "" : "s"}</span><em>${({ available: "Free now", reserved: "Reserved now", disabled: "Unavailable", "walk-in": "Walk-in only" })[t.status] || ""}</em></li>`).join("")}</ul>
        <p class="hint">Table availability depends on the date and time. You can check specific times when you reserve.</p>` : ""}
      <div class="item-actions detail-actions">
        ${mapped ? `<button class="btn btn-primary" type="button" data-act="nav">${icon("navigation")} Navigate${session ? "" : " (log in)"}</button>`
                 : `<span class="muted">No saved map pin yet.</span>`}
        ${r.acceptsReservations ? `<button class="btn btn-quiet" type="button" data-act="reserve">${icon("clock")} Reserve a table</button>` : ""}
        ${r.acceptsOrders ? `<button class="btn btn-quiet" type="button" data-act="order">${icon("utensils")} Order ahead</button>` : ""}
        <button class="btn btn-quiet" type="button" data-act="message">${icon("bell")} Message restaurant</button>
        <button class="btn btn-quiet" type="button" data-act="review">${icon("circle-check")} ${myReview ? "Edit my rating" : "Rate"}</button>
      </div>${custNote}
      ${menu.length ? `<h3 class="detail-h">Menu</h3><ul class="menu-cards">${menu.map(i => `<li class="menu-card ${i.available ? "" : "off"}">${okImg(i.image) ? `<img src="${esc(i.image)}" alt="${esc(i.name)}" loading="lazy">` : `<span class="menu-noimg" aria-hidden="true">${icon("utensils")}</span>`}<div class="menu-body"><strong>${esc(i.name)}</strong>${i.category ? ` <span class="pill">${esc(i.category)}</span>` : ""}${i.description ? `<p class="muted">${esc(i.description)}</p>` : ""}<div class="menu-foot"><strong>${esc(App.money(i.price))}</strong><span class="pill ${i.available ? "ok" : "warn"}">${i.available ? "Available" : "Unavailable"}</span></div></div></li>`).join("")}</ul>` : isCafeInfinite ? `<p class="muted">The current itemized menu and prices have not been verified. Please message the restaurant for current offerings.</p>` : ""}
      <h3 class="detail-h">Customer reviews</h3>
      ${reviews.length ? `<div class="stack">${reviews.map(v => `<div class="item-card"><div class="item-head"><strong>${esc(v.name)}</strong>${App.stars(v.rating)}</div>${v.comment ? `<p class="item-body">${esc(v.comment)}</p>` : ""}<div class="item-meta">${esc(App.fmtDateTime(v.at))}</div></div>`).join("")}</div>` : `<p class="muted">No reviews yet.</p>`}`;
    refreshIcons();
    const on = (act, fn) => { const b = m.body.querySelector(`[data-act="${act}"]`); if (b) b.addEventListener("click", fn); };
    on("show-map", () => { m.close(); selectRestaurant(r.id); });
    on("nav", () => { m.close(); beginNavigation(r.id); });
    on("reserve", () => { if (needCustomer("reserve")) { m.close(); reserveDialog(r); } else if (!session) m.close(); });
    on("order", () => { if (needCustomer("order")) { m.close(); orderDialog(r, menu.filter(i => i.available)); } else if (!session) m.close(); });
    on("message", () => { if (needCustomer("message")) { m.close(); messageDialog(r); } else if (!session) m.close(); });
    on("review", () => { if (needCustomer("review")) { m.close(); reviewDialog(r, myReview); } else if (!session) m.close(); });
  }

  /* ---------- Customer forms ---------- */
  function formAlert(m) { return (msg) => { const a = m.body.querySelector(".form-alert"); a.textContent = msg; a.classList.remove("hidden"); a.scrollIntoView({ block: "nearest" }); }; }
  function reserveDialog(r) {
    const m = App.modal({ title: `Reserve at ${r.name}`, size: "narrow", html: `
      <div class="alert alert-error hidden form-alert" role="alert"></div>
      ${r.hours ? `<p class="hint">Listed hours: ${esc(r.hours)}. The restaurant confirms every request.</p>` : `<p class="hint">The restaurant confirms every request.</p>`}
      <div class="stack"><div class="inline-fields">
        <label class="form-field"><span>Date</span><input type="date" id="rvDate" min="${App.todayPH()}" required></label>
        <label class="form-field"><span>Time</span><input type="time" id="rvTime" required></label>
        <label class="form-field"><span>Party size</span><input type="number" id="rvParty" min="1" max="20" value="2" required></label></div>
      ${r.reservationFee ? `<div id="rvFee"></div>` : ""}
      ${r.tables ? `<div id="rvTables" class="stack"></div>` : ""}
      <label class="form-field"><span>Notes (optional)</span><textarea id="rvNotes" maxlength="300" placeholder="Occasion, seating preference, allergies…"></textarea></label></div>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Send request</button></div>`});
    const alertFn = formAlert(m);
    let feeTotal; const feeBox = m.body.querySelector("#rvFee");
    async function loadFee() {
      if (!feeBox) return;
      const q = await App.api(`/api/restaurants/${encodeURIComponent(r.id)}/reservation-quote`);
      if (q.ok && q.data.feeRequired) { feeTotal = q.data.total; feeBox.innerHTML = `<div class="alert alert-info"><span>This restaurant asks for a reservation fee, paid by GCash after you send the request. Your table is held only after the restaurant verifies the payment and confirms.</span></div>${App.breakdown(q.data.breakdown, q.data.total)}`; }
      else { feeTotal = undefined; feeBox.innerHTML = ""; }
    }
    loadFee();
    const tbox = m.body.querySelector("#rvTables"); let tseq = 0;
    async function refreshTables() {
      if (!tbox) return;
      const date = m.body.querySelector("#rvDate").value, time = m.body.querySelector("#rvTime").value, party = Number(m.body.querySelector("#rvParty").value) || 1;
      if (!date || !time) { tbox.innerHTML = `<p class="hint">Choose a date and time to see which tables are free.</p>`; return; }
      const mine = ++tseq, resp = await App.api(`/api/restaurants/${encodeURIComponent(r.id)}/tables?date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}`);
      if (mine !== tseq) return; // a newer choice arrived
      if (!resp.ok) { tbox.innerHTML = `<p class="hint">${esc(resp.data.error || "Could not check tables.")}</p>`; return; }
      const prev = tbox.querySelector("input[name=rvTable]:checked"), chosen = prev ? prev.value : "", { tables, summary } = resp.data;
      const fits = tables.filter(t => t.status === "available" && t.capacity >= party);
      tbox.innerHTML = `<fieldset class="table-pick"><legend>Table</legend><p class="hint">${summary.available} of ${summary.reservable} reservable tables are free at that time.</p>
        <label class="check-line"><input type="radio" name="rvTable" value="" ${chosen === "" ? "checked" : ""}> Any suitable table (the restaurant assigns one)</label>
        ${tables.filter(t => t.status !== "walk-in").map(t => { const okT = t.status === "available" && t.capacity >= party; const why = t.status === "reserved" ? "Reserved at that time" : t.status === "disabled" ? "Unavailable" : t.capacity < party ? `Too small for ${party}` : "";
          return `<label class="check-line ${okT ? "" : "off"}"><input type="radio" name="rvTable" value="${t.id}" ${okT ? "" : "disabled"} ${okT && String(t.id) === chosen ? "checked" : ""}> ${esc(t.label)} · seats ${t.capacity}${why ? ` <small class="muted">(${why})</small>` : ""}</label>`; }).join("")}
        ${fits.length ? "" : `<div class="alert alert-error"><span>No table is free for ${party} guest${party === 1 ? "" : "s"} at that time. Try another time.</span></div>`}</fieldset>`;
    }
    ["#rvDate", "#rvTime", "#rvParty"].forEach(sel => { const el = m.body.querySelector(sel); el.addEventListener("change", refreshTables); el.addEventListener("input", refreshTables); });
    refreshTables();
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const pick = m.body.querySelector("input[name=rvTable]:checked");
      const res = await App.api("/api/reservations", { body: { restaurantId: r.id, date: m.body.querySelector("#rvDate").value, time: m.body.querySelector("#rvTime").value,
        partySize: Number(m.body.querySelector("#rvParty").value), notes: m.body.querySelector("#rvNotes").value, tableId: pick && pick.value ? Number(pick.value) : undefined, expectedTotal: feeTotal } });
      btn.disabled = false;
      if (res.ok) { m.close(); toast(res.data.paymentRequired ? "Request sent. Complete the reservation fee payment." : "Reservation request sent. Track it in My Account.", "success"); if (res.data.paymentRequired) App.paymentDialog(res.data.paymentId); } else { alertFn(res.data.error || "Could not send the request."); if (/changed since you reviewed/.test(res.data.error || "")) loadFee(); }
    });
  }
  function orderDialog(r, menu) {
    const options = r.fulfillmentOptions && r.fulfillmentOptions.length ? r.fulfillmentOptions : ["PICKUP"];
    const state = { qty: {}, fulfillment: "PICKUP", date: "", time: "", notes: "" };
    const m = App.modal({ title: `Order ahead from ${r.name}`, size: "narrow", html: "<div></div>" });
    const safeImg = (u) => typeof u === "string" && u.startsWith("/uploads/public/") ? u : "";
    const subtotal = () => menu.reduce((t, i) => t + i.price * (state.qty[i.id] || 0), 0);
    const items = () => menu.filter(i => state.qty[i.id] > 0).map(i => ({ menuItemId: i.id, qty: state.qty[i.id] }));
    const when = () => state.fulfillment === "DINE_IN" ? "Arrival" : "Pickup";
    function showError(msg) { const a = m.body.querySelector(".form-alert"); if (!a) return; a.textContent = msg; a.classList.remove("hidden"); a.scrollIntoView({ block: "nearest" }); }
    function renderChoose() {
      m.body.innerHTML = `<div class="alert alert-error hidden form-alert" role="alert"></div>
        <p class="hint">The restaurant accepts or declines each order. Prices come from the restaurant's current menu and are checked again on the review step.</p>
        <ul class="order-list">${menu.map(i => `<li>${safeImg(i.image) ? `<img class="order-thumb" src="${esc(i.image)}" alt="" loading="lazy">` : ""}
          <div class="order-info"><strong>${esc(i.name)}</strong><small>${esc(App.money(i.price))}${i.description ? " · " + esc(i.description) : ""}</small></div>
          <div class="stepper"><button type="button" data-step="-1" data-id="${i.id}" aria-label="One fewer ${esc(i.name)}">−</button><output id="q${i.id}" aria-live="polite">${state.qty[i.id] || 0}</output><button type="button" data-step="1" data-id="${i.id}" aria-label="One more ${esc(i.name)}">+</button></div></li>`).join("")}</ul>
        <p class="order-total">Items subtotal: <strong id="orTotal">${esc(App.money(subtotal()))}</strong></p>
        <fieldset class="table-pick"><legend>How would you like your order?</legend>
          ${options.map(o => `<label class="check-line"><input type="radio" name="orFul" value="${o}" ${state.fulfillment === o ? "checked" : ""}> ${o === "DINE_IN" ? "Dine-in: the food is prepared for your arrival" : "Pickup at the restaurant"}</label>`).join("")}</fieldset>
        <div class="stack"><div class="inline-fields"><label class="form-field"><span id="orDateL">${when()} date</span><input type="date" id="orDate" min="${App.todayPH()}" value="${esc(state.date)}"></label>
          <label class="form-field"><span id="orTimeL">${when()} time</span><input type="time" id="orTime" value="${esc(state.time)}"></label></div>
        <label class="form-field"><span>Notes (optional)</span><textarea id="orNotes" maxlength="300">${esc(state.notes)}</textarea></label></div>
        <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-go="review">Review order</button></div>`;
    }
    function renderReview(q) {
      state.expected = q.breakdown ? q.total : undefined; // the total the customer actually saw; the server refuses the order if fees changed meanwhile
      m.body.innerHTML = `<div class="alert alert-error hidden form-alert" role="alert"></div>
        <h3 class="detail-h">Review your order</h3>
        <ul class="review-lines">${q.items.map(l => `<li>${safeImg(l.image) ? `<img class="order-thumb" src="${esc(l.image)}" alt="" loading="lazy">` : ""}<span class="review-name">${l.qty} × ${esc(l.name)}<small>${esc(App.money(l.price))} each</small></span><strong>${esc(App.money(l.lineTotal))}</strong></li>`).join("")}</ul>
        ${q.breakdown ? App.breakdown(q.breakdown, q.total) : `<div class="review-totals"><div><span>Items subtotal</span><span>${esc(App.money(q.subtotal))}</span></div><div class="grand"><span>Total</span><span>${esc(App.money(q.total))}</span></div></div>`}
        <div class="review-meta"><div><small>Service</small><div>${esc(q.fulfillmentLabel)}</div></div><div><small>${when()} on</small><div>${esc(App.fmtSlot(state.date, state.time))}</div></div>${state.notes ? `<div><small>Your note</small><div>${esc(state.notes)}</div></div>` : ""}</div>
        <p class="hint">${q.paymentRequired ? "After you place the order you will pay with GCash and upload your receipt. The restaurant accepts the order only after it has verified your payment." : "Nothing is charged by ISLA-PLATEU when you place the order. The restaurant reviews it first."}</p>
        <div class="modal-actions"><button class="btn btn-quiet" type="button" data-go="back">Back</button><button class="btn btn-primary" type="button" data-go="place">Place order</button></div>`;
    }
    renderChoose();
    m.body.addEventListener("input", (e) => {
      if (e.target.id === "orDate") state.date = e.target.value;
      else if (e.target.id === "orTime") state.time = e.target.value;
      else if (e.target.id === "orNotes") state.notes = e.target.value;
      else if (e.target.name === "orFul") { state.fulfillment = e.target.value; const a = m.body.querySelector("#orDateL"), b = m.body.querySelector("#orTimeL"); if (a) a.textContent = when() + " date"; if (b) b.textContent = when() + " time"; }
    });
    m.body.addEventListener("click", async (e) => {
      const st = e.target.closest("[data-step]"), go = e.target.closest("[data-go]");
      if (e.target.closest("[data-no]")) { m.close(); return; }
      if (st) {
        const id = st.dataset.id, n = Math.min(20, Math.max(0, (state.qty[id] || 0) + Number(st.dataset.step)));
        state.qty[id] = n; m.body.querySelector(`#q${id}`).textContent = n; m.body.querySelector("#orTotal").textContent = App.money(subtotal()); return;
      }
      if (!go) return;
      if (go.dataset.go === "back") { renderChoose(); return; }
      const btn = go; btn.disabled = true;
      if (go.dataset.go === "review") {
        if (!items().length) { btn.disabled = false; showError("Choose at least one item."); return; }
        if (!state.date || !state.time) { btn.disabled = false; showError(`Choose the ${when().toLowerCase()} date and time.`); return; }
        const q = await App.api("/api/orders/quote", { body: { restaurantId: r.id, items: items(), fulfillment: state.fulfillment } });
        btn.disabled = false; if (q.ok) renderReview(q.data); else showError(q.data.error || "Could not review the order.");
      } else if (go.dataset.go === "place") {
        const res = await App.api("/api/orders", { body: { restaurantId: r.id, pickupDate: state.date, pickupTime: state.time, notes: state.notes, items: items(), fulfillment: state.fulfillment, expectedTotal: state.expected } });
        btn.disabled = false;
        if (!res.ok && /changed since you reviewed/.test(res.data.error || "")) { const q2 = await App.api("/api/orders/quote", { body: { restaurantId: r.id, items: items(), fulfillment: state.fulfillment } }); if (q2.ok) renderReview(q2.data); showError(res.data.error); return; }
        if (res.ok) { m.close(); toast(res.data.paymentRequired ? "Order sent. Complete your payment so the restaurant can accept it." : "Advance order sent. Track it in My Account.", "success"); if (res.data.paymentRequired) App.paymentDialog(res.data.paymentId); } else showError(res.data.error || "Could not place the order.");
      }
    });
  }
  function messageDialog(r) {
    const m = App.modal({ title: `Message ${r.name}`, size: "narrow", html: `
      <div class="alert alert-error hidden form-alert" role="alert"></div>
      <p class="hint">Staff reply inside ISLA-PLATEU. Replies appear in My Account and your notifications.</p>
      <div class="stack"><label class="form-field"><span>Subject</span><input id="msSubject" maxlength="100" placeholder="e.g. Group booking question"></label>
      <label class="form-field"><span>Message</span><textarea id="msBody" maxlength="1000"></textarea></label></div>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Send message</button></div>`});
    const alertFn = formAlert(m);
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const res = await App.api("/api/inquiries", { body: { restaurantId: r.id, subject: m.body.querySelector("#msSubject").value, message: m.body.querySelector("#msBody").value } });
      btn.disabled = false;
      if (res.ok) { m.close(); toast("Message sent to the restaurant.", "success"); } else alertFn(res.data.error || "Could not send the message.");
    });
  }
  function reviewDialog(r, mine) {
    const m = App.modal({ title: `Rate ${r.name}`, size: "narrow", html: `
      <div class="alert alert-error hidden form-alert" role="alert"></div>
      <p class="hint">One rating per restaurant. You can edit yours later.</p>
      <div class="star-input" role="radiogroup" aria-label="Rating">${[5, 4, 3, 2, 1].map(i => `<input type="radio" name="rate" id="rate${i}" value="${i}" ${mine && mine.rating === i ? "checked" : ""}><label for="rate${i}" title="${i} star${i > 1 ? "s" : ""}">★</label>`).join("")}</div>
      <label class="form-field" style="margin-top:12px"><span>Comment (optional)</span><textarea id="rvComment" maxlength="500">${esc(mine ? mine.comment : "")}</textarea></label>
      <div class="modal-actions"><button class="btn btn-quiet" type="button" data-no>Cancel</button><button class="btn btn-primary" type="button" data-yes>Save rating</button></div>`});
    const alertFn = formAlert(m);
    m.body.querySelector("[data-no]").addEventListener("click", () => m.close());
    m.body.querySelector("[data-yes]").addEventListener("click", async (e) => {
      const picked = m.body.querySelector('input[name="rate"]:checked');
      if (!picked) { alertFn("Choose a star rating."); return; }
      const btn = e.currentTarget; btn.disabled = true;
      const res = await App.api(`/api/restaurants/${encodeURIComponent(r.id)}/reviews`, { body: { rating: Number(picked.value), comment: m.body.querySelector("#rvComment").value } });
      btn.disabled = false;
      if (res.ok) { m.close(); toast(res.data.updated ? "Your rating was updated." : "Thanks for rating!", "success"); loadRestaurants(); } else alertFn(res.data.error || "Could not save the rating.");
    });
  }

  /* ================= Live tracking and in-app navigation (see assets/tracking.js) ================= */
  function beginNavigation(id) {
    const r = restaurants.find(x => x.id === id); if (!r) return;
    if (!session) { loginPrompt("navigation"); return; }
    if (!tracker) { toast("The map is unavailable right now.", "error"); return; }
    activeId = id; renderDirectory();
    if (tracker.navigateTo(r) && window.innerWidth <= 760) document.querySelector(".map-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Session + data ---------- */
  async function loadSession() {
    const res = await App.api("/api/me");
    if (!res.ok) return; // visitors can use the public map
    session = res.data.user;
    $("guestNav").classList.add("hidden"); $("userNav").classList.remove("hidden");
    $("userName").textContent = session.fullName; $("userRole").textContent = ISLA.ROLE_LABEL[session.role];
    const link = $("dashLink"); link.href = HOME[session.role]; link.querySelector("span").textContent = session.role === "CUSTOMER" ? "My Account" : "My Dashboard";
    App.initBell($("bellMount"));
  }
  async function loadRestaurants() {
    const res = await App.api("/api/restaurants");
    if (!res.ok || !Array.isArray(res.data)) {
      elements.list.innerHTML = `<div class="loading-state error">${icon("circle-alert")} Could not load restaurants. <button type="button" class="btn btn-quiet small" id="retryDataBtn">Try again</button></div>`;
      $("retryDataBtn").addEventListener("click", loadRestaurants); refreshIcons(); return;
    }
    restaurants = res.data;
    populateFilters(); rebuildMarkers(); renderDirectory();
  }

  /* ---------- Events ---------- */
  elements.search.addEventListener("input", renderDirectory);
  elements.municipality.addEventListener("change", renderDirectory);
  elements.category.addEventListener("change", renderDirectory);
  $("clearFiltersBtn").addEventListener("click", () => { elements.search.value = ""; elements.municipality.value = ""; elements.category.value = ""; renderDirectory(); });
  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing && !document.querySelector("dialog[open]")) { e.preventDefault(); elements.search.focus(); }
  });
  elements.list.addEventListener("click", e => {
    const d = e.target.closest("[data-details]"), n = e.target.closest("[data-nav]");
    if (d) { e.stopPropagation(); openDetails(d.dataset.details); }
    if (n) { e.stopPropagation(); beginNavigation(n.dataset.nav); }
  });
  $("myLocationBtn").addEventListener("click", () => {
    if (!session) { loginPrompt("tracking"); return; }
    if (!tracker) { toast("The map is unavailable right now.", "error"); return; }
    if (tracker.isTracking()) tracker.stopTracking(); else tracker.startTracking();
  });
  $("resetMapBtn").addEventListener("click", () => { if (map) map.flyTo(ISLAND_CENTER, 11, { duration: 0.6 }); });
  $("backToListBtn").addEventListener("click", () => document.querySelector(".sidebar").scrollIntoView({ behavior: "smooth", block: "start" }));

  initMap();
  loadSession().finally(loadRestaurants);
})();
