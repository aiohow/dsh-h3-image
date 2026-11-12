#!/usr/bin/env node
/**
 * Job supervisor — the detached keeper of one setup job.
 *
 * Spawned by lib/jobs.js as its own process-group leader (detached), it runs
 * the spec's command chain sequentially (no shell), appends every line of
 * stdout/stderr to the job log, and writes an atomic result file with the
 * terminal verdict. It deliberately knows NOTHING about the plugin host: if
 * DSH reloads, this process and its child keep running; if this process is
 * killed, the plugin's poll/reap path reports `interrupted`, never success.
 *
 * Usage: node job-supervisor.mjs <spec.json>
 * Spec:  { id, commands: [{ label, argv, cwd?, env? }], logPath, resultPath }
 */
import { spawn } from "node:child_process";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: job-supervisor.mjs <spec.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));

async function log(line) {
  try {
    await appendFile(spec.logPath, line);
  } catch {
    /* the log is best-effort; the result file is the contract */
  }
}

function runCommand(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd.argv[0], cmd.argv.slice(1), {
      cwd: cmd.cwd,
      env: { ...process.env, ...(cmd.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (b) => void log(b.toString()));
    child.stderr.on("data", (b) => void log(b.toString()));
    child.on("error", (error) => resolve({ code: -1, error: String(error?.message ?? error) }));
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal: signal ?? null }));
  });
}

async function writeResult(value) {
  const tmp = `${spec.resultPath}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1) + "\n", "utf8");
  await rename(tmp, spec.resultPath);
}

// Reap safety: if this supervisor is SIGKILLed the child would be orphaned
// under init. The plugin kills the whole GROUP (kill -pgid), so normal
// operation never orphans; nothing extra to do here beyond staying alive.
let outcome = { ok: true, exit_code: 0 };
for (const cmd of spec.commands) {
  await log(`\n== ${cmd.label} ==\n`);
  const res = await runCommand(cmd);
  if (res.code !== 0) {
    outcome = {
      ok: false,
      exit_code: res.code,
      signal: res.signal,
      failed_label: cmd.label,
      spawn_error: res.error,
      finishedAt: new Date().toISOString(),
    };
    break;
  }
}
outcome.finishedAt = new Date().toISOString();
try {
  await writeResult(outcome);
} catch {
  /* nowhere to report to; the plugin will see pid-gone + no result = interrupted */
}
process.exit(outcome.ok ? 0 : 1);
