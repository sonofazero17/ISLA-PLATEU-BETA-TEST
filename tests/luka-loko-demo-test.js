/* Luka Loko demonstration restaurant seed: additive, idempotent and isolated. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-luka-loko-'));
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (condition, label) => { if (condition) pass++; else fail++; console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); };
try {
  const dbPath = path.join(dir, 'islaplateu.db');
  let db = openDatabase(dbPath, root);
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id='luka-loko'").get();
  const menu = db.prepare("SELECT * FROM menu_items WHERE restaurant_id='luka-loko'").all();
  ok(!!restaurant && restaurant.name === 'Luca Loko Restaurant', 'existing Luka Loko record is reused and official public spelling is shown');
  ok(restaurant.lat === 9.1542172 && restaurant.lng === 123.4972914 && restaurant.verified === 1 &&
    restaurant.location_status === 'verified' && restaurant.map_search_url.includes('0x59494518cce51505'),
    'Google Maps listing coordinates, place ID and verified status are saved on the existing record');
  ok(!!restaurant.logo_file && !!restaurant.cover_file && restaurant.logo_file !== restaurant.cover_file, 'supplied logo and separate food-collage cover are assigned');
  ok(menu.length === 8 && menu.every(item => item.image_file && item.price_cents > 0), 'eight priced demonstration menu items have image references');
  ok(menu.every(item => fs.existsSync(path.join(dir, 'uploads', 'public', item.image_file))) && fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.logo_file)) && fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.cover_file)), 'logo, cover and menu image files are persisted in public upload storage');
  ok(db.prepare("SELECT COUNT(*) n FROM restaurant_tables WHERE restaurant_id='luka-loko'").get().n === 6, 'six restaurant tables are seeded');
  ok(!!db.prepare("SELECT qr_file FROM restaurant_payment_accounts WHERE restaurant_id='luka-loko'").get(), 'separate demo payment account is seeded');
  const pagudCount = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='pagudfood'").get().n;
  const cafeCount = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='the-cafe-infinite'").get().n;
  db.prepare("UPDATE menu_items SET price_cents=12345 WHERE restaurant_id='luka-loko' AND name='Ocean Vibes Smoothie Bowl'").run();
  db.close();
  db = openDatabase(dbPath, root);
  const savedLocation = db.prepare("SELECT lat, lng, verified, location_status, map_search_url FROM restaurants WHERE id='luka-loko'").get();
  ok(savedLocation.lat === 9.1542172 && savedLocation.lng === 123.4972914 && savedLocation.verified === 1 &&
    savedLocation.location_status === 'verified' && savedLocation.map_search_url.includes('0x59494518cce51505'),
    'verified restaurant location and Google listing URL persist after restart');
  ok(db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='luka-loko'").get().n === 8, 'reopening does not duplicate menu items');
  ok(db.prepare("SELECT price_cents FROM menu_items WHERE restaurant_id='luka-loko' AND name='Ocean Vibes Smoothie Bowl'").get().price_cents === 12345, 'staff-edited menu price is preserved on restart');
  ok(db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='pagudfood'").get().n === pagudCount && db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='the-cafe-infinite'").get().n === cafeCount, 'PagudFood and The Cafe Infinite menus remain unchanged');
  db.close();
} catch (error) { fail++; console.error(error.stack); }
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
