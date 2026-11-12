/**
 * dsh-h3-image — DSH Host plugin bundle exposing three model-facing tools:
 *
 *  - `h3_status` — read-only environment check (platform / memory / python /
 *    engine commit / weights / text encoder / disk), returning a structured
 *    red/green checklist. Zero side effects, zero network.
 *  - `h3_setup`  — setup state machine (M2). M1 implements the LICENSE step
 *    (display + explicit user acceptance + reset) because generation is gated
 *    on it; the remaining actions return a structured NOT_IMPLEMENTED envelope.
 *  - `h3_image`  — text-to-image via the pinned local MLX engine (M1): one
 *    subprocess per call, internal deadline, concurrency gate = 1, metrics
 *    parsed, PNG structurally validated, workspace-fenced output, nameplate.
 *
 * Canonical API usage (verified against the installed dsh-image-gen bundle
 * and the dsh-doc references rather than guessed):
 *  - `ctx.tools.register(definition)` takes a RAW ToolDefinition; schemas are
 *    enforced JSON Schema and arguments are validated locally (the Loader
 *    cannot resolve `@deepseek-ai/dsh-tools` imports from a workspace bundle —
 *    measured in dsh-image-gen, so nothing external is imported here).
 *  - Registrations are `ctx.effect`-owned so unloading the plugin disposes
 *    the tools; a final effect kills any live child on unload (no orphan
 *    generator behind a disabled plugin).
 *  - `config` is read defensively (`config?.field ?? default`); the Config
 *    schema + configEditor persistence arrive with the M2 wizard.
 *
 * Message discipline: every user-visible string is free of absolute machine
 * paths and usernames (checks.js `displayPath`), matching the release-safety
 * gate (scripts/check-release-safety.mjs).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { displayPath, envelope, resolveConfig, runStatus } from "./checks.js";
import { killActive } from "./gate.js";
import { reapOrphans } from "./jobs.js";
import { runSetup } from "./setup.js";
import { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, engineScript, runGeneration } from "./runner.js";
import { acceptLicense, licenseGate, licenseSummary, readState, statePath, writeState } from "./state.js";

export const inject = ["tools", "attachments"];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function validateArgs(args, checks, required) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return ["arguments must be an object"];
  }
  const violations = [];
  for (const key of required) {
    if (args[key] === undefined) violations.push(`"${key}" is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const check = checks[key];
    if (check === undefined) {
      violations.push(`unexpected argument "${key}"`);
      continue;
    }
    if (check.type === "string" && typeof value !== "string") violations.push(`"${key}" must be a string`);
    else if (check.type === "integer" && !Number.isInteger(value)) violations.push(`"${key}" must be an integer`);
    else if (check.type === "boolean" && typeof value !== "boolean") violations.push(`"${key}" must be a boolean`);
    if (check.type === "integer" && Number.isInteger(value)) {
      if (check.min !== undefined && value < check.min) violations.push(`"${key}" must be >= ${check.min}`);
      if (check.max !== undefined && value > check.max) violations.push(`"${key}" must be <= ${check.max}`);
    }
    if (check.values && Array.isArray(check.values) && !check.values.includes(value)) {
      violations.push(`"${key}" must be one of ${JSON.stringify(check.values)}`);
    }
  }
  return violations;
}

function textBlock(text) {
  return { content: [{ type: "text", text }] };
}

/** Model-facing failure text: the envelope verbatim, no invented detail. */
function formatFailure(value) {
  const lines = [`h3_image: FAILED [${value.error_type ?? "engine"}]`, value.message];
  if (value.fix_hint) lines.push(`fix: ${value.fix_hint}`);
  if (value.queue_hint) lines.push(`queue: ${value.queue_hint}`);
  return lines.join("\n");
}

/** Compact render for h3_setup results (envelope, job handle, or poll state). */
function formatSetup(value) {
  const lines = [];
  const stage = value.stage ?? value.kind ?? "setup";
  if (value.ok === false) {
    lines.push(`h3_setup [${stage}]: FAILED [${value.error_type ?? "engine"}]`);
    lines.push(value.message);
    if (value.fix_hint) lines.push(`fix: ${value.fix_hint}`);
    return lines.join("\n");
  }
  if (value.state === "running") {
    lines.push(`h3_setup [${stage}]: RUNNING job ${value.job_id}`);
    lines.push(value.message);
    return lines.join("\n");
  }
  if (value.job_id !== undefined && value.state !== undefined) {
    // poll result
    lines.push(`h3_setup poll [${value.kind}/${value.state}] job ${value.job_id}`);
    const p = value.progress ?? {};
    if (value.kind === "weights") {
      lines.push(`shards ${p.shard_done ?? 0}/${p.shard_total ?? 12} converted${p.current ? ` (fetching #${p.current})` : ""}; text encoder ${p.te_done ?? 0}/${p.te_total ?? 9}`);
    } else if (p.stage) {
      lines.push(`stage: ${p.stage}`);
    }
    if (value.verified) lines.push(`verified: ${JSON.stringify(value.verified)}`);
    if (value.smoke_png) lines.push(`smoke png: ${JSON.stringify(value.smoke_png)}`);
    if (value.message) lines.push(value.message);
    if (value.log_tail) lines.push(`--- log tail ---\n${value.log_tail.trimEnd()}`);
    return lines.join("\n");
  }
  if (value.status) {
    // check/status: reuse the status renderer + job list + license line
    lines.push(formatStatus(value.status));
    lines.push(`license: ${value.license?.accepted ? `accepted ${value.license.at}` : "NOT accepted"}`);
    if (Array.isArray(value.jobs) && value.jobs.length > 0) {
      lines.push("jobs:");
      for (const j of value.jobs) lines.push(`  ${j.id}  ${j.kind}  ${j.status}  ${j.startedAt ?? ""}`);
    }
    return lines.join("\n");
  }
  lines.push(`h3_setup [${stage}]: ${value.message}`);
  if (value.next) lines.push(`next: ${value.next}`);
  return lines.join("\n");
}

function formatStatus(result) {
  const lines = [];
  lines.push(`h3_status: ${result.overall.toUpperCase()}`);
  for (const c of result.checks) {
    const mark = c.state === "ok" ? "OK  " : c.state === "refused" ? "NO  " : "MISS";
    lines.push(`${mark} ${c.id.padEnd(12)} ${c.state} — ${c.detail}`);
    if (c.fix_hint) lines.push(`       fix: ${c.fix_hint}`);
  }
  const cfg = result.config;
  lines.push(`config: model_dir=${cfg.model_dir} engine_dir=${cfg.engine_dir} venv_dir=${cfg.venv_dir}`);
  lines.push(`        text_dir=${cfg.text_dir} text_config=${cfg.text_config} mirror=${cfg.mirror}`);
  return lines.join("\n");
}

const STATUS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overall", "checks", "config"],
  properties: {
    overall: { type: "string", enum: ["ready", "setup_required", "unsupported", "blocked"] },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "state", "detail"],
        properties: {
          id: { type: "string" },
          state: { type: "string", enum: ["ok", "missing", "mismatch", "too_low", "refused"] },
          detail: { type: "string" },
          fix_hint: { type: "string" },
          warning: { type: "boolean" },
        },
      },
    },
    config: {
      type: "object",
      additionalProperties: false,
      properties: {
        model_dir: { type: "string" },
        engine_dir: { type: "string" },
        venv_dir: { type: "string" },
        text_dir: { type: "string" },
        text_config: { type: "string" },
        mirror: { type: "string" },
      },
    },
  },
};

const SETUP_ACTIONS = ["check", "venv", "engine", "license", "weights", "convert", "smoke", "poll", "kill", "status", "reset"];

// Arguments that belong to image-to-image / editing surfaces the pinned engine
// does not have. They are REFUSED with an explicit message (D7), never silently
// ignored — a silently dropped reference image would produce a wrong image.
const REFUSED_ARGS = [
  "reference_images", "reference_image", "images", "image", "init_image",
  "mask", "edit", "strength", "denoise", "control", "ip_adapter",
];

/**
 * Workspace fence (dsh-image-gen D2 precedent): output_dir must resolve inside
 * the session workspace. Runs BEFORE any side effect so a bad path can never
 * orphan a spawned 27 GB generation.
 */
function resolveOutputDir(requested, exec, toolName) {
  const workspaceRoot = exec?.agent?.session?.header?.cwd;
  if (typeof workspaceRoot !== "string" || workspaceRoot === "") {
    throw new Error(`${toolName}: no session workspace available to fence output_dir`);
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(isAbsolute(requested) ? requested : join(root, requested));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`${toolName}: output_dir must stay inside the session workspace`);
  }
  return candidate;
}

/** Unique-ish file stem: timestamp + 8 hex (collisions are effectively out). */
function buildStem(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:TZ]/g, "").slice(0, 14);
  return `h3-${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Map a red h3_status check to the shared error taxonomy (ARCHITECTURE §6). */
const CHECK_TO_ERROR = {
  platform: "unsupported_platform",
  memory: "memory",
  python: "engine",
  engine: "engine",
  weights: "verify",
  text_encoder: "verify",
  disk: "disk",
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});

  ctx.effect(() =>
    ctx.tools.register({
      name: "h3_status",
      description:
        "Read-only health check of the local MiniMax H3-Image environment (this machine only, " +
        "no network, no writes). Returns overall status plus one line per check: platform " +
        "(Apple Silicon macOS), unified memory, venv python, engine checkout at the pinned commit, " +
        "converted weights, text encoder (with hash-verified reuse candidates), free disk. " +
        "Use it before h3_image and after any h3_setup step; every red item carries a fix_hint. " +
        "A fresh machine is expected to read mostly red until the setup wizard completes.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: "text", text: formatStatus(value) }],
      },
      presentCall() {
        return { card: "generic", title: "H3 environment check", kind: "other" };
      },
      async execute(args) {
        const violations = validateArgs(args ?? {}, {}, []);
        if (violations.length > 0) {
          throw new Error(`h3_status: invalid arguments: ${violations.join("; ")}`);
        }
        return runStatus(config ?? {});
      },
    }),
  );

  // Setup state machine (M2). Steps are reentrant — re-running skips finished
  // work by re-probing the disk, never by trusting a cached claim. Long steps
  // (engine/weights/smoke) submit a background job and return a job_id in
  // seconds; progress comes from action=poll (D4 three-phase, like async
  // video tasks). LICENSE stays handled here (M1 semantics unchanged: the
  // plugin never accepts on the user's behalf); `reset` deletes the whole
  // state file (license record + step records).
  ctx.effect(() =>
    ctx.tools.register({
      name: "h3_setup",
      description:
        "Setup state machine for the local H3 environment: check → venv → engine → license → " +
        "weights → smoke, each step resumable. venv finds a suitable CPython (brew/python.org/" +
        "uv/pyenv or config python_bin) and creates the environment; engine clones the pinned " +
        "commit and pip-installs its requirements; weights download 12 transformer shards " +
        "(~5.5 GB each, download→convert→delete, resumable — finished shards are NOT re-downloaded) " +
        "plus the text encoder (sha256-verified reuse of an existing copy when one exists, else " +
        "download); smoke generates one 1 MP image as the end-to-end proof. Long steps return " +
        "{ job_id, next: \"poll\" } immediately — poll for progress, kill to stop a job (finished " +
        "work survives). action=license shows the agreement; license with accept=true records YOUR " +
        "acceptance (required before downloads and generation; never done on your behalf). " +
        "action=reset deletes the local state record. Use h3_status meanwhile.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: SETUP_ACTIONS },
          accept: {
            type: "boolean",
            description: "license only: true records YOUR acceptance of the community license after you have read it.",
          },
          job_id: {
            type: "string",
            description: "poll/kill only: the job id returned by the submitted step.",
          },
          confirm_risk: {
            type: "boolean",
            description: "weights only: true acknowledges the machine is below recommended memory and accepts the OOM risk.",
          },
          python_bin: {
            type: "string",
            description: "venv only: use this interpreter instead of auto-discovery (also settable in the plugin config).",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "message"],
          properties: {
            ok: { type: "boolean" },
            stage: { type: "string" },
            error_type: { type: "string" },
            message: { type: "string" },
            fix_hint: { type: "string" },
            noop: { type: "boolean" },
            next: { type: "string" },
            state: { type: "string" },
            job_id: { type: "string" },
            progress: { type: "object" },
            log_tail: { type: "string" },
            verified: { type: "object" },
            smoke_png: { type: "object" },
            status: { type: "object" },
            jobs: { type: "array" },
            license: { type: "object" },
          },
        },
        render: (_args, value) => [{ type: "text", text: formatSetup(value) }],
      },
      presentCall(args) {
        return { card: "generic", title: `H3 setup · ${args?.action ?? "?"}`, kind: "other" };
      },
      async execute(args) {
        const violations = validateArgs(args ?? {}, {
          action: { values: SETUP_ACTIONS },
          accept: { type: "boolean" },
          job_id: { type: "string" },
          confirm_risk: { type: "boolean" },
          python_bin: { type: "string" },
        }, []);
        if (violations.length > 0) {
          throw new Error(`h3_setup: invalid arguments: ${violations.join("; ")}`);
        }
        const action = args?.action;
        const sPath = statePath(resolved.model_dir);
        if (action === "license" && args?.accept === true) {
          const state = await readState(sPath, (p) => readFile(p, "utf8"));
          const next = acceptLicense(state);
          try {
            await writeState(sPath, next);
          } catch (error) {
            return envelope(
              "disk",
              `Could not record the license acceptance: ${error?.code ?? error?.message ?? "write failed"}.`,
              "Check that model_dir exists and is writable (create the directory first), then retry.",
            );
          }
          return {
            ok: true,
            stage: "license",
            message: `License acceptance recorded (${next.license.agreement}) at ${next.license.at}. ` +
              `Stored in ${displayPath(sPath)} — delete it (or run action=reset) to revoke.`,
            next: "weights",
          };
        }
        if (action === "license") {
          const state = await readState(sPath, (p) => readFile(p, "utf8"));
          const gate = licenseGate(state);
          if (gate === null) {
            return { ok: true, stage: "license", message: "License already accepted for this model_dir (record present)." };
          }
          return { ok: true, stage: "license", message: licenseSummary() };
        }
        if (action === "reset") {
          try {
            await unlink(sPath);
            return { ok: true, stage: "reset", message: `State record deleted (${displayPath(sPath)}): license + step records. Generation is gated again; finished downloads on disk remain (re-probes will see them).` };
          } catch (error) {
            if (error?.code === "ENOENT") {
              return { ok: true, stage: "reset", message: "No state record existed; nothing to delete." };
            }
            return envelope("disk", `Could not delete the state record: ${error?.code ?? "error"}.`, "Delete the file manually if it persists.");
          }
        }
        return runSetup(action, args ?? {}, resolved, { ...(config ?? {}), ...(typeof args?.python_bin === "string" && args.python_bin !== "" ? { python_bin: args.python_bin } : {}) }, {});
      },
    }),
  );

  // Activation sweep: jobs whose supervisor died (host restart, external kill)
  // are marked `interrupted` — never reported as completed. Running jobs are
  // deliberately LEFT RUNNING (a multi-hour download survives plugin reload).
  ctx.effect(() => {
    reapOrphans(resolved.model_dir).then((reaped) => {
      if (reaped.length > 0) ctx.log?.("info", `h3-setup: marked ${reaped.length} interrupted job(s): ${reaped.join(", ")}`);
    }).catch(() => {});
  });

  // Kill any live engine child if the plugin unloads mid-generation (no
  // orphaned 27 GB process behind a disabled plugin).
  ctx.effect(() => () => killActive("plugin unloaded"));

  ctx.effect(() =>
    ctx.tools.register({
      name: "h3_image",
      description:
        "Generate an image with the local MiniMax H3-Image MLX engine (text-to-image only; " +
        "reference-image/edit inputs are refused by design — the engine has no such capability). " +
        "Runs one subprocess per call under an internal deadline (default 240 s, max 900 s); " +
        "exactly ONE generation at a time (~27 GB memory), a second concurrent call returns " +
        "busy immediately. Requires h3_status ready AND the community license accepted " +
        "(h3_setup action=license). Output is written into the session workspace " +
        "(default generated-images/) and attached to the conversation with a nameplate " +
        "(size, seconds, seed, peak memory from the engine metrics).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "Text description of the image to generate." },
          aspect: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"], description: "Default 1:1. Ignored when width/height are given." },
          mp: { type: "integer", minimum: 1, maximum: 16, description: "Megapixel target, default 4. 16 MP takes ~80 s and the most memory." },
          seed: { type: "integer", minimum: 0, description: "Reproducibility seed; the engine default (0) applies when omitted." },
          width: { type: "integer", description: "Exact pixel width; must come with height and be a multiple of 32." },
          height: { type: "integer", description: "Exact pixel height; must come with width and be a multiple of 32." },
          output_dir: { type: "string", description: "Directory inside the session workspace, default generated-images/." },
          timeout_seconds: { type: "integer", minimum: 10, maximum: 900, description: "Internal deadline, default 240." },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: {
            ok: { type: "boolean" },
            provider: { type: "string" },
            model: { type: "string" },
            prompt: { type: "string" },
            aspect: { type: "string" },
            mp: { type: "integer" },
            canvas: { type: "string" },
            seed: { type: "integer" },
            seconds: { type: "number" },
            peak_gb: { type: "number" },
            path: { type: "string" },
            saved: { type: "boolean" },
            image: {
              type: "object",
              additionalProperties: false,
              required: ["attachmentId", "mediaType", "bytes", "width", "height"],
              properties: {
                attachmentId: { type: "string" },
                mediaType: { type: "string" },
                bytes: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                name: { type: "string" },
              },
            },
            error_type: { type: "string" },
            message: { type: "string" },
            fix_hint: { type: "string" },
            queue_hint: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return [{ type: "text", text: formatFailure(value) }];
          const nameplate =
            `**h3-local · MiniMax H3-Image · ${value.canvas} · PNG · ${value.seconds}s · ` +
            `seed ${value.seed} · peak ${value.peak_gb} GB**`;
          const target = value.image !== undefined ? `attachment:${value.image.attachmentId}` : value.path;
          const blocks = [{ type: "text", text: `${nameplate}\n![h3-local](${target})` }];
          if (value.image !== undefined) blocks.push({ type: "image", attachment: { ...value.image } });
          return blocks;
        },
      },
      presentCall(args) {
        const preview = typeof args?.prompt === "string" ? args.prompt.slice(0, 40) : "";
        return { card: "generic", title: `H3 generate${preview ? `: ${preview}` : ""}`, kind: "other" };
      },
      async execute(args, exec) {
        // D7: capability refusals FIRST — an explicit "not supported" beats a
        // generic "unexpected argument" from the schema validator.
        const refused = REFUSED_ARGS.filter((k) => args?.[k] !== undefined);
        if (refused.length > 0) {
          throw new Error(
            `h3_image: ${refused.map((k) => `"${k}"`).join(", ")} ${refused.length > 1 ? "are" : "is"} not supported — ` +
              `the current engine capability surface is pure text-to-image. Remove the argument(s) and re-run.`,
          );
        }
        const violations = validateArgs(args ?? {}, {
          prompt: { type: "string" },
          aspect: { values: ["1:1", "16:9", "9:16", "4:3", "3:4"] },
          mp: { type: "integer", min: 1, max: 16 },
          seed: { type: "integer", min: 0 },
          width: { type: "integer", min: 64 },
          height: { type: "integer", min: 64 },
          output_dir: { type: "string" },
          timeout_seconds: { type: "integer", min: 10, max: 900 },
          ...Object.fromEntries(REFUSED_ARGS.map((k) => [k, {}])),
        }, ["prompt"]);
        if (violations.length > 0) {
          throw new Error(`h3_image: invalid arguments: ${violations.join("; ")}`);
        }
        const { prompt } = args;
        const hasW = args.width !== undefined;
        const hasH = args.height !== undefined;
        if (hasW !== hasH) {
          throw new Error("h3_image: width and height must be supplied together");
        }
        if (hasW && (args.width % 32 !== 0 || args.height % 32 !== 0)) {
          throw new Error("h3_image: width and height must be multiples of 32");
        }

        // Fence before ANY side effect (no orphaned spawn on a bad path).
        const outputDir = resolveOutputDir(args.output_dir ?? "generated-images", exec, "h3_image");

        // License gate: no record → refuse (persists across restarts; the
        // record lives next to the weights it gates).
        const state = await readState(statePath(resolved.model_dir), (p) => readFile(p, "utf8"));
        const gateBlock = licenseGate(state);
        if (gateBlock !== null) return gateBlock;

        // Environment gate: h3_status must read ready (warnings don't block).
        const status = await runStatus(config ?? {});
        if (status.overall !== "ready") {
          const red = status.checks.find((c) => c.state !== "ok" && c.warning !== true) ?? status.checks.find((c) => c.state !== "ok");
          const etype = CHECK_TO_ERROR[red?.id] ?? "engine";
          return envelope(
            etype,
            `Environment is not ready (${status.overall}): ${red?.id} — ${red?.detail ?? "see h3_status"}.`,
            red?.fix_hint ?? "Run h3_status and clear the red items before generating.",
          );
        }

        const stem = buildStem();
        const output = join(outputDir, `${stem}.png`);
        const metricsPath = join(tmpdir(), "dsh-h3-image", `${stem}.metrics.json`);
        try {
          await mkdir(join(tmpdir(), "dsh-h3-image"), { recursive: true });
        } catch { /* tmpdir exists in practice */ }

        const result = await runGeneration(
          {
            pythonBin: join(resolved.venv_dir, "bin", "python"),
            engineDir: resolved.engine_dir,
            script: engineScript(resolved.engine_dir),
            prompt,
            output,
            root: resolved.model_dir,
            textDir: resolved.text_dir,
            textConfig: resolved.text_config,
            aspect: args.aspect ?? "1:1",
            mp: args.mp ?? 4,
            width: args.width,
            height: args.height,
            seed: args.seed,
            metricsPath,
            timeoutSeconds: args.timeout_seconds ?? DEFAULT_TIMEOUT_S,
          },
          { home: process.env.HOME ?? "" },
        );
        if (result.ok === false) return result;

        // The engine already wrote the workspace copy (it mkdirs the parent
        // itself — verified in generate_h3_image.py). The durable attachment
        // is the conversation deliverable; a save failure must not lose the
        // on-disk image, so the two are independent.
        const fileName = `${stem}.png`;
        let ref = null;
        let saveError = null;
        try {
          ref = await ctx.attachments.saveImage({
            data: result.png.bytes,
            mediaType: "image/png",
            name: fileName,
          });
        } catch (error) {
          saveError = error?.message ?? String(error);
        }

        const image = ref === null ? undefined : {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType,
          bytes: Number(ref.bytes),
          width: Number(ref.width),
          height: Number(ref.height),
        };
        if (image !== undefined && typeof ref.name === "string") image.name = ref.name;

        const value = {
          ok: true,
          provider: "h3-local",
          model: "MiniMax H3-Image",
          prompt,
          aspect: hasW ? `${args.width}x${args.height}` : (args.aspect ?? "1:1"),
          canvas: `${result.png.width}x${result.png.height}`,
          seed: Number.isInteger(result.metrics.seed) ? result.metrics.seed : (args.seed ?? 0),
          seconds: Math.round(Number(result.metrics.total_seconds ?? 0) * 10) / 10,
          peak_gb: Math.round(Number(result.metrics.peak_gb ?? 0) * 100) / 100,
          path: displayPath(output),
          saved: true,
        };
        if (!hasW) value.mp = args.mp ?? 4;
        if (image !== undefined) value.image = image;
        else value.message = `Image written to ${displayPath(output)} but the conversation attachment failed: ${saveError}`;
        return value;
      },
    }),
  );
}
