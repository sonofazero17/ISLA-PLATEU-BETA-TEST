/* Secure administrative process for creating Restaurant Staff / Administrator accounts
   (public sign-up can only ever create CUSTOMER accounts).

   Usage:
     node create-user.js --email staff@example.com --name "Maria Santos" --role staff [--restaurant la-candura] [--password "..."]
     node create-user.js --email admin2@example.com --name "Jane Doe" --role admin
     node create-user.js --email someone@example.com --reset            (set a new password for an existing account)

   Roles: customer | staff | admin. If --password is omitted, a strong random one is generated and printed once. */
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { hashPassword } = require("./server.js");
const { DatabaseSync } = require("node:sqlite");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) args[key] = true; else { args[key] = next; i++; }
}
const ROLE_MAP = { customer: "CUSTOMER", staff: "RESTAURANT_STAFF", admin: "ADMINISTRATOR" };
const fail = (m) => { console.error("Error: " + m); process.exit(1); };

(async () => {
  const email = String(args.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("provide a valid --email");
  const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "data", "islaplateu.db"));
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const generated = !args.password || args.password === true;
  const password = generated ? crypto.randomBytes(9).toString("base64url") : String(args.password);
  if (password.length < 8) fail("password must be at least 8 characters");
  const hash = await hashPassword(password);

  if (args.reset) {
    if (!existing) fail("no account with that email");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, existing.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(existing.id); // sign the user out everywhere
    console.log(`Password reset for ${email}.${generated ? "\nNew password: " + password : ""}`);
    return;
  }
  const role = ROLE_MAP[String(args.role || "").toLowerCase()];
  const name = String(args.name || "").trim();
  if (!role) fail("--role must be customer, staff, or admin");
  if (name.length < 2) fail("provide --name");
  if (existing) fail("an account with that email already exists (use --reset to change its password)");
  db.prepare("INSERT INTO users (full_name, email, password_hash, role, restaurant_id) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, hash, role, typeof args.restaurant === "string" ? args.restaurant : null);
  console.log(`Created ${role} account for ${email}.${generated ? "\nPassword: " + password + "   (shown once)" : ""}`);
})().then(() => process.exit(0));
