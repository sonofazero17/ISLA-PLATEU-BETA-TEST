/* Database: connection, additive migrations (safe on an existing database) and first-run seeding. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function columns(db, table) { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
function addColumn(db, table, name, ddl) { if (!columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); }

function openDatabase(dbPath, root) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('CUSTOMER','RESTAURANT_STAFF','ADMINISTRATOR')),
      restaurant_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      municipality TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Unconfirmed',
      address TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      hours TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      lat REAL, lng REAL,
      verified INTEGER NOT NULL DEFAULT 0,
      location_status TEXT NOT NULL DEFAULT 'address-only',
      map_search_url TEXT NOT NULL DEFAULT '',
      photo TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      accepts_reservations INTEGER NOT NULL DEFAULT 1,
      accepts_orders INTEGER NOT NULL DEFAULT 0,
      reservation_capacity INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      res_date TEXT NOT NULL, res_time TEXT NOT NULL, party_size INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '', staff_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_res_rest ON reservations(restaurant_id, res_date, res_time);
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pickup_date TEXT NOT NULL, pickup_time TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', total_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      name TEXT NOT NULL, price_cents INTEGER NOT NULL, qty INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inquiry_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (restaurant_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); // small server-side flags (e.g. admin recovery marker)
  // additive changes to tables that existed in earlier versions
  addColumn(db, "users", "status", "TEXT NOT NULL DEFAULT 'ACTIVE'");   // ACTIVE | DISABLED | PENDING (staff awaiting approval) | REJECTED
  addColumn(db, "users", "contact_number", "TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
      is_new_restaurant INTEGER NOT NULL DEFAULT 0,
      restaurant_name TEXT NOT NULL,
      restaurant_name_key TEXT NOT NULL,
      restaurant_contact TEXT NOT NULL DEFAULT '',
      restaurant_address TEXT NOT NULL DEFAULT '',
      municipality TEXT NOT NULL DEFAULT '',
      barangay TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Restaurant',
      description TEXT NOT NULL DEFAULT '',
      position TEXT NOT NULL DEFAULT '',
      permit_number TEXT NOT NULL DEFAULT '',
      applicant_note TEXT NOT NULL DEFAULT '',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_apps_status ON staff_applications(status, created_at);
    -- two people cannot have pending applications to register the same NEW restaurant
    CREATE UNIQUE INDEX IF NOT EXISTS uq_apps_pending_new_name ON staff_applications(restaurant_name_key) WHERE status = 'pending' AND is_new_restaurant = 1;
  `);
  addColumn(db, "sessions", "last_seen", "INTEGER");

  // first run: import the original restaurant list so no existing data is lost
  if (db.prepare("SELECT COUNT(*) AS n FROM restaurants").get().n === 0) {
    const seedFile = path.join(root, "data", "restaurants.json");
    if (fs.existsSync(seedFile)) {
      const list = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      const ins = db.prepare(`INSERT OR IGNORE INTO restaurants
        (id, name, municipality, category, address, contact, hours, notes, lat, lng, verified, location_status, map_search_url, photo, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of list) {
        const hasPin = Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && r.lat !== null && r.lng !== null;
        ins.run(r.id, r.name, r.municipality || "", r.category || "Unconfirmed", r.address || "", r.contact || "", r.hours || "", r.notes || "",
          hasPin ? Number(r.lat) : null, hasPin ? Number(r.lng) : null, r.verified ? 1 : 0,
          hasPin ? (r.verified ? "verified" : (r.locationStatus || "approximate")) : "address-only", r.mapSearchUrl || "", r.photo || "", r.source || "");
      }
    }
  }
  return db;
}
module.exports = { openDatabase };
