/* ISLA-PLATEU heading logic (no DOM, works in the browser and in Node tests).

   Three different things are kept SEPARATE here, because they are not interchangeable:
     1. GPS course      - direction of TRAVEL from the Geolocation API (coords.heading). Only meaningful while moving.
     2. Compass heading - direction the DEVICE is pointing, from orientation sensors. Needs screen-orientation correction.
     3. Screen angle    - how the page is rotated relative to the device body (0/90/180/270).
   The engine picks the best fresh source, smooths it as an angle (so 359° -> 1° is a 2° move, not 358°), keeps the last
   reliable heading for a short time, and otherwise reports "unknown" so the UI shows a neutral marker instead of a made-up direction. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IslaHeading = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;

  const normalize = (d) => ((d % 360) + 360) % 360;
  /** shortest signed rotation from `from` to `to`, in (-180, 180] */
  function shortestDelta(from, to) {
    let d = normalize(to) - normalize(from);
    if (d > 180) d -= 360; else if (d <= -180) d += 360;
    return d;
  }
  /** move `prev` towards `next` by factor alpha along the shortest arc */
  function smoothAngle(prev, next, alpha) { return prev == null ? normalize(next) : normalize(prev + shortestDelta(prev, next) * alpha); }
  /** screen rotation relative to the device (0, 90, 180, 270). screen.orientation.angle and window.orientation agree once normalised. */
  function screenAngle(win) {
    const w = win || (typeof window !== "undefined" ? window : {});
    const a = w.screen && w.screen.orientation && typeof w.screen.orientation.angle === "number" ? w.screen.orientation.angle
      : typeof w.orientation === "number" ? w.orientation : 0;
    return normalize(a);
  }

  /** Compass heading of the direction the USER FACES, from a deviceorientation event.
      - iOS gives webkitCompassHeading (clockwise from north, relative to the top of the device in portrait) + webkitCompassAccuracy.
      - Others give absolute alpha/beta/gamma. We build the device rotation matrix and use the device's top edge when the phone is
        held flat, or the direction the back of the phone points when it is held upright.
      The screen angle is then added, because the page rotates with the screen but the sensors do not.
      Returns { deg, accuracy } or null when the event carries no usable absolute heading. */
  function compassFromEvent(e, angle) {
    const sa = normalize(angle || 0);
    if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading)) {
      const acc = typeof e.webkitCompassAccuracy === "number" ? e.webkitCompassAccuracy : null;
      return { deg: normalize(e.webkitCompassHeading + sa), accuracy: acc };
    }
    if (e.absolute !== true) return null;                        // relative alpha is not a compass: ignore it
    const { alpha, beta, gamma } = e;
    if (![alpha, beta, gamma].every(v => typeof v === "number" && Number.isFinite(v))) return null;
    const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    // columns of the rotation matrix = device axes in earth coordinates (x east, y north, z up)
    const top = { x: -cB * sA, y: cA * cB };                       // device top edge
    const back = { x: -(cG * sA * sB + cA * sG), y: -(sA * sG - cA * cG * sB) }; // direction the back of the phone points
    const topLen = Math.hypot(top.x, top.y), backLen = Math.hypot(back.x, back.y);
    const v = topLen >= backLen ? top : back;
    if (Math.hypot(v.x, v.y) < 0.2) return null;                   // too close to face-up/face-down ambiguity
    return { deg: normalize(Math.atan2(v.x, v.y) * DEG + sa), accuracy: null };
  }

  /** Chooses and smooths the heading. `now` is injectable for tests. */
  function createEngine(opts) {
    const o = Object.assign({ gpsFreshMs: 4000, compassFreshMs: 3000, lastKnownMs: 15000, gpsMinSpeed: 1.0, gpsPreferSpeed: 2.0,
      compassMaxError: 45, gpsAlpha: 0.5, compassAlpha: 0.3, now: () => Date.now() }, opts || {});
    let gps = null, compass = null, smoothed = null, lastReliable = null, lastSource = "none";

    function pushSource(deg, alpha, ts) { smoothed = smoothAngle(smoothed, deg, alpha); lastReliable = { deg: smoothed, ts }; }
    return {
      /** GPS course sample. Ignored when stationary or missing (browsers report null/NaN then). */
      onGps({ heading, speed, ts }) {
        const t = ts == null ? o.now() : ts;
        const valid = typeof heading === "number" && Number.isFinite(heading) && (speed == null || (Number.isFinite(speed) && speed >= o.gpsMinSpeed));
        if (!valid) return false;
        gps = { deg: normalize(heading), ts: t, speed: speed == null ? null : speed };
        if (this._chosen(t) === "gps") pushSource(gps.deg, o.gpsAlpha, t);
        return true;
      },
      /** Compass sample (already screen-corrected). Ignored when the sensor says it is unreliable. */
      onCompass({ deg, accuracy, ts }) {
        const t = ts == null ? o.now() : ts;
        if (typeof deg !== "number" || !Number.isFinite(deg)) return false;
        if (accuracy != null && (accuracy < 0 || accuracy > o.compassMaxError)) return false;   // iOS: negative = uncalibrated
        compass = { deg: normalize(deg), ts: t, accuracy: accuracy == null ? null : accuracy };
        if (this._chosen(t) === "compass") pushSource(compass.deg, o.compassAlpha, t);
        return true;
      },
      _chosen(t) {
        const gpsFresh = gps && t - gps.ts <= o.gpsFreshMs, compassFresh = compass && t - compass.ts <= o.compassFreshMs;
        if (gpsFresh && gps.speed != null && gps.speed >= o.gpsPreferSpeed) return "gps";   // clearly moving: course over ground wins
        if (compassFresh) return "compass";
        if (gpsFresh) return "gps";
        return null;
      },
      /** { deg, source: 'gps'|'compass'|'last'|'none', accuracy } */
      current(t) {
        const now = t == null ? o.now() : t, c = this._chosen(now);
        if (c && smoothed != null) { lastSource = c; return { deg: smoothed, source: c, accuracy: c === "compass" && compass ? compass.accuracy : null }; }
        if (lastReliable && now - lastReliable.ts <= o.lastKnownMs) return { deg: lastReliable.deg, source: "last", accuracy: null };
        return { deg: null, source: "none", accuracy: null };
      },
      reset() { gps = compass = smoothed = lastReliable = null; }
    };
  }

  /** Keeps a CSS rotation continuous: returns the angle to set so the arrow turns the short way (never spins through 360°). */
  function unwrap(displayed, target) { return displayed + shortestDelta(displayed, target); }

  return { normalize, shortestDelta, smoothAngle, screenAngle, compassFromEvent, createEngine, unwrap };
});
