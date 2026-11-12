#!/usr/bin/env node
/**
 * Release-safety gate: is this tree — or this built tarball — safe to hand to
 * someone else?
 *
 * The three failure classes this checks for were each paid for once, on a
 * sibling project: (1) tar headers carrying the build machine's real username,
 * (2) AppleDouble `._*` entries that macOS bsdtar swallows but GNU tar does
 * not, (3) a shipped document referencing an internal workspace path. Content
 * scans alone miss all three, so this gate scans CONTENTS, the FILE LIST, and
 * the TAR METADATA.
 *
 * USAGE
 *   node scripts/check-release-safety.mjs                   # scan the source tree
 *   node scripts/check-release-safety.mjs --tarball <f.tgz> # scan a built tarball
 *   exit 0 = safe; exit 1 = findings, each printed with location and reason
 *
 * Dev-only: intentionally NOT in package.json `files`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll("\\", "/");

const findings = [];
const fail = (where, what, why) => findings.push({ where, what, why });

// Patterns built from PARTS so this file never matches itself.
const S = "sk" + "-";
const CF = "cfut" + "_";

const SECRET_PATTERNS = [
  { name: "OpenAI-style key", re: new RegExp(`${S}[A-Za-z0-9]{16,}`, "g") },
  { name: "Cloudflare token", re: new RegExp(`${CF}[A-Za-z0-9_-]{15,}`, "g") },
  { name: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "npm token", re: /npm_[A-Za-z0-9]{20,}/g },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
];

// Machine fingerprints that must never ship. Built from the live environment
// so it catches THIS machine's identity without hardcoding it.
const HOME = homedir();
const USER = HOME.split("/").pop();
const FINGERPRINTS = [
  { name: "home directory path", re: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") },
  // Workspace root path (parent of any dsh-* project dir this repo sits in).
  { name: "workspace root path", re: new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/deepseek", "g") },
];
// Username fingerprint only when it is not a generic name. "agent" is in the
// list because this build machine's account is literally named agent while
// "agent" is also a core DSH API identifier (exec.agent.session...) — the
// home-path and absolute-path fingerprints still catch real leaks.
if (USER && !["root", "user", "admin", "runner", "github", "agent"].includes(USER)) {
  FINGERPRINTS.push({
    name: "username",
    re: new RegExp(`(?<![A-Za-z0-9])${USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"),
  });
}

// Internal-path references (workspace-internal deliverable directories that
// mean nothing — and leak — outside this machine).
const INTERNAL_PATH_RE = /(?:deliverables\/|\/Users\/[^/\s]+\/|C:\\Users\\[^\\\s]+\\)/g;

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt", ".svg", ".html", ".css", ".ts", ".py"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "test", "scripts", ".github", "docs"]);
// Local-only operational documents (append-only handoff notes) legitimately
// carry machine paths and are NOT in package.json `files` — the source pass
// skips them; the tarball pass is the real gate for what ships.
const SKIP_SOURCE_RE = /^HANDOFF-\d+\.md$/;

function scanText(where, text) {
  for (const p of SECRET_PATTERNS) {
    const m = text.match(p.re);
    if (m) fail(where, p.name, `${m.length} match(es) of a credential pattern`);
  }
  for (const p of FINGERPRINTS) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      p.re.lastIndex = 0;
      if (p.re.test(lines[i])) {
        fail(where, p.name, `line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
        break;
      }
    }
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    INTERNAL_PATH_RE.lastIndex = 0;
    if (INTERNAL_PATH_RE.test(lines[i])) {
      fail(where, "absolute user path", `line ${i + 1}: ${lines[i].trim().slice(0, 80)}`);
    }
  }
}

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function scanSource() {
  const files = walk(ROOT, []).filter((f) => {
    const rel = relative(ROOT, f).replaceAll(sep, "/");
    if (rel === SELF) return false;
    if (SKIP_SOURCE_RE.test(rel)) return false;
    return TEXT_EXT.has(rel.slice(rel.lastIndexOf(".")));
  });
  for (const f of files) {
    const rel = relative(ROOT, f).replaceAll(sep, "/");
    if (statSync(f).size > 2 * 1024 * 1024) continue;
    scanText(rel, readFileSync(f, "utf8"));
  }
  return files.length;
}

function scanTarball(tarball) {
  const abs = resolve(tarball);
  if (!existsSync(abs)) {
    fail(tarball, "missing", "tarball path does not exist");
    return;
  }
  let listing;
  try {
    listing = execFileSync("tar", ["-tvf", abs], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    fail(tarball, "unreadable", String(e.message).slice(0, 200));
    return;
  }
  const names = [];
  for (const line of listing.split("\n")) {
    if (!line.trim()) continue;
    // bsdtar -tvf: "mode uid/gname size date name"; GNU tar: "mode uid/gname ...".
    const parts = line.trim().split(/\s+/);
    const name = parts.slice(-1)[0];
    names.push(name);
    if (/(^|\/)\._[^/]+$/.test(name)) fail(tarball, "AppleDouble entry", name);
    if (/(^|\/)\.DS_Store$/.test(name)) fail(tarball, "macOS metadata", name);
    // tar header user/group: fields 2 (uid/gname) in bsdtar output.
    const owner = parts[1];
    if (owner && USER && !["root", "0", "wheel", "staff", "runner", "github"].includes(owner.split("/")[1])) {
      if (owner.split("/")[1] === USER) fail(tarball, "tar header username", `entry ${name} carries gname=${owner.split("/")[1]}`);
    }
  }
  // Extract to a temp dir and scan contents.
  const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
  try {
    execFileSync("tar", ["-xzf", abs, "-C", tmp], { maxBuffer: 16 * 1024 * 1024 });
    const files = walk(tmp, []).filter((f) => TEXT_EXT.has(f.slice(f.lastIndexOf("."))));
    for (const f of files) {
      if (statSync(f).size > 2 * 1024 * 1024) continue;
      scanText(relative(tmp, f).replaceAll(sep, "/"), readFileSync(f, "utf8"));
    }
  } finally {
    execFileSync("rm", ["-rf", tmp]);
  }
  return names.length;
}

const argIdx = process.argv.indexOf("--tarball");
let scanned;
if (argIdx >= 0) {
  scanned = scanTarball(process.argv[argIdx + 1]);
  console.log(`scanned tarball entries: ${scanned ?? 0}`);
} else {
  scanned = scanSource();
  console.log(`scanned source files: ${scanned}`);
}

if (findings.length > 0) {
  console.error(`RELEASE SAFETY: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f.where}: ${f.what} — ${f.why}`);
  process.exit(1);
}
console.log("RELEASE SAFETY: PASS");
