import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../lib/index.js";
import { statePath } from "../lib/state.js";

/** Register the plugin's tools against a scripted ctx; returns the tool map. */
async function boot(config, { workspace, saveImageFails = false } = {}) {
  const tools = new Map();
  const ctx = {
    effect: (fn) => {
      const r = fn();
      return typeof r === "function" ? r : () => {};
    },
    tools: { register: (def) => { tools.set(def.name, def); return { dispose() {} }; } },
    attachments: {
      saveImage: saveImageFails
        ? async () => { throw new Error("attachment store full"); }
        : async ({ data, name }) => ({
            attachmentId: "att-1", mediaType: "image/png", bytes: data.length,
            width: data.readUInt32BE(16), height: data.readUInt32BE(20), name,
          }),
    },
  };
  apply(ctx, config);
  return { tools, exec: { agent: { session: { header: { cwd: workspace } } } } };
}

test("h3_image refuses capability args explicitly, before schema noise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools, exec } = await boot({ model_dir: dir }, { workspace: dir });
  await assert.rejects(
    () => tools.get("h3_image").execute({ prompt: "x", reference_images: ["https://e/i.png"] }, exec),
    /not supported .*pure text-to-image/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("h3_image validates width/height pairing and 32-alignment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools, exec } = await boot({ model_dir: dir }, { workspace: dir });
  await assert.rejects(
    () => tools.get("h3_image").execute({ prompt: "x", width: 1024 }, exec),
    /supplied together/,
  );
  await assert.rejects(
    () => tools.get("h3_image").execute({ prompt: "x", width: 1000, height: 500 }, exec),
    /multiples of 32/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("h3_image fences output_dir outside the workspace before any spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools, exec } = await boot({ model_dir: dir }, { workspace: dir });
  await assert.rejects(
    () => tools.get("h3_image").execute({ prompt: "x", output_dir: "../escape" }, exec),
    /inside the session workspace/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("h3_image without a license record returns the license envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools, exec } = await boot({ model_dir: dir }, { workspace: dir });
  const r = await tools.get("h3_image").execute({ prompt: "x" }, exec);
  assert.equal(r.ok, false);
  assert.equal(r.error_type, "license");
  await rm(dir, { recursive: true, force: true });
});

test("h3_image with license but red environment returns the mapped red item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools, exec } = await boot({ model_dir: dir }, { workspace: dir });
  const setup = tools.get("h3_setup");
  const acc = await setup.execute({ action: "license", accept: true });
  assert.equal(acc.ok, true);
  // Environment is far from ready on a bare temp dir; the first red item
  // (weights or disk on this machine) must come back as a structured envelope.
  const r = await tools.get("h3_image").execute({ prompt: "x" }, exec);
  assert.equal(r.ok, false);
  assert.notEqual(r.error_type, "license");
  assert.ok(["engine", "verify", "disk", "memory", "unsupported_platform"].includes(r.error_type), r.error_type);
  assert.ok(r.fix_hint);
  await rm(dir, { recursive: true, force: true });
});

test("h3_setup license display/accept/reset round-trip is honest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools } = await boot({ model_dir: dir }, { workspace: dir });
  const setup = tools.get("h3_setup");
  const disp = await setup.execute({ action: "license" });
  assert.ok(disp.message.includes("Community License"));
  const acc = await setup.execute({ action: "license", accept: true });
  assert.equal(acc.ok, true);
  const again = await setup.execute({ action: "license" });
  assert.ok(again.message.includes("already accepted"));
  const reset = await setup.execute({ action: "reset" });
  assert.equal(reset.ok, true);
  const after = await setup.execute({ action: "license" });
  assert.ok(after.message.includes("Key points"));
  await rm(dir, { recursive: true, force: true });
});

test("h3_setup weights without license acceptance returns the license envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools } = await boot({ model_dir: dir }, { workspace: dir });
  const r = await tools.get("h3_setup").execute({ action: "weights" });
  assert.equal(r.ok, false);
  assert.equal(r.error_type, "license");
  await rm(dir, { recursive: true, force: true });
});

test("h3_setup poll without job_id is a structured engine error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools } = await boot({ model_dir: dir }, { workspace: dir });
  const r = await tools.get("h3_setup").execute({ action: "poll" });
  assert.equal(r.ok, false);
  assert.equal(r.error_type, "engine");
  assert.match(r.message, /job_id/);
  await rm(dir, { recursive: true, force: true });
});

test("h3_setup status returns the checklist plus job list and license line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools } = await boot({ model_dir: dir }, { workspace: dir });
  const r = await tools.get("h3_setup").execute({ action: "status" });
  assert.equal(r.ok, true);
  assert.ok(r.status && Array.isArray(r.status.checks));
  assert.ok(Array.isArray(r.jobs));
  assert.equal(r.license, null); // fresh dir: no record
  await rm(dir, { recursive: true, force: true });
});

test("h3_setup smoke preconditions gate before any job submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-tool-"));
  const { tools } = await boot({ model_dir: dir }, { workspace: dir });
  const r = await tools.get("h3_setup").execute({ action: "smoke" });
  assert.equal(r.ok, false);
  assert.ok(["engine", "verify"].includes(r.error_type), r.error_type);
  // No job may exist for a gated step.
  const st = await tools.get("h3_setup").execute({ action: "status" });
  assert.equal(st.jobs.length, 0);
  await rm(dir, { recursive: true, force: true });
});
