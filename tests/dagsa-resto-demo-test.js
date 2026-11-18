/* Dagsa Resto Bar demonstration setup: additive, persistent and isolated. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-dagsa-'));
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (condition, label) => {
  if (condition) pass++; else fail++;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
};
let db;
try {
  const dbPath = path.join(dir, 'islaplateu.db');
  db = openDatabase(dbPath, root);
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id='dagsa-resto'").get();
  const menu = db.prepare("SELECT * FROM menu_items WHERE restaurant_id='dagsa-resto' ORDER BY id").all();
  const tables = db.prepare("SELECT * FROM restaurant_tables WHERE restaurant_id='dagsa-resto'").all();
  const payment = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id='dagsa-resto'").get();
  ok(!!restaurant && restaurant.name === 'Dagsa Resto Bar', 'existing Dagsa Resto Bar restaurant record is reused');
  ok(restaurant.address.includes('5FFG+7G7') && restaurant.contact === '+63 997 583 1177', 'public listing address and contact are populated');
  ok(restaurant.lat === 9.1731544 && restaurant.lng === 123.4763088 && restaurant.verified === 1 &&
    restaurant.location_status === 'verified' && restaurant.map_search_url.includes('0xcf7de85b0b3adff6'),
    'Google Maps listing pin and place ID are saved as the verified location');
  ok(!!restaurant.logo_file && !!restaurant.cover_file && restaurant.logo_file !== restaurant.cover_file, 'separate demo brand mark and supplied interior cover are assigned');
  ok(menu.length === 8 && menu.every(item => item.image_file && item.price_cents > 0 && item.available === 1), 'eight priced demo menu items include image references');
  ok(menu.every(item => fs.existsSync(path.join(dir, 'uploads', 'public', item.image_file))), 'all menu image files are persisted in public upload storage');
  ok(fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.logo_file)) && fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.cover_file)), 'logo and interior cover files are persisted');
  ok(tables.length === 7, 'seven reservation tables are seeded');
  ok(!!payment && payment.holder_name === 'DAGSA RESTO BAR — DEMO ONLY' && payment.mobile === '00000000000', 'separate non-functional demo payment account is seeded');
  const qrPath = path.join(dir, 'uploads', 'private', payment.qr_file);
  ok(fs.existsSync(qrPath) && fs.readFileSync(qrPath).subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), 'non-scannable demo payment placeholder is stored privately as a PNG');
  const pagudCount = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='pagudfood'").get().n;
  const cafeCount = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='the-cafe-infinite'").get().n;
  db.close();
  db = openDatabase(dbPath, root);
  const savedLocation = db.prepare("SELECT lat, lng, verified, location_status, map_search_url FROM restaurants WHERE id='dagsa-resto'").get();
  ok(savedLocation.lat === 9.1731544 && savedLocation.lng === 123.4763088 && savedLocation.verified === 1 &&
    savedLocation.location_status === 'verified' && savedLocation.map_search_url.includes('0xcf7de85b0b3adff6'),
    'verified restaurant location and Google listing URL persist after restart');
  ok(db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='dagsa-resto'").get().n === 8, 'reopening does not duplicate Dagsa menu items');
  ok(db.prepare("SELECT COUNT(*) n FROM restaurants WHERE id='dagsa-resto'").get().n === 1, 'reopening does not create a duplicate restaurant');
  ok(db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='pagudfood'").get().n === pagudCount &&
     db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='the-cafe-infinite'").get().n === cafeCount,
     'PagudFood and The Cafe Infinite menu records remain unchanged');
  db.close();
} catch (error) {
  fail++;
  console.error(error.stack);
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
