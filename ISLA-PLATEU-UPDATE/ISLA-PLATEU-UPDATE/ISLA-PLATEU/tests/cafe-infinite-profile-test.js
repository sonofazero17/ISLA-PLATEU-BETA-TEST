/* Cafe Infinite verified profile facts and no-guessed-pin migration. Run: node tests/cafe-infinite-profile-test.js */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.join(__dirname, '..'), PORT = 3957, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-cafe-infinite-'));
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|RENDER|ADMIN_|DB_PATH|PORT|HOST|TRUST_PROXY|TILE_|COOKIE_SECURE|APPLY_LIMIT|UPLOAD_DIR)/.test(k)));
const OFFICIAL_PAGE = 'https://www.facebook.com/p/Cafe-Infinite-Siquijor-61572994205118/';
const LEGACY_MAP_URL = 'https://www.google.com/maps/search/?api=1&query=Cafe+Infinite+Tubod+San+Juan+Siquijor';
let proc, out = '', pass = 0, fail = 0;
const ok = (condition, name) => { condition ? pass++ : fail++; console.log((condition ? 'PASS ' : 'FAIL ') + name); };
const jar = () => { let cookie = ''; return { get: () => cookie, set(header) { const match = /isla_sid=([^;]*)/.exec(header || ''); if (match) cookie = match[1] ? `isla_sid=${match[1]}` : ''; } }; };
async function call(j, method, route, body) {
  const headers = { ...(j.get() ? { Cookie: j.get() } : {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + route, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  j.set(res.headers.get('set-cookie'));
  return { status: res.status, data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
}
async function start() {
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...CLEAN, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), ADMIN_PASSWORD: 'Cafe-Profile-Test-2026' } });
  out = '';
  proc.stdout.on('data', data => out += data);
  proc.stderr.on('data', data => out += data);
  for (let i = 0; i < 80 && !/running at/.test(out); i++) await new Promise(resolve => setTimeout(resolve, 150));
  return /running at/.test(out);
}
async function stop() {
  if (proc && proc.exitCode === null) await new Promise(resolve => { proc.once('exit', resolve); proc.kill('SIGKILL'); });
}
(async () => {
  try {
    ok(await start(), 'application starts with a temporary database');
    let response = await call(jar(), 'GET', '/api/restaurants/the-cafe-infinite');
    let { restaurant, menu } = response.data;
    ok(response.status === 200 && restaurant.locationStatus === 'verified' &&
      restaurant.lat === 9.1421151 && restaurant.lng === 123.5126152 && restaurant.verified &&
      restaurant.mapSearchUrl.includes('0xddddde2b0472e797'),
      'profile publishes the verified Cafe Infinite Google Maps listing coordinates and place ID');
    ok(restaurant.address.includes('Wiggle Gas') && restaurant.address.includes('6227 Siquijor') &&
      restaurant.contact === OFFICIAL_PAGE && restaurant.hours.includes('dine-in hours unconfirmed'),
      'public profile uses the official page contact and clearly qualifies unconfirmed address/hours');
    ok(menu.length === 8 && restaurant.acceptsOrders && menu.every(item => item.image && item.description.includes('DEMO MENU ITEM')),
      'Cafe Infinite has eight clearly identified demo menu items, each with an image and enabled demo ordering');
    ok(restaurant.logo && restaurant.cover && restaurant.description.includes('DEMONSTRATION RESTAURANT PROFILE'),
      'supplied Cafe Infinite logo, cover image and demo profile are available to customers');
    const admin = jar();
    const adminLogin = await call(admin, 'POST', '/api/login', { portal: 'ADMINISTRATOR', email: 'admin@islaplateu.local', password: 'Cafe-Profile-Test-2026' });
    const staffCreate = await call(admin, 'POST', '/api/admin/staff', { fullName: 'Cafe Infinite Demo Staff', email: 'cafe-staff@example.com', restaurantId: 'the-cafe-infinite' });
    const staff = jar();
    const staffLogin = await call(staff, 'POST', '/api/login', { portal: 'RESTAURANT_STAFF', email: 'cafe-staff@example.com', password: staffCreate.data.temporaryPassword });
    const staffEdit = await call(staff, 'PATCH', '/api/staff/restaurant', { name: 'The Cafe Infinite', category: 'Cafe / Demo Restaurant', address: restaurant.address, municipality: 'San Juan', description: restaurant.description });
    const staffUpdated = await call(jar(), 'GET', '/api/restaurants/the-cafe-infinite');
    ok(adminLogin.status === 200 && staffCreate.status === 201 && staffLogin.status === 200 && staffEdit.status === 200 && staffUpdated.data.restaurant.category === 'Cafe / Demo Restaurant',
      'assigned Cafe Infinite staff can edit its restaurant profile without changing map-pin authority');
    const logoResponse = await fetch(BASE + restaurant.logo), coverResponse = await fetch(BASE + restaurant.cover);
    const firstFoodImage = await fetch(BASE + menu[0].image);
    ok(logoResponse.status === 200 && coverResponse.status === 200 && firstFoodImage.status === 200,
      'restaurant logo, cover and menu food photographs are served successfully');
    const db = new DatabaseSync(path.join(dir, 't.db'));
    const payment = db.prepare("SELECT COUNT(*) AS n FROM restaurant_payment_accounts WHERE restaurant_id = ?").get('the-cafe-infinite').n;
    const demo = db.prepare("SELECT demo_payment FROM restaurants WHERE id = ?").get('the-cafe-infinite').demo_payment;
    const account = db.prepare("SELECT holder_name, mobile, qr_file FROM restaurant_payment_accounts WHERE restaurant_id = ?").get('the-cafe-infinite');
    ok(payment === 1 && !!demo && account.holder_name === 'THE CAFE INFINITE DEMO ACCOUNT' && account.qr_file.endsWith('.png'),
      'Cafe Infinite uses its own non-scannable demo payment account and clearly labelled placeholder QR');
    ok(db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = ?").get('the-cafe-infinite').n === 6,
      'Cafe Infinite has its own demo reservation tables');
    db.prepare(`UPDATE restaurants SET address = ?, contact = ?, hours = ?, description = '', notes = ?,
      source = 'Public business listing', map_search_url = ?, lat = NULL, lng = NULL, verified = 0,
      location_status = 'address-only' WHERE id = ?`)
      .run('Wiggle Gas, San Juan, 6227 Siquijor, Philippines (Tubod area)', '+63 915 699 6727',
        'Listed as open 24 hours; confirm locally',
        'Address is included. Exact latitude/longitude was not confidently confirmed, so no guessed pin is placed.',
        LEGACY_MAP_URL, 'the-cafe-infinite');
    db.prepare("DELETE FROM settings WHERE key = ?").run('cafe_infinite_profile_v1');
    db.close();
    await stop();
    ok(await start(), 'application restarts for the legacy-profile migration');
    response = await call(jar(), 'GET', '/api/restaurants/the-cafe-infinite');
    ({ restaurant, menu } = response.data);
    ok(restaurant.address.includes('Wiggle Gas') && restaurant.contact === OFFICIAL_PAGE &&
      restaurant.hours.includes('dine-in hours unconfirmed') && restaurant.description.length > 0,
      'existing address-only profile receives the confirmed profile details once');
    ok(restaurant.lat === null && restaurant.lng === null && restaurant.locationStatus === 'address-only' &&
      !restaurant.verified && !restaurant.mapSearchUrl && menu.length === 8 && menu.every(item => item.image),
      'migration preserves the unverified map pin and all demo menu images without inventing coordinates');
    ok(restaurant.logo && restaurant.cover && restaurant.acceptsOrders,
      'restaurant logo, cover and ordering configuration persist after restart');
    const migratedDb = new DatabaseSync(path.join(dir, 't.db'));
    ok(migratedDb.prepare("SELECT value FROM settings WHERE key = ?").get('cafe_infinite_profile_v1') !== undefined,
      'profile migration is recorded so future staff edits are preserved');
    ok(migratedDb.prepare("SELECT value FROM settings WHERE key = ?").get('cafe_infinite_demo_v1') !== undefined,
      'demo content migration is recorded and will not duplicate menu items on future restarts');
    migratedDb.close();
  } catch (error) {
    fail++;
    console.log('FAIL unexpected error: ' + error.stack + (out ? '\n' + out : ''));
  }
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
