/* ISLA-PLATEU live location + restaurant navigation.
   Two independent, collapsible panels (Live location / Navigation). Each panel's DOM is built ONCE and only its text is updated,
   so GPS updates never recreate buttons, lose keyboard focus, or add event listeners.
   - one geolocation watch at most; one routing request at most (a newer request waits for the running one)
   - one position marker (a directional arrow) that is moved/rotated, never recreated
   - minimizing a panel only hides its body: tracking and routes keep running
   Depends on Leaflet (L) and assets/heading.js. */
(function (root) {
  "use strict";
  const H = root.IslaHeading;

  function create(o) {
    const { map, container, api, esc, icon, toast } = o;
    const refresh = () => (o.refreshIcons ? o.refreshIcons() : null);
    const S = {
      watchId: null, status: "idle", message: "", pos: null, follow: false, firstFixDone: false, autoMinDone: false,
      dest: null, route: null, routeError: "", routing: false, routeQueued: false, lastRouteAt: 0, lastRoutePos: null, fitted: false, routeRequests: 0,
      marker: null, arrowEl: null, meEl: null, accCircle: null, routeLine: null,
      compass: "idle", /* idle | listening | needs-permission | denied | unsupported */ lastOrient: 0, orientAttached: false,
      displayAngle: null, headingTimer: null, raf: 0, min: { live: false, nav: false }
    };
    const engine = H.createEngine();
    const $ = (id) => container.querySelector("#" + id);

    /* ---------- panels (built once) ---------- */
    const head = (id, ic, title, stopLabel) => `
      <div class="ov-head">
        <div class="ov-title">${icon(ic)}<span class="ov-text"><b id="${id}Title">${title}</b><small id="${id}Summary"></small></span></div>
        <button type="button" class="ov-btn" data-act="${id}-stop" aria-label="${stopLabel}" title="${stopLabel}">${icon("x")}</button>
        <button type="button" class="ov-btn ov-toggle" data-act="${id}-toggle" aria-expanded="true" aria-controls="${id}Body" aria-label="Minimize ${title.toLowerCase()} panel" title="Minimize">
          ${icon("chevron-down", "ic-min")}${icon("chevron-up", "ic-max")}</button>
      </div>`;
    container.innerHTML = `
      <section class="ov-card" id="navPanel" hidden data-min="false" aria-label="Navigation to restaurant">
        ${head("nav", "navigation", "Navigation", "Stop navigation")}
        <div class="ov-body" id="navBody">
          <div class="ov-stats" id="navStats" hidden><div><strong id="navDist">–</strong><span>route distance</span></div><div><strong id="navEta">–</strong><span>est. by car</span></div></div>
          <p class="ov-line" id="navLine" role="status" aria-live="polite"></p>
          <div class="alert alert-error" id="navError" hidden role="alert"></div>
          <p class="ov-fine" id="navFine" hidden>Route by OSRM using OpenStreetMap data. Times are estimates and ignore traffic.</p>
          <div class="ov-actions">
            <button type="button" class="btn btn-quiet" data-act="recenter">${icon("locate-fixed")} Recenter</button>
            <button type="button" class="btn btn-quiet" data-act="change">${icon("map-pinned")} Change destination</button>
            <button type="button" class="btn danger" data-act="nav-stop">${icon("x")} Stop navigation</button>
          </div>
        </div>
      </section>
      <section class="ov-card" id="livePanel" hidden data-min="false" aria-label="Live location">
        ${head("live", "locate-fixed", "Live location", "Stop tracking")}
        <div class="ov-body" id="liveBody">
          <p class="ov-line" id="liveLine" role="status" aria-live="polite"></p>
          <p class="ov-warn" id="liveWarn" hidden></p>
          <div class="alert alert-error" id="liveError" hidden role="alert"></div>
          <dl class="ov-facts"><div><dt>Accuracy</dt><dd id="liveAcc">–</dd></div><div><dt>Direction</dt><dd id="liveDir">–</dd></div></dl>
          <p class="ov-fine" id="liveTip">Allow location access when your browser asks. Drag the map to look around (this turns Follow off). Minimize this panel to see more of the map: tracking keeps running until you press Stop.</p>
          <div class="ov-actions">
            <button type="button" class="btn btn-quiet" data-act="recenter">${icon("locate-fixed")} Recenter</button>
            <button type="button" class="btn btn-quiet" id="followBtn" data-act="follow" aria-pressed="false">${icon("navigation")} <span>Follow me</span></button>
            <button type="button" class="btn btn-quiet" id="compassBtn" data-act="compass" hidden>${icon("compass")} Enable compass</button>
            <button type="button" class="btn btn-quiet" id="retryBtn" data-act="retry" hidden>${icon("rotate-ccw")} Try again</button>
            <button type="button" class="btn danger" data-act="live-stop">${icon("x")} Stop tracking</button>
          </div>
        </div>
      </section>`;
    refresh();

    function setMin(which, minimized) {
      S.min[which] = minimized;
      const card = $(which + "Panel"), btn = card.querySelector(".ov-toggle"), title = which === "nav" ? "navigation" : "live location";
      card.dataset.min = String(minimized);
      btn.setAttribute("aria-expanded", String(!minimized));
      btn.setAttribute("aria-label", `${minimized ? "Restore" : "Minimize"} ${title} panel`); btn.title = minimized ? "Restore" : "Minimize";
    }
    const show = (which, on) => { $(which + "Panel").hidden = !on; };
    const narrow = () => root.matchMedia && root.matchMedia("(max-width: 760px)").matches;

    /* ---------- text updates ---------- */
    const fmtDist = (m) => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
    const fmtTime = (s) => { const mins = Math.max(1, Math.round(s / 60)); return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`; };
    const hav = (a, b) => { const R = 6371000, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
    function dirText() {
      const c = engine.current();
      const deg = Math.round(c.deg) % 360;
      if (c.source === "compass") return `${deg}° (compass${c.accuracy != null ? ` ±${Math.round(c.accuracy)}°` : ""})`;
      if (c.source === "gps") return `${deg}° (GPS direction of travel)`;
      if (c.source === "last") return `${deg}° (last known)`;
      return S.compass === "unsupported" ? "Not available on this device" : "Unknown right now";
    }
    function updateLive() {
      const line = $("liveLine"), err = $("liveError"), warn = $("liveWarn"), acc = S.pos ? Math.round(S.pos.acc) : null;
      err.hidden = true; warn.hidden = true;
      let summary = "";
      if (S.status === "locating") { line.innerHTML = `${icon("loader-circle", "spin")} Finding your location… allow the browser's location prompt.`; summary = "Finding your location…"; }
      else if (S.status === "denied") { line.textContent = ""; err.hidden = false; err.textContent = "Location permission was denied. Allow location access for this site in your browser settings, then press Try again."; summary = "Location blocked"; }
      else if (S.status === "unavailable") { line.textContent = ""; err.hidden = false; err.textContent = S.message || "Your location is unavailable."; summary = "Location unavailable"; }
      else if (S.status === "tracking") {
        line.textContent = "Tracking your location.";
        if (acc !== null && acc > 100) { warn.hidden = false; warn.textContent = "Low GPS accuracy. Move to an open area for a better position."; }
        summary = `Tracking${acc !== null ? ` · ±${acc} m` : ""}${engine.current().deg != null ? ` · ${Math.round(engine.current().deg) % 360}°` : ""}`;
      }
      $("liveAcc").textContent = acc !== null ? `±${acc} m` : "–";
      $("liveDir").textContent = dirText();
      $("liveSummary").textContent = summary;
      const f = $("followBtn"); f.setAttribute("aria-pressed", String(S.follow)); f.querySelector("span").textContent = S.follow ? "Following you" : "Follow me";
      $("compassBtn").hidden = S.compass !== "needs-permission";
      $("retryBtn").hidden = !(S.status === "denied" || S.status === "unavailable");
      const tip = $("liveTip");
      tip.textContent = S.compass === "unsupported" ? "This device does not report compass direction, so the arrow follows your direction of travel while you move. Otherwise a plain dot is shown."
        : S.compass === "denied" ? "Compass access was denied, so the arrow follows your direction of travel while you move. You can allow motion/orientation access in the browser settings."
        : "Allow location access when your browser asks. Drag the map to look around (this turns Follow off). Minimize this panel to see more of the map: tracking keeps running until you press Stop.";
    }
    function updateNav() {
      const d = S.dest; if (!d) return;
      $("navTitle").textContent = d.name;                                  // destination name stays visible when minimized
      $("navSummary").textContent = S.route ? `${fmtDist(S.route.distanceMeters)} · ${fmtTime(S.route.durationSeconds)} by car` : S.routing ? "Calculating route…" : S.routeError ? "No route available" : "Waiting for your location…";
      $("navStats").hidden = !S.route;
      if (S.route) { $("navDist").textContent = fmtDist(S.route.distanceMeters); $("navEta").textContent = fmtTime(S.route.durationSeconds); }
      $("navFine").hidden = !S.route;
      const line = $("navLine"), err = $("navError");
      err.hidden = !S.routeError; err.textContent = S.routeError || "";
      if (S.routing && !S.route) line.innerHTML = `${icon("loader-circle", "spin")} Calculating route…`;
      else if (!S.pos && !S.routeError) line.textContent = "Waiting for your location…";
      else if (S.routeError && S.pos) line.textContent = `Straight-line distance (not a route): ${fmtDist(hav(S.pos, { lat: Number(d.lat), lng: Number(d.lng) }))}`;
      else line.textContent = "";
      if (line.querySelector(".spin")) refresh();
    }

    /* ---------- marker: a directional arrow that is moved and rotated, never recreated ---------- */
    function ensureMarker(ll) {
      if (!S.marker) {
        S.marker = L.marker(ll, { icon: L.divIcon({ className: "me-icon",
          html: '<div class="me no-heading"><span class="me-pulse"></span><svg class="me-arrow" viewBox="0 0 44 44" aria-hidden="true"><path d="M22 3 L34 37 L22 30 L10 37 Z"/></svg><span class="me-dot"></span></div>',
          iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 1200 }).addTo(map);
        const el = S.marker.getElement && S.marker.getElement();
        S.meEl = el && el.querySelector(".me"); S.arrowEl = el && el.querySelector(".me-arrow");
      } else S.marker.setLatLng(ll);
      if (!S.accCircle) S.accCircle = L.circle(ll, { radius: S.pos.acc, color: "#168B8B", weight: 1, fillColor: "#168B8B", fillOpacity: 0.12, interactive: false }).addTo(map);
      else { S.accCircle.setLatLng(ll); S.accCircle.setRadius(S.pos.acc); }
    }
    function renderHeading() {
      S.raf = 0;
      if (!S.meEl) return;
      const c = engine.current();
      S.meEl.classList.toggle("no-heading", c.deg == null);               // neutral dot when there is no trustworthy direction
      S.meEl.classList.toggle("stale", c.source === "last");
      if (c.deg != null) {
        const next = S.displayAngle == null ? c.deg : H.unwrap(S.displayAngle, c.deg);
        if (S.displayAngle == null || Math.abs(next - S.displayAngle) >= 1.5) {   // dead-band: ignore sub-degree jitter
          S.displayAngle = next; S.arrowEl.style.transform = `rotate(${next}deg)`;
        }
        S.meEl.dataset.heading = String(Math.round(H.normalize(S.displayAngle)) % 360);
      } else { delete S.meEl.dataset.heading; S.displayAngle = null; }
      if (S.status === "tracking") updateLive();
    }
    const scheduleHeading = () => { if (!S.raf) S.raf = (root.requestAnimationFrame || ((f) => setTimeout(f, 16)))(renderHeading); };

    /* ---------- compass (device orientation) ---------- */
    function onOrient(e) {
      const now = Date.now(); if (now - S.lastOrient < 100) return; S.lastOrient = now;
      const c = H.compassFromEvent(e, H.screenAngle(root));
      if (c) { engine.onCompass({ deg: c.deg, accuracy: c.accuracy }); scheduleHeading(); }
    }
    function attachOrientation() {
      if (S.orientAttached) return;                                       // never attach twice
      root.addEventListener("deviceorientationabsolute", onOrient, true);
      root.addEventListener("deviceorientation", onOrient, true);
      S.orientAttached = true; S.compass = "listening";
    }
    function detachOrientation() {
      if (!S.orientAttached) return;
      root.removeEventListener("deviceorientationabsolute", onOrient, true);
      root.removeEventListener("deviceorientation", onOrient, true);
      S.orientAttached = false;
    }
    function startOrientation() {
      const DOE = root.DeviceOrientationEvent;
      if (!DOE) { S.compass = "unsupported"; return; }
      if (typeof DOE.requestPermission === "function") { if (S.compass !== "denied") S.compass = "needs-permission"; return; } // iOS: needs a tap
      attachOrientation();
    }
    async function enableCompass() {
      try {
        const state = await root.DeviceOrientationEvent.requestPermission();
        if (state === "granted") attachOrientation(); else S.compass = "denied";
      } catch { S.compass = "denied"; }
      updateLive();
    }

    /* ---------- tracking ---------- */
    function startTracking(opts) {
      if (!o.isSignedIn()) { o.needLogin(S.dest ? "navigation" : "tracking"); return false; }
      if (!navigator.geolocation) { S.status = "unavailable"; S.message = "This browser does not support location services."; show("live", true); updateLive(); return false; }
      show("live", true);
      if (S.watchId !== null) { updateLive(); return true; }               // already tracking: do not start a second watcher
      S.status = "locating"; S.firstFixDone = false; S.autoMinDone = false; S.follow = !(opts && opts.follow === false);
      setMin("live", false); updateLive();
      S.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 4000, timeout: 25000 });
      startOrientation(); updateLive();
      if (!S.headingTimer) S.headingTimer = setInterval(scheduleHeading, 1000);  // lets a stale direction fade to the neutral dot
      if (o.onTrackingChange) o.onTrackingChange(true);
      return true;
    }
    function onPosition(p) {
      const c = p.coords;
      S.pos = { lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0 };
      engine.onGps({ heading: c.heading, speed: c.speed });
      const first = !S.firstFixDone; S.firstFixDone = true; S.status = "tracking";
      const ll = [S.pos.lat, S.pos.lng];
      ensureMarker(ll);
      if (first && !S.dest) map.flyTo(ll, Math.max(map.getZoom(), 15), { duration: 0.7 });
      else if (S.follow && !first) map.panTo(ll, { animate: true, duration: 0.5 });
      if (first && !S.autoMinDone && narrow()) { S.autoMinDone = true; setMin("live", true); }  // small screens: get out of the way once we have a fix
      maybeRoute(false); updateLive(); updateNav(); scheduleHeading();
    }
    function onPositionError(e) {
      if (e.code === 1) { stopWatchOnly(); S.status = "denied"; }
      else if (e.code === 2) { S.status = S.pos ? "tracking" : "unavailable"; S.message = "Your location is currently unavailable. Make sure GPS / location services are on."; }
      else { S.status = S.pos ? "tracking" : "unavailable"; S.message = "Finding your location is taking too long. Move to an open area and try again."; }
      updateLive();
    }
    function stopWatchOnly() { if (S.watchId !== null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; } }
    function stopTracking() {
      stopWatchOnly(); detachOrientation();
      if (S.headingTimer) { clearInterval(S.headingTimer); S.headingTimer = null; }
      if (S.raf && root.cancelAnimationFrame) { root.cancelAnimationFrame(S.raf); } S.raf = 0;
      stopNavigation(true);                                                // a route needs a position, so it ends with tracking
      [S.marker, S.accCircle].forEach(l => { if (l) map.removeLayer(l); });
      S.marker = S.accCircle = S.arrowEl = S.meEl = null; S.pos = null; S.displayAngle = null; S.status = "idle"; S.follow = false; S.firstFixDone = false;
      engine.reset(); show("live", false);
      if (o.onTrackingChange) o.onTrackingChange(false);
    }

    /* ---------- navigation ---------- */
    function clearRoute() { if (S.routeLine) { map.removeLayer(S.routeLine); S.routeLine = null; } S.route = null; S.routeError = ""; S.lastRoutePos = null; S.fitted = false; }
    function maybeRoute(force) {
      if (!S.dest || !S.pos || S.routing) return;
      const moved = S.lastRoutePos ? hav(S.pos, S.lastRoutePos) : Infinity;
      if (force || !S.lastRoutePos || (moved > 50 && Date.now() - S.lastRouteAt > 15000)) requestRoute();
    }
    async function requestRoute() {
      if (!S.dest || !S.pos) return;
      if (S.routing) { S.routeQueued = true; return; }                     // one request at a time
      const dest = S.dest, from = { ...S.pos };
      S.routing = true; S.routeQueued = false; S.lastRouteAt = Date.now(); S.lastRoutePos = from; S.routeRequests++; updateNav();
      const res = await api(`/api/route?from=${from.lat.toFixed(6)},${from.lng.toFixed(6)}&restaurantId=${encodeURIComponent(dest.id)}`);
      S.routing = false;
      if (S.dest !== dest) { if (S.dest && S.routeQueued) requestRoute(); return; }   // destination changed or navigation stopped while waiting
      if (res.status === 401) { stopTracking(); o.needLogin("navigation"); return; }
      if (!res.ok) { S.route = null; S.routeError = res.data.error || "No route could be calculated."; if (S.routeLine) { map.removeLayer(S.routeLine); S.routeLine = null; } updateNav(); return; }
      S.route = res.data; S.routeError = "";
      if (!S.routeLine) S.routeLine = L.polyline(res.data.geometry, { color: "#E98B68", weight: 6, opacity: 0.9 }).addTo(map);
      else S.routeLine.setLatLngs(res.data.geometry);                       // reuse the one polyline
      if (!S.fitted) { S.fitted = true; S.follow = false; map.fitBounds(S.routeLine.getBounds().pad(0.25)); updateLive(); }
      updateNav();
      if (S.routeQueued) { S.routeQueued = false; requestRoute(); }
    }
    function navigateTo(r) {
      if (!o.isSignedIn()) { o.needLogin("navigation"); return false; }
      if (!o.isMappable(r)) { toast(`${r.name} does not have a confirmed map pin yet, so a route cannot be calculated.`, "error"); return false; }
      if (S.dest && S.dest.id !== r.id) clearRoute();                      // old route and marker state are removed before the new destination is set
      else if (S.dest && S.dest.id === r.id && S.route) { setMin("nav", false); show("nav", true); return true; }
      S.dest = r; S.route = null; S.routeError = ""; S.fitted = false; S.lastRoutePos = null;
      if (o.onNavDestination) o.onNavDestination(r.id);
      show("nav", true); setMin("nav", false);
      if (narrow() && S.watchId !== null) setMin("live", true);            // keep the map visible: the navigation panel is the important one
      startTracking({ follow: false });
      updateNav();
      if (S.pos) { S.routeQueued = S.routing; if (!S.routing) requestRoute(true); }
      return true;
    }
    function stopNavigation(silent) {
      const had = !!S.dest;
      S.dest = null; S.routeQueued = false; clearRoute(); show("nav", false);
      if (had && o.onNavDestination) o.onNavDestination(null);
      if (had && !silent) toast("Navigation stopped. Your live location is still on.");
    }
    function recenter() {
      if (!S.pos) { toast("Still waiting for your location."); return; }
      S.follow = true; map.flyTo([S.pos.lat, S.pos.lng], Math.max(map.getZoom(), 16), { duration: 0.6 }); updateLive();
    }

    /* ---------- one delegated listener for every button ---------- */
    container.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      switch (b.dataset.act) {
        case "nav-toggle": setMin("nav", !S.min.nav); break;
        case "live-toggle": setMin("live", !S.min.live); break;
        case "nav-stop": stopNavigation(false); break;
        case "live-stop": stopTracking(); break;
        case "recenter": recenter(); break;
        case "follow": S.follow = !S.follow; if (S.follow && S.pos) map.panTo([S.pos.lat, S.pos.lng], { animate: true }); updateLive(); break;
        case "change": stopNavigation(true); if (o.onChangeDestination) o.onChangeDestination(); break;
        case "compass": enableCompass(); break;
        case "retry": { const d = S.dest; stopTracking(); startTracking({ follow: !d }); if (d) navigateTo(d); break; }
      }
    });
    map.on("dragstart", () => { if (S.follow) { S.follow = false; updateLive(); } });   // the user moved the map by hand: stop following

    const api2 = { startTracking, stopTracking, navigateTo, stopNavigation, isTracking: () => S.watchId !== null || S.status === "denied", getDestinationId: () => (S.dest ? S.dest.id : null),
      debug: () => ({ status: S.status, watching: S.watchId !== null, follow: S.follow, dest: S.dest && S.dest.id, routeRequests: S.routeRequests, orient: S.orientAttached, compass: S.compass, min: { ...S.min }, hasMarker: !!S.marker, hasLine: !!S.routeLine }) };
    root.IslaTrackingDebug = api2.debug;   // read-only status for automated tests
    return api2;
  }
  root.IslaTracking = { create };
})(window);
