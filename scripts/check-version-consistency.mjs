#!/usr/bin/env node
/**
 * Version-consistency gate: every version string that ships must agree.
 *
 * Checks:
 *  1. package.json version === CHANGELOG.md latest [x.y.z] heading
 *  2. locale meta.description mentions the same version when it mentions one
 *  3. lib/pinned.js parses and its pinned constants are well-formed
 *     (40-hex commit, 40-hex revisions, 64-hex sha256)
 *
 * exit 0 = consistent; exit 1 = mismatch (printed).
 * Dev-only: intentionally NOT in package.json `files`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const en = JSON.parse(readFileSync(join(ROOT, "locale", "en.json"), "utf8"));
const zh = JSON.parse(readFileSync(join(ROOT, "locale", "zh.json"), "utf8"));

// 1. package.json vs CHANGELOG latest heading
const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
if (headings.length === 0) problems.push("CHANGELOG.md has no [x.y.z] release heading");
else if (headings[0] !== pkg.version) problems.push(`CHANGELOG latest ${headings[0]} != package.json ${pkg.version}`);

// 2. locale descriptions: if they cite a version, it must match
for (const [name, loc] of [["en", en], ["zh", zh]]) {
  const m = /(0\.\d+\.\d+|v?\d+\.\d+\.\d+)/.exec(loc?.meta?.description ?? "");
  if (m) {
    const cited = m[1].replace(/^v/, "");
    if (cited !== pkg.version) problems.push(`locale/${name}.json cites ${cited} != package.json ${pkg.version}`);
  }
}

// 3. pinned.js shape (import as module)
const pinned = await import(join(ROOT, "lib", "pinned.js"));
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
if (!HEX40.test(pinned.ENGINE.commit)) problems.push("ENGINE.commit is not a 40-hex sha");
if (!HEX40.test(pinned.WEIGHTS.revision)) problems.push("WEIGHTS.revision is not a 40-hex sha");
if (!HEX40.test(pinned.TEXT_ENCODER.revision)) problems.push("TEXT_ENCODER.revision is not a 40-hex sha");
if (!HEX64.test(pinned.TEXT_ENCODER_REUSE.sha256)) problems.push("TEXT_ENCODER_REUSE.sha256 is not a 64-hex sha");
if (!Array.isArray(pinned.ENGINE.pythonMin) || pinned.ENGINE.pythonMin.length !== 2) problems.push("ENGINE.pythonMin malformed");

if (problems.length > 0) {
  console.error(`VERSION CONSISTENCY: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`VERSION CONSISTENCY: PASS (${pkg.version})`);
