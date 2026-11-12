import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSmokeCommands,
  buildWeightsCommands,
  discoverInterpreter,
  evaluateInterpreterVersion,
  interpreterCandidates,
  planEngine,
  planVenv,
  planWeights,
  pollSetup,
} from "../lib/setup.js";
import { ENGINE } from "../lib/pinned.js";

// ---------------------------------------------------------------------------
// Pure decision cores
// ---------------------------------------------------------------------------

test("evaluateInterpreterVersion: 3.13.12 ok, 3.12 too_old, junk invalid", () => {
  assert.equal(evaluateInterpreterVersion("3.13.12").ok, true);
  assert.equal(evaluateInterpreterVersion("3.14.0").ok, true);
  assert.equal(evaluateInterpreterVersion("3.12.9").ok, false);
  assert.equal(evaluateInterpreterVersion("3.12.9").verdict, "too_old");
  assert.equal(evaluateInterpreterVersion("not a version").verdict, "invalid");
});

test("interpreterCandidates: config python_bin first, no absolute home paths leak", () => {
  const cands = interpreterCandidates({ python_bin: "/x/custom" }, "/home/zed");
  assert.equal(cands[0].bin, "/x/custom");
  assert.equal(cands[0].source, "config");
  // Machine-specific knowledge is only ever $HOME-relative or a system prefix.
  assert.ok(!JSON.stringify(cands).includes("/home/zed"));
});

test("discoverInterpreter: picks the first >=3.13, skips old and broken", async () => {
  const versions = {
    "python3.14": null, // not installed
    "python3.13": "3.13.12",
  };
  const exec = async (bin, argv) => {
    const v = versions[bin];
    if (v === undefined || v === null) throw new Error("ENOENT");
    return { stdout: v + "\n" };
  };
  const found = await discoverInterpreter({}, { exec, readdir: async () => { throw new Error("no pyenv"); }, home: "/h" });
  assert.equal(found.bin, "python3.13");
  assert.equal(found.version, "3.13.12");
});

test("discoverInterpreter: nothing suitable → engine envelope listing sources", async () => {
  const exec = async () => { throw new Error("ENOENT"); };
  const r = await discoverInterpreter({}, { exec, readdir: async () => { throw new Error("no pyenv"); }, home: "/h" });
  assert.equal(r.ok, false);
  assert.equal(r.error_type, "engine");
  assert.match(r.message, /brew/);
  assert.match(r.fix_hint, /python_bin/);
});

test("planVenv: create / ok / replace decisions", () => {
  assert.equal(planVenv({ python: null }).action, "create");
  assert.equal(planVenv({ python: { major: 3, minor: 13 } }).action, "ok");
  assert.equal(planVenv({ python: { major: 3, minor: 12 } }).action, "replace");
  assert.equal(planVenv({ python: { broken: true, major: 0, minor: 0 } }).action, "replace");
});

test("planEngine: fresh clone chain; pinned+deps → noop; wrong head → checkout", () => {
  const fresh = planEngine({ exists: false, head: null, pinnedCommit: ENGINE.commit, depsRecorded: false, venvBin: "/v/bin/python" });
  assert.deepEqual(fresh.steps, ["clone", "checkout", "pip"]);
  const done = planEngine({ exists: true, head: ENGINE.commit, pinnedCommit: ENGINE.commit, depsRecorded: true, venvBin: "/v" });
  assert.equal(done.action, "ok");
  const wrong = planEngine({ exists: true, head: "f".repeat(40), pinnedCommit: ENGINE.commit, depsRecorded: true, venvBin: "/v" });
  assert.deepEqual(wrong.steps, ["checkout"]);
  const notGit = planEngine({ exists: true, head: null, pinnedCommit: ENGINE.commit, depsRecorded: false, venvBin: "/v" });
  assert.equal(notGit.action, "not-a-checkout");
});

test("planWeights: license gate first, then memory floor, then disk, then risk confirm", () => {
  const base = { licenseAccepted: true, memoryGB: 64, freeGB: 500, diskMinGB: 80, ditComplete: false, teComplete: false, riskConfirmed: false };
  assert.equal(planWeights({ ...base, licenseAccepted: false }).block.error_type, "license");
  assert.equal(planWeights({ ...base, memoryGB: 16 }).block.error_type, "memory");
  assert.equal(planWeights({ ...base, freeGB: 10 }).block.error_type, "disk");
  // 36 GB: between floor(32) and recommended(48) → needs explicit confirmation
  const risky = planWeights({ ...base, memoryGB: 36 });
  assert.equal(risky.block.error_type, "memory");
  assert.match(risky.block.fix_hint, /confirm_risk/);
  const confirmed = planWeights({ ...base, memoryGB: 36, riskConfirmed: true });
  assert.equal(confirmed.block, null);
  assert.equal(confirmed.riskWarning, true);
  const complete = planWeights({ ...base, ditComplete: true, teComplete: true });
  assert.equal(complete.alreadyComplete, true);
});

// ---------------------------------------------------------------------------
// Command builders (argv contract; zero shell, pinned values present)
// ---------------------------------------------------------------------------

const resolved = {
  model_dir: "/m/models",
  engine_dir: "/m/engine",
  venv_dir: "/m/venv",
  text_dir: "/m/models/text_encoder",
  text_config: "/m/models/upstream-meta/FL2VA/text_encoder/config.json",
  mirror: "hf",
};

test("buildWeightsCommands: engine fetch pinned flags + TE driver full pin set", () => {
  const cmds = buildWeightsCommands({ resolved, venvBin: "/m/venv/bin/python3", mirror: "hf" });
  assert.equal(cmds.length, 2);
  const [fetch, te] = cmds;
  assert.deepEqual(fetch.argv.slice(0, 3), ["/m/venv/bin/python3", "/m/engine/scripts/fetch_h3_image.py", "--dir"]);
  assert.ok(fetch.argv.includes("--accepted"));
  const revIdx = te.argv.indexOf("--revision");
  assert.equal(te.argv[revIdx + 1], "64314cde0ac6d90f132bc94ae58e0c82f77396c6"); // quantized package pin
  const metaIdx = te.argv.indexOf("--meta-revision");
  assert.equal(te.argv[metaIdx + 1], "0919fb684102ef115126612f3fbb84d1027e7317"); // upstream meta pin
  const shaIdx = te.argv.indexOf("--sha256");
  assert.match(te.argv[shaIdx + 1], /^[0-9a-f]{64}$/);
  assert.equal(te.env, undefined); // hf default: no env override at all
});

test("buildWeightsCommands: hf-mirror only touches the TE command env", () => {
  const cmds = buildWeightsCommands({ resolved, venvBin: "/v", mirror: "hf-mirror" });
  assert.equal(cmds[0].env, undefined);
  assert.equal(cmds[1].env.HF_ENDPOINT, "https://hf-mirror.com");
});

test("buildSmokeCommands: 1MP seed 7 no-canvas into the job area", () => {
  const { outPath, commands } = buildSmokeCommands({ resolved, venvBin: "/v/bin/python3", jobId: "smoke-1" });
  assert.equal(outPath, join("/m/models", "h3-jobs", "smoke-1.png"));
  const argv = commands[0].argv;
  assert.ok(argv.includes("--no-canvas"));
  assert.equal(argv[argv.indexOf("--mp") + 1], "1");
  assert.equal(argv[argv.indexOf("--seed") + 1], "7");
  assert.ok(argv.includes("--metrics"));
  assert.ok(!argv.some((a) => a.includes(";") || a.includes("&&")));
});

// ---------------------------------------------------------------------------
// pollSetup: exit-0 is never the verdict — the disk decides
// ---------------------------------------------------------------------------

test("pollSetup smoke: done + decodable PNG → done; done + garbage PNG → failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-poll-"));
  const jDir = join(dir, "h3-jobs");
  await (await import("node:fs/promises")).mkdir(jDir, { recursive: true });
  const id = "smoke-x";
  await writeFile(join(jDir, `${id}.json`), JSON.stringify({ id, kind: "smoke", pid: 1, status: "running", startedAt: "t" }));
  await writeFile(join(jDir, `${id}.result.json`), JSON.stringify({ ok: true, exit_code: 0 }));
  await writeFile(join(jDir, `${id}.log`), "== smoke ==\n");

  const magic = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(magic, 0);
  magic.writeUInt32BE(13, 8); // IHDR chunk length
  magic.write("IHDR", 12, "ascii");
  magic.writeUInt32BE(64, 16);
  magic.writeUInt32BE(64, 20);
  Buffer.from("IEND").copy(magic, 56);
  Buffer.from([0xae, 0x42, 0x60, 0x82]).copy(magic, 60);

  const res = { model_dir: dir, text_dir: join(dir, "te"), text_config: join(dir, "tc"), engine_dir: join(dir, "eng") };

  // No PNG at all → failed verify.
  let r = await pollSetup(res, id, { alive: () => false });
  assert.equal(r.state, "failed");
  assert.equal(r.error_type, "verify");

  // Garbage PNG → failed verify.
  await writeFile(join(jDir, `${id}.png`), "not a png");
  r = await pollSetup(res, id, { alive: () => false });
  assert.equal(r.state, "failed");

  // Structurally valid PNG → done with smoke_png.
  await writeFile(join(jDir, `${id}.png`), magic);
  r = await pollSetup(res, id, { alive: () => false });
  assert.equal(r.state, "done");
  assert.equal(r.smoke_png.ok, true);
  assert.equal(r.smoke_png.width, 64);
  await rm(dir, { recursive: true, force: true });
});

test("pollSetup weights: done but missing manifest on disk → failed verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-poll-"));
  const jDir = join(dir, "h3-jobs");
  await (await import("node:fs/promises")).mkdir(jDir, { recursive: true });
  const id = "weights-x";
  await writeFile(join(jDir, `${id}.json`), JSON.stringify({ id, kind: "weights", pid: 1, status: "running", startedAt: "t" }));
  await writeFile(join(jDir, `${id}.result.json`), JSON.stringify({ ok: true, exit_code: 0 }));
  const res = { model_dir: dir, text_dir: join(dir, "te"), text_config: join(dir, "tc"), engine_dir: join(dir, "eng") };
  const r = await pollSetup(res, id, { alive: () => false });
  assert.equal(r.state, "failed");
  assert.equal(r.error_type, "verify");
  assert.equal(r.verified.dit_manifest, false);
  await rm(dir, { recursive: true, force: true });
});
