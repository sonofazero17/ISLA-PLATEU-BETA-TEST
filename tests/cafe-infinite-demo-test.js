/* The Cafe Infinite preloaded demo integration. Run: node tests/cafe-infinite-demo-test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ROOT = path.join(__dirname, '..'), PORT = 3945, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-cafe-infinite-demo-'));
const ADMIN_PW = 'Cafe-Infinite-Demo-Test-2026'; let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + name); };
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR)/.test(k)));
const jar = () => { let c = ''; return { get: () => c, set(h) { const m = /isla_sid=([^;]*)/.exec(h || ''); if (m) c = m[1] ? 'isla_sid=' + m[1] : ''; } }; };
async function call(j, method, p, body, extra = {}) {
  const bin = Buffer.isBuffer(body), res = await fetch(BASE + p, { method, redirect: 'manual', body: body === undefined ? undefined : bin ? body : JSON.stringify(body), headers: { ...(body !== undefined && !bin ? { 'Content-Type': 'application/json' } : {}), ...(j.get() ? { Cookie: j.get() } : {}), ...extra } });
  j.set(res.headers.get('set-cookie')); let data = null; if ((res.headers.get('content-type') || '').includes('json')) { try { data = await res.json(); } catch {} }
  return { status: res.status, data, res };
}
(async () => {
  let proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), ADMIN_PASSWORD: ADMIN_PW } });
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  for (let i = 0; i < 80 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
  const stopApp = async () => {
    if (proc && proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGKILL'); });
  };
  const restartApp = async () => {
    await stopApp();
    out = '';
    proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), ADMIN_PASSWORD: ADMIN_PW } });
    proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
    for (let i = 0; i < 80 && !/running at/.test(out); i++) await new Promise(r => setTimeout(r, 150));
    return /running at/.test(out);
  };
  try {
    const login = async (portal, email, password) => { const j = jar(), r = await call(j, 'POST', '/api/login', { portal, email, password }); return { j, r }; };
    const admin = await login('ADMINISTRATOR', 'admin@islaplateu.local', ADMIN_PW);
    ok(admin.r.status === 200, 'administrator login for demo setup');
    const sr = await call(admin.j, 'POST', '/api/admin/staff', { fullName: 'Cafe Infinite Demo Staff', email: 'cafe-infinite-staff@example.com', restaurantId: 'the-cafe-infinite' });
    const staff = await login('RESTAURANT_STAFF', 'cafe-infinite-staff@example.com', sr.data.temporaryPassword);
    ok(staff.r.status === 200, 'staff account can be assigned to preloaded The Cafe Infinite');
    const anon = jar(), listing = await call(anon, 'GET', '/api/restaurants/the-cafe-infinite');
    const r = listing.data.restaurant;
    ok(listing.status === 200 && r.name === 'The Cafe Infinite' && r.address.includes('Wiggle Gas'), 'The Cafe Infinite profile is preloaded at its verified Google Maps address');
    ok(r.lat === 9.1421151 && r.lng === 123.5126152 && r.verified && r.locationStatus === 'verified' &&
      r.mapSearchUrl.includes('0xddddde2b0472e797'), 'Cafe Infinite uses its verified Google Maps listing coordinates');
    ok(r.logo && r.cover && listing.data.menu.length === 8, 'logo, cover and all eight demo menu items are preloaded');
    const expected = [['Chicken Parmesan Wings (with rice)',189],['Chicken Buffalo Wings (with rice)',179],['Crispy Fried Chicken Rice Bowl',149],['Pancit Guisado',119],['Crispy Pata Sharing Plate',699],['Loaded Beef Nachos',219],['Beef Burrito',129],['Cheese Quesadilla',99]];
    ok(expected.every(([n,p]) => listing.data.menu.some(m => m.name === n && m.price === p && m.image)), 'all eight sample menu items have demo prices and food images');
    const tables = await call(anon, 'GET', '/api/restaurants/the-cafe-infinite/tables');
    ok(tables.status === 200 && tables.data.tables.length === 6, 'six reservation tables are preloaded');
    const payCfg = await call(staff.j, 'GET', '/api/staff/payment-account');
    ok(payCfg.status === 200 && payCfg.data.demoPayment && payCfg.data.hasQr && payCfg.data.orderPrepay, 'demo payment account and fixed QR are preconfigured');
    ok((await call(staff.j, 'POST', '/api/staff/payment-account/qr', Buffer.from('not-an-image'), { 'Content-Type': 'image/png' })).status === 409, 'staff cannot replace the demo QR with a potentially scannable payment QR');
    const upd = await call(staff.j, 'PATCH', '/api/staff/restaurant', { name: 'The Cafe Infinite', category: 'Cafe / Restaurant', address: 'Tubod, San Juan, Siquijor, Philippines', municipality: 'Siquijor', description: 'Updated staff demo description' });
    const refreshed = await call(anon, 'GET', '/api/restaurants/the-cafe-infinite');
    ok(upd.status === 200 && refreshed.data.restaurant.name === 'The Cafe Infinite' && refreshed.data.restaurant.address === 'Tubod, San Juan, Siquijor, Philippines', 'Cafe Infinite staff edits are reflected on the customer restaurant profile');
    ok(refreshed.data.restaurant.lat === 9.1421151 && refreshed.data.restaurant.lng === 123.5126152 &&
      refreshed.data.restaurant.locationStatus === 'verified', 'Cafe Infinite staff edits preserve the verified location');
    const newPrice = refreshed.data.menu[0].price + 10;
    const priceEdit = await call(staff.j, 'PATCH', `/api/staff/menu/${refreshed.data.menu[0].id}`, { price: newPrice });
    const liveMenu = await call(anon, 'GET', '/api/restaurants/the-cafe-infinite');
    ok(priceEdit.status === 200 && liveMenu.data.menu.find(m => m.id === refreshed.data.menu[0].id).price === newPrice,
      'Staff menu price changes are immediately reflected in the Customer restaurant API');
    await call(jar(), 'POST', '/api/register', { fullName: 'Cafe Infinite Demo Customer', email: 'cafe-infinite-customer@example.com', password: 'Island2026', confirmPassword: 'Island2026' });
    const customer = await login('CUSTOMER', 'cafe-infinite-customer@example.com', 'Island2026');
    ok(customer.r.status === 200, 'demo customer registration and login');
    const item = liveMenu.data.menu[0], dt = new Date(Date.now() + 8 * 3600e3 + 2 * 864e5), date = dt.toISOString().slice(0,10), time = '12:00';
    const quote = await call(customer.j, 'POST', '/api/orders/quote', { restaurantId: 'the-cafe-infinite', items: [{ menuItemId: item.id, qty: 1 }], fulfillment: 'PICKUP' });
    const order = await call(customer.j, 'POST', '/api/orders', { restaurantId: 'the-cafe-infinite', items: [{ menuItemId: item.id, qty: 1 }], fulfillment: 'PICKUP', pickupDate: date, pickupTime: time });
    ok(quote.status === 200 && quote.data.paymentRequired && order.status === 201 && order.data.paymentId, 'customer can place a priced order that creates a demo payment');
    const payment = await call(customer.j, 'GET', `/api/payments/${order.data.paymentId}`);
    ok(payment.status === 200 && payment.data.demoPayment && payment.data.instructions.demo && /NOT A REAL ACCOUNT/.test(payment.data.instructions.mobileMasked), 'customer payment page is explicitly marked simulated with a fake account');
    const qr = await fetch(BASE + `/api/payments/${order.data.paymentId}/qr`, { headers: { Cookie: customer.j.get() } });
    ok(qr.status === 200 && qr.headers.get('content-type') === 'image/png' && /no-store/.test(qr.headers.get('cache-control')), 'demo QR is served as a private non-scannable PNG');
    const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,...Array(200).fill(7)]);
    const proof = await call(customer.j, 'POST', `/api/payments/${order.data.paymentId}/proof?reference=DEMO123456&amount=${quote.data.total}`, png, { 'Content-Type': 'image/png' });
    ok(proof.status === 201 && proof.data.status === 'UNDER_REVIEW', 'customer can upload a simulated receipt');
    const decide = await call(staff.j, 'POST', `/api/staff/payments/${order.data.paymentId}/decision`, { decision: 'ACCEPTED', verified: true });
    const status = await call(customer.j, 'GET', `/api/payments/${order.data.paymentId}`);
    ok(decide.status === 200 && status.data.status === 'ACCEPTED', 'staff can approve the simulated receipt and customer sees accepted status');
    const restarted = await restartApp();
    const afterRestart = await call(jar(), 'GET', '/api/restaurants/the-cafe-infinite');
    ok(restarted && afterRestart.data.restaurant.lat === 9.1421151 && afterRestart.data.restaurant.lng === 123.5126152 &&
      afterRestart.data.restaurant.locationStatus === 'verified' && afterRestart.data.menu.length === 8 && afterRestart.data.restaurant.logo,
      'Cafe Infinite verified location, menu and demo profile remain saved after an application restart');

  } catch (e) { fail++; console.log('FAIL unexpected error: ' + e.stack); }
  await stopApp();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
