/* PagudFood preloaded demo integration. Run: node tests/pagudfood-demo-test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const ROOT = path.join(__dirname, '..'), PORT = 3944, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-pagud-demo-'));
const ADMIN_PW = 'Pagud-Demo-Test-2026'; let pass = 0, fail = 0;
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
    const sr = await call(admin.j, 'POST', '/api/admin/staff', { fullName: 'Pagud Demo Staff', email: 'pagud-staff@example.com', restaurantId: 'pagudfood' });
    const staff = await login('RESTAURANT_STAFF', 'pagud-staff@example.com', sr.data.temporaryPassword);
    ok(staff.r.status === 200, 'staff account can be assigned to preloaded PagudFood');
    const anon = jar(), listing = await call(anon, 'GET', '/api/restaurants/pagudfood');
    const r = listing.data.restaurant;
    ok(listing.status === 200 && r.name === 'PagudFood Cafe' && r.address === '1 Sta. Fe St, Siquijor, Philippines', 'PagudFood profile is preloaded');
    ok(r.lat === 9.2140502 && r.lng === 123.5119131 && r.verified && r.locationStatus === 'verified', 'PagudFood pin is loaded from its saved location record');
    ok(r.logo && r.cover && listing.data.menu.length === 9, 'logo, cover and all nine menu items are preloaded');
    const expected = [['Chicken Parmesan Wings (served with rice)',169],['Chicken Buffalo Wings (served with rice)',169],['Fried Chicken (served with rice)',139],['Pancit Guisado',85],['Crispy Pata',749],['Homemade Beef Nachos (Good for Sharing)',199],['Solo Quesadilla',79],['Duo Quesadilla',99],['Homemade Beef Burrito',89]];
    ok(expected.every(([n,p]) => listing.data.menu.some(m => m.name === n && m.price === p && m.image)), 'all exact menu prices and local food images match the supplied menu');
    const tables = await call(anon, 'GET', '/api/restaurants/pagudfood/tables');
    ok(tables.status === 200 && tables.data.tables.length === 7, 'seven reservation tables are preloaded');
    const payCfg = await call(staff.j, 'GET', '/api/staff/payment-account');
    ok(payCfg.status === 200 && payCfg.data.demoPayment && payCfg.data.hasQr && payCfg.data.orderPrepay, 'demo payment account and QR are preconfigured');
    const demoQrReplacement = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,...Array(200).fill(5)]);
    const qrUpdate = await call(staff.j, 'POST', '/api/staff/payment-account/qr', demoQrReplacement, { 'Content-Type': 'image/png' });
    const staffQr = await call(staff.j, 'GET', '/api/staff/payment-account/qr');
    ok(qrUpdate.status === 200 && staffQr.status === 200 && Buffer.from(await staffQr.res.arrayBuffer()).equals(demoQrReplacement),
      'PagudFood staff can replace its demo QR image');
    const upd = await call(staff.j, 'PATCH', '/api/staff/restaurant', { name: 'PagudFood Cafe Updated', category: 'Cafe / Restaurant', address: 'Updated demo address, Siquijor', municipality: 'Siquijor', description: 'Updated staff demo description' });
    const refreshed = await call(anon, 'GET', '/api/restaurants/pagudfood');
    ok(upd.status === 200 && refreshed.data.restaurant.name === 'PagudFood Cafe Updated' && refreshed.data.restaurant.address === 'Updated demo address, Siquijor', 'PagudFood staff edits are reflected on the customer restaurant profile');
    const pinUpdate = await call(admin.j, 'PUT', '/api/admin/restaurants/pagudfood', { lat: 9.21405, lng: 123.511913, verified: true });
    const pinRefreshed = await call(anon, 'GET', '/api/restaurants/pagudfood');
    ok(pinUpdate.status === 200 && pinRefreshed.data.restaurant.lat === 9.21405 && pinRefreshed.data.restaurant.lng === 123.511913 &&
      pinRefreshed.data.restaurant.locationStatus === 'verified', 'administrator pin edits are reflected on the customer restaurant profile');
    await call(jar(), 'POST', '/api/register', { fullName: 'Demo Customer', email: 'pagud-customer@example.com', password: 'Island2026', confirmPassword: 'Island2026' });
    const customer = await login('CUSTOMER', 'pagud-customer@example.com', 'Island2026');
    ok(customer.r.status === 200, 'demo customer registration and login');
    const item = refreshed.data.menu[0], dt = new Date(Date.now() + 8 * 3600e3 + 2 * 864e5), date = dt.toISOString().slice(0,10), time = '12:00';
    const quote = await call(customer.j, 'POST', '/api/orders/quote', { restaurantId: 'pagudfood', items: [{ menuItemId: item.id, qty: 1 }], fulfillment: 'PICKUP' });
    const order = await call(customer.j, 'POST', '/api/orders', { restaurantId: 'pagudfood', items: [{ menuItemId: item.id, qty: 1 }], fulfillment: 'PICKUP', pickupDate: date, pickupTime: time });
    ok(quote.status === 200 && quote.data.paymentRequired && order.status === 201 && order.data.paymentId, 'customer can place a priced order that creates a demo payment');
    const payment = await call(customer.j, 'GET', `/api/payments/${order.data.paymentId}`);
    ok(payment.status === 200 && payment.data.demoPayment && payment.data.instructions.demo && /NOT A REAL ACCOUNT/.test(payment.data.instructions.mobileMasked), 'customer payment page is explicitly marked simulated with a fake account');
    const qr = await fetch(BASE + `/api/payments/${order.data.paymentId}/qr`, { headers: { Cookie: customer.j.get() } });
    ok(qr.status === 200 && qr.headers.get('content-type') === 'image/png' && /no-store/.test(qr.headers.get('cache-control')) &&
      Buffer.from(await qr.arrayBuffer()).equals(demoQrReplacement), 'customer receives the replacement demo QR through the private payment endpoint');
    const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,...Array(200).fill(7)]);
    const proof = await call(customer.j, 'POST', `/api/payments/${order.data.paymentId}/proof?reference=DEMO123456&amount=${quote.data.total}`, png, { 'Content-Type': 'image/png' });
    ok(proof.status === 201 && proof.data.status === 'UNDER_REVIEW', 'customer can upload a simulated receipt');
    const decide = await call(staff.j, 'POST', `/api/staff/payments/${order.data.paymentId}/decision`, { decision: 'ACCEPTED', verified: true });
    const status = await call(customer.j, 'GET', `/api/payments/${order.data.paymentId}`);
    ok(decide.status === 200 && status.data.status === 'ACCEPTED', 'staff can approve the simulated receipt and customer sees accepted status');
    const restarted = await restartApp();
    const afterRestart = await call(jar(), 'GET', '/api/restaurants/pagudfood');
    ok(restarted && afterRestart.data.restaurant.lat === 9.21405 && afterRestart.data.restaurant.lng === 123.511913,
      'PagudFood coordinates remain saved after an application restart');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 't.db'));
    db.prepare("UPDATE restaurants SET lat = NULL, lng = NULL, verified = 0, location_status = 'address-only' WHERE id = ?").run('pagudfood');
    db.prepare("DELETE FROM settings WHERE key = ?").run('pagudfood_location_pin_v1');
    db.close();
    const migratedRestart = await restartApp();
    const afterMigration = await call(jar(), 'GET', '/api/restaurants/pagudfood');
    ok(migratedRestart && afterMigration.data.restaurant.lat === 9.2140502 && afterMigration.data.restaurant.lng === 123.5119131 &&
      afterMigration.data.restaurant.locationStatus === 'verified', 'existing address-only database is backfilled on startup');
  } catch (e) { fail++; console.log('FAIL unexpected error: ' + e.stack); }
  await stopApp();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
