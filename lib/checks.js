/**
 * Read-only environment checks (design: docs/PRD.md §3.1, docs/ARCHITECTURE.md §6).
 *
 * Every check is a pure decision over probed facts, so the decision logic is
 * unit-testable without a machine. `probe*` functions do the I/O and are
 * injectable for tests. Nothing here writes anything, ever.
 *
 * Message discipline (SECURITY-PRIVACY §3): user-visible strings contain no
 * absolute machine paths and no usernames — directories are reported by their
 * CONFIG NAME (`model_dir`, `engine_dir`, `venv_dir`) or with `~`.
 */
import { execFile } from "node:child_process";
import { stat, statfs, readdir } from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ENGINE, LIMITS, TEXT_ENCODER_REUSE } from "./pinned.js";

const execFileP = promisify(execFile);

/** Error/answer envelope shared by all tools (ARCHITECTURE §6). */
export function envelope(errorType, message, fixHint) {
  return { ok: false, error_type: errorType, message, fix_hint: fixHint };
}

// ---------------------------------------------------------------------------
// Probes (I/O only; each returns null on "not found", never throws for
// absence — a missing file is a normal answer here).
// ---------------------------------------------------------------------------

export async function probeFile(path) {
  try {
    const st = await stat(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export async function probeDir(path) {
  try {
    const st = await stat(path);
    return st.isDirectory() ? st : null;
  } catch {
    return null;
  }
}

/** `git rev-parse HEAD` inside dir; null when dir is not a git checkout. */
export async function probeGitHead(dir, exec = execFileP) {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      timeout: 10_000,
    });
    const head = String(stdout).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

export async function probeFreeGB(path) {
  // Walk up to the nearest existing ancestor: model_dir usually does not
  // exist yet on a fresh machine, but its volume's free space is knowable.
  let cur = path;
  for (let i = 0; i < 6; i++) {
    try {
      const s = await statfs(cur);
      return s.bsize * s.bavail / 1e9;
    } catch {
      const parent = cur.replace(/\/[^/]+$/, "") || "/";
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

/** First existing `bin/python*` in a venv, with its reported version. */
export async function probeVenvPython(venvDir, exec = execFileP) {
  let names = [];
  try {
    names = await readdir(join(venvDir, "bin"));
  } catch {
    return null;
  }
  const py = names.filter((n) => /^python3(\.\d+)?$/.test(n)).sort();
  for (const name of py) {
    const bin = join(venvDir, "bin", name);
    if (!(await probeFile(bin))) continue;
    try {
      const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 });
      const m = /Python (\d+)\.(\d+)/.exec(stdout);
      if (m) return { bin, major: +m[1], minor: +m[2] };
    } catch {
      // A broken interpreter is a real finding, not an absence: report it.
      return { bin, major: 0, minor: 0, broken: true };
    }
  }
  return null;
}

/**
 * Reuse probe for the shared text encoder (design D3). Scans the candidate
 * directories one level deep for `TEXT_ENCODER_REUSE.fileName` with the exact
 * byte size. A size match is only a CANDIDATE — the sha256 verdict happens in
 * the weights step (hashing 28 GB does not belong in a status check).
 */
export async function probeTextEncoderReuse(scanDirs, deps = {}) {
  const readdirP = deps.readdir ?? readdir;
  const statP = deps.stat ?? stat;
  const candidates = [];
  const fileName = TEXT_ENCODER_REUSE.fileName;
  const probe = async (fp) => {
    try {
      const st = await statP(fp);
      if (st.isFile() && st.size === TEXT_ENCODER_REUSE.bytes) candidates.push(fp);
    } catch {
      /* absence is normal */
    }
  };
  for (const dir of scanDirs) {
    let entries;
    try {
      entries = await readdirP(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const l1 = join(dir, ent.name);
      await probe(join(l1, fileName));
      // One more level: real layouts are <scan>/<org>/<model>/<file>.
      let subs;
      try {
        subs = await readdirP(l1, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of subs) {
        if (sub.isDirectory()) await probe(join(l1, sub.name, fileName));
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Check decisions (pure). Each returns { id, state, detail, fix_hint? }.
// ---------------------------------------------------------------------------

export function checkPlatform({ platform, arch }) {
  if (platform !== "darwin") {
    return {
      id: "platform",
      state: "refused",
      detail: `This engine runs on Apple Silicon macOS only; detected "${platform}".`,
      fix_hint: "dsh-h3-image cannot run here. Use a cloud image plugin instead.",
    };
  }
  if (arch !== "arm64") {
    return {
      id: "platform",
      state: "refused",
      detail: `This engine requires Apple Silicon; detected arch "${arch}" (Intel Mac or emulated Node).`,
      fix_hint: "Run on an Apple Silicon Mac, or use a cloud image plugin.",
    };
  }
  return { id: "platform", state: "ok", detail: "Apple Silicon macOS." };
}

export function checkMemory({ totalGB }) {
  if (totalGB < LIMITS.memoryFloorGB) {
    return {
      id: "memory",
      state: "too_low",
      detail: `${totalGB.toFixed(0)} GB unified memory; the engine needs at least ${LIMITS.memoryFloorGB} GB and runs comfortably at ${LIMITS.memoryRecommendedGB} GB+.`,
      fix_hint: "This machine is below the hard floor; generation will OOM. Not supported.",
    };
  }
  if (totalGB < LIMITS.memoryRecommendedGB) {
    return {
      id: "memory",
      state: "too_low",
      detail: `${totalGB.toFixed(0)} GB unified memory: workable but NOT guaranteed (recommended ${LIMITS.memoryRecommendedGB} GB+).`,
      fix_hint: "The wizard will ask you to confirm this risk before downloading.",
      warning: true,
    };
  }
  return { id: "memory", state: "ok", detail: `${totalGB.toFixed(0)} GB unified memory.` };
}

export function checkPython({ python, venvDirName }) {
  if (python === null) {
    return {
      id: "python",
      state: "missing",
      detail: `No virtual environment found at ${venvDirName}.`,
      fix_hint: "Run h3_setup action=venv (the wizard finds a suitable interpreter and creates it).",
    };
  }
  if (python.broken) {
    return {
      id: "python",
      state: "mismatch",
      detail: `The interpreter inside ${venvDirName} exists but does not run.`,
      fix_hint: "Delete the venv directory and re-run h3_setup action=venv.",
    };
  }
  const [minMajor, minMinor] = ENGINE.pythonMin;
  if (python.major < minMajor || (python.major === minMajor && python.minor < minMinor)) {
    return {
      id: "python",
      state: "mismatch",
      detail: `venv Python is ${python.major}.${python.minor}; the engine requires >= ${minMajor}.${minMinor}.`,
      fix_hint: "Recreate the venv with a newer interpreter (h3_setup action=venv).",
    };
  }
  return { id: "python", state: "ok", detail: `venv Python ${python.major}.${python.minor}.` };
}

export function checkEngine({ engineDirName, head, pinnedCommit }) {
  if (engineDirName === null) {
    return {
      id: "engine",
      state: "missing",
      detail: "No engine checkout at engine_dir.",
      fix_hint: "Run h3_setup action=engine (clones the pinned commit).",
    };
  }
  if (head === null) {
    return {
      id: "engine",
      state: "mismatch",
      detail: "engine_dir exists but is not a git checkout.",
      fix_hint: "Remove engine_dir and re-run h3_setup action=engine.",
    };
  }
  if (head !== pinnedCommit) {
    return {
      id: "engine",
      state: "mismatch",
      detail: `engine checkout is at ${head.slice(0, 12)}, plugin pins ${pinnedCommit.slice(0, 12)}.`,
      fix_hint: "Run h3_setup action=engine to check out the pinned commit.",
    };
  }
  return { id: "engine", state: "ok", detail: `Pinned commit ${head.slice(0, 12)}.` };
}

export function checkWeights({ weightsDirName, ditManifest }) {
  if (weightsDirName === null) {
    return {
      id: "weights",
      state: "missing",
      detail: "No model directory at model_dir.",
      fix_hint: "Run h3_setup action=license first, then action=weights.",
    };
  }
  if (!ditManifest) {
    return {
      id: "weights",
      state: "missing",
      detail: "model_dir exists but the converted DiT is incomplete (no asset manifest).",
      fix_hint: "Re-run h3_setup action=weights (resumable; finished shards are not re-downloaded).",
    };
  }
  return { id: "weights", state: "ok", detail: "Converted DiT asset manifest present." };
}

export function checkTextEncoder({ upstreamPresent, reuseCandidates }) {
  if (upstreamPresent) {
    return { id: "text_encoder", state: "ok", detail: "Text encoder present at text_dir." };
  }
  if (reuseCandidates.length > 0) {
    return {
      id: "text_encoder",
      state: "missing",
      detail: `Text encoder not in model_dir, but ${reuseCandidates.length} size-matching candidate file(s) found; the weights step verifies the sha256 before reusing.`,
      fix_hint: "Run h3_setup action=weights — it hashes the candidate and skips the ~28 GB download on a match.",
    };
  }
  return {
    id: "text_encoder",
    state: "missing",
    detail: "Text encoder not found (no local candidate either).",
    fix_hint: "h3_setup action=weights downloads it from the pinned upstream revision.",
  };
}

export function checkDisk({ freeGB, modelDirName }) {
  if (freeGB === null) {
    return {
      id: "disk",
      state: "missing",
      detail: `Could not read free space for ${modelDirName}.`,
      fix_hint: "Ensure model_dir's parent exists or let the wizard create it.",
    };
  }
  if (freeGB < LIMITS.diskMinFreeGB) {
    return {
      id: "disk",
      state: "too_low",
      detail: `${freeGB.toFixed(0)} GB free at model_dir; the download + conversion peak needs about ${LIMITS.diskMinFreeGB} GB.`,
      fix_hint: "Free disk space, or point model_dir at a larger volume in the plugin configuration.",
    };
  }
  return { id: "disk", state: "ok", detail: `${freeGB.toFixed(0)} GB free.` };
}

// ---------------------------------------------------------------------------
// Full status run (used by the h3_status tool).
// ---------------------------------------------------------------------------

export function resolveConfig(config = {}) {
  const home = homedir();
  // With an explicit model_dir, sibling defaults hang off its parent (the
  // wizard layout is <root>/{models,engine,venv}); otherwise everything lives
  // under ~/.dsh-h3-image.
  const root = config.model_dir ? join(config.model_dir, "..") : join(home, "dsh-h3-image");
  const model_dir = config.model_dir ?? join(root, "models");
  // Text-encoder layout (engine contract, verified against generate_h3_image.py):
  // `text_dir` is the folder holding text_encoder.safetensors + tokenizer;
  // `text_config` is the UPSTREAM config.json (its text_config.num_hidden_layers
  // is what the loader reads — the quantized folder's own config.json is a
  // different shape and is NOT a substitute). Defaults follow the M2 wizard
  // layout; both are overridable for machines with reusable assets.
  const text_dir = config.text_dir ?? join(model_dir, "text_encoder");
  // Wizard layout puts the upstream config under model_dir/upstream-meta/
  // (that is where the weights step downloads FL2VA/text_encoder/config.json).
  const text_config =
    config.text_config ?? join(model_dir, "upstream-meta", "FL2VA", "text_encoder", "config.json");
  return {
    model_dir,
    engine_dir: config.engine_dir ?? join(root, "engine"),
    venv_dir: config.venv_dir ?? join(root, "venv"),
    text_dir,
    text_config,
    mirror: config.mirror === "hf-mirror" ? "hf-mirror" : "hf",
    // Reuse-probe scan roots (absolute or $HOME-relative). Default is the
    // one known asset location; an explicit [] forces a true bare-metal
    // simulation (no candidates → full download + verification path).
    scan_dirs: Array.isArray(config.scan_dirs)
      ? config.scan_dirs.map((d) => (d.startsWith("~") ? join(home, d.slice(1)) : d))
      : TEXT_ENCODER_REUSE.scanDirs.map((d) => join(home, d)),
  };
}

/** Display form of a path: home-relative with `~`, for zero-leak messages. */
export function displayPath(path) {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

export async function runStatus(config, deps = {}) {
  const resolved = resolveConfig(config);
  const exec = deps.exec ?? execFileP;

  const platform = checkPlatform({
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
  });
  const memory = checkMemory({
    totalGB: deps.totalGB ?? (deps.totalmem ?? totalmem)() / 1e9,
  });

  const engineDirSt = await probeDir(resolved.engine_dir);
  const [python, engineHead, modelDirSt] = await Promise.all([
    probeVenvPython(resolved.venv_dir, exec),
    engineDirSt ? probeGitHead(resolved.engine_dir, exec) : Promise.resolve(null),
    probeDir(resolved.model_dir),
  ]);

  const ditManifest = modelDirSt
    ? await probeFile(join(resolved.model_dir, "dit", "ASSET_SHA256.json"))
    : null;
  // Probe the file the ENGINE actually loads (text_dir/text_encoder.safetensors),
  // not a layout guess.
  const upstreamTe = await probeFile(join(resolved.text_dir, "text_encoder.safetensors"));
  const reuseCandidates = await probeTextEncoderReuse(
    resolved.scan_dirs ?? TEXT_ENCODER_REUSE.scanDirs.map((d) => join(homedir(), d)),
    deps,
  );
  const freeGB = deps.freeGB !== undefined ? deps.freeGB : await probeFreeGB(resolved.model_dir);

  const checks = [
    platform,
    memory,
    checkPython({ python, venvDirName: displayPath(resolved.venv_dir) }),
    checkEngine({
      engineDirName: engineDirSt ? displayPath(resolved.engine_dir) : null,
      head: engineHead,
      pinnedCommit: ENGINE.commit,
    }),
    checkWeights({
      weightsDirName: modelDirSt ? displayPath(resolved.model_dir) : null,
      ditManifest,
    }),
    checkTextEncoder({ upstreamPresent: upstreamTe, reuseCandidates }),
    checkDisk({ freeGB, modelDirName: displayPath(resolved.model_dir) }),
  ];

  const overall = overallOf(checks);
  return {
    overall,
    checks,
    config: {
      model_dir: displayPath(resolved.model_dir),
      engine_dir: displayPath(resolved.engine_dir),
      venv_dir: displayPath(resolved.venv_dir),
      text_dir: displayPath(resolved.text_dir),
      text_config: displayPath(resolved.text_config),
      mirror: resolved.mirror,
    },
  };
}

export function overallOf(checks) {
  if (checks.some((c) => c.state === "refused")) return "unsupported";
  const bad = checks.filter((c) => c.state !== "ok");
  if (bad.length === 0) return "ready";
  // "blocked" is reserved for a refused license (M2); until then anything
  // not-ready is setup work.
  return "setup_required";
}
