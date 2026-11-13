/**
 * Setup state machine (PLAN M2): check → venv → engine → license → weights →
 * smoke. Every step is REENTRANT: it re-probes the disk as the truth and
 * treats the state file only as a record, so a re-run after a crash, a reload
 * or a wrong turn never redoes finished work.
 *
 * Step costs decide the execution model (design D4):
 *   venv    — seconds (create the environment only)      → synchronous
 *   engine  — minutes (clone + checkout + pip install)   → background job
 *   license — instant (display / accept, M1 code in index.js)
 *   weights — hours (12 shards + text encoder)           → background job
 *   smoke   — minutes (first model load + 1 MP image)    → background job
 * Long steps return { job_id, next: "poll" } in seconds; progress comes from
 * the job log (lib/jobs.js parseProgress), never from trusting an exit code —
 * poll additionally re-verifies the on-disk result (HEAD, manifest, PNG).
 *
 * Order note (measured, not assumed): the engine's dependency list lives in
 * its own requirements.txt, so the venv is created first and dependencies are
 * installed at the END of the engine step (clone → checkout → pip install).
 *
 * Reuse (design D3): a size-matching text-encoder candidate is only a
 * CANDIDATE; the weights job hashes it (streaming sha256) and reuses it — by
 * symlink, never by copy — only on an exact digest match. No match → download
 * from the pinned revision. A size match alone never authorizes reuse.
 *
 * Mirror honesty (documented in README): `mirror: "hf-mirror"` redirects the
 * text-encoder download (hf_hub_download honors HF_ENDPOINT). The main
 * weights come from the engine's own fetch script whose URL is hardcoded —
 * patching the pinned engine is out of scope (design D1), so the mirror
 * option never claims to cover the main weights.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  displayPath,
  envelope,
  probeDir,
  probeFile,
  probeFreeGB,
  probeGitHead,
  probeTextEncoderReuse,
  probeVenvPython,
  runStatus,
} from "./checks.js";
import { findRunningJob, killJob, listJobs, newJobId, pollJob, submitJob } from "./jobs.js";
import { ENGINE, LIMITS, TEXT_ENCODER_PACKAGE, TEXT_ENCODER_REUSE, UPSTREAM_META } from "./pinned.js";
import { pngInfo } from "./runner.js";
import { licenseGate, readState, statePath, writeState } from "./state.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Interpreter discovery (PLAN M2 "解释器发现")
// ---------------------------------------------------------------------------

/** Pure: "3.13.12" vs [3,13] → ok / too_old / invalid. */
export function evaluateInterpreterVersion(version, [minMajor, minMinor] = ENGINE.pythonMin) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(version).trim());
  if (!m) return { ok: false, verdict: "invalid" };
  const [major, minor] = [+m[1], +m[2]];
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return { ok: true, verdict: "ok", major, minor };
  return { ok: false, verdict: "too_old", major, minor };
}

/**
 * Candidate interpreter locations, in probe order. Machine-specific paths
 * appear only as RELATIVE-to-$HOME patterns or standard system prefixes —
 * never a literal home path (design D6). `config.python_bin` overrides all.
 */
export function interpreterCandidates(config = {}, home = homedir()) {
  const out = [];
  if (typeof config.python_bin === "string" && config.python_bin !== "") out.push({ source: "config", bin: config.python_bin });
  for (const name of ["python3.14", "python3.13"]) out.push({ source: "PATH", bin: name });
  for (const p of [
    "/opt/homebrew/bin/python3.14", "/opt/homebrew/bin/python3.13",
    "/usr/local/bin/python3.14", "/usr/local/bin/python3.13",
  ]) out.push({ source: "brew", bin: p });
  for (const v of ["3.14", "3.13"]) out.push({ source: "python.org", bin: `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3` });
  out.push({ source: "uv", bin: null }); // resolved via `uv python find`
  out.push({ source: "pyenv", bin: null }); // resolved via readdir under $HOME
  return out;
}

/**
 * Probe candidates until one reports >= pythonMin. Returns { bin, version,
 * source } or an error envelope. All I/O injected for tests.
 */
export async function discoverInterpreter(config = {}, deps = {}) {
  const home = deps.home ?? homedir();
  const exec = deps.exec ?? execFileP;
  const readdirP = deps.readdir ?? readdir;
  const versionOf = async (bin) => {
    try {
      const { stdout } = await exec(bin, ["-c", "import sys;print('.'.join(map(str, sys.version_info[:3])))"], { timeout: 15_000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const tried = new Set();
  for (const cand of interpreterCandidates(config, home)) {
    let bins = [];
    if (cand.source === "uv") {
      tried.add("uv");
      try {
        const { stdout } = await exec("uv", ["python", "find", "3.13"], { timeout: 15_000 });
        bins = [stdout.trim()];
      } catch { bins = []; }
    } else if (cand.source === "pyenv") {
      tried.add("pyenv");
      try {
        const versions = await readdirP(join(home, ".pyenv", "versions"));
        bins = versions.filter((v) => /^3\.1[34]/.test(v)).map((v) => join(home, ".pyenv", "versions", v, "bin", "python3"));
      } catch { bins = []; }
    } else {
      tried.add(cand.source);
      bins = [cand.bin];
    }
    for (const bin of bins) {
      if (typeof bin !== "string" || bin === "") continue;
      const version = await versionOf(bin);
      if (version === null) continue;
      if (evaluateInterpreterVersion(version).ok) return { bin, version, source: cand.source };
    }
  }
  return envelope(
    "engine",
    `No CPython >= ${ENGINE.pythonMin.join(".")} found (searched: ${[...tried].join(", ") || "nothing"}).`,
    "Install one — e.g. `brew install python@3.13`, the python.org installer, `uv python install 3.13`, or set python_bin in the plugin config to an existing interpreter.",
  );
}

// ---------------------------------------------------------------------------
// Step plans (pure decision cores; unit-testable without a machine)
// ---------------------------------------------------------------------------

/** venv step: create / already good / broken. */
export function planVenv({ python }) {
  if (python === null) return { action: "create" };
  if (python.broken) return { action: "replace", reason: "interpreter inside venv does not run" };
  const [minMajor, minMinor] = ENGINE.pythonMin;
  if (python.major < minMajor || (python.major === minMajor && python.minor < minMinor)) {
    return { action: "replace", reason: `venv python ${python.major}.${python.minor} < ${minMajor}.${minMinor}` };
  }
  return { action: "ok", python };
}

/** engine step chain: clone / checkout-pinned / pip-install as needed. */
export function planEngine({ exists, head, pinnedCommit, depsRecorded, venvBin }) {
  if (!exists) return { action: "run", steps: ["clone", "checkout", "pip"], venvBin };
  if (head === null) return { action: "not-a-checkout" };
  const steps = [];
  if (head !== pinnedCommit) steps.push("checkout");
  if (!depsRecorded) steps.push("pip");
  if (steps.length === 0) return { action: "ok", head };
  return { action: "run", steps, venvBin };
}

/** weights step preconditions (pure). */
export function planWeights({ licenseAccepted, memoryGB, freeGB, diskMinGB, ditComplete, teComplete, riskConfirmed }) {
  if (!licenseAccepted) {
    return { block: envelope("license", "Weights download requires YOUR license acceptance first.", "h3_setup action=license accept=true after reading the agreement.") };
  }
  if (memoryGB !== null && memoryGB < LIMITS.memoryFloorGB) {
    return { block: envelope("memory", `${memoryGB.toFixed(0)} GB unified memory is below the ${LIMITS.memoryFloorGB} GB hard floor; conversion will OOM.`, "Use a machine with more unified memory.") };
  }
  if (freeGB !== null && freeGB < diskMinGB) {
    return { block: envelope("disk", `${freeGB.toFixed(0)} GB free is below the ${diskMinGB} GB the download + conversion peak needs.`, "Free space or point model_dir at a larger volume.") };
  }
  const riskWarning = memoryGB !== null && memoryGB >= LIMITS.memoryFloorGB && memoryGB < LIMITS.memoryRecommendedGB;
  if (riskWarning && !riskConfirmed) {
    return {
      block: envelope(
        "memory",
        `${memoryGB.toFixed(0)} GB unified memory: workable but NOT guaranteed (recommended ${LIMITS.memoryRecommendedGB} GB+).`,
        "Re-run with confirm_risk=true to acknowledge this machine is below the recommended memory.",
      ),
    };
  }
  return { block: null, alreadyComplete: ditComplete && teComplete, riskWarning };
}

// ---------------------------------------------------------------------------
// Command builders (absolute paths live ONLY here; messages use displayPath)
// ---------------------------------------------------------------------------

function teDriverPath() {
  return join(import.meta.dirname, "..", "assets", "te_setup.py");
}

/** Engine fetch chain for the weights job (resumable by the engine itself). */
export function buildWeightsCommands({ resolved, venvBin, mirror }) {
  return [
    {
      label: "weights-fetch",
      argv: [venvBin, join(resolved.engine_dir, "scripts", "fetch_h3_image.py"), "--dir", resolved.model_dir, "--accepted"],
    },
    {
      label: "text-encoder",
      argv: [
        venvBin,
        teDriverPath(),
        "--dest", resolved.text_dir,
        "--meta-dest", join(resolved.model_dir, "upstream-meta"),
        "--repo", TEXT_ENCODER_PACKAGE.repo,
        "--revision", TEXT_ENCODER_PACKAGE.revision,
        "--files", TEXT_ENCODER_PACKAGE.files.join(","),
        "--main-file", "text_encoder.safetensors",
        "--sha256", TEXT_ENCODER_PACKAGE.mainSha256,
        "--bytes", String(TEXT_ENCODER_PACKAGE.mainBytes),
        "--meta-repo", UPSTREAM_META.repo,
        "--meta-revision", UPSTREAM_META.revision,
        "--meta-files", UPSTREAM_META.files.join(","),
        "--candidates-file", join(resolved.model_dir, "h3-jobs", "reuse-candidates.txt"),
      ],
      // hf-mirror only ever touches THIS command (hf_hub_download honours
      // HF_ENDPOINT); the default carries no env override at all.
      ...(mirror === "hf-mirror" ? { env: { HF_ENDPOINT: "https://hf-mirror.com" } } : {}),
    },
  ];
}

/** Smoke chain: one 1 MP image into the job area, metrics beside it. */
export function buildSmokeCommands({ resolved, venvBin, jobId }) {
  const outPath = join(resolved.model_dir, "h3-jobs", `${jobId}.png`);
  const commands = [
    {
      label: "smoke",
      argv: [
        venvBin,
        join(resolved.engine_dir, "scripts", "generate_h3_image.py"),
        "a small blue circle on a plain white background, minimal",
        "--root", resolved.model_dir,
        "--text-dir", resolved.text_dir,
        "--text-config", resolved.text_config,
        "-o", outPath,
        "--mp", "1",
        "--seed", "7",
        "--no-canvas",
        "--metrics", join(resolved.model_dir, "h3-jobs", `${jobId}.metrics.json`),
      ],
    },
  ];
  return { outPath, commands };
}

// ---------------------------------------------------------------------------
// Step implementations (I/O wrappers around the plans)
// ---------------------------------------------------------------------------

async function stepVenv(resolved, config, deps) {
  const exec = deps.exec ?? execFileP;
  const python = await probeVenvPython(resolved.venv_dir, exec);
  const plan = planVenv({ python });
  if (plan.action === "ok") {
    return { ok: true, stage: "venv", message: `venv already good (Python ${plan.python.major}.${plan.python.minor} at ${displayPath(resolved.venv_dir)}).`, noop: true, next: "engine" };
  }
  if (plan.action === "replace") {
    return envelope("engine", `Existing venv unusable: ${plan.reason}.`, `Delete ${displayPath(resolved.venv_dir)} and re-run h3_setup action=venv (the wizard never deletes directories on its own).`);
  }
  const found = await discoverInterpreter(config, deps);
  if (found.ok === false) return found;
  try {
    await exec(found.bin, ["-m", "venv", resolved.venv_dir], { timeout: 180_000 });
  } catch (error) {
    return envelope("engine", `venv creation failed: ${String(error?.message ?? error).slice(0, 200)}`, "Check the target directory is writable, or point venv_dir elsewhere.");
  }
  const after = await probeVenvPython(resolved.venv_dir, exec);
  if (after === null || after.broken) {
    return envelope("engine", "venv was created but its interpreter does not run.", "Delete the venv directory and retry.");
  }
  return {
    ok: true,
    stage: "venv",
    message: `venv created at ${displayPath(resolved.venv_dir)} (Python ${after.major}.${after.minor}, base: ${found.source}).`,
    next: "engine",
  };
}

async function stepEngine(resolved, state, deps) {
  const exec = deps.exec ?? execFileP;
  // Re-entrancy: a live engine job means work is already in flight — attach.
  const live = await findRunningJob(resolved.model_dir, "engine", deps);
  if (live) {
    return { ok: true, stage: "engine", state: "running", job_id: live.id, next: "poll", message: `Engine job ${live.id} is already running — attached instead of double-submitting.` };
  }
  const exists = await probeDir(resolved.engine_dir);
  const head = exists ? await probeGitHead(resolved.engine_dir, exec) : null;
  const venvPy = await probeVenvPython(resolved.venv_dir, exec);
  const depsRecorded = state?.setup?.engine?.depsInstalled === true;
  const plan = planEngine({ exists: exists !== null, head, pinnedCommit: ENGINE.commit, depsRecorded, venvBin: venvPy?.bin ?? null });
  if (plan.action === "ok") {
    return { ok: true, stage: "engine", message: `Engine already at pinned commit ${String(head).slice(0, 12)} with dependencies recorded.`, noop: true, next: "license" };
  }
  if (plan.action === "not-a-checkout") {
    return envelope("engine", "engine_dir exists but is not a git checkout.", `Remove ${displayPath(resolved.engine_dir)} and re-run h3_setup action=engine.`);
  }
  if (plan.steps.includes("pip") && plan.venvBin === null) {
    return envelope("engine", "Dependencies need a working venv first.", "Run h3_setup action=venv.");
  }
  const commands = [];
  if (plan.steps.includes("clone")) {
    // Full clone (all branch refs) without touching the worktree: the pinned
    // commit lives on a release branch, NOT main (measured: it is reachable
    // from refs/heads/phosphene/v5.0-image5), so a default-branch checkout
    // would land on code without the image scripts. --no-checkout avoids that
    // intermediate state entirely; the next command lands exactly on the pin.
    commands.push({ label: "clone", argv: ["git", "clone", "--no-checkout", ENGINE.repo, resolved.engine_dir] });
  }
  if (plan.steps.includes("checkout")) {
    if (plan.steps.includes("clone")) {
      // The full clone above already carries the pin as a remote-tracking ref.
      commands.push({ label: "checkout", argv: ["git", "-C", resolved.engine_dir, "checkout", ENGINE.commit] });
    } else {
      // Older clone: refresh ALL refs (the pin may sit on another branch),
      // then land on it.
      commands.push({ label: "fetch", argv: ["git", "-C", resolved.engine_dir, "fetch", "origin"] });
      commands.push({ label: "checkout", argv: ["git", "-C", resolved.engine_dir, "checkout", ENGINE.commit] });
    }
  }
  if (plan.steps.includes("pip")) {
    commands.push({ label: "pip-install", argv: [plan.venvBin, "-m", "pip", "install", "-r", join(resolved.engine_dir, "requirements.txt")] });
  }
  const { id } = await submitJob({ modelDir: resolved.model_dir, kind: "engine", commands, nodeBin: deps.nodeBin ?? process.execPath });
  return {
    ok: true,
    stage: "engine",
    state: "running",
    job_id: id,
    next: "poll",
    message: `Engine step submitted (${plan.steps.join(" → ")}). Poll with h3_setup action=poll job_id=${id}.`,
  };
}

async function stepWeights(resolved, args, state, deps) {
  const exec = deps.exec ?? execFileP;
  // Re-entrancy: a live weights job means the download is already in flight —
  // attach (a second fetch would race the same .part files).
  const live = await findRunningJob(resolved.model_dir, "weights", deps);
  if (live) {
    return { ok: true, stage: "weights", state: "running", job_id: live.id, next: "poll", message: `Weights job ${live.id} is already running — attached instead of double-submitting.` };
  }
  const totalGB = (deps.totalmem ?? totalmem)() / 1e9;
  const freeGB = await probeFreeGB(resolved.model_dir);
  const ditManifest = await probeFile(join(resolved.model_dir, "dit", "ASSET_SHA256.json"));
  const teMain = await probeFile(join(resolved.text_dir, "text_encoder.safetensors"));
  const teConfig = await probeFile(resolved.text_config);
  const plan = planWeights({
    licenseAccepted: licenseGate(state) === null,
    memoryGB: totalGB,
    freeGB,
    diskMinGB: LIMITS.diskMinFreeGB,
    ditComplete: ditManifest !== null,
    teComplete: teMain !== null && teConfig !== null,
    riskConfirmed: args.confirm_risk === true || state?.setup?.riskConfirmed === true,
  });
  if (plan.block) return plan.block;
  if (plan.alreadyComplete) {
    return { ok: true, stage: "weights", message: "Weights and text encoder already complete (DiT manifest + text encoder + upstream config all present).", noop: true, next: "smoke" };
  }
  const venvPy = await probeVenvPython(resolved.venv_dir, exec);
  if (venvPy === null || venvPy.broken) return envelope("engine", "Weights conversion needs the venv.", "Run h3_setup action=venv first.");
  const head = await probeGitHead(resolved.engine_dir, exec);
  if (head !== ENGINE.commit) return envelope("engine", "Weights fetch runs the pinned engine's fetch script.", "Run h3_setup action=engine first.");

  // Reuse candidates (size-matching only so far) go to a file the driver
  // hashes inside the job — hashing 28 GB never blocks a tool call.
  await mkdir(join(resolved.model_dir, "h3-jobs"), { recursive: true });
  const candidates = await probeTextEncoderReuse(resolved.scan_dirs ?? TEXT_ENCODER_REUSE.scanDirs.map((d) => join(homedir(), d)), deps);
  await writeFile(candidatesFile(resolved), candidates.join("\n") + (candidates.length ? "\n" : ""), "utf8");

  const commands = buildWeightsCommands({ resolved, venvBin: venvPy.bin, mirror: resolved.mirror });
  const { id } = await submitJob({ modelDir: resolved.model_dir, kind: "weights", commands, nodeBin: deps.nodeBin ?? process.execPath });
  return {
    ok: true,
    stage: "weights",
    state: "running",
    job_id: id,
    next: "poll",
    message:
      `Weights step submitted: 12 transformer shards (~5.5 GB each, download→convert→delete, resumable) + text encoder ` +
      `(${candidates.length > 0 ? `${candidates.length} size-matching reuse candidate(s) will be sha256-verified first` : "no local candidate; full download"}). ` +
      `Poll with h3_setup action=poll job_id=${id}.`,
    fix_hint: plan.riskWarning ? "Memory below recommended (you confirmed the risk): close other memory-heavy apps during conversion." : undefined,
  };
}

function candidatesFile(resolved) {
  return join(resolved.model_dir, "h3-jobs", "reuse-candidates.txt");
}

async function stepSmoke(resolved, deps) {
  const exec = deps.exec ?? execFileP;
  const live = await findRunningJob(resolved.model_dir, "smoke", deps);
  if (live) {
    return { ok: true, stage: "smoke", state: "running", job_id: live.id, next: "poll", message: `Smoke job ${live.id} is already running — attached instead of double-submitting.` };
  }
  const venvPy = await probeVenvPython(resolved.venv_dir, exec);
  if (venvPy === null || venvPy.broken) return envelope("engine", "Smoke needs the venv.", "Run h3_setup action=venv first.");
  const head = await probeGitHead(resolved.engine_dir, exec);
  if (head !== ENGINE.commit) return envelope("engine", "Smoke runs the pinned engine.", "Run h3_setup action=engine first.");
  const ditManifest = await probeFile(join(resolved.model_dir, "dit", "ASSET_SHA256.json"));
  if (ditManifest === null) return envelope("verify", "Smoke needs converted weights.", "Run h3_setup action=weights first.");
  const teMain = await probeFile(join(resolved.text_dir, "text_encoder.safetensors"));
  if (teMain === null) return envelope("verify", "Smoke needs the text encoder.", "Run h3_setup action=weights first.");

  const id = newJobId("smoke");
  const built = buildSmokeCommands({ resolved, venvBin: venvPy.bin, jobId: id });
  await submitJob({ modelDir: resolved.model_dir, kind: "smoke", commands: built.commands, nodeBin: deps.nodeBin ?? process.execPath, precomputedId: id });
  return {
    ok: true,
    stage: "smoke",
    state: "running",
    job_id: id,
    next: "poll",
    message: `Smoke submitted (1 MP image, seed 7). Poll with h3_setup action=poll job_id=${id}. A passing smoke requires a structurally valid PNG — exit code alone is never the verdict.`,
  };
}

/**
 * Poll wrapper with M2 acceptance semantics: `done` is only `done` after the
 * on-disk result is re-verified (engine HEAD, weight manifest, PNG decode).
 */
export async function pollSetup(resolved, jobId, deps = {}) {
  const result = await pollJob(resolved.model_dir, jobId, deps);
  if (!result.ok || result.state !== "done") return result;
  const exec = deps.exec ?? execFileP;
  if (result.kind === "smoke") {
    const out = join(resolved.model_dir, "h3-jobs", `${jobId}.png`);
    try {
      const bytes = await (deps.readFileP ?? readFile)(out);
      const info = pngInfo(bytes);
      result.smoke_png = { ok: info !== null, ...(info ?? {}) };
      if (info === null) {
        result.state = "failed";
        result.error_type = "verify";
        result.message = "Smoke job exited 0 but its PNG failed structural validation — treated as FAILED.";
      }
    } catch {
      result.state = "failed";
      result.error_type = "verify";
      result.message = "Smoke job exited 0 but produced no PNG file — treated as FAILED.";
    }
  } else if (result.kind === "weights") {
    const ditManifest = await probeFile(join(resolved.model_dir, "dit", "ASSET_SHA256.json"));
    const teMain = await probeFile(join(resolved.text_dir, "text_encoder.safetensors"));
    const teConfig = await probeFile(resolved.text_config);
    result.verified = { dit_manifest: ditManifest !== null, text_encoder: teMain !== null, text_config: teConfig !== null };
    if (!result.verified.dit_manifest || !result.verified.text_encoder || !result.verified.text_config) {
      result.state = "failed";
      result.error_type = "verify";
      result.message = "Weights chain exited 0 but the DiT manifest, text encoder or upstream config is missing on disk — treated as FAILED.";
    }
  } else if (result.kind === "engine") {
    const head = await probeGitHead(resolved.engine_dir, exec);
    result.verified = { head_matches_pin: head === ENGINE.commit };
    if (head !== ENGINE.commit) {
      result.state = "failed";
      result.error_type = "verify";
      result.message = `Engine chain exited 0 but HEAD is ${head ?? "not a checkout"}, expected the pinned commit.`;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Entry: h3_setup dispatch (index.js routes every non-license action here)
// ---------------------------------------------------------------------------

export async function runSetup(action, args, resolved, config, deps = {}) {
  const sPath = statePath(resolved.model_dir);
  const state = await readState(sPath, (p) => readFile(p, "utf8"));

  switch (action) {
    case "check":
    case "status": {
      const status = await runStatus(config, deps);
      const jobs = await listJobs(resolved.model_dir, 5);
      // `message` is required by the tool output schema — the status block
      // itself renders via formatSetup, but the envelope must stay valid.
      return {
        ok: true,
        stage: action,
        message: `Setup status: ${status.overall}.`,
        status,
        jobs,
        license: state?.license ?? null,
      };
    }
    case "venv":
      return stepVenv(resolved, config, deps);
    case "engine":
      return stepEngine(resolved, state, deps);
    case "weights":
    case "convert": // the engine fetches AND converts per shard in one resumable flow; `convert` is an alias
      return stepWeights(resolved, args, state, deps);
    case "smoke":
      return stepSmoke(resolved, deps);
    case "poll": {
      if (typeof args.job_id !== "string" || args.job_id === "") {
        return envelope("engine", "poll needs job_id (returned by the submitted step).", "Recent job ids appear in h3_setup action=status.");
      }
      const result = await pollSetup(resolved, args.job_id, deps);
      if (result.ok && result.state === "done") {
        const setup = { ...(state.setup ?? {}) };
        if (result.kind === "engine") setup.engine = { depsInstalled: true, at: new Date().toISOString() };
        if (result.kind === "weights") setup.weights = { complete: true, at: new Date().toISOString() };
        if (result.kind === "smoke" && result.smoke_png?.ok) setup.smoke = { passed: true, at: new Date().toISOString() };
        await writeState(sPath, { ...state, setup });
      }
      return result;
    }
    case "kill": {
      if (typeof args.job_id !== "string" || args.job_id === "") {
        return envelope("engine", "kill needs job_id.", "Recent job ids appear in h3_setup action=status.");
      }
      return killJob(resolved.model_dir, args.job_id);
    }
    default:
      return envelope("engine", `Unknown setup action "${action}".`, "Use check|venv|engine|license|weights|smoke|poll|kill|status|reset.");
  }
}
