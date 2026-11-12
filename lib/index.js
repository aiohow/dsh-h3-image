/**
 * dsh-h3-image — DSH Host plugin bundle exposing three model-facing tools:
 *
 *  - `h3_status` — read-only environment check (platform / memory / python /
 *    engine commit / weights / text encoder / disk), returning a structured
 *    red/green checklist. Zero side effects, zero network.
 *  - `h3_setup`  — the setup state machine (M2). Until it lands it returns a
 *    structured NOT_IMPLEMENTED envelope instead of failing opaquely.
 *  - `h3_image`  — text-to-image via the pinned local MLX engine (M1). Same
 *    stub discipline until it lands.
 *
 * Canonical API usage (verified against the installed dsh-image-gen bundle
 * and the dsh-doc references rather than guessed):
 *  - `ctx.tools.register(definition)` takes a RAW ToolDefinition; schemas are
 *    enforced JSON Schema and arguments are validated locally (the Loader
 *    cannot resolve `@deepseek-ai/dsh-tools` imports from a workspace bundle —
 *    measured in dsh-image-gen, so nothing external is imported here).
 *  - Registrations are `ctx.effect`-owned so unloading the plugin disposes
 *    the tools.
 *  - `config` is read defensively (`config?.field ?? default`); the Config
 *    schema + configEditor persistence arrive with the M2 wizard.
 *
 * Message discipline: every user-visible string is free of absolute machine
 * paths and usernames (checks.js `displayPath`), matching the release-safety
 * gate (scripts/check-release-safety.mjs).
 */
import { envelope, runStatus } from "./checks.js";

export const inject = ["tools"];

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
    else if (check.type === "integer" && (!Number.isInteger(value))) violations.push(`"${key}" must be an integer`);
    else if (check.type === "boolean" && typeof value !== "boolean") violations.push(`"${key}" must be a boolean`);
    else if (check.values && !check.values.includes(value)) {
      violations.push(`"${key}" must be one of ${JSON.stringify(check.values)}`);
    }
  }
  return violations;
}

function textBlock(text) {
  return { content: [{ type: "text", text }] };
}

function formatStatus(result) {
  const lines = [];
  lines.push(`h3_status: ${result.overall.toUpperCase()}`);
  for (const c of result.checks) {
    const mark = c.state === "ok" ? "OK  " : c.state === "refused" ? "NO  " : "MISS";
    lines.push(`${mark} ${c.id.padEnd(12)} ${c.state} — ${c.detail}`);
    if (c.fix_hint) lines.push(`       fix: ${c.fix_hint}`);
  }
  lines.push(`config: model_dir=${result.config.model_dir} engine_dir=${result.config.engine_dir} venv_dir=${result.config.venv_dir} mirror=${result.config.mirror}`);
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
        mirror: { type: "string" },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
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

  // M2 lands the real state machine; until then the stub keeps the tool
  // surface honest and self-explanatory (no opaque "unknown tool" failures).
  ctx.effect(() =>
    ctx.tools.register({
      name: "h3_setup",
      description:
        "Setup state machine for the local H3 environment: check → venv → engine → license → " +
        "weights → smoke, each step resumable. NOT IMPLEMENTED in this build (0.0.1): calls " +
        "return a structured NOT_IMPLEMENTED envelope. Use h3_status meanwhile.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["check", "venv", "engine", "license", "weights", "convert", "smoke", "status", "reset"],
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "error_type", "message"],
          properties: {
            ok: { type: "boolean" },
            error_type: { type: "string" },
            message: { type: "string" },
            fix_hint: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `${value.ok} ${value.error_type ?? ""} ${value.message}` }],
      },
      presentCall() {
        return { card: "generic", title: "H3 setup", kind: "other" };
      },
      async execute(args) {
        const violations = validateArgs(args ?? {}, { action: { values: ["check", "venv", "engine", "license", "weights", "convert", "smoke", "status", "reset"] } }, []);
        if (violations.length > 0) {
          throw new Error(`h3_setup: invalid arguments: ${violations.join("; ")}`);
        }
        return envelope(
          "not_implemented",
          "h3_setup arrives in the next milestone (the wizard state machine).",
          "Run h3_status to see what the future wizard will fix; nothing is downloadable yet.",
        );
      },
    }),
  );

  // M1 lands generation; same honesty discipline.
  ctx.effect(() =>
    ctx.tools.register({
      name: "h3_image",
      description:
        "Generate an image with the local MiniMax H3-Image MLX engine (text-to-image only; " +
        "reference-image/edit inputs are declined by design). NOT IMPLEMENTED in this build " +
        "(0.0.1): calls return a structured NOT_IMPLEMENTED envelope. Use h3_status meanwhile.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          prompt: { type: "string" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "error_type", "message"],
          properties: {
            ok: { type: "boolean" },
            error_type: { type: "string" },
            message: { type: "string" },
            fix_hint: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: `${value.ok} ${value.error_type ?? ""} ${value.message}` }],
      },
      presentCall() {
        return { card: "generic", title: "H3 image", kind: "other" };
      },
      async execute(args) {
        const violations = validateArgs(args ?? {}, { prompt: { type: "string" } }, []);
        if (violations.length > 0) {
          throw new Error(`h3_image: invalid arguments: ${violations.join("; ")}`);
        }
        return envelope(
          "not_implemented",
          "h3_image arrives in the next milestone (local generation).",
          "Run h3_status to inspect the environment; nothing generates yet.",
        );
      },
    }),
  );
}
