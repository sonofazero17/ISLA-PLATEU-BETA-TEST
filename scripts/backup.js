/* Make a safe copy of the ISLA-PLATEU database.
   Usage:   node scripts/backup.js [outputFile]
   The database location comes from DB_PATH (same variable the server uses). Works while the server is running.
   Login sessions are removed from the copy. The file contains personal data and password hashes: keep it private. */
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const dbPath = process.env.DB_PATH || path.join(ROOT, "data", "islaplateu.db");
if (!fs.existsSync(dbPath)) { console.error(`No database found at ${dbPath}. Set DB_PATH to the database you want to back up.`); process.exit(1); }
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const out = path.resolve(process.argv[2] || path.join(path.dirname(dbPath), "backups", `isla-plateu-${stamp}.db`));
if (fs.existsSync(out)) { console.error(`Refusing to overwrite ${out}`); process.exit(1); }
fs.mkdirSync(path.dirname(out), { recursive: true });
const src = new DatabaseSync(dbPath);
src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
src.close();
const copy = new DatabaseSync(out);
copy.exec("DELETE FROM sessions");
const check = copy.prepare("PRAGMA integrity_check").get().integrity_check;
const users = copy.prepare("SELECT COUNT(*) AS n FROM users").get().n;
copy.exec("VACUUM"); copy.close();
if (check !== "ok") { console.error("Backup failed its integrity check: " + check); process.exit(1); }
console.log(`Backup written: ${out}\n  size: ${fs.statSync(out).size} bytes, accounts in backup: ${users}, integrity: ok`);
