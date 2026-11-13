import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquire, killActive, release, resetGate } from "../lib/gate.js";
import { buildArgv, classifyFailure, pngInfo, runGeneration } from "../lib/runner.js";
import { acceptLicense, licenseGate, readState, statePath, writeState } from "../lib/state.js";
import { WEIGHTS } from "../lib/pinned.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-engine.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// gate: single slot, immediate busy, holder-only release
// ---------------------------------------------------------------------------

test("gate: second acquire is busy with elapsed + preview, no queue", () => {
  resetGate();
  const first = acquire("a cat");
  assert.equal(first.ok, true);
  const second = acquire("a dog");
  assert.equal(second.ok, false);
  assert.equal(typeof second.busy.elapsed_seconds, "number");
  assert.equal(second.busy.prompt_preview, "a cat");
  release(first.ticket);
  const third = acquire("a dog");
  assert.equal(third.ok, true);
  release(third.ticket);
});

test("gate: release by a foreign ticket does not free the slot", () => {
  resetGate();
  const held = acquire("x");
  release(held.ticket + 999);
  assert.equal(acquire("y").ok, false);
  release(held.ticket);
  resetGate();
});

test("gate: killActive frees the slot and survives a missing killer", () => {
  resetGate();
  const held = acquire("x");
  assert.equal(held.ok, true);
  killActive("test"); // no killer attached — must not throw
  assert.equal(acquire("y").ok, true); // slot freed
  resetGate();
});

// ---------------------------------------------------------------------------
// buildArgv: the injection-negative contract (TEST-PLAN §2)
// ---------------------------------------------------------------------------

test("argv: full flag set in engine order", () => {
  const argv = buildArgv({
    script: "/eng/scripts/generate_h3_image.py",
    prompt: "a capybara",
    output: "/ws/out.png",
    root: "/m/MiniMax-H3-Image",
    textDir: "/m/text_encoder",
    textConfig: "/m/text_encoder/config.json",
    aspect: "16:9",
    mp: 4,
    seed: 88,
    metricsPath: "/tmp/m.json",
  });
  assert.deepEqual(argv, [
    "/eng/scripts/generate_h3_image.py", "a capybara", "-o", "/ws/out.png",
    "--root", "/m/MiniMax-H3-Image", "--text-dir", "/m/text_encoder",
    "--text-config", "/m/text_encoder/config.json",
    "--aspect", "16:9", "--mp", "4", "--seed", "88", "--metrics", "/tmp/m.json",
  ]);
});

test("argv: prompt with shell metacharacters stays ONE argv element (no shell)", () => {
  const evil = `'; curl evil; echo $(pwned) \`id\` "quote`;
  const argv = buildArgv({
    script: "s.py", prompt: evil, output: "o", root: "r", textDir: "t", textConfig: "c",
    aspect: "1:1", mp: 4, metricsPath: "m",
  });
  assert.equal(argv[1], evil);
  assert.equal(argv.filter((a) => a === evil).length, 1);
});

test("argv: width/height replace aspect/mp; no-canvas flag passes through", () => {
  const argv = buildArgv({
    script: "s.py", prompt: "p", output: "o", root: "r", textDir: "t", textConfig: "c",
    width: 1024, height: 576, noCanvas: true, metricsPath: "m",
  });
  assert.ok(argv.includes("--width") && argv.includes("1024") && argv.includes("--height") && argv.includes("576"));
  assert.ok(!argv.includes("--aspect") && !argv.includes("--mp"));
  assert.ok(argv.includes("--no-canvas"));
});

// ---------------------------------------------------------------------------
// pngInfo: structural validation (existence is never a pass)
// ---------------------------------------------------------------------------

test("pngInfo: rejects short, bad-magic and truncated-IEND buffers", () => {
  assert.equal(pngInfo(Buffer.alloc(10)), null);
  assert.equal(pngInfo(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e]), Buffer.alloc(40)])), null);
  const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  assert.equal(pngInfo(fake), null); // IHDR length/chunk check fails
});

// ---------------------------------------------------------------------------
// classifyFailure: stderr → error taxonomy
// ---------------------------------------------------------------------------

test("classify: deadline is timeout with retry hint", () => {
  const r = classifyFailure({ killedByDeadline: true, signal: "SIGKILL", code: null, stderrTail: "" });
  assert.equal(r.error_type, "timeout");
  assert.ok(r.fix_hint.includes("timeout_seconds"));
});

test("classify: OOM strings and SIGKILL map to memory", () => {
  assert.equal(classifyFailure({ killedByDeadline: false, signal: null, code: 1, stderrTail: "std::bad_alloc: out of memory" }).error_type, "memory");
  assert.equal(classifyFailure({ killedByDeadline: false, signal: "SIGKILL", code: null, stderrTail: "" }).error_type, "memory");
});

test("classify: ENOSPC maps to disk, checksum to verify, else engine", () => {
  assert.equal(classifyFailure({ killedByDeadline: false, signal: null, code: 1, stderrTail: "OSError: [Errno 28] No space left on device" }).error_type, "disk");
  assert.equal(classifyFailure({ killedByDeadline: false, signal: null, code: 1, stderrTail: "sha256 mismatch for dit/foo.safetensors" }).error_type, "verify");
  assert.equal(classifyFailure({ killedByDeadline: false, signal: null, code: 2, stderrTail: "weird" }).error_type, "engine");
});

// ---------------------------------------------------------------------------
// state: license gate is pure, persistence is atomic, acceptance is explicit
// ---------------------------------------------------------------------------

test("licenseGate: empty state blocks with license type and self-accept hint", () => {
  const r = licenseGate({});
  assert.equal(r.ok, false);
  assert.equal(r.error_type, "license");
  assert.ok(r.message.includes(WEIGHTS.license));
  assert.ok(r.fix_hint.includes("accept=true"));
});

test("licenseGate: matching record passes; foreign agreement name does not", () => {
  const ok = acceptLicense({}, "2026-11-12T00:00:00.000Z");
  assert.equal(licenseGate(ok), null);
  assert.notEqual(licenseGate({ license: { accepted: true, agreement: "MIT" } }), null);
});

test("licenseGate: a legacy record naming only the image agreement must re-accept", () => {
  const legacy = { license: { accepted: true, agreement: WEIGHTS.license, at: "2026-11-13T00:00:00.000Z" } };
  const r = licenseGate(legacy);
  assert.notEqual(r, null);
  assert.equal(r.error_type, "license");
});

test("state: corrupt file reads as empty; write is tmp+rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-state-"));
  const path = statePath(dir);
  await writeFile(path, "{not json", "utf8");
  assert.deepEqual(await readState(path, (p) => readFile(p, "utf8")), {});
  await writeState(path, { license: { accepted: true } });
  assert.equal(JSON.parse(await readFile(path, "utf8")).license.accepted, true);
  // no tmp leftover
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runGeneration against the fake engine (L2)
// ---------------------------------------------------------------------------

async function fixtureRun(prompt, extra = {}) {
  resetGate();
  const dir = await mkdtemp(join(tmpdir(), "h3-run-"));
  const opts = {
    pythonBin: process.execPath, // node runs the .mjs fixture
    engineDir: join(FIXTURE, "..", ".."),
    script: FIXTURE,
    prompt,
    output: join(dir, "out.png"),
    root: "/fake/root",
    textDir: "/fake/text",
    textConfig: "/fake/text/config.json",
    aspect: "1:1",
    mp: 4,
    metricsPath: join(dir, "m.json"),
    ...extra,
  };
  const result = await runGeneration(opts, { env: process.env });
  return { dir, result };
}

test("run: success parses metrics, validates PNG bytes", async () => {
  const { dir, result } = await fixtureRun("a capybara in a hot spring", { seed: 88 });
  assert.equal(result.metrics.seed, 88);
  assert.equal(result.png.width, 64);
  assert.equal(result.png.height, 32);
  assert.equal(result.png.bytes.length > 100, true);
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: second concurrent call returns busy immediately", async () => {
  resetGate();
  const dir = await mkdtemp(join(tmpdir(), "h3-busy-"));
  const base = {
    pythonBin: process.execPath, engineDir: ".", script: FIXTURE,
    root: "/r", textDir: "/t", textConfig: "/c", aspect: "1:1", mp: 4,
    metricsPath: join(dir, "m.json"),
  };
  const first = runGeneration({ ...base, prompt: "SLEEP", output: join(dir, "a.png"), timeoutSeconds: 10 });
  // give the child a moment to spawn, then hit the gate
  await new Promise((r) => setTimeout(r, 150));
  const second = await runGeneration({ ...base, prompt: "x", output: join(dir, "b.png"), metricsPath: join(dir, "m2.json") });
  assert.equal(second.error_type, "busy");
  assert.ok(second.queue_hint);
  killActive("test cleanup");
  await first;
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: internal deadline kills the child and returns timeout", async () => {
  resetGate();
  const dir = await mkdtemp(join(tmpdir(), "h3-deadline-"));
  const result = await runGeneration(
    {
      pythonBin: process.execPath, engineDir: ".", script: FIXTURE, prompt: "SLEEP",
      output: join(dir, "o.png"), root: "/r", textDir: "/t", textConfig: "/c",
      aspect: "1:1", mp: 4, metricsPath: join(dir, "m.json"), timeoutSeconds: 1,
    },
    { env: process.env, minTimeoutS: 1 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_type, "timeout");
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: engine exit 1 with OOM stderr classifies as memory", async () => {
  const { dir, result } = await fixtureRun("FAIL:torch.OutOfMemoryError: MPS out of memory");
  assert.equal(result.error_type, "memory");
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: exit 0 without PNG is engine failure, not success", async () => {
  const { dir, result } = await fixtureRun("NOIMAGE");
  assert.equal(result.ok, false);
  assert.equal(result.error_type, "engine");
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: truncated PNG is verify, never a silent success", async () => {
  const { dir, result } = await fixtureRun("BADPNG");
  assert.equal(result.error_type, "verify");
  await rm(dir, { recursive: true, force: true });
  resetGate();
});

test("run: spawn failure (missing python) is engine with h3_status hint", async () => {
  resetGate();
  const dir = await mkdtemp(join(tmpdir(), "h3-nopy-"));
  const result = await runGeneration({
    pythonBin: join(dir, "nope", "python"), script: FIXTURE, prompt: "p",
    output: join(dir, "o.png"), root: "/r", textDir: "/t", textConfig: "/c",
    aspect: "1:1", mp: 4, metricsPath: join(dir, "m.json"),
  }, { env: process.env });
  assert.equal(result.ok, false);
  assert.equal(result.error_type, "engine");
  assert.ok(result.fix_hint.includes("h3_status"));
  await rm(dir, { recursive: true, force: true });
  resetGate();
});
