import test from "node:test";
import assert from "node:assert/strict";

import {
  checkPlatform,
  checkMemory,
  checkPython,
  checkEngine,
  checkWeights,
  checkTextEncoder,
  checkDisk,
  normalizeMirror,
  memoryGB,
  overallOf,
  resolveConfig,
} from "../lib/checks.js";

test("platform: refuses non-darwin", () => {
  const r = checkPlatform({ platform: "linux", arch: "arm64" });
  assert.equal(r.state, "refused");
  assert.ok(r.fix_hint);
});

test("platform: refuses Intel", () => {
  const r = checkPlatform({ platform: "darwin", arch: "x64" });
  assert.equal(r.state, "refused");
});

test("platform: accepts arm64 darwin", () => {
  assert.equal(checkPlatform({ platform: "darwin", arch: "arm64" }).state, "ok");
});

test("memory: below floor is too_low without warning", () => {
  const r = checkMemory({ totalGB: 16 });
  assert.equal(r.state, "too_low");
  assert.notEqual(r.warning, true);
});

test("memory: 36GB is not-guaranteed warning", () => {
  const r = checkMemory({ totalGB: 36 });
  assert.equal(r.state, "too_low");
  assert.equal(r.warning, true);
});

test("memory: 48GB ok", () => {
  assert.equal(checkMemory({ totalGB: 48 }).state, "ok");
});

test("python: missing venv", () => {
  const r = checkPython({ python: null, venvDirName: "~/x/venv" });
  assert.equal(r.state, "missing");
  assert.match(r.detail, /~\/x\/venv/);
});

test("python: broken interpreter is mismatch not absence", () => {
  const r = checkPython({ python: { bin: "p", broken: true }, venvDirName: "v" });
  assert.equal(r.state, "mismatch");
});

test("python: 3.12 too old, 3.13 ok", () => {
  assert.equal(checkPython({ python: { major: 3, minor: 12 }, venvDirName: "v" }).state, "mismatch");
  assert.equal(checkPython({ python: { major: 3, minor: 13 }, venvDirName: "v" }).state, "ok");
});

test("engine: commit mismatch names both shas", () => {
  const r = checkEngine({
    engineDirName: "~/e",
    head: "a".repeat(40),
    pinnedCommit: "b".repeat(40),
  });
  assert.equal(r.state, "mismatch");
  assert.match(r.detail, /aaaaaaaaaaaa/);
  assert.match(r.detail, /bbbbbbbbbbbb/);
});

test("engine: ok at pinned commit", () => {
  const c = "c".repeat(40);
  assert.equal(checkEngine({ engineDirName: "~/e", head: c, pinnedCommit: c }).state, "ok");
});

test("weights: dir present but no DiT manifest is resumable-missing", () => {
  const r = checkWeights({ weightsDirName: "~/m", ditManifest: null });
  assert.equal(r.state, "missing");
  assert.match(r.fix_hint, /resumable/i);
});

test("text encoder: size-match candidate is reported as candidate not ok", () => {
  const r = checkTextEncoder({ upstreamPresent: null, reuseCandidates: ["/x/text_encoder.safetensors"] });
  assert.equal(r.state, "missing");
  assert.match(r.detail, /sha256/);
});

test("disk: insufficient reports GB shortfall", () => {
  const r = checkDisk({ freeGB: 10, modelDirName: "~/m" });
  assert.equal(r.state, "too_low");
  assert.match(r.detail, /10 GB/);
});

test("overall: refused beats everything", () => {
  const checks = [
    { id: "platform", state: "refused" },
    { id: "memory", state: "ok" },
  ];
  assert.equal(overallOf(checks), "unsupported");
});

test("overall: any non-ok is setup_required", () => {
  const checks = [
    { id: "platform", state: "ok" },
    { id: "weights", state: "missing" },
  ];
  assert.equal(overallOf(checks), "setup_required");
});

test("overall: all ok is ready", () => {
  assert.equal(overallOf([{ id: "a", state: "ok" }]), "ready");
});

test("overall: warning-tier checks do not block ready (34GB Air regression)", () => {
  // A "32 GB" Apple machine reports 32 GiB; memoryGB must show 32, matching
  // the spec sheet, and it must land in the warning tier (floor 32, rec 48).
  const mem = checkMemory({ totalGB: memoryGB(34359738368) });
  assert.equal(mem.state, "too_low");
  assert.equal(mem.warning, true);
  assert.ok(mem.detail.startsWith("32 GB"), mem.detail);
  const checks = [
    { id: "platform", state: "ok" },
    mem,
    { id: "python", state: "ok" },
    { id: "engine", state: "ok" },
    { id: "weights", state: "ok" },
    { id: "text_encoder", state: "ok" },
    { id: "disk", state: "ok" },
  ];
  assert.equal(overallOf(checks), "ready");
});

test("overall: a real blocker alongside a warning still means setup_required", () => {
  const checks = [
    { id: "memory", state: "too_low", warning: true },
    { id: "weights", state: "missing" },
  ];
  assert.equal(overallOf(checks), "setup_required");
});

test("normalizeMirror: hf / legacy hf-mirror / custom https URL / invalid → hf", () => {
  assert.equal(normalizeMirror("hf"), "hf");
  assert.equal(normalizeMirror(undefined), "hf");
  assert.equal(normalizeMirror("hf-mirror"), "https://hf-mirror.com");
  assert.equal(normalizeMirror("https://mirror.example"), "https://mirror.example");
  assert.equal(normalizeMirror("http://insecure.example"), "hf"); // http is not accepted
  assert.equal(normalizeMirror("nonsense"), "hf");
  assert.equal(normalizeMirror(42), "hf");
});

test("resolveConfig carries the normalized mirror", () => {
  assert.equal(resolveConfig({ model_dir: "/tmp/m" }).mirror, "hf");
  assert.equal(resolveConfig({ model_dir: "/tmp/m", mirror: "hf-mirror" }).mirror, "https://hf-mirror.com");
  assert.equal(resolveConfig({ model_dir: "/tmp/m", mirror: "https://my.mirror/v1" }).mirror, "https://my.mirror/v1");
});
