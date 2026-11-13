import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { killJob, parseProgress, pidAlive, pollJob, reapOrphans, resolveStatus, submitJob, tailLog } from "../lib/jobs.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTerminal(modelDir, id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await resolveStatus(join(modelDir, "h3-jobs"), id);
    if (r.status !== "running") return r;
    if (Date.now() > deadline) throw new Error(`job ${id} still running after ${timeoutMs} ms`);
    await sleep(100);
  }
}

test("submitJob → supervisor → done: exit 0 chain writes result and log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const { id } = await submitJob({
    modelDir: dir,
    kind: "engine",
    commands: [{ label: "echo", argv: [process.execPath, "-e", "console.log('hello from job')"] }],
  });
  const resolved = await waitForTerminal(dir, id);
  assert.equal(resolved.status, "done");
  const tail = await tailLog(join(dir, "h3-jobs"), id);
  assert.match(tail, /hello from job/);
  assert.match(tail, /== echo ==/);
  await rm(dir, { recursive: true, force: true });
});

test("failed chain: first non-zero stops the chain and records the label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const { id } = await submitJob({
    modelDir: dir,
    kind: "engine",
    commands: [
      { label: "first", argv: [process.execPath, "-e", "console.log('one')"] },
      { label: "boom", argv: [process.execPath, "-e", "console.error('disk on fire'); process.exit(3)"] },
      { label: "never", argv: [process.execPath, "-e", "console.log('never runs')"] },
    ],
  });
  const resolved = await waitForTerminal(dir, id);
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.result.failed_label, "boom");
  assert.equal(resolved.result.exit_code, 3);
  const tail = await tailLog(join(dir, "h3-jobs"), id);
  assert.match(tail, /disk on fire/);
  assert.doesNotMatch(tail, /never runs/);
  await rm(dir, { recursive: true, force: true });
});

test("interrupted: supervisor gone with no result never reads as done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const jDir = join(dir, "h3-jobs");
  await mkdir(jDir, { recursive: true });
  const id = "fake-1";
  await writeFile(join(jDir, `${id}.json`), JSON.stringify({ id, kind: "weights", pid: 999_999, status: "running", startedAt: "x", commands: [] }));
  const resolved = await resolveStatus(jDir, id, { alive: () => false });
  assert.equal(resolved.status, "interrupted");
  // The patched record persists the truth for later polls.
  const again = JSON.parse(await readFile(join(jDir, `${id}.json`), "utf8"));
  assert.equal(again.status, "interrupted");
  await rm(dir, { recursive: true, force: true });
});

test("killJob stops a running job and finished shards survive on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const marker = join(dir, "shard1.done");
  const { id } = await submitJob({
    modelDir: dir,
    kind: "weights",
    commands: [{
      label: "slow",
      // writes a "finished shard", then sleeps forever — kill must not undo the shard
      argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'shard'); setInterval(()=>{},1000)`],
    }],
  });
  // Wait for the shard marker to appear (job really started).
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await readFile(marker); break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error("job never started");
    await sleep(100);
  }
  const killed = await killJob(dir, id);
  assert.equal(killed.ok, true);
  const resolved = await waitForTerminal(dir, id);
  assert.equal(resolved.status, "killed");
  // The finished work survives the kill — that is the resume contract.
  assert.equal((await readFile(marker, "utf8")), "shard");
  await rm(dir, { recursive: true, force: true });
});

test("reapOrphans marks dead running jobs interrupted and leaves live ones alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const jDir = join(dir, "h3-jobs");
  await mkdir(jDir, { recursive: true });
  await writeFile(join(jDir, "dead.json"), JSON.stringify({ id: "dead", kind: "weights", pid: 999_999, status: "running", startedAt: "x" }));
  await writeFile(join(jDir, "live.json"), JSON.stringify({ id: "live", kind: "weights", pid: process.pid, status: "running", startedAt: "y" }));
  const reaped = await reapOrphans(dir, { alive: (pid) => pid === process.pid });
  assert.deepEqual(reaped, ["dead"]);
  const live = JSON.parse(await readFile(join(jDir, "live.json"), "utf8"));
  assert.equal(live.status, "running"); // untouched — a running download survives reload
  await rm(dir, { recursive: true, force: true });
});

test("pollJob on unknown id is a structured miss, not a throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "h3-jobs-"));
  const r = await pollJob(dir, "nope-1");
  assert.equal(r.ok, false);
  assert.match(r.message, /No job/);
  await rm(dir, { recursive: true, force: true });
});

test("parseProgress reads the engine fetch + TE driver contract", () => {
  const log = [
    "== weights-fetch ==",
    "small files fetched",
    "[1/12] fetching model-00001-of-00012.safetensors (5.55 GB)",
    "[1/12] converted model-00001-of-00012.safetensors: 120 tensors, 1.39 GB, adaln blocks ['0']..['3']",
    "[2/12] fetching model-00002-of-00012.safetensors (5.55 GB)",
    "[2/12] converted model-00002-of-00012.safetensors: 120 tensors, 1.39 GB, adaln blocks ['4']..['7']",
    "[3/12] fetching model-00003-of-00012.safetensors (5.55 GB)",
  ].join("\n");
  const p = parseProgress(log);
  assert.equal(p.shard_done, 2);
  assert.equal(p.shard_total, 12);
  assert.equal(p.current, 3);
  assert.equal(p.pack_ok, false);
  assert.equal(p.stage, "weights-fetch");
  const done = parseProgress("[12/12] converted x\nPACK OK -> /tmp/dit\n[te 1/9] fetched text_encoder.safetensors\n[te 9/9] fetched MODIFICATIONS.md\nTE OK");
  assert.equal(done.shard_done, 12);
  assert.equal(done.pack_ok, true);
  assert.equal(done.te_done, 9);
  assert.equal(done.te_ok, true);
});

test("parseProgress counts staging lines only when a mirror run staged files", () => {
  const plain = parseProgress("== weights-fetch ==\n[1/12] fetching x\n");
  assert.equal(plain.stage_done, undefined);
  assert.equal(plain.stage_total, undefined);
  const staged = parseProgress(
    "== stage ==\n[stage 1/20] skipped LICENSE (already present)\n[stage 2/20] placed model_index.json\n[stage 20/20] placed model-00012-of-00012.safetensors\nSTAGE OK\n== weights-fetch ==\n",
  );
  assert.equal(staged.stage_done, 20);
  assert.equal(staged.stage_total, 20);
});

test("pidAlive: our own pid true, absurd pid false", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(999_999), false);
  assert.equal(pidAlive(null), false);
});
