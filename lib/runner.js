/**
 * Generation runner (ARCHITECTURE §2): spawn the pinned engine CLI as a child
 * process (one process per call — the engine returns its ~27 GB on exit),
 * wait under an INTERNAL deadline, parse the metrics JSON, validate and read
 * the PNG.
 *
 * Hard rules encoded here:
 *  - spawn(argv array, no shell) — a prompt containing `" ` $( )` is data,
 *    never shell (TEST-PLAN §2 injection negative).
 *  - internal deadline (default 240 s, cap 900 s) so the harness tool-timeout
 *    policy never arms; expiry kills the child and returns error_type:"timeout".
 *  - every failure leaves a structured envelope with a classified error_type
 *    and a zero-machine-path message (SECURITY-PRIVACY §3).
 *  - the PNG is validated structurally (magic + IHDR + IEND) before the call
 *    claims success — "file exists" is never a pass (team red line).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { envelope } from "./checks.js";
import { acquire, noteKill, release } from "./gate.js";

export const DEFAULT_TIMEOUT_S = 240;
export const MAX_TIMEOUT_S = 900;
export const ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"];

/**
 * Pure argv builder (unit-tested; also the injection-negative fixture).
 * `script` is absolute inside the pinned engine checkout.
 */
export function buildArgv({ script, prompt, output, root, textDir, textConfig, aspect, mp, width, height, seed, metricsPath, noCanvas }) {
  const argv = [script, prompt, "-o", output, "--root", root, "--text-dir", textDir, "--text-config", textConfig];
  if (width !== undefined && height !== undefined) argv.push("--width", String(width), "--height", String(height));
  else argv.push("--aspect", aspect, "--mp", String(mp));
  if (seed !== undefined) argv.push("--seed", String(seed));
  argv.push("--metrics", metricsPath);
  if (noCanvas) argv.push("--no-canvas");
  return argv;
}

/** Structural PNG check: magic, IHDR size, IEND. Returns {width,height}|null. */
export function pngInfo(bytes) {
  const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC[i]) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  if (bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") return null;
  return { width, height };
}

/** Classify a failed child run into the shared error taxonomy. */
export function classifyFailure({ killedByDeadline, signal, code, stderrTail }) {
  if (killedByDeadline) {
    return envelope(
      "timeout",
      `Generation exceeded its internal deadline and was stopped.`,
      "Re-run with a larger timeout_seconds (max 900), a smaller mp, or close memory-heavy apps first.",
    );
  }
  const s = (stderrTail ?? "").toLowerCase();
  if (s.includes("no space left") || s.includes("enospc")) {
    return envelope("disk", "The engine could not write its output: the volume is out of space.", "Free disk space near model_dir and retry.");
  }
  if (s.includes("out of memory") || s.includes("mps backend") || signal === "SIGKILL") {
    return envelope(
      "memory",
      "The engine ran out of unified memory (or was killed by the memory pressure guard).",
      "Close other memory-heavy apps (browsers with many tabs, other model servers) and retry at a smaller mp.",
    );
  }
  if (s.includes("sha256") || s.includes("checksum") || s.includes("corrupt")) {
    return envelope("verify", "The engine rejected a weight file (checksum/structure mismatch).", "Re-run h3_setup action=weights to re-verify assets.");
  }
  return envelope(
    "engine",
    `The engine process failed${code === null ? ` (signal ${signal ?? "?"})` : ` (exit ${code})`}.`,
    "Run h3_status to check the environment; if all green, report this message with the engine commit.",
  );
}

/** Last non-empty lines of stderr, home-relative (zero-leak discipline). */
function stderrTail(text, home) {
  const lines = String(text).split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
  const scrub = (l) => (home ? l.split(home).join("~") : l);
  return lines.map(scrub).join("\n");
}

/**
 * Run one generation. `deps` injects spawn/readFile for tests.
 * Returns an envelope ({ok:false,...}) or the success value
 * { metrics, png: {bytes,width,height}, metricsPath }.
 */
export async function runGeneration(opts, deps = {}) {
  const spawnP = deps.spawn ?? spawn;
  const readFileP = deps.readFile ?? readFile;
  const home = deps.home ?? "";

  const gate = acquire(String(opts.prompt ?? "").slice(0, 60));
  if (!gate.ok) {
    return {
      ok: false,
      error_type: "busy",
      message: `Another generation is already running (${gate.busy.elapsed_seconds}s in, prompt: "${gate.busy.prompt_preview}").`,
      fix_hint: "The engine allows one generation at a time (~27 GB memory each). Wait for the running one to finish.",
      queue_hint: "no queue in v1 — retry after the current run completes",
    };
  }
  const ticket = gate.ticket;

  // Internal deadline; the 10 s floor is a deps seam so the deadline path is
  // unit-testable without a 10-second suite (production floor stays 10 s).
  const timeoutMs =
    Math.min(Math.max(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_S, deps.minTimeoutS ?? 10), MAX_TIMEOUT_S) * 1000;
  const argv = buildArgv(opts);
  const pythonBin = opts.pythonBin;

  try {
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawnP(pythonBin, argv, { cwd: opts.engineDir, stdio: ["ignore", "pipe", "pipe"], env: deps.env ?? process.env });
      } catch (error) {
        resolve({ spawnError: error instanceof Error ? error.message : String(error) });
        return;
      }
      let out = "";
      let err = "";
      let killedByDeadline = false;
      const timer = setTimeout(() => {
        killedByDeadline = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, timeoutMs);
      noteKill(ticket, () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
      child.stdout.on("data", (d) => { out += d; if (out.length > 64_000) out = out.slice(-32_000); });
      child.stderr.on("data", (d) => { err += d; if (err.length > 64_000) err = err.slice(-32_000); });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ spawnError: error instanceof Error ? error.message : String(error) });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, killedByDeadline, stdout: out, stderr: err });
      });
    });

    if (result.spawnError !== undefined) {
      return envelope(
        "engine",
        `Could not start the engine process: ${stderrTail(result.spawnError, home)}`,
        "Run h3_status — the venv python or the pinned engine checkout is missing or broken.",
      );
    }
    if (result.code !== 0) {
      return classifyFailure({
        killedByDeadline: result.killedByDeadline,
        signal: result.signal,
        code: result.code,
        stderrTail: stderrTail(result.stderr, home),
      });
    }

    let metrics;
    try {
      metrics = JSON.parse(await readFileP(opts.metricsPath, "utf8"));
    } catch {
      return envelope(
        "engine",
        "The engine exited 0 but wrote no parseable metrics file.",
        "Check engine_dir is at the pinned commit (h3_status); the metrics contract belongs to that commit.",
      );
    }

    let bytes;
    try {
      bytes = await readFileP(opts.output);
    } catch {
      return envelope("engine", "The engine exited 0 but produced no output image.", "Re-run; if it repeats, check free disk near the output directory.");
    }
    const info = pngInfo(bytes);
    if (info === null) {
      return envelope("verify", "The output file is not a structurally valid PNG (truncated or corrupt).", "Delete the file, free disk space if low, and retry.");
    }
    return { metrics, png: { bytes, ...info }, metricsPath: opts.metricsPath };
  } finally {
    release(ticket);
  }
}

/** Convenience: the engine CLI script path inside a checkout. */
export function engineScript(engineDir) {
  return join(engineDir, "scripts", "generate_h3_image.py");
}
