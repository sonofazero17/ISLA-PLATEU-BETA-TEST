/* Uploads: binary body reading, server-side image validation (magic bytes, never the client's word), and persistent storage.
   Public images (logos, covers, food photos) live in <uploads>/public and are served by /uploads/public/<name>.
   Private files (documents, receipts) will live in <uploads>/private and are NEVER served statically. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const IMAGE_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const PUBLIC_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const PRIVATE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|pdf)$/;
const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8 MB
const DOC_TYPES = { ...IMAGE_TYPES, pdf: "application/pdf" };

/* The real format from the first bytes of the file. SVG and anything else is refused (SVG can carry scripts). */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

function createUploads(dbPath) {
  const root = path.resolve(process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), "uploads"));
  const publicDir = path.join(root, "public"), privateDir = path.join(root, "private");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });

  /* Reads a raw request body with a hard size cap. Rejects early on Content-Length, and again while streaming. */
  function readBinary(req, maxBytes = MAX_IMAGE_BYTES) {
    return new Promise((resolve, reject) => {
      const tooBig = () => Object.assign(new Error(`The file is too large. The limit is ${Math.round(maxBytes / 1048576)} MB.`), { status: 413 });
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) { req.resume(); setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref(); return reject(tooBig()); } // answer first, then drop the connection
      let size = 0, over = false; const chunks = [];
      req.on("data", c => {
        if (over) return;
        size += c.length;
        if (size > maxBytes) { over = true; chunks.length = 0; reject(tooBig()); req.resume(); setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref(); return; } // let the 413 reply go out, then cut the connection
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  /* Validates and stores an image in the public folder. Returns the stored file name. */
  function savePublicImage(buf) {
    if (!buf.length) throw Object.assign(new Error("No image was received."), { status: 400 });
    const ext = sniffImage(buf);
    if (!ext) throw Object.assign(new Error("Only JPG, PNG or WEBP images are accepted."), { status: 415 });
    const name = crypto.randomBytes(16).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(publicDir, name), buf, { flag: "wx", mode: 0o640 });
    return name;
  }

  function deletePublicImage(name) {
    if (!name || !PUBLIC_NAME.test(name)) return;
    try { fs.unlinkSync(path.join(publicDir, name)); } catch { /* already gone */ }
  }

  /* Looks up a public file by its (validated) name. Anything not matching the exact pattern is refused: no path tricks. */
  function publicFile(name) {
    if (!PUBLIC_NAME.test(name || "")) return null;
    const file = path.join(publicDir, name);
    return fs.existsSync(file) ? { file, type: IMAGE_TYPES[name.split(".")[1]] } : null;
  }

  /* Private documents (verification evidence, later payment receipts): images or PDF. Stored under random names, never served statically. */
  function savePrivateFile(buf, { imagesOnly = false } = {}) {
    if (!buf.length) throw Object.assign(new Error("No file was received."), { status: 400 });
    const ext = sniffImage(buf) || (!imagesOnly && buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-" ? "pdf" : null);
    if (!ext) throw Object.assign(new Error(imagesOnly ? "Only JPG, PNG or WEBP images are accepted." : "Only JPG, PNG, WEBP or PDF files are accepted."), { status: 415 });
    const name = crypto.randomBytes(16).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(privateDir, name), buf, { flag: "wx", mode: 0o600 });
    return { name, type: DOC_TYPES[ext], size: buf.length, hash: crypto.createHash("sha256").update(buf).digest("hex") };
  }
  function readPrivateFile(name) {
    if (!PRIVATE_NAME.test(name || "")) return null;
    try { return { data: fs.readFileSync(path.join(privateDir, name)), type: DOC_TYPES[name.split(".")[1]] }; } catch { return null; }
  }
  function deletePrivateFile(name) {
    if (!name || !PRIVATE_NAME.test(name)) return;
    try { fs.unlinkSync(path.join(privateDir, name)); } catch { /* already gone */ }
  }

  const publicUrl = (name) => (name ? `/uploads/public/${name}` : null);
  return { root, publicDir, privateDir, readBinary, savePrivateFile, readPrivateFile, deletePrivateFile, savePublicImage, deletePublicImage, publicFile, publicUrl, MAX_IMAGE_BYTES, MAX_DOC_BYTES };
}

module.exports = { createUploads, sniffImage };
