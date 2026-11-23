"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = process.cwd();
const QUIET_MS = 4000;
const RETRY_MS = 30000;
const BRANCH = "main";

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function requireGit(args) {
  const result = git(args);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed.`);
  return result.stdout.trim();
}

const repoRoot = path.resolve(requireGit(["rev-parse", "--show-toplevel"]));
if (repoRoot.toLowerCase() !== path.resolve(ROOT).toLowerCase()) {
  throw new Error("Open the Git repository root in VS Code before starting auto-push.");
}
if (requireGit(["branch", "--show-current"]) !== BRANCH) {
  throw new Error(`Auto-push is limited to the ${BRANCH} branch.`);
}
if (requireGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) !== "origin/main") {
  throw new Error("The main branch must track origin/main before auto-push can run.");
}

const lockPath = path.join(requireGit(["rev-parse", "--git-path", "auto-push.lock"]));
let lockFd;
try {
  lockFd = fs.openSync(lockPath, "wx");
} catch (error) {
  if (error.code === "EEXIST") throw new Error("An auto-push watcher is already running for this repository.");
  throw error;
}

function releaseLock() {
  try { fs.closeSync(lockFd); } catch { /* already closed */ }
  try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") console.error(error.message); }
}

const statusNames = (status) => {
  const entries = status.split("\0");
  const names = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const state = entry.slice(0, 2);
    names.push(entry.slice(3));
    if (state.includes("R") || state.includes("C")) i++;
  }
  return names;
};

const SENSITIVE_PATH = /(^|[\\/])\.env(?:$|\.(?!example$))|(^|[\\/])(?:id_rsa|id_ed25519)(?:$|\.)|\.((?:db(?:-wal|-shm)?|pem|key|p12|pfx))$/i;
function containsSensitivePath(names) {
  return names.some((name) => SENSITIVE_PATH.test(name) || /(^|[\\/])(?:data[\\/]backups|backups|data[\\/]uploads|uploads)([\\/]|$)/i.test(name));
}

function stageAndCommit() {
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(status.stderr.trim() || "Could not read Git status.");
  if (!status.stdout) return false;
  if (containsSensitivePath(statusNames(status.stdout))) {
    console.error("Auto-push paused: a changed path looks like a secret, database, backup, or upload. Review it and update .gitignore before continuing.");
    return false;
  }

  const add = git(["add", "-A"]);
  if (add.status !== 0) throw new Error(add.stderr.trim() || "Could not stage changes.");
  const staged = git(["diff", "--cached", "--name-only", "-z"]);
  if (staged.status !== 0) throw new Error(staged.stderr.trim() || "Could not inspect staged changes.");
  if (!staged.stdout) return false;
  if (containsSensitivePath(staged.stdout.split("\0").filter(Boolean))) {
    throw new Error("A sensitive path is staged; auto-push refused to commit it.");
  }

  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const commit = git(["commit", "-m", `Auto-sync changes (${stamp})`, "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"]);
  if (commit.status !== 0) throw new Error(commit.stderr.trim() || "Could not create the automatic commit.");
  console.log(commit.stdout.trim());
  return true;
}

let debounceTimer = null;
let retryTimer = null;
let busy = false;
let pendingChange = false;
let stopped = false;

function push() {
  if (stopped || busy) return;
  busy = true;
  const result = git(["push", "origin", BRANCH]);
  busy = false;
  if (result.status === 0) {
    console.log("Auto-push complete.");
    return;
  }
  console.error(`Auto-push failed: ${(result.stderr || result.stdout).trim() || "Git push failed."}`);
  console.error("The local commit is preserved. Resolve the Git/authentication issue; auto-push will retry in 30 seconds.");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(push, RETRY_MS);
}

function flush() {
  if (stopped) return;
  if (busy) { pendingChange = true; return; }
  busy = true;
  try {
    const committed = stageAndCommit();
    busy = false;
    if (committed) push();
  } catch (error) {
    busy = false;
    console.error(`Auto-push could not process changes: ${error.message}`);
  }
  if (pendingChange) {
    pendingChange = false;
    schedule();
  }
}

function schedule() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, QUIET_MS);
}

const watcher = fs.watch(ROOT, { recursive: true }, (_event, fileName) => {
  if (!fileName) return;
  const relative = String(fileName).replace(/\\/g, "/");
  if (relative.split("/").some((part) => part === ".git" || part === "node_modules")) return;
  const ignored = git(["check-ignore", "-q", "--", relative]);
  if (ignored.status === 0) return;
  schedule();
});

function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(debounceTimer);
  clearTimeout(retryTimer);
  watcher.close();
  releaseLock();
  console.log("Auto-push watcher stopped.");
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", releaseLock);
console.log("Auto-push watcher started. Changes are committed and pushed after 4 seconds without file edits.");
if (git(["status", "--porcelain", "--untracked-files=all"]).stdout.trim()) schedule();
