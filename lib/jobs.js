/**
 * Long-task plumbing (design D4, PLAN M2): submit → job handle → poll →
 * recover, modelled on the async video-task pattern.
 *
 * Why a supervisor process: the plugin host can restart (DSH reload) while a
 * multi-hour download runs. A plain child would be reaped with its parent.
 * So each job is a DETACHED supervisor (`lib/job-supervisor.mjs`) that is its
 * own process-group leader, runs the job's command chain, appends all output
 * to a log file, and writes an atomic result file when the chain ends. The
 * plugin only ever reads files and probes pids — nothing to lose on restart.
 *
 * Job files live under `<model_dir>/h3-jobs/` (travels with the install,
 * visible to the user, deleted by nothing automatically):
 *   <id>.json           record (kind, pid, status, timestamps) — written at submit
 *   <id>.spec.json      the supervisor's input (command chain)
 *   <id>.log            stdout+stderr of every command, appended
 *   <id>.result.json    terminal verdict written by the supervisor
 *
 * Status vocabulary: running | done | failed | killed | interrupted.
 * `interrupted` = supervisor pid gone with no result file (reaped at plugin
 * activation or on the next poll) — never reported as completion.
 */
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const SUPERVISOR = join(fileURLToPath(new URL(".", import.meta.url)), "job-supervisor.mjs");

export const JOBS_SUBDIR = "h3-jobs";

export function jobsDir(modelDir) {
  return join(modelDir, JOBS_SUBDIR);
}

export function newJobId(kind) {
  const stamp = new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 14);
  return `${kind}-${stamp}-${randomBytes(3).toString("hex")}`;
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1) + "\n", "utf8");
  await rename(tmp, path);
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function paths(jDir, id) {
  return {
    record: join(jDir, `${id}.json`),
    spec: join(jDir, `${id}.spec.json`),
    log: join(jDir, `${id}.log`),
    result: join(jDir, `${id}.result.json`),
  };
}

/** Signal 0 probe: does this pid still exist (same user)? */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // exists, just not ours to signal
  }
}

/**
 * Submit a job: write spec + record, then spawn the detached supervisor.
 * `commands` is a chain [{ label, argv, cwd?, env? }] executed sequentially;
 * the first non-zero exit stops the chain. Returns the job id immediately —
 * the tool call itself never blocks on the work (D4).
 */
export async function submitJob({ modelDir, kind, commands, nodeBin = process.execPath, precomputedId = null }) {
  const jDir = jobsDir(modelDir);
  await mkdir(jDir, { recursive: true });
  const id = precomputedId ?? newJobId(kind);
  const p = paths(jDir, id);
  const spec = { id, commands, logPath: p.log, resultPath: p.result };
  await writeJsonAtomic(p.spec, spec);
  // Touch the log so poll has something to tail from t=0.
  await writeFile(p.log, "", { flag: "a" });
  const child = spawn(nodeBin, [SUPERVISOR, p.spec], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const record = {
    id,
    kind,
    pid: child.pid ?? null,
    status: "running",
    startedAt: new Date().toISOString(),
    commands: commands.map((c) => c.label),
  };
  await writeJsonAtomic(p.record, record);
  return { id, record };
}

/**
 * Resolve the TERMINAL status of a job from disk facts only (pure-ish; pid
 * probe injected). Never claims success without the supervisor's result file.
 */
export async function resolveStatus(jDir, id, { alive = pidAlive, readFileP = readFile } = {}) {
  const p = paths(jDir, id);
  const record = await readJsonSafe(p.record);
  if (record === null) return { status: "unknown", record: null };
  const result = await readJsonSafe(p.result);
  if (result !== null) {
    return { status: result.ok ? "done" : "failed", record, result };
  }
  if (record.status === "killed") return { status: "killed", record };
  if (record.status !== "running") return { status: record.status, record };
  if (record.pid !== null && alive(record.pid)) return { status: "running", record };
  // Supervisor gone without writing a verdict: interrupted, never "done".
  const patched = { ...record, status: "interrupted", interruptedAt: new Date().toISOString() };
  await writeJsonAtomic(p.record, patched).catch(() => {});
  return { status: "interrupted", record: patched };
}

/** Tail the last `maxBytes` of a job log (for poll responses). */
export async function tailLog(jDir, id, maxBytes = 2000, readFileP = readFile) {
  try {
    const buf = await readFileP(paths(jDir, id).log, "utf8");
    return buf.length <= maxBytes ? buf : buf.slice(-maxBytes);
  } catch {
    return "";
  }
}

/**
 * Parse progress out of the log tail. Contract lines (all flushed by the
 * emitters):
 *   `[n/12] fetching model-00003-of-00012.safetensors (5.55 GB)`   (engine fetch)
 *   `[n/12] converted model-00003-of-00012.safetensors: ...`       (engine fetch)
 *   `PACK OK -> ...`                                               (engine fetch, terminal)
 *   `[te n/9] fetched <name>` / `[te n/9] reused <name>`           (our TE driver)
 *   `TE OK`                                                        (TE driver, terminal)
 *   `== <label> ==`                                                (supervisor stage marker)
 */
export function parseProgress(logTail) {
  const out = { stage: null, shard_done: 0, shard_total: 12, current: null, te_done: 0, te_total: 9, pack_ok: false, te_ok: false };
  const stage = /== ([a-z0-9-]+) ==\s*$/gm.exec(logTail);
  if (stage) out.stage = stage[1];
  const totals = [...logTail.matchAll(/^\[(\d+)\/(\d+)\] (fetching|converted)/gm)];
  for (const m of totals) {
    out.shard_total = Math.max(out.shard_total, +m[2]);
    if (m[3] === "converted") out.shard_done = Math.max(out.shard_done, +m[1]);
    else out.current = +m[1];
  }
  const te = [...logTail.matchAll(/^\[te (\d+)\/(\d+)\] (fetched|reused)/gm)];
  for (const m of te) {
    out.te_total = Math.max(out.te_total, +m[2]);
    out.te_done = Math.max(out.te_done, +m[1]);
  }
  out.pack_ok = /^PACK OK/m.test(logTail);
  out.te_ok = /^TE OK/m.test(logTail);
  return out;
}

/** Poll = resolve status + progress + log tail in one shot. */
export async function pollJob(modelDir, id, deps = {}) {
  const jDir = jobsDir(modelDir);
  const resolved = await resolveStatus(jDir, id, deps);
  if (resolved.status === "unknown") {
    return { ok: false, error_type: "engine", message: `No job "${id}" in this install's job log.`, fix_hint: "List recent jobs via h3_setup action=status." };
  }
  const tail = await tailLog(jDir, id, deps.maxTailBytes ?? 2000, deps.readFileP);
  const progress = parseProgress(tail);
  const base = { ok: true, job_id: id, kind: resolved.record.kind, state: resolved.status, progress, log_tail: tail };
  if (resolved.status === "failed" && resolved.result) {
    base.error_type = resolved.result.error_type ?? "engine";
    base.message = resolved.result.message ?? `Job command "${resolved.result.failed_label}" exited ${resolved.result.exit_code}.`;
  }
  if (resolved.status === "interrupted") {
    base.message = "The job process ended without a verdict (host restart or external kill). Re-run the same action — finished work is skipped, unfinished work resumes.";
    base.error_type = "engine";
  }
  return base;
}

/** Kill a running job: SIGKILL the supervisor's whole process group. */
export async function killJob(modelDir, id, { kill = process.kill.bind(process) } = {}) {
  const jDir = jobsDir(modelDir);
  const record = await readJsonSafe(paths(jDir, id).record);
  if (record === null) return { ok: false, error_type: "engine", message: `No job "${id}".` };
  if (record.status !== "running") return { ok: true, job_id: id, message: `Job already ${record.status}; nothing to kill.` };
  try {
    if (record.pid) kill(-record.pid, "SIGKILL"); // detached pgid == pid
  } catch {
    /* group may already be gone */
  }
  const patched = { ...record, status: "killed", killedAt: new Date().toISOString() };
  await writeJsonAtomic(paths(jDir, id).record, patched);
  return { ok: true, job_id: id, message: "Job killed. Finished shards stay; re-run the action to resume." };
}

/**
 * Activation sweep: any record claiming `running` whose supervisor is gone
 * becomes `interrupted`. Active jobs are LEFT ALONE (a running download must
 * survive plugin reload — that is the whole point of the supervisor).
 */
export async function reapOrphans(modelDir, deps = {}) {
  const jDir = jobsDir(modelDir);
  let names;
  try {
    names = await readdir(jDir);
  } catch {
    return [];
  }
  const reaped = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".spec.json") || name.endsWith(".result.json")) continue;
    const id = name.slice(0, -".json".length);
    const resolved = await resolveStatus(jDir, id, deps);
    if (resolved.status === "interrupted") reaped.push(id);
  }
  return reaped;
}

/** List recent job records (newest first), for status output. */
export async function listJobs(modelDir, limit = 5) {
  const jDir = jobsDir(modelDir);
  let names;
  try {
    names = await readdir(jDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".spec.json") || name.endsWith(".result.json")) continue;
    const rec = await readJsonSafe(join(jDir, name));
    if (rec?.id) records.push(rec);
  }
  records.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  return records.slice(0, limit);
}

/**
 * Classify a failed job chain from the supervisor's captured tail. Same error
 * taxonomy as the rest of the plugin (ARCHITECTURE §6).
 */
export function classifySetupFailure(exitCode, tail = "") {
  const t = tail.toLowerCase();
  if (/enospc|no space left/.test(t)) return { error_type: "disk", message: `Out of disk space (exit ${exitCode}). Free space or move model_dir to a larger volume.` };
  if (/sha256|checksum|hash mismatch|size mismatch/.test(t)) return { error_type: "verify", message: `A downloaded file failed its sha256/size check (exit ${exitCode}). Re-run the action — the bad part file is removed and refetched.` };
  if (/license|gated|401|403|forbidden/.test(t)) return { error_type: "license", message: `The download was refused (license/gated repo, exit ${exitCode}). Check that the pinned repo is accessible from your network.` };
  if (/timeout|timed out|connection|network|temporary failure in name resolution|econn|remotedisconnect|incomplete read/.test(t)) return { error_type: "network", message: `Network failure during download (exit ${exitCode}). Re-run the action — finished shards are skipped and .part files resume.` };
  if (/memory|cannot allocate|bad_alloc/.test(t)) return { error_type: "memory", message: `Out of memory during conversion (exit ${exitCode}). Close other memory-heavy apps and re-run.` };
  return { error_type: "engine", message: `Setup command failed (exit ${exitCode}). See log_tail for the exact error.` };
}

/** Open helper for the supervisor's log handle (exported for symmetry/tests). */
export const openLog = (path) => open(path, "a");
