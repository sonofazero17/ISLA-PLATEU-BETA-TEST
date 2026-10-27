/* Restore a backup into the database location. STOP THE SERVER FIRST.
   Usage:   node scripts/restore.js <backupFile> --yes
   The backup is checked first. The current database (if any) is copied aside, never deleted. */
"use strict";
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const dbPath = process.env.DB_PATH || path.join(ROOT, "data", "islaplateu.db");
const file = process.argv[2];
const fail = (m) => { console.error("Error: " + m); process.exit(1); };
if (!file || file.startsWith("--")) fail("usage: node scripts/restore.js <backupFile> --yes");
if (!fs.existsSync(file)) fail(`file not found: ${file}`);
let users;
try {
  const b = new DatabaseSync(path.resolve(file), { readOnly: true });
  if (b.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") fail("the backup file is damaged (integrity check failed)");
  users = b.prepare("SELECT COUNT(*) AS n FROM users").get().n; b.close();
} catch (e) { fail("that file is not a valid ISLA-PLATEU database: " + e.message); }
console.log(`Backup is valid (${users} accounts). Target: ${dbPath}`);
if (!process.argv.includes("--yes")) fail("add --yes to confirm. Make sure the server is stopped first.");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) {
  const aside = `${dbPath}.before-restore-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  fs.copyFileSync(dbPath, aside); console.log(`Current database kept as ${aside}`);
}
for (const ext of ["-wal", "-shm"]) { try { fs.unlinkSync(dbPath + ext); } catch { /* none */ } }
const tmp = dbPath + ".restoring"; fs.copyFileSync(path.resolve(file), tmp); fs.renameSync(tmp, dbPath);
console.log("Restore complete. Start the server again.");
