#!/usr/bin/env node
/**
 * L3 live acceptance driver (TEST-PLAN §3): drives the REAL registered tools
 * through a scripted ctx (no DSH host needed), against real assets. Paths come
 * from env so nothing machine-specific is committed.
 *
 *   H3_MODEL_DIR=... H3_ENGINE_DIR=... H3_VENV_DIR=... H3_TEXT_DIR=... \
 *   H3_TEXT_CONFIG=... H3_WORKSPACE=... node scripts/accept-live.mjs
 *
 * Sequence (each step prints one verdict line):
 *   1. h3_image BEFORE any license record  -> structured license envelope (no crash)
 *   2. h3_setup license (display)          -> summary
 *   3. h3_setup license accept=true        -> record written
 *   4. h3_image 4MP 16:9 seed 88           -> success value + render nameplate
 *   5. workspace fence                     -> escape refused
 *   6. refused capability arg              -> explicit refusal
 * The PNG itself is decoded/compared OUTSIDE this driver (sips + metrics diff).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { apply } from "../lib/index.js";

const env = process.env;
for (const k of ["H3_MODEL_DIR", "H3_ENGINE_DIR", "H3_VENV_DIR", "H3_TEXT_DIR", "H3_TEXT_CONFIG", "H3_WORKSPACE"]) {
  if (!env[k]) throw new Error(`missing env ${k}`);
}
const config = {
  model_dir: env.H3_MODEL_DIR,
  engine_dir: env.H3_ENGINE_DIR,
  venv_dir: env.H3_VENV_DIR,
  text_dir: env.H3_TEXT_DIR,
  text_config: env.H3_TEXT_CONFIG,
};
const workspace = env.H3_WORKSPACE;
const exec = { agent: { session: { header: { cwd: workspace } } } };

const tools = new Map();
const disposers = [];
apply(
  {
    effect: (fn) => {
      const r = fn();
      if (typeof r === "function") disposers.push(r);
      return () => {};
    },
    tools: { register: (def) => { tools.set(def.name, def); return { dispose() {} }; } },
    attachments: {
      saveImage: async ({ data, mediaType, name }) => {
        const dir = join(workspace, "attachments");
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), data);
        return {
          attachmentId: `att-${name}`,
          mediaType,
          bytes: data.length,
          width: Number(env.__FAKE_W ?? 0) || readPngW(data),
          height: Number(env.__FAKE_H ?? 0) || readPngH(data),
          name,
        };
      },
    },
  },
  config,
);

function readPngW(b) { return b.readUInt32BE(16); }
function readPngH(b) { return b.readUInt32BE(20); }

const step = (n, msg) => console.log(`[${n}] ${msg}`);

// 0. ensure no stale record exists (idempotent reruns)
await tools.get("h3_setup").execute({ action: "reset" });

// 1. license negative — before any record exists
const img = tools.get("h3_image");
const neg = await img.execute({ prompt: "acceptance probe" }, exec);
step("license-negative", neg.ok === false && neg.error_type === "license" ? "PASS structured license envelope" : `FAIL ${JSON.stringify(neg)}`);
if (neg.ok !== false) process.exit(1);

// 2/3. license display + explicit acceptance
const setup = tools.get("h3_setup");
const disp = await setup.execute({ action: "license" });
step("license-display", disp.ok === true && disp.message.includes("Community License") ? "PASS summary shown" : `FAIL ${disp.message}`);
const acc = await setup.execute({ action: "license", accept: true });
step("license-accept", acc.ok === true ? "PASS record written" : `FAIL ${acc.message}`);

// 5. workspace fence (cheap, before the expensive run)
let fence = "FAIL no throw";
try {
  await img.execute({ prompt: "x", output_dir: "../escape" }, exec);
} catch (error) {
  fence = String(error?.message).includes("workspace") ? "PASS refused" : `FAIL ${error?.message}`;
}
step("fence", fence);

// 6. capability refusal
let refused = "FAIL no throw";
try {
  await img.execute({ prompt: "x", reference_images: ["https://x/y.png"] }, exec);
} catch (error) {
  refused = String(error?.message).includes("text-to-image") ? "PASS refused explicitly" : `FAIL ${error?.message}`;
}
step("refused-arg", refused);

// 4. the real generation
const t0 = Date.now();
const res = await img.execute(
  { prompt: "a capybara wearing a tiny astronaut helmet, studio product photo", aspect: "16:9", mp: 4, seed: 88, timeout_seconds: 600 },
  exec,
);
const wall = ((Date.now() - t0) / 1000).toFixed(1);
if (res.ok !== true) {
  step("generate", `FAIL ${JSON.stringify(res)}`);
  process.exit(1);
}
step("generate", `PASS wall=${wall}s metrics_total=${res.seconds}s canvas=${res.canvas} seed=${res.seed} peak=${res.peak_gb}GB saved=${res.saved} path=${res.path}`);
const rendered = img.output.render({}, res);
step("render", rendered[0].text.split("\n")[0]);
console.log(`[png] ${join(workspace, "attachments", res.image.name)}`);
console.log(`[metrics-path] kept in tmpdir next to run`);
for (const d of disposers) d();
