/* Unit tests for assets/heading.js (GPS course vs compass vs screen orientation, smoothing, wraparound).  Run: node tests/heading-test.js */
const H = require("../assets/heading.js");
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + name); };
const near = (a, b, tol = 0.01) => Math.abs(H.shortestDelta(a, b)) <= tol;

/* angle maths */
ok(H.normalize(-10) === 350 && H.normalize(370) === 10 && H.normalize(360) === 0, "normalize keeps angles in 0-359");
ok(H.shortestDelta(350, 10) === 20 && H.shortestDelta(10, 350) === -20 && Math.abs(H.shortestDelta(0, 180)) === 180, "shortestDelta goes the short way round (350 -> 10 is +20)");
ok(near(H.smoothAngle(359, 1, 0.5), 0), "smoothing across the 359°/0° boundary lands near 0°, not near 180°");
ok(H.smoothAngle(null, 123, 0.3) === 123, "first sample is taken as is");
ok(H.unwrap(359, 1) === 361 && H.unwrap(10, 350) === -10, "CSS rotation stays continuous (359 -> 361, never spins back through 360)");
ok(H.screenAngle({ screen: { orientation: { angle: 90 } } }) === 90 && H.screenAngle({ orientation: -90 }) === 270 && H.screenAngle({}) === 0, "screen angle from screen.orientation or legacy window.orientation (-90 = 270)");

/* compass from device-orientation events */
const ev = (alpha, beta, gamma, absolute = true) => ({ alpha, beta, gamma, absolute });
ok(near(H.compassFromEvent(ev(0, 0, 0), 0).deg, 0), "phone flat, top edge north -> 0°");
ok(near(H.compassFromEvent(ev(90, 0, 0), 0).deg, 270), "phone flat, turned 90° anticlockwise (top edge west) -> 270°");
ok(near(H.compassFromEvent(ev(270, 0, 0), 0).deg, 90), "phone flat, top edge east -> 90°");
ok(near(H.compassFromEvent(ev(90, 0, 0), 90).deg, 0), "screen rotated 90° (landscape) shifts the heading by the screen angle - compass and screen orientation are not interchangeable");
ok(near(H.compassFromEvent(ev(0, 90, 0), 0).deg, 0) && near(H.compassFromEvent(ev(90, 90, 0), 0).deg, 270), "phone held upright: uses the direction the back of the phone points");
ok(H.compassFromEvent(ev(10, 20, 5, false), 0) === null, "relative (non-absolute) orientation is not a compass and is ignored");
ok(H.compassFromEvent(ev(null, 0, 0), 0) === null && H.compassFromEvent({ absolute: true }, 0) === null, "events without sensor values are ignored");
const ios = H.compassFromEvent({ webkitCompassHeading: 135, webkitCompassAccuracy: 10 }, 0);
ok(ios.deg === 135 && ios.accuracy === 10, "iOS webkitCompassHeading + accuracy are used directly");
ok(H.compassFromEvent({ webkitCompassHeading: 135 }, 90).deg === 225, "iOS heading is also corrected for the screen angle");

/* engine: source selection */
let t = 0; const E = (o) => H.createEngine(Object.assign({ now: () => t }, o));
let e = E();
ok(e.current(0).source === "none" && e.current(0).deg === null, "no data: heading is unknown (neutral marker, nothing invented)");
ok(e.onGps({ heading: NaN, speed: 0, ts: 0 }) === false && e.onGps({ heading: null, speed: null, ts: 0 }) === false && e.current(0).source === "none", "stationary / missing GPS heading is ignored");
ok(e.onGps({ heading: 90, speed: 0.3, ts: 0 }) === false, "GPS heading while barely moving (< 1 m/s) is ignored");
ok(e.onGps({ heading: 90, speed: 1.6, ts: 0 }) && e.current(0).source === "gps" && near(e.current(0).deg, 90), "walking-speed GPS course is used when no compass exists");
e = E(); e.onCompass({ deg: 200, ts: 0 });
ok(e.current(0).source === "compass" && near(e.current(0).deg, 200), "compass is used when GPS has no heading");
e.onGps({ heading: 80, speed: 4, ts: 100 }); e.onGps({ heading: 80, speed: 4, ts: 200 }); e.onGps({ heading: 80, speed: 4, ts: 300 });
ok(e.current(300).source === "gps", "when clearly moving (>= 2 m/s) the GPS course wins over the compass");
e = E(); e.onCompass({ deg: 45, ts: 0 });
ok(e.onCompass({ deg: 90, accuracy: -1, ts: 10 }) === false && e.onCompass({ deg: 90, accuracy: 70, ts: 10 }) === false && near(e.current(10).deg, 45), "uncalibrated / inaccurate compass samples (iOS accuracy < 0 or > 45°) are ignored");
/* freshness: last reliable heading, then unknown */
e = E(); e.onCompass({ deg: 300, ts: 0 });
ok(e.current(2900).source === "compass", "compass sample is fresh for 3 s");
ok(e.current(5000).source === "last" && near(e.current(5000).deg, 300), "after the sensor goes quiet the last reliable heading is kept for a while, labelled 'last'");
ok(e.current(16000).source === "none" && e.current(16000).deg === null, "after 15 s without data the heading becomes unknown again (no pretending)");

/* smoothing */
e = E(); let ts = 0; const seq = [350, 355, 0, 5, 10, 15]; const out = [];
for (const d of seq) { e.onCompass({ deg: d, ts: ts += 100 }); out.push(e.current(ts).deg); }
let cont = true, disp = out[0]; for (const d of out) { const nd = H.unwrap(disp, d); if (Math.abs(nd - disp) > 20) cont = false; disp = nd; }
ok(cont, "a turn through north (350° -> 15°) produces small steps only: no 340° jump at the wrap");
e = E(); ts = 0; const noisy = []; for (let i = 0; i < 40; i++) { e.onCompass({ deg: 100 + (i % 2 ? 12 : -12), ts: ts += 50 }); noisy.push(e.current(ts).deg); }
const tail = noisy.slice(-10), spread = Math.max(...tail) - Math.min(...tail);
ok(spread < 12 && Math.abs(H.shortestDelta(100, noisy[noisy.length - 1])) < 10, "noisy compass (±12°) is damped to a steady value near 100°");
e = E(); ts = 0; for (let i = 0; i < 6; i++) e.onCompass({ deg: 0, ts: ts += 50 }); for (let i = 0; i < 12; i++) e.onCompass({ deg: 90, ts: ts += 50 });
ok(Math.abs(H.shortestDelta(90, e.current(ts).deg)) < 5, "a real 90° turn is followed within about a second (smoothing does not lag excessively)");
e = E(); ts = 0; e.onCompass({ deg: 10, ts: ts += 50 }); e.onCompass({ deg: 350, ts: ts += 50 });
ok(e.current(ts).deg > 340 || e.current(ts).deg < 10, "averaging 10° and 350° stays near north, not 180°");

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
