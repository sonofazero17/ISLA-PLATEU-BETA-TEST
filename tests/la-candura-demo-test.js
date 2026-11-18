/* La Candura demonstration setup: additive, persistent and isolated. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isla-la-candura-'));
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
  const restaurant = db.prepare("SELECT * FROM restaurants WHERE id='la-candura'").get();
  const menu = db.prepare("SELECT * FROM menu_items WHERE restaurant_id='la-candura' ORDER BY id").all();
  const tables = db.prepare("SELECT * FROM restaurant_tables WHERE restaurant_id='la-candura'").all();
  const payment = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id='la-candura'").get();
  ok(!!restaurant && restaurant.name === 'LA Candura', 'existing LA Candura restaurant record is reused');
  ok(restaurant.address.includes('Candura, San Juan') && restaurant.contact === '+63 915 748 8924', 'official property address and contact are populated');
  ok(restaurant.lat === 9.16677475 && restaurant.lng === 123.51394653 && restaurant.verified === 1 && restaurant.location_status === 'verified', 'official published property coordinates are saved as verified');
  ok(!!restaurant.logo_file && !!restaurant.cover_file && restaurant.logo_file !== restaurant.cover_file, 'official LA Candura logo and separate restaurant cover are assigned');
  ok(menu.length === 8 && menu.every(item => item.image_file && item.price_cents > 0 && item.available === 1), 'eight priced demo menu items include image references');
  ok(menu.every(item => fs.existsSync(path.join(dir, 'uploads', 'public', item.image_file))), 'all menu image files are persisted in public upload storage');
  ok(fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.logo_file)) && fs.existsSync(path.join(dir, 'uploads', 'public', restaurant.cover_file)), 'logo and cover files are persisted');
  ok(fs.readFileSync(path.join(dir, 'uploads', 'public', restaurant.logo_file)).equals(fs.readFileSync(path.join(root, 'assets', 'la-candura', 'la-candura-official-logo.jpg'))), 'uploaded official logo is copied without alteration');
  ok(tables.length === 6, 'six reservation tables are seeded');
  ok(!!payment && payment.holder_name === 'LA CANDURA — DEMO ONLY' && payment.mobile === '00000000000', 'separate non-functional demo payment account is seeded');
  const qrPath = path.join(dir, 'uploads', 'private', payment.qr_file);
  ok(fs.existsSync(qrPath) && fs.readFileSync(qrPath).subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), 'non-scannable demo payment placeholder is stored privately as a PNG');
  const otherCounts = {};
  for (const id of ['pagudfood','the-cafe-infinite','luka-loko','dagsa-resto']) {
    otherCounts[id] = db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=?").get(id).n;
  }
  // Simulate a database that already completed the earlier demo seed and
  // still points at the old placeholder logo.
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('la_candura_demo_v1','already-seeded')").run();
  db.prepare("UPDATE restaurants SET logo_file='previous-demo-logo.png' WHERE id='la-candura'").run();
  db.close();
  db = openDatabase(dbPath, root);
  const refreshedLogo = db.prepare("SELECT logo_file FROM restaurants WHERE id='la-candura'").get().logo_file;
  ok(refreshedLogo !== 'previous-demo-logo.png' && fs.readFileSync(path.join(dir, 'uploads', 'public', refreshedLogo)).equals(fs.readFileSync(path.join(root, 'assets', 'la-candura', 'la-candura-official-logo.jpg'))), 'existing seeded database refreshes old placeholder logo to the supplied official logo');
  ok(db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id='la-candura'").get().n === 8, 'reopening does not duplicate LA Candura menu items');
  ok(db.prepare("SELECT COUNT(*) n FROM restaurants WHERE id='la-candura'").get().n === 1, 'reopening does not create a duplicate restaurant');
  ok(Object.entries(otherCounts).every(([id,n]) => db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=?").get(id).n === n),
     'PagudFood, The Cafe Infinite, Luca Loko and Dagsa menu records remain unchanged');
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
