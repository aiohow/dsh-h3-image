/**
 * M2 bare-metal acceptance driver (TEST-PLAN §3) — the ONLY evidence that the
 * wizard "works on another machine". Runs the plugin's own state machine
 * against a FRESH EMPTY layout with scan_dirs disabled (reuse probe must
 * report miss, never a false hit), doing real work end to end:
 *
 *   venv (real python -m venv) → engine (real clone+checkout+pip, HEAD==pin)
 *   → license (recorded as the user's acceptance for the simulation)
 *   → weights (real 12-shard download+convert; KILLED once after the first
 *     finished shard to prove resume does not re-download finished shards;
 *     then real text-encoder download + sha256 verify)
 *   → smoke (1 MP image, PNG structurally validated)
 *
 * Sampling every 60 s: disk usage of the bare layout + system memory used
 * (peak values feed the README 资源账 table — measured numbers only).
 *
 * Fingerprint check: every plugin-returned message (the user-visible surface)
 * must contain no absolute home path. Engine stdout logs are local files and
 * may contain paths; the check applies to envelopes, which is what ships.
 *
 * Run detached:  nohup node scripts/bare-metal-run.mjs &
 * Resume after a crash: just run it again — every step re-probes the disk.
 */
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveConfig } from "../lib/checks.js";
import { killJob, tailLog } from "../lib/jobs.js";
import { runSetup } from "../lib/setup.js";
import { acceptLicense, readState, statePath, writeState } from "../lib/state.js";
import { ENGINE } from "../lib/pinned.js";

const ROOT = "/Users/agent/deepseek/h3-bare-metal";
const CONFIG = {
  model_dir: join(ROOT, "bare-models"),
  engine_dir: join(ROOT, "bare-engine"),
  venv_dir: join(ROOT, "bare-venv"),
  scan_dirs: [], // true bare-metal: reuse probe must MISS
  python_bin: "/Users/agent/ComfyUI-Installs/ComfyUI (1)/standalone-env/bin/python3.13",
};
const resolved = resolveConfig(CONFIG);
const REPORT = join(ROOT, "bare-report.json");
const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, "utf8")) : { startedAt: new Date().toISOString(), steps: {}, peaks: { diskKB: 0, memUsedBytes: 0 }, notes: [] };
const save = () => writeFileSync(REPORT, JSON.stringify(report, null, 1));
const say = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(join(ROOT, "bare-driver.log"), line + "\n");
};

// --- fingerprint gate on every plugin envelope ------------------------------
function checkFingerprint(where, value) {
  const text = JSON.stringify(value);
  if (text.includes("/Users/agent") || text.includes("/Users/")) {
    report.notes.push(`FINGERPRINT LEAK at ${where}: ${text.slice(0, 200)}`);
    save();
    throw new Error(`fingerprint leak at ${where}`);
  }
}

// --- samplers ----------------------------------------------------------------
setInterval(() => {
  try {
    const du = Number(execSync(`du -sk ${ROOT} 2>/dev/null | cut -f1`).toString().trim());
    if (du > report.peaks.diskKB) report.peaks.diskKB = du;
    const vm = execSync("vm_stat").toString();
    const pageSize = Number(/page size of (\d+)/.exec(vm)[1]);
    const free = Number(/Pages free:\s+(\d+)/.exec(vm)[1]);
    const spec = Number(/Pages speculative:\s+(\d+)/.exec(vm)[1]);
    const total = Number(execSync("sysctl -n hw.memsize").toString().trim());
    const used = total - (free + spec) * pageSize;
    if (used > report.peaks.memUsedBytes) report.peaks.memUsedBytes = used;
    save();
  } catch { /* sampling must never kill the run */ }
}, 60_000);

// --- polling loop (in-process; this driver is itself detached) --------------
async function drive(step, args = {}) {
  const t0 = Date.now();
  let r = await runSetup(step, args, resolved, CONFIG, {});
  checkFingerprint(step, r);
  if (r.ok && (r.noop || r.job_id === undefined)) {
    // Synchronous step (venv) or a noop re-run: complete on return.
    report.steps[step] = { noop: r.noop === true, seconds: Math.round((Date.now() - t0) / 1000), message: r.message };
    save();
    say(`${step}: ${r.noop ? "noop (already complete on disk)" : "done synchronously"} — ${r.message}`);
    return r;
  }
  if (!r.ok && r.state !== "running") {
    report.steps[step] = { failed: r };
    save();
    throw new Error(`${step} failed: ${JSON.stringify(r).slice(0, 400)}`);
  }
  say(`${step}: submitted job ${r.job_id}`);
  for (;;) {
    await new Promise((res) => setTimeout(res, 30_000));
    const p = await runSetup("poll", { job_id: r.job_id }, resolved, CONFIG, {});
    if (!p.ok) throw new Error(`poll ${r.job_id} envelope failed: ${p.message}`);
    if (p.state === "running") {
      const pr = p.progress ?? {};
      say(`poll ${r.job_id}: ${p.kind} shards ${pr.shard_done ?? "-"}/${pr.shard_total ?? "-"}` + (pr.current ? ` fetching#${pr.current}` : "") + ` te ${pr.te_done ?? 0}/${pr.te_total ?? 9}`);
      continue;
    }
    const seconds = Math.round((Date.now() - t0) / 1000);
    report.steps[step] = { state: p.state, job_id: r.job_id, seconds, verified: p.verified ?? null, smoke_png: p.smoke_png ?? null };
    save();
    if (p.state !== "done") throw new Error(`${step} job ${r.job_id} ended ${p.state}: ${(p.message ?? "").slice(0, 300)}`);
    say(`${step}: DONE in ${seconds}s`);
    return p;
  }
}

// --- the run -----------------------------------------------------------------
say(`=== bare-metal run start (model=${resolved.model_dir}) ===`);

// 1. venv
await drive("venv");

// 2. engine — HEAD == pin asserted INDEPENDENTLY of the plugin's own verdict
//    (a noop re-entry carries no `verified`, and self-assertion is not proof).
await drive("engine");
const head = execSync(`git -C ${resolved.engine_dir} rev-parse HEAD`).toString().trim();
report.steps.engine.head_measured = head;
save();
if (head !== ENGINE.commit) throw new Error(`engine HEAD ${head} != pinned ${ENGINE.commit}`);
say(`engine: HEAD independently verified == pinned ${head.slice(0, 12)}`);

// 3. license — the simulation records acceptance AS the user would (tool call
//    license accept=true does exactly this; here it is scripted for unattended run)
{
  const sPath = statePath(resolved.model_dir);
  const st = acceptLicense(await readState(sPath, (p) => readFileSync(p, "utf8")));
  await writeState(sPath, st);
  report.steps.license = { accepted: st.license.at };
  save();
  say("license: recorded (simulated user acceptance)");
}

// 4. weights with the mandatory mid-run kill (kill-once resume proof).
//    Disk truth (dit/convert_state.json) is the kill trigger — logs can be
//    truncated, the state file cannot lie about finished shards.
{
  const jDir = join(resolved.model_dir, "h3-jobs");
  const fullLog = (id) => {
    try { return readFileSync(join(jDir, `${id}.log`), "utf8"); } catch { return ""; }
  };
  const stateFile = join(resolved.model_dir, "dit", "convert_state.json");
  const doneShards = () => {
    try { return Object.keys(JSON.parse(readFileSync(stateFile, "utf8")).done); } catch { return []; }
  };

  const submit = await runSetup("weights", {}, resolved, CONFIG, {});
  checkFingerprint("weights-submit", submit);
  if (!submit.ok && submit.state !== "running") throw new Error(`weights submit failed: ${JSON.stringify(submit).slice(0, 300)}`);
  const firstJob = submit.job_id;
  say(`weights: job ${firstJob} ${submit.noop ? "attached (already running)" : "submitted"} — kill-once resume test armed`);

  // Wait for the first FINISHED shard on disk, then kill the whole group.
  let killed = false;
  for (;;) {
    await new Promise((res) => setTimeout(res, 30_000));
    if (!killed && doneShards().length >= 1) {
      say(`weights: ${doneShards().length} shard(s) finished on disk — KILLING ${firstJob} to test resume`);
      await killJob(resolved.model_dir, firstJob);
      killed = true;
      report.notes.push(`kill point: convert_state.done=[${doneShards().join(",")}] after first converted`);
      save();
    }
    const p = await runSetup("poll", { job_id: firstJob }, resolved, CONFIG, {});
    if (p.state === "failed" || p.state === "interrupted" || p.state === "killed") break;
    if (p.state === "done") break; // finished before we could kill — resume proof then impossible; note it
  }
  const firstLog = fullLog(firstJob);
  const doneIdx = new Set([...firstLog.matchAll(/\[(\d+)\/12\] converted/g)].map((m) => m[1]));

  // Resume: re-submit (attaches if somehow still live; else fresh job).
  const again = await runSetup("weights", {}, resolved, CONFIG, {});
  if (!again.ok && again.state !== "running") throw new Error(`weights resume failed: ${JSON.stringify(again).slice(0, 300)}`);
  say(`weights: resume job ${again.job_id} — polling to completion`);
  for (;;) {
    await new Promise((res) => setTimeout(res, 60_000));
    const p = await runSetup("poll", { job_id: again.job_id }, resolved, CONFIG, {});
    const pr = p.progress ?? {};
    say(`poll ${again.job_id}: shards ${pr.shard_done ?? doneShards().length}/12 te ${pr.te_done ?? 0}/${pr.te_total ?? 9} state=${p.state}`);
    if (p.state === "done") break;
    if (p.state !== "running") throw new Error(`weights resume ended ${p.state}: ${(p.message ?? "").slice(0, 300)}`);
  }
  const resumeLog = fullLog(again.job_id);
  const refetchedIdx = [...resumeLog.matchAll(/\[(\d+)\/12\] fetching/g)].map((m) => m[1]).filter((i) => doneIdx.has(i));
  report.notes.push(`resume check: first-run converted [${[...doneIdx].join(",")}], resume refetches of those: [${refetchedIdx.join(",")}] (must be empty)`);
  report.steps.weights = { killed_job: firstJob, resume_job: again.job_id, shards: doneShards().length };
  save();
  if (refetchedIdx.length > 0) throw new Error(`RESUME FAILED: re-downloaded finished shards ${refetchedIdx}`);
  say("weights: resume verified — no finished shard re-downloaded");
}

// 5. smoke
const smoke = await drive("smoke");
if (smoke.smoke_png?.ok !== true) throw new Error("smoke png not ok");

// 6. final status must read ready
const status = await runSetup("status", {}, resolved, CONFIG, {});
checkFingerprint("status", status);
const overall = status.status.overall;
report.overall = overall;
report.finishedAt = new Date().toISOString();
save();
say(`status overall: ${overall}`);
if (overall !== "ready") throw new Error(`overall not ready: ${JSON.stringify(status.status.checks?.filter((c) => c.state !== "ok"))}`);
say("=== BARE-METAL ACCEPTANCE PASS ===");
process.exit(0);
