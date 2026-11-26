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
  // Phase 2: restaurant logo/cover and food images (file names inside the uploads/public folder) and food categories
  addColumn(db, "restaurants", "logo_file", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "restaurants", "cover_file", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "menu_items", "image_file", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "menu_items", "category", "TEXT NOT NULL DEFAULT ''");
  // Phase 9: slideshow photos (every photo carries its credit, licence/permission and the admin who confirmed the right to use it)
  db.exec(`
    CREATE TABLE IF NOT EXISTS slideshow_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slide_set TEXT NOT NULL CHECK (slide_set IN ('LANDING','MAP')),
      file_name TEXT NOT NULL, alt_text TEXT NOT NULL, caption TEXT NOT NULL DEFAULT '',
      credit TEXT NOT NULL, license TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      permission_confirmed_by INTEGER REFERENCES users(id), permission_confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_slides_set ON slideshow_images (slide_set, active, sort_order);
  `);
  addColumn(db, "slideshow_images", "title", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "slideshow_images", "button_label", "TEXT NOT NULL DEFAULT 'Explore Restaurant'");
  // Phase 8: email verification (accounts created before this update are not locked out: verification_required stays 0 for them)
  addColumn(db, "users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "users", "email_verified_at", "TEXT");
  addColumn(db, "users", "verification_required", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evc_user ON email_verification_codes (user_id, id);
  `);
  // Password recovery: only SHA-256 token hashes are stored; tokens expire and are single-use.
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, id);
  `);
  // Gmail password recovery: one-time codes are stored only as salted HMAC hashes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_recovery_codes_user ON password_recovery_codes(user_id, id);
    CREATE TABLE IF NOT EXISTS password_recovery_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grant_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_recovery_grants_user ON password_recovery_grants(user_id, id);
  `);
  // Phase 7: system fee / tax configuration and restaurant-set charges (empty by default: no rate is ever assumed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_fee_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('SERVICE_FEE','SYSTEM_TAX')),
      label TEXT NOT NULL, calc TEXT NOT NULL CHECK (calc IN ('PERCENT','FIXED')),
      value INTEGER NOT NULL CHECK (value > 0),
      base TEXT NOT NULL CHECK (base IN ('FOOD','RESTAURANT_TOTAL','SERVICE_FEES')),
      applies_to TEXT NOT NULL CHECK (applies_to IN ('ORDER','RESERVATION','BOTH')),
      active INTEGER NOT NULL DEFAULT 1, basis_note TEXT NOT NULL DEFAULT '',
      verified_by INTEGER REFERENCES users(id), verified_at TEXT, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS restaurant_charges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('FEE','TAX')),
      label TEXT NOT NULL, calc TEXT NOT NULL CHECK (calc IN ('PERCENT','FIXED')),
      value INTEGER NOT NULL CHECK (value > 0),
      base TEXT NOT NULL CHECK (base IN ('FOOD','FOOD_AND_FEES')),
      applies_to TEXT NOT NULL CHECK (applies_to IN ('ORDER','RESERVATION','BOTH')),
      active INTEGER NOT NULL DEFAULT 1, confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rcharge_rest ON restaurant_charges (restaurant_id, active);
  `);
  // Phase 6: GCash payment details, payments, receipt submissions, verification log
  addColumn(db, "restaurants", "order_prepay", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "restaurants", "reservation_fee_cents", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "restaurants", "demo_payment", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_payment_accounts (
      restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
      holder_name TEXT NOT NULL, mobile TEXT NOT NULL, qr_file TEXT NOT NULL DEFAULT '',
      updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('ORDER','RESERVATION')),
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL, breakdown_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'AWAITING_PROOF' CHECK (status IN ('UNPAID','AWAITING_PROOF','UNDER_REVIEW','ACCEPTED','REJECTED','REFUNDED','VOID')),
      review_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
      refund_note TEXT NOT NULL DEFAULT '', refunded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((kind = 'ORDER' AND order_id IS NOT NULL AND reservation_id IS NULL) OR (kind = 'RESERVATION' AND reservation_id IS NOT NULL AND order_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_order ON payments (order_id) WHERE order_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reservation ON payments (reservation_id) WHERE reservation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payment_rest ON payments (restaurant_id, status);
    CREATE TABLE IF NOT EXISTS payment_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL, proof_file TEXT NOT NULL, proof_hash TEXT NOT NULL,
      reference TEXT NOT NULL, ref_norm TEXT NOT NULL, declared_cents INTEGER NOT NULL,
      submitted_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decision TEXT CHECK (decision IN ('ACCEPTED','REJECTED')), decided_by INTEGER REFERENCES users(id), decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_psub_hash ON payment_submissions (restaurant_id, proof_hash);
    CREATE INDEX IF NOT EXISTS idx_psub_ref ON payment_submissions (restaurant_id, ref_norm);
    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pevent_payment ON payment_events (payment_id, id);
  `);
  // Phase 5: advance ordering (fulfilment option, staff note, status history)
  addColumn(db, "orders", "fulfillment", "TEXT NOT NULL DEFAULT 'PICKUP'");
  addColumn(db, "orders", "staff_note", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "restaurants", "order_dine_in", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ordhist_order ON order_status_history (order_id, id);
  `);
  // Phase 4: tables and table-based reservations
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      label TEXT NOT NULL COLLATE NOCASE, capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 50),
      reservable INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (restaurant_id, label)
    );
  `);
  addColumn(db, "reservations", "table_id", "INTEGER REFERENCES restaurant_tables(id) ON DELETE SET NULL");
  addColumn(db, "restaurants", "reservation_minutes", "INTEGER NOT NULL DEFAULT 90");
  // Phase 3: location requests, private verification documents, audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_location_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      submitted_by INTEGER NOT NULL REFERENCES users(id),
      lat REAL NOT NULL, lng REAL NOT NULL,
      address TEXT NOT NULL, contact_phone TEXT NOT NULL, business_contact TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING','UNDER_REVIEW','APPROVED','REJECTED','NEEDS_EVIDENCE')),
      review_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, submitted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_locreq_restaurant ON restaurant_location_requests (restaurant_id, id);
    CREATE INDEX IF NOT EXISTS idx_locreq_status ON restaurant_location_requests (status);
    CREATE TABLE IF NOT EXISTS restaurant_verification_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES restaurant_location_requests(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('MAYORS_PERMIT','DTI_SEC','STOREFRONT_PHOTO','INTERIOR_PHOTO','AUTHORIZATION','OTHER')),
      file_name TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_verdoc_request ON restaurant_verification_documents (request_id);
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER, actor_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_logs (id DESC);
  `);

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

  // PagudFood presentation seed: additive and idempotent. Never overwrite staff edits or existing records.
  const pagud = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("pagudfood");
  if (pagud) {
    const pinMigration = db.prepare("SELECT value FROM settings WHERE key = ?").get("pagudfood_location_pin_v1");
    if (!pinMigration) {
      const locationSeed = JSON.parse(fs.readFileSync(path.join(root, "data", "restaurants.json"), "utf8"))
        .find(r => r.id === "pagudfood");
      if (locationSeed && locationSeed.verified === true && Number.isFinite(locationSeed.lat) && Number.isFinite(locationSeed.lng)) {
        if (pagud.lat === null || pagud.lng === null) {
          db.prepare(`UPDATE restaurants SET lat = ?, lng = ?, verified = 1, location_status = 'verified',
            map_search_url = '', notes = CASE
              WHEN notes LIKE '%Exact latitude/longitude was not confidently confirmed%' THEN ?
              ELSE notes END,
            source = ?, updated_at = datetime('now')
            WHERE id = 'pagudfood' AND (lat IS NULL OR lng IS NULL)`)
            .run(locationSeed.lat, locationSeed.lng, locationSeed.notes, locationSeed.source);
        }
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))")
          .run("pagudfood_location_pin_v1");
      }
    }
    const wasDemoPayment = !!pagud.demo_payment;
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
    const publicDir = path.join(uploadRoot, "public");
    const privateDir = path.join(uploadRoot, "private");
    const assetDir = path.join(root, "assets", "pagudfood");
    fs.mkdirSync(publicDir, { recursive: true }); fs.mkdirSync(privateDir, { recursive: true });
    const copyAsset = (source, destDir, fallback) => {
      if (!fs.existsSync(source)) return fallback || "";
      const ext = path.extname(source).toLowerCase();
      const name = fallback || require("node:crypto").randomBytes(16).toString("hex") + ext;
      const target = path.join(destDir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      return name;
    };
    const logo = pagud.logo_file || copyAsset(path.join(assetDir, "pagudfood-logo.jpg"), publicDir);
    const cover = pagud.cover_file || copyAsset(path.join(assetDir, "food-cover.jpg"), publicDir);
    db.prepare(`UPDATE restaurants SET
      name = CASE WHEN name = 'PagudFood Food and Beverage House' THEN 'PagudFood Cafe' ELSE name END,
      category = CASE WHEN category = 'Cafe' OR category = '' THEN 'Cafe / Restaurant' ELSE category END,
      description = CASE WHEN description = '' THEN ? ELSE description END,
      contact = CASE WHEN contact = '' THEN 'Demo contact — not connected' ELSE contact END,
      hours = CASE WHEN hours = '' OR hours LIKE 'Public listings vary%' THEN 'DEMO HOURS: 10:00 AM–9:00 PM (presentation sample)' ELSE hours END,
      logo_file = CASE WHEN logo_file = '' THEN ? ELSE logo_file END,
      cover_file = CASE WHEN cover_file = '' OR cover_file = logo_file THEN ? ELSE cover_file END,
      accepts_orders = 1, accepts_reservations = 1, order_dine_in = 1,
      order_prepay = 1, reservation_minutes = CASE WHEN reservation_minutes = 90 THEN 90 ELSE reservation_minutes END,
      demo_payment = 1, updated_at = datetime('now') WHERE id = 'pagudfood'`).run(
        'Business name: PagudFood Food and Beverage House. PagudFood Cafe is a demonstration restaurant profile for the ISLA PLATEU school project. Cuisine: Filipino favorites, chicken and wings, rice meals, snacks and appetizers, Mexican-inspired food and sharing meals. Estimated preparation time: 15–30 minutes (demo estimate). Ordering methods: dine-in and pickup through this demonstration; delivery is not enabled. Reservations are demonstration requests and require staff confirmation. Policies: sample orders and reservations only; no real financial transaction. Menu photographs are illustrative demo images; contact details and operating hours are not verified live business information.', logo, cover);

    const menuSeed = [
      ['Chicken Parmesan Wings (served with rice)',169,'Crispy chicken wings coated in a creamy parmesan-style sauce, served with rice. Illustrative demo dish.','Chicken and Wings','chicken-parmesan-wings.jpg'],
      ['Chicken Buffalo Wings (served with rice)',169,'Buffalo-style chicken wings with rice. Illustrative demo dish.','Chicken and Wings','chicken-buffalo-wings.jpg'],
      ['Fried Chicken (served with rice)',139,'Golden fried chicken served with rice. Illustrative demo dish.','Rice Meals','fried-chicken-rice.jpg'],
      ['Pancit Guisado',85,'Filipino stir-fried noodles with vegetables. Illustrative demo dish.','Filipino Favorites','pancit-guisado.jpg'],
      ['Crispy Pata',749,'Crispy pork knuckle served with dipping sauce. Illustrative demo dish.','Filipino Favorites','crispy-pata.jpg'],
      ['Homemade Beef Nachos (Good for Sharing)',199,'Tortilla chips topped with beef, cheese and vegetables. Illustrative demo dish.','Sharing Meals','homemade-beef-nachos.jpg'],
      ['Solo Quesadilla',79,'Toasted tortilla with a savory filling and melted cheese. Illustrative demo dish.','Snacks and Appetizers','solo-quesadilla.jpg'],
      ['Duo Quesadilla',99,'Two portions of toasted quesadilla with a savory filling. Illustrative demo dish.','Mexican Food','duo-quesadilla.jpg'],
      ['Homemade Beef Burrito',89,'Flour tortilla filled with beef and savory ingredients. Illustrative demo dish.','Mexican Food','homemade-beef-burrito.jpg']
    ];
    if (db.prepare("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = 'pagudfood'").get().n === 0) {
      const ins = db.prepare("INSERT INTO menu_items (restaurant_id,name,description,price_cents,available,category,image_file) VALUES ('pagudfood',?,?,?,?,?,?)");
      for (const [name, price, desc, category, image] of menuSeed) {
        const file = copyAsset(path.join(assetDir, image), publicDir);
        ins.run(name, desc, price * 100, 1, category, file);
      }
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = 'pagudfood'").get().n === 0) {
      const ins = db.prepare("INSERT OR IGNORE INTO restaurant_tables (restaurant_id,label,capacity,reservable,active) VALUES ('pagudfood',?,?,1,1)");
      for (const [label, cap] of [['T1',2],['T2',2],['T3',4],['T4',4],['T5',4],['T6',6],['T7',2]]) ins.run(label,cap);
    }
    const existingAccount = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = 'pagudfood'").get();
    if (!existingAccount) {
      const qrName = copyAsset(path.join(assetDir, "demo-gcash-qr.png"), privateDir);
      db.prepare("INSERT INTO restaurant_payment_accounts (restaurant_id,holder_name,mobile,qr_file) VALUES ('pagudfood','PAGUDFOOD DEMO ACCOUNT','09170000000',?)").run(qrName);
    } else if (!wasDemoPayment) {
      const qrName = copyAsset(path.join(assetDir, "demo-gcash-qr.png"), privateDir);
      // On the one-time switch into demo mode, remove any previously stored real payment details/QR.
      if (existingAccount.qr_file && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(existingAccount.qr_file)) {
        try { fs.unlinkSync(path.join(privateDir, existingAccount.qr_file)); } catch {}
      }
      db.prepare("UPDATE restaurant_payment_accounts SET holder_name='PAGUDFOOD DEMO ACCOUNT', mobile='09170000000', qr_file=?, updated_at=datetime('now') WHERE restaurant_id='pagudfood'").run(qrName);
    } else if (existingAccount.qr_file && !fs.existsSync(path.join(privateDir, existingAccount.qr_file))) {
      // Restore the non-scannable demo QR if a project archive contains the DB row but not its private upload asset.
      const target = path.join(privateDir, existingAccount.qr_file);
      const source = path.join(assetDir, "demo-gcash-qr.png");
      if (fs.existsSync(source) && path.extname(existingAccount.qr_file).toLowerCase() === ".png") fs.copyFileSync(source, target);
    }
  }
  // Cafe Infinite profile facts from its official public page; preserve staff-edited fields and do not invent a pin or menu.
  const cafe = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("the-cafe-infinite");
  if (cafe && !db.prepare("SELECT value FROM settings WHERE key = ?").get("cafe_infinite_profile_v1")) {
    const cafeSeed = JSON.parse(fs.readFileSync(path.join(root, "data", "restaurants.json"), "utf8"))
      .find(r => r.id === "the-cafe-infinite");
    if (cafeSeed) {
      const oldAddress = "Wiggle Gas, San Juan, 6227 Siquijor, Philippines (Tubod area)";
      const oldContact = "+63 915 699 6727";
      const oldHours = "Listed as open 24 hours; confirm locally";
      const oldNotes = "Address is included. Exact latitude/longitude was not confidently confirmed, so no guessed pin is placed.";
      const oldMapSearchUrl = "https://www.google.com/maps/search/?api=1&query=Cafe+Infinite+Tubod+San+Juan+Siquijor";
      db.prepare(`UPDATE restaurants SET
        address = CASE WHEN address = ? THEN ? ELSE address END,
        contact = CASE WHEN contact = ? THEN ? ELSE contact END,
        hours = CASE WHEN hours = ? THEN ? ELSE hours END,
        description = CASE WHEN description = '' THEN ? ELSE description END,
        notes = CASE WHEN notes = ? THEN ? ELSE notes END,
        map_search_url = CASE WHEN map_search_url = ? THEN '' ELSE map_search_url END,
        source = CASE WHEN source = 'Public business listing' OR source = '' THEN ? ELSE source END,
        updated_at = datetime('now')
        WHERE id = 'the-cafe-infinite'`)
        .run(oldAddress, cafeSeed.address, oldContact, cafeSeed.contact, oldHours, cafeSeed.hours,
          cafeSeed.description, oldNotes, cafeSeed.notes, oldMapSearchUrl, cafeSeed.source);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))")
      .run("cafe_infinite_profile_v1");
  }
  // The Cafe Infinite demo presentation: use the supplied logo and illustrative menu assets.
  // This is additive/idempotent, updates only the existing restaurant record, and never fabricates map coordinates.
  const cafeDemo = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("the-cafe-infinite");
  if (cafeDemo && !db.prepare("SELECT value FROM settings WHERE key = ?").get("cafe_infinite_demo_v1")) {
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
    const publicDir = path.join(uploadRoot, "public"), privateDir = path.join(uploadRoot, "private");
    const assetDir = path.join(root, "assets", "cafe-infinite");
    fs.mkdirSync(publicDir, { recursive: true }); fs.mkdirSync(privateDir, { recursive: true });
    const copyCafeAsset = (file, dir) => {
      const source = path.join(assetDir, file);
      if (!fs.existsSync(source)) return "";
      const name = require("node:crypto").createHash("sha256").update(`cafe-infinite:${file}`).digest("hex").slice(0, 32) + path.extname(file).toLowerCase();
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      return name;
    };
    const logo = cafeDemo.logo_file || copyCafeAsset("the-cafe-infinite-logo.jpg", publicDir);
    const cover = cafeDemo.cover_file || copyCafeAsset("cafe-cover.jpg", publicDir);
    db.prepare(`UPDATE restaurants SET
      category = CASE WHEN category = '' OR category = 'Cafe' THEN 'Cafe / Restaurant' ELSE category END,
      description = CASE WHEN description = '' OR description LIKE '%current itemized menu and prices need confirmation%' THEN ? ELSE description END,
      logo_file = CASE WHEN logo_file = '' THEN ? ELSE logo_file END,
      cover_file = CASE WHEN cover_file = '' OR cover_file = logo_file THEN ? ELSE cover_file END,
      accepts_orders = 1, accepts_reservations = 1, order_dine_in = 1, order_prepay = 1,
      demo_payment = 1, updated_at = datetime('now')
      WHERE id = 'the-cafe-infinite'`).run(
      'THE CAFE INFINITE — DEMONSTRATION RESTAURANT PROFILE. Sample food names, descriptions, prices and photographs are for ISLA PLATEU testing only and are not represented as the cafe’s current real-world menu. Customers can browse sample meals and submit simulated orders and demo payments. Staff can edit the menu, prices, availability and restaurant information.',
      logo, cover);

    const cafeMenu = [
      ['Chicken Parmesan Wings (with rice)', 189, 'Crispy chicken wings with a creamy parmesan-style coating, served with rice. DEMO MENU ITEM.', 'Chicken Meals', 'chicken-parmesan-wings.jpg'],
      ['Chicken Buffalo Wings (with rice)', 179, 'Buffalo-style chicken wings served with steamed rice. DEMO MENU ITEM.', 'Chicken Meals', 'chicken-buffalo-wings.jpg'],
      ['Crispy Fried Chicken Rice Bowl', 149, 'Golden fried chicken served with rice. DEMO MENU ITEM.', 'Rice Meals', 'fried-chicken-rice.jpg'],
      ['Pancit Guisado', 119, 'Filipino stir-fried noodles with vegetables. DEMO MENU ITEM.', 'Filipino Favorites', 'pancit-guisado.jpg'],
      ['Crispy Pata Sharing Plate', 699, 'Crispy pork knuckle with a dipping sauce, ideal for sharing. DEMO MENU ITEM.', 'Sharing Plates', 'crispy-pata.jpg'],
      ['Loaded Beef Nachos', 219, 'Tortilla chips topped with seasoned beef, cheese and vegetables. DEMO MENU ITEM.', 'Snacks and Appetizers', 'homemade-beef-nachos.jpg'],
      ['Beef Burrito', 129, 'A soft tortilla filled with savory beef and fresh toppings. DEMO MENU ITEM.', 'Cafe Favorites', 'homemade-beef-burrito.jpg'],
      ['Cheese Quesadilla', 99, 'Toasted tortilla with a savory filling and melted cheese. DEMO MENU ITEM.', 'Snacks and Appetizers', 'solo-quesadilla.jpg']
    ];
    if (db.prepare("SELECT COUNT(*) AS n FROM menu_items WHERE restaurant_id = 'the-cafe-infinite'").get().n === 0) {
      const addMenu = db.prepare("INSERT INTO menu_items (restaurant_id,name,description,price_cents,available,category,image_file) VALUES ('the-cafe-infinite',?,?,?,?,?,?)");
      for (const [name, price, description, category, image] of cafeMenu) {
        const imageFile = copyCafeAsset(image, publicDir);
        addMenu.run(name, description, price * 100, 1, category, imageFile);
      }
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = 'the-cafe-infinite'").get().n === 0) {
      const addTable = db.prepare("INSERT OR IGNORE INTO restaurant_tables (restaurant_id,label,capacity,reservable,active) VALUES ('the-cafe-infinite',?,?,1,1)");
      for (const [label, capacity] of [['T1',2],['T2',2],['T3',4],['T4',4],['T5',4],['T6',6]]) addTable.run(label, capacity);
    }
    const demoQr = copyCafeAsset("demo-gcash-qr.png", privateDir);
    const paymentAccount = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = 'the-cafe-infinite'").get();
    if (!paymentAccount) {
      db.prepare("INSERT INTO restaurant_payment_accounts (restaurant_id,holder_name,mobile,qr_file) VALUES ('the-cafe-infinite','THE CAFE INFINITE DEMO ACCOUNT','09000000000',?)").run(demoQr);
    } else {
      if (paymentAccount.qr_file && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(paymentAccount.qr_file)) {
        try { fs.unlinkSync(path.join(privateDir, paymentAccount.qr_file)); } catch {}
      }
      db.prepare("UPDATE restaurant_payment_accounts SET holder_name='THE CAFE INFINITE DEMO ACCOUNT', mobile='09000000000', qr_file=?, updated_at=datetime('now') WHERE restaurant_id='the-cafe-infinite'").run(demoQr);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))").run("cafe_infinite_demo_v1");
  }
  // Luca Loko / Luka Loko demonstration restaurant. Additive and idempotent:
  // reuse the existing restaurant row, preserve staff edits, and never invent map coordinates.
  const luka = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("luka-loko");
  if (luka) {
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
    const publicDir = path.join(uploadRoot, "public"), privateDir = path.join(uploadRoot, "private");
    const assetDir = path.join(root, "assets", "luka-loko");
    fs.mkdirSync(publicDir, { recursive: true }); fs.mkdirSync(privateDir, { recursive: true });
    const copyLukaAsset = (file, dir) => {
      const source = path.join(assetDir, file);
      if (!fs.existsSync(source)) return "";
      const ext = path.extname(file).toLowerCase();
      const name = require("node:crypto").createHash("sha256").update(`luka-loko:${file}`).digest("hex").slice(0, 32) + ext;
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      return name;
    };
    const logo = luka.logo_file || copyLukaAsset("luca-loko-logo.jpg", publicDir);
    const cover = luka.cover_file || copyLukaAsset("luca-loko-cover.jpg", publicDir);
    // One-time cover refresh: the first local draft used the supplied logo as the cover.
    // Replace only that original seeded asset; preserve any later staff-selected cover.
    if (!db.prepare("SELECT value FROM settings WHERE key='luka_loko_cover_v2'").get()) {
      const crypto = require("node:crypto");
      const coverName = crypto.createHash("sha256").update("luka-loko:luca-loko-cover.jpg").digest("hex").slice(0, 32) + ".jpg";
      const coverSource = path.join(assetDir, "luca-loko-cover.jpg");
      if (fs.existsSync(coverSource)) {
        fs.copyFileSync(coverSource, path.join(publicDir, coverName));
        db.prepare("UPDATE restaurants SET cover_file=? WHERE id='luka-loko' AND (cover_file='' OR cover_file=?)").run(coverName, coverName);
      }
      db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('luka_loko_cover_v2',datetime('now'))");
    }
    const description = "LUCA LOKO RESTAURANT — ISLA PLATEU DEMONSTRATION PROFILE. Public listings describe this Maite, San Juan restaurant as an open-air brunch and dinner spot serving healthy, vegetarian-friendly and international dishes. Menu names, descriptions, prices and generated food photographs shown here are illustrative demonstration content only and are not the restaurant's verified current menu. Orders, reservations and payments in this project are simulated for system testing.";
    db.prepare(`UPDATE restaurants SET
      name = CASE WHEN name = '' OR name LIKE 'Luka Loko (%' THEN 'Luca Loko Restaurant' ELSE name END,
      municipality = CASE WHEN municipality = '' THEN 'San Juan' ELSE municipality END,
      category = CASE WHEN category = '' OR category = 'Restaurant' THEN 'Cafe / Restaurant' ELSE category END,
      address = CASE WHEN address = '' THEN 'Maite, San Juan, Siquijor, Philippines' ELSE address END,
      hours = CASE WHEN hours = '' OR hours LIKE 'Public listings vary%' OR hours LIKE 'Public listings differ:%' THEN 'Public listings commonly show 8 AM–10 PM; Tuesday may close earlier. Confirm directly.' ELSE hours END,
      description = CASE WHEN description = '' THEN ? ELSE description END,
      notes = CASE WHEN notes = '' OR notes LIKE 'Likely the establishment%' THEN 'Public sources identify Luca Loko Restaurant in Maite, San Juan. The exact entrance coordinates have not been independently confirmed, so the map pin remains pending. Public contact listings conflict; confirm contact details directly with the restaurant.' ELSE notes END,
      source = CASE WHEN source = '' OR source = 'Public restaurant listings' THEN 'Public references: Tripadvisor listing (https://www.tripadvisor.com/Restaurant_Review-g664445-d13313726-Reviews-Luca_Loko_Restaurant-Siquijor_Island_Visayas.html); Koobo guide (https://www.koobo.ph/siquijor/restaurants/guides/luca-loko-restaurant-siquijor); Siquijor Directory (https://beta.siquijordirectory.com/lucaloko/). Details vary between listings and should be confirmed by the business.' ELSE source END,
      lat = CASE WHEN lat IS NULL OR lng IS NULL THEN NULL ELSE lat END,
      lng = CASE WHEN lat IS NULL OR lng IS NULL THEN NULL ELSE lng END,
      verified = CASE WHEN lat IS NULL OR lng IS NULL THEN 0 ELSE verified END,
      location_status = CASE WHEN lat IS NULL OR lng IS NULL THEN 'address-only' ELSE location_status END,
      map_search_url = CASE WHEN location_status = 'verified' AND map_search_url <> '' THEN map_search_url
        ELSE 'https://www.google.com/maps/search/?api=1&query=Luca+Loko+Restaurant+Maite+San+Juan+Siquijor' END,
      logo_file = CASE WHEN logo_file = '' THEN ? ELSE logo_file END,
      cover_file = CASE WHEN cover_file = '' OR cover_file = logo_file THEN ? ELSE cover_file END,
      accepts_orders = 1, accepts_reservations = 1, order_dine_in = 1,
      order_prepay = 1, demo_payment = 1, updated_at = datetime('now')
      WHERE id = 'luka-loko'`).run(description, logo, cover);

    const lukaMenu = [
      ['Ocean Vibes Smoothie Bowl', 295, 'A bright blue smoothie bowl topped with fruit, banana and crunchy granola. DEMO MENU ITEM — illustrative image and price.', 'Smoothie Bowls', 'ocean-vibes-smoothie-bowl.jpg'],
      ['Garden Buddha Bowl', 325, 'A colorful plant-forward bowl with grains, greens, avocado and roasted vegetables. DEMO MENU ITEM — illustrative image and price.', 'Healthy Bowls', 'buddha-bowl.jpg'],
      ['Tuna Poke Bowl', 365, 'A fresh-style poke bowl with tuna, rice, avocado and crisp vegetables. DEMO MENU ITEM — illustrative image and price.', 'Healthy Bowls', 'tuna-poke-bowl.jpg'],
      ['Shakshuka with Toast', 285, 'Eggs served in a rich tomato and pepper skillet with toasted bread. DEMO MENU ITEM — illustrative image and price.', 'Brunch', 'shakshuka-toast.jpg'],
      ['Avocado Toast', 245, 'Toasted bread topped with creamy avocado and a poached egg. DEMO MENU ITEM — illustrative image and price.', 'Brunch', 'avocado-toast.jpg'],
      ['Beef Rendang Rice Bowl', 345, 'Slow-cooked spiced beef served with steamed rice. DEMO MENU ITEM — illustrative image and price.', 'Main Dishes', 'beef-rendang-rice.jpg'],
      ['Creamy Mushroom Gnocchi', 335, 'Soft potato gnocchi tossed in a creamy mushroom sauce. DEMO MENU ITEM — illustrative image and price.', 'Pasta and Mains', 'creamy-mushroom-gnocchi.jpg'],
      ['Fresh Mango Smoothie', 175, 'A chilled mango smoothie made for a refreshing tropical drink. DEMO MENU ITEM — illustrative image and price.', 'Beverages', 'mango-smoothie.jpg']
    ];
    const addLukaMenu = db.prepare("INSERT INTO menu_items (restaurant_id,name,description,price_cents,available,category,image_file) SELECT 'luka-loko',?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE restaurant_id='luka-loko' AND name=?)");
    for (const [name, price, desc, category, image] of lukaMenu) {
      const file = copyLukaAsset(image, publicDir);
      addLukaMenu.run(name, desc, price * 100, 1, category, file, name);
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = 'luka-loko'").get().n === 0) {
      const addTable = db.prepare("INSERT OR IGNORE INTO restaurant_tables (restaurant_id,label,capacity,reservable,active) VALUES ('luka-loko',?,?,1,1)");
      for (const [label, capacity] of [['T1',2],['T2',2],['T3',4],['T4',4],['T5',4],['T6',6]]) addTable.run(label, capacity);
    }
    const paymentAccount = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = 'luka-loko'").get();
    const demoQr = copyLukaAsset("demo-gcash-qr.png", privateDir);
    if (!paymentAccount) {
      db.prepare("INSERT INTO restaurant_payment_accounts (restaurant_id,holder_name,mobile,qr_file) VALUES ('luka-loko','LUCA LOKO DEMO ACCOUNT','09000000000',?)").run(demoQr);
    } else if (paymentAccount.holder_name === 'LUCA LOKO DEMO ACCOUNT' && demoQr &&
      (!paymentAccount.qr_file || !fs.existsSync(path.join(privateDir, paymentAccount.qr_file)))) {
      db.prepare("UPDATE restaurant_payment_accounts SET qr_file=?, updated_at=datetime('now') WHERE restaurant_id='luka-loko'").run(demoQr);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('luka_loko_demo_v1', datetime('now'))");
  }

  // Dagsa Resto Bar demonstration setup. Reuses the existing restaurant row,
  // seeds only missing menu records, and keeps its approximate map location clearly unverified.
  const dagsa = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("dagsa-resto");
  if (dagsa) {
    const dagsaSeeded = !!db.prepare("SELECT value FROM settings WHERE key='dagsa_resto_demo_v1'").get();
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
    const publicDir = path.join(uploadRoot, "public"), privateDir = path.join(uploadRoot, "private");
    const assetDir = path.join(root, "assets", "dagsa-resto");
    fs.mkdirSync(publicDir, { recursive: true }); fs.mkdirSync(privateDir, { recursive: true });
    const copyDagsaAsset = (file, dir) => {
      const source = path.join(assetDir, file);
      if (!fs.existsSync(source)) return "";
      const ext = path.extname(file).toLowerCase();
      const name = require("node:crypto").createHash("sha256").update(`dagsa-resto:${file}`).digest("hex").slice(0, 32) + ext;
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      return name;
    };
    const logo = copyDagsaAsset("dagsa-demo-logo.png", publicDir);
    const cover = copyDagsaAsset("dagsa-interior-cover.jpg", publicDir);
    const description = "DAGSA RESTO BAR — ISLA PLATEU DEMONSTRATION PROFILE. Public listings describe Dagsa as a Filipino, seafood-forward restaurant in San Juan, Siquijor, with dine-in, takeaway, outdoor seating and occasional live music. All menu names, descriptions, prices and generated food photos in this ISLA PLATEU profile are illustrative demonstration content only and are not represented as Dagsa's verified current menu or prices. Orders, reservations and payments in this project are simulated for system testing.";
    db.prepare(`UPDATE restaurants SET
      name = CASE WHEN name = '' THEN 'Dagsa Resto Bar' ELSE name END,
      municipality = CASE WHEN municipality = '' THEN 'San Juan' ELSE municipality END,
      category = CASE WHEN category = '' OR category = 'Restaurant' THEN 'Filipino / Seafood / International' ELSE category END,
      address = CASE WHEN address = '' THEN '5FFG+7G7, Siquijor Circumferential Road, San Juan, 6227 Siquijor, Philippines' ELSE address END,
      contact = CASE WHEN contact = '' THEN '+63 997 583 1177' ELSE contact END,
      hours = CASE WHEN hours = '' THEN 'Daily: 8:00 AM–10:00 PM (public listings; hours may vary on holidays)' ELSE hours END,
      description = CASE WHEN description = '' THEN ? ELSE description END,
      notes = CASE WHEN notes = '' THEN 'Public listings show the address/Plus Code 5FFG+7G7, phone +63 997 583 1177 and typical hours 8 AM–10 PM daily. The stored coordinates are approximate and not owner-confirmed; confirm the exact entrance with the business.' ELSE notes END,
      source = CASE WHEN source = '' THEN 'Public listings: Tripadvisor Dagsa; Restaurant Guru; Wanderlog. Existing coordinates retained as approximate, not owner-confirmed.' ELSE source END,
      lat = CASE WHEN location_status = 'verified' THEN lat ELSE NULL END,
      lng = CASE WHEN location_status = 'verified' THEN lng ELSE NULL END,
      verified = CASE WHEN location_status = 'verified' THEN verified ELSE 0 END,
      location_status = CASE WHEN location_status = 'verified' THEN location_status ELSE 'address-only' END,
      map_search_url = CASE WHEN location_status = 'verified' AND map_search_url <> '' THEN map_search_url ELSE '' END,
      logo_file = CASE WHEN logo_file = '' THEN ? ELSE logo_file END,
      cover_file = CASE WHEN cover_file = '' THEN ? ELSE cover_file END,
      accepts_orders = 1, accepts_reservations = 1, order_dine_in = 1,
      order_prepay = 1, demo_payment = 1, updated_at = datetime('now')
      WHERE id = 'dagsa-resto'`).run(description, logo, cover);

    const dagsaMenu = [
      ['Sizzling Sisig with Rice', 249, 'A sizzling Filipino-style chopped pork dish with onions and a sunny-side egg, served with rice. DEMO ITEM — not a confirmed current menu offering.', 'Filipino Favorites', 'sizzling-sisig.jpg'],
      ['Grilled Chicken Inasal', 289, 'Grilled chicken with a bright citrus-garlic marinade, served with rice and pickled vegetables. DEMO ITEM — illustrative price and photo.', 'Grilled Favorites', 'grilled-chicken-inasal.jpg'],
      ['Honey-Glazed Pork Cutlets', 329, 'Grilled pork cutlets with a sweet-savory glaze and steamed rice. DEMO ITEM — illustrative price and photo.', 'Grilled Favorites', 'honey-glazed-pork-cutlets.jpg'],
      ['Seafood Sharing Platter', 699, 'A shareable selection of grilled prawns and seafood with dipping sauce. DEMO ITEM — illustrative price and photo.', 'Seafood', 'seafood-sharing-platter.jpg'],
      ['Pancit Canton Special', 219, 'Stir-fried noodles with vegetables and savory toppings. DEMO ITEM — illustrative price and photo.', 'Filipino Favorites', 'pancit-canton.jpg'],
      ['Classic Cheeseburger & Fries', 259, 'A cheeseburger with lettuce and tomato, served with golden fries. DEMO ITEM — illustrative price and photo.', 'Snacks and Mains', 'classic-cheeseburger.jpg'],
      ['Crispy Chicken Wings', 279, 'Crispy glazed chicken wings served with a house-style dipping sauce. DEMO ITEM — illustrative price and photo.', 'Snacks and Mains', 'crispy-chicken-wings.jpg'],
      ['Calamansi Citrus Cooler', 99, 'A refreshing chilled citrus drink with calamansi and ice. DEMO ITEM — illustrative price and photo.', 'Non-Alcoholic Drinks', 'calamansi-citrus-cooler.jpg']
    ];
    // Keep default asset files available, but seed database records only once so later staff edits/deletions persist.
    for (const [, , , , image] of dagsaMenu) copyDagsaAsset(image, publicDir);
    const addDagsaMenu = db.prepare("INSERT INTO menu_items (restaurant_id,name,description,price_cents,available,category,image_file) SELECT 'dagsa-resto',?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE restaurant_id='dagsa-resto' AND name=?)");
    if (!dagsaSeeded) for (const [name, price, desc, category, image] of dagsaMenu) {
      const file = copyDagsaAsset(image, publicDir);
      addDagsaMenu.run(name, desc, price * 100, 1, category, file, name);
    }
    if (!dagsaSeeded && db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = 'dagsa-resto'").get().n === 0) {
      const addTable = db.prepare("INSERT OR IGNORE INTO restaurant_tables (restaurant_id,label,capacity,reservable,active) VALUES ('dagsa-resto',?,?,1,1)");
      for (const [label, capacity] of [['T1',2],['T2',2],['T3',4],['T4',4],['T5',6],['T6',6],['T7',8]]) addTable.run(label, capacity);
    }
    const paymentAccount = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = 'dagsa-resto'").get();
    const demoQr = copyDagsaAsset("demo-payment-placeholder.png", privateDir);
    if (!paymentAccount && !dagsaSeeded) {
      db.prepare("INSERT INTO restaurant_payment_accounts (restaurant_id,holder_name,mobile,qr_file) VALUES ('dagsa-resto','DAGSA RESTO BAR — DEMO ONLY','00000000000',?)").run(demoQr);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('dagsa_resto_demo_v1', datetime('now'))");
  }


  // La Candura demonstration setup. Reuses the existing restaurant record and
  // only seeds sample menu/table/payment data once, preserving future staff edits.
  const laCandura = db.prepare("SELECT * FROM restaurants WHERE id = ?").get("la-candura");
  if (laCandura) {
    const laCanduraSeeded = !!db.prepare("SELECT value FROM settings WHERE key='la_candura_demo_v1'").get();
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
    const publicDir = path.join(uploadRoot, "public"), privateDir = path.join(uploadRoot, "private");
    const assetDir = path.join(root, "assets", "la-candura");
    fs.mkdirSync(publicDir, { recursive: true }); fs.mkdirSync(privateDir, { recursive: true });
    const copyLaCanduraAsset = (file, dir) => {
      const source = path.join(assetDir, file);
      if (!fs.existsSync(source)) return "";
      const ext = path.extname(file).toLowerCase();
      const name = require("node:crypto").createHash("sha256").update(`la-candura:${file}`).digest("hex").slice(0, 32) + ext;
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      return name;
    };
    const logo = copyLaCanduraAsset("la-candura-official-logo.jpg", publicDir);
    const cover = copyLaCanduraAsset("la-candura-demo-cover.jpg", publicDir);
    const description = "LA CANDURA — ISLA PLATEU DEMONSTRATION RESTAURANT PROFILE. La Candura Resort and Hotel's published property information lists an on-site restaurant and bar serving Asian cuisine, with vegetarian options and breakfast, brunch, lunch and dinner service. The food names, descriptions, prices and generated food photographs in this ISLA PLATEU menu are illustrative demonstration content only and are not represented as La Candura's verified current menu or prices. Orders, reservations and payments in this project are simulated for system testing.";
    if (!laCanduraSeeded) {
      db.prepare(`UPDATE restaurants SET
        name = CASE WHEN name = '' THEN 'LA Candura' ELSE name END,
        municipality = CASE WHEN municipality = '' THEN 'San Juan' ELSE municipality END,
        category = CASE WHEN category = '' OR category = 'Restaurant' THEN 'Resort Restaurant / Asian Cuisine' ELSE category END,
        address = CASE WHEN address = '' THEN 'Candura, San Juan, 6227 Siquijor, Philippines' ELSE address END,
        contact = CASE WHEN contact = '' THEN '0915 748 8924' ELSE contact END,
        hours = CASE WHEN hours = '' THEN 'Restaurant service listed for breakfast, brunch, lunch and dinner; exact daily hours not published.' ELSE hours END,
        description = CASE WHEN description = '' THEN ? ELSE description END,
        notes = ?,
        source = ?,
        lat = 9.16677475, lng = 123.51394653, verified = 1, location_status = 'verified',
        map_search_url = '',
        logo_file = ?,
        cover_file = CASE WHEN cover_file = '' THEN ? ELSE cover_file END,
        accepts_orders = 1, accepts_reservations = 1, order_dine_in = 1,
        order_prepay = 1, demo_payment = 1, updated_at = datetime('now')
        WHERE id = 'la-candura'`).run(
          description,
          'La Candura Resort and Hotel official Cloudbeds listing identifies the property at Candura, San Juan, Siquijor and publishes telephone +63 915 748 8924, an on-site restaurant and bar, Asian cuisine and vegetarian options. Published property geo-coordinates: 9.16677475, 123.51394653. Restaurant-specific menu/prices and exact daily restaurant hours are not published. Demo menu and prices are illustrative only.',
          'Official La Candura Resort and Hotel Cloudbeds listing: https://hotels.cloudbeds.com/en/reservation/0xe4mS; Google Hotels listing.',
          logo, cover
        );
    }

    // Always refresh the restaurant logo from the latest user-supplied asset,
    // even when the one-time demonstration seed has already run.
    if (logo) {
      db.prepare("UPDATE restaurants SET logo_file = ?, updated_at = datetime('now') WHERE id = 'la-candura' AND logo_file != ?").run(logo, logo);
    }

    const laCanduraMenu = [
      ['Braised Chicken Rice Bowl', 259, 'Tender braised chicken served with steamed rice and seasonal vegetables. DEMO ITEM — illustrative price and generated image, not a verified current offering.', 'Asian-inspired Mains', 'braised-chicken-rice.jpg'],
      ['Grilled Fish with Calamansi', 329, 'Grilled whole fish with calamansi, fresh herbs and a side of rice. DEMO ITEM — illustrative price and generated image.', 'Asian-inspired Mains', 'grilled-fish-calamansi.jpg'],
      ['Shrimp Pancit Canton', 249, 'Stir-fried noodles with shrimp and crisp vegetables. DEMO ITEM — illustrative price and generated image.', 'Noodles and Pasta', 'shrimp-pancit-canton.jpg'],
      ['Creamy Mushroom Pasta', 279, 'Creamy mushroom sauce tossed with pasta and served with garlic toast. DEMO ITEM — illustrative price and generated image.', 'Noodles and Pasta', 'creamy-mushroom-pasta.jpg'],
      ['Crispy Chicken Burger and Fries', 269, 'Crispy chicken fillet with lettuce and tomato in a soft bun, served with fries. DEMO ITEM — illustrative price and generated image.', 'Snacks and Light Meals', 'crispy-chicken-burger.jpg'],
      ['Tofu Garden Bowl', 229, 'A colorful bowl of tofu, grains and fresh vegetables with a light dressing. DEMO ITEM — vegetarian sample; illustrative price and generated image.', 'Vegetarian Choices', 'tofu-buddha-bowl.jpg'],
      ['Mango Cheesecake', 159, 'Creamy cheesecake topped with mango and a buttery crumb base. DEMO ITEM — illustrative price and generated image.', 'Desserts', 'mango-cheesecake.jpg'],
      ['Mango Citrus Cooler', 119, 'A chilled mango drink brightened with citrus and ice. NON-ALCOHOLIC DEMO ITEM — illustrative price and generated image.', 'Non-Alcoholic Drinks', 'mango-citrus-cooler.jpg']
    ];
    for (const [, , , , image] of laCanduraMenu) copyLaCanduraAsset(image, publicDir);
    const addLaCanduraMenu = db.prepare("INSERT INTO menu_items (restaurant_id,name,description,price_cents,available,category,image_file) SELECT 'la-candura',?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE restaurant_id='la-candura' AND name=?)");
    if (!laCanduraSeeded) for (const [name, price, desc, category, image] of laCanduraMenu) {
      const file = copyLaCanduraAsset(image, publicDir);
      addLaCanduraMenu.run(name, desc, price * 100, 1, category, file, name);
    }
    if (!laCanduraSeeded && db.prepare("SELECT COUNT(*) AS n FROM restaurant_tables WHERE restaurant_id = 'la-candura'").get().n === 0) {
      const addTable = db.prepare("INSERT OR IGNORE INTO restaurant_tables (restaurant_id,label,capacity,reservable,active) VALUES ('la-candura',?,?,1,1)");
      for (const [label, capacity] of [['LC-1',2],['LC-2',2],['LC-3',4],['LC-4',4],['LC-5',6],['LC-6',8]]) addTable.run(label, capacity);
    }
    const paymentAccount = db.prepare("SELECT * FROM restaurant_payment_accounts WHERE restaurant_id = 'la-candura'").get();
    const demoQr = copyLaCanduraAsset("demo-payment-placeholder.png", privateDir);
    if (!paymentAccount && !laCanduraSeeded) {
      db.prepare("INSERT INTO restaurant_payment_accounts (restaurant_id,holder_name,mobile,qr_file) VALUES ('la-candura','LA CANDURA — DEMO ONLY','00000000000',?)").run(demoQr);
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('la_candura_demo_v1', datetime('now'))");
  }

  const landingSlideSeed = db.prepare("SELECT value FROM settings WHERE key = ?");
  if (!landingSlideSeed.get("landing_restaurant_slides_v1")) {
    const slides = [
      ["pagudfood", "placeholder-pagudfood.svg", 1],
      ["the-cafe-infinite", "placeholder-cafe-infinite.svg", 2],
      ["dagsa-resto", "placeholder-dagsa.svg", 3],
      ["la-candura", "placeholder-la-candura.svg", 4],
      ["luka-loko", "placeholder-luca-loko.svg", 5]
    ];
    const insert = db.prepare(`INSERT INTO slideshow_images
      (slide_set, file_name, title, alt_text, caption, button_label, credit, license, source_url, restaurant_id, sort_order, active)
      VALUES ('LANDING',?,?,?,?,?,?,?,?,?,?,1)`);
    const restaurant = db.prepare("SELECT name, municipality FROM restaurants WHERE id = ?");
    const existing = db.prepare("SELECT 1 FROM slideshow_images WHERE slide_set = 'LANDING' AND restaurant_id = ?");
    for (const [restaurantId, placeholder, order] of slides) {
      const current = restaurant.get(restaurantId);
      if (!current || existing.get(restaurantId)) continue;
      const caption = `${current.name} · ${current.municipality || "Siquijor"}. An authorized restaurant photo is awaiting upload.`;
      insert.run(
        `builtin:restaurant-photo:${restaurantId}`,
        current.name,
        `Illustrated placeholder for ${current.name}; authentic restaurant photo not yet supplied.`,
        caption,
        "Explore Restaurant",
        "ISLA-PLATEU placeholder artwork",
        "Placeholder illustration; not a restaurant photograph",
        "",
        restaurantId,
        order
      );
    }
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))").run("landing_restaurant_slides_v1");
  }

  return db;
}
module.exports = { openDatabase };
